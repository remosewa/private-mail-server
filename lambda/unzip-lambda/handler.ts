import { S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'stream';
import * as unzipper from 'unzipper';
import { ulid } from 'ulid';
import { updateMboxFileList, failMigration, getMigrationState, updateMigrationState } from '../migration/db-utils';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});
const MBOX_BUCKET = process.env.MBOX_BUCKET_NAME!;
const RAW_BUCKET = process.env.RAW_BUCKET_NAME!;
const EMAILS_TABLE = process.env.EMAILS_TABLE_NAME!;

function parseS3Key(key: string): { userId: string; migrationId: string } {
  const parts = key.split('/');
  if (parts.length !== 3 || parts[0] !== 'uploads') {
    throw new Error(`Invalid S3 key format: ${key}`);
  }
  return { userId: parts[1], migrationId: parts[2].replace('.zip', '') };
}

interface ExtractResult {
  mboxFilenames: string[];
  emlCount: number;
}

async function extractAndUploadFiles(
  bucket: string,
  key: string,
  userId: string,
  migrationId: string
): Promise<ExtractResult> {
  const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!Body) throw new Error('Empty response body from S3');

  const mboxFilenames: string[] = [];
  let emlCount = 0;

  const zipStream = (Body as Readable).pipe(unzipper.Parse());

  await new Promise<void>((resolve, reject) => {
    const pendingUploads: Promise<void>[] = [];

    zipStream.on('entry', (entry: unzipper.Entry) => {
      const filename = entry.path;
      const lower = filename.toLowerCase();

      if (entry.type === 'Directory') {
        entry.autodrain();
        return;
      }

      if (lower.endsWith('.mbox')) {
        console.log(`Found mbox file: ${filename}`);
        const sanitized = filename.split('/').pop()!;
        const destKey = `mbox/${userId}/${migrationId}/${sanitized}`;

        zipStream.pause();

        const uploadPromise = new Upload({
          client: s3,
          params: { Bucket: MBOX_BUCKET, Key: destKey, Body: entry, ContentType: 'application/mbox' },
          partSize: 10 * 1024 * 1024,
          queueSize: 1,
        })
          .done()
          .then(() => {
            mboxFilenames.push(sanitized);
            console.log(`Uploaded mbox: ${sanitized}`);
            zipStream.resume();
          })
          .catch((err: Error) => {
            console.error(`Failed to upload mbox ${filename}:`, err);
            zipStream.resume();
          });

        pendingUploads.push(uploadPromise);

      } else if (lower.endsWith('.eml')) {
        // Upload each .eml directly to migration/ prefix in RAW_BUCKET.
        // The ingest Lambda is already triggered by migration/ prefix events.
        const emlId = ulid();
        const destKey = `migration/${userId}/${emlId}.eml`;
        emlCount++;

        zipStream.pause();

        const uploadPromise = new Upload({
          client: s3,
          params: { Bucket: RAW_BUCKET, Key: destKey, Body: entry, ContentType: 'message/rfc822' },
          partSize: 5 * 1024 * 1024,
          queueSize: 1,
        })
          .done()
          .then(() => {
            console.log(`Uploaded eml ${emlCount}: ${destKey}`);
            zipStream.resume();
          })
          .catch((err: Error) => {
            console.error(`Failed to upload eml ${filename}:`, err);
            zipStream.resume();
          });

        pendingUploads.push(uploadPromise);

      } else {
        entry.autodrain();
      }
    });

    zipStream.on('finish', () => {
      Promise.all(pendingUploads).then(() => resolve()).catch(reject);
    });

    zipStream.on('error', reject);
  });

  return { mboxFilenames, emlCount };
}

/**
 * Update migration state for eml-only migrations.
 * Sets totalMessages = processedMessages = emlCount and marks completed immediately,
 * since all files are already uploaded to S3 for async ingest processing.
 */
async function initEmlMigration(userId: string, emlCount: number): Promise<void> {
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
  await ddb.send(new UpdateItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({ PK: `USER#${userId}`, SK: 'MIGRATION#STATE' }),
    UpdateExpression: 'SET totalMessages = :count, processedMessages = :count, #state = :completed, completedAt = :now, lastUpdatedAt = :now, #ttl = :ttl',
    ExpressionAttributeNames: { '#state': 'state', '#ttl': 'ttl' },
    ExpressionAttributeValues: marshall({ ':count': emlCount, ':completed': 'completed', ':now': now, ':ttl': ttl }),
  }));
}

async function deleteZipFile(bucket: string, key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function handler(event: S3Event): Promise<void> {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    const { userId, migrationId } = parseS3Key(key);

    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));

      const state = await getMigrationState(userId);
      if (!state || state.migrationId !== migrationId) {
        console.log(`Stale event for migration ${migrationId}, skipping`);
        return;
      }

      await updateMigrationState(userId, 'extracting');

      const { mboxFilenames, emlCount } = await extractAndUploadFiles(bucket, key, userId, migrationId);

      if (mboxFilenames.length === 0 && emlCount === 0) {
        await failMigration(userId, 'No .mbox or .eml files found in uploaded archive');
        await deleteZipFile(bucket, key);
        return;
      }

      console.log(`Migration ${migrationId}: ${mboxFilenames.length} mbox files, ${emlCount} eml files`);

      if (mboxFilenames.length > 0) {
        // mbox path: indexer will scan files and set totalMessages + transition to 'running'
        // If there are also eml files, the indexer will ADD to totalMessages atomically
        await updateMboxFileList(userId, mboxFilenames);

        if (emlCount > 0) {
          // Also bump totalMessages for the eml files (indexer will ADD its own count)
          const now = new Date().toISOString();
          await ddb.send(new UpdateItemCommand({
            TableName: EMAILS_TABLE,
            Key: marshall({ PK: `USER#${userId}`, SK: 'MIGRATION#STATE' }),
            UpdateExpression: 'ADD totalMessages :count SET lastUpdatedAt = :now',
            ExpressionAttributeValues: marshall({ ':count': emlCount, ':now': now }),
          }));
        }
      } else {
        // eml-only: files are uploaded to S3, ingest Lambda handles them async.
        // Mark migration completed immediately — no further tracking needed.
        await initEmlMigration(userId, emlCount);
      }

      await deleteZipFile(bucket, key);

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await failMigration(userId, message).catch(console.error);
      await deleteZipFile(bucket, key).catch(console.error);
      throw error;
    }
  }
}
