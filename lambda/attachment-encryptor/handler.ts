/**
 * attachment-encryptor Lambda
 *
 * Trigger: S3 ObjectCreated on attachment-staging-bucket
 * Key format: {userId}/{attachmentId}
 *
 * Pipeline:
 *   1. Parse userId + attachmentId from the S3 key.
 *   2. Fetch user's RSA public key from the users table.
 *   3. Read the raw bytes from staging.
 *   4. Encrypt with hybridEncrypt (AES-256-GCM + RSA-OAEP).
 *   5. Write encrypted blob to user-data-bucket at
 *        {userId}/attachment-staging/{attachmentId}.enc
 *
 * The raw staging file is NOT deleted here — the send handler needs it
 * to build the outgoing SES MIME and will delete it after dispatch.
 * The 24-hour staging lifecycle rule is the safety net.
 *
 * No DynamoDB is used for attachment tracking; existence is checked
 * directly via S3 HeadObject in the send handler.
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { S3Event } from 'aws-lambda';
import type { Readable } from 'stream';
import { hybridEncrypt } from '../shared/encrypt';

const s3  = new S3Client({});
const ddb = new DynamoDBClient({});

const STAGING_BUCKET   = process.env.ATTACHMENT_STAGING_BUCKET_NAME!;
const USER_DATA_BUCKET = process.env.USER_DATA_BUCKET_NAME!;
const USERS_TABLE      = process.env.USERS_TABLE_NAME!;

export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    const rawKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    try {
      await processAttachment(rawKey);
    } catch (err) {
      // Non-fatal: staging file expires via lifecycle rule.
      // The send handler falls back to inline encryption if the pre-encrypted
      // copy is missing.
      console.error(`[attachment-encryptor] Failed key=${rawKey}:`, err);
    }
  }
};

async function processAttachment(rawKey: string): Promise<void> {
  // Key format: {userId}/{attachmentId}
  const slash = rawKey.indexOf('/');
  if (slash < 0) throw new Error(`Unexpected key format: ${rawKey}`);
  const userId       = rawKey.slice(0, slash);
  const attachmentId = rawKey.slice(slash + 1);

  // Fetch user's public key
  const userRes = await ddb.send(new GetItemCommand({
    TableName: USERS_TABLE,
    Key: marshall({ userId }),
    ProjectionExpression: 'publicKey',
  }));
  if (!userRes.Item) throw new Error(`User not found: ${userId}`);
  const { publicKey } = unmarshall(userRes.Item) as { publicKey: string };

  // Fetch raw bytes from staging
  const getRes = await s3.send(new GetObjectCommand({ Bucket: STAGING_BUCKET, Key: rawKey }));
  const rawBytes = await streamToBuffer(getRes.Body as Readable);

  // Encrypt and store
  const encrypted = hybridEncrypt(rawBytes, publicKey);
  await s3.send(new PutObjectCommand({
    Bucket: USER_DATA_BUCKET,
    Key: `${userId}/attachment-staging/${attachmentId}.enc`,
    Body: encrypted,
    ContentType: 'application/octet-stream',
  }));

  console.log(`[attachment-encryptor] OK ${userId}/${attachmentId} (${rawBytes.length} bytes)`);
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}
