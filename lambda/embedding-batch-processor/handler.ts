/**
 * embedding-batch-processor Lambda
 *
 * Trigger: S3 ObjectCreated on {userId}/embedding-batches/*.json
 *
 * Unpacks batch embedding files and updates DynamoDB s3EmbeddingKey fields.
 */

import { S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});

const USER_DATA_BUCKET = process.env.USER_DATA_BUCKET_NAME!;
const EMAILS_TABLE = process.env.EMAILS_TABLE_NAME!;

interface BatchFile {
  batchId: string;
  embeddings: Array<{
    ulid: string;
    data: string;  // base64 encoded embedding
  }>;
}

export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    // Extract userId from key: {userId}/embedding-batches/{batchId}.json
    const match = key.match(/^([^/]+)\/embedding-batches\/([^/]+)\.json$/);
    if (!match) {
      console.warn(`[batch-processor] Skipping non-batch file: ${key}`);
      continue;
    }

    const [, userId, batchId] = match;

    try {
      // Download batch file
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = await res.Body?.transformToString();
      if (!body) throw new Error('Empty batch file');

      const batch: BatchFile = JSON.parse(body);

      // Process each embedding in the batch
      await Promise.allSettled(
        batch.embeddings.map(async ({ ulid, data }) => {
          // Decode base64 and write individual embedding file
          const embBytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
          const s3Key = `${userId}/embeddings/${ulid}.enc`;

          await s3.send(new PutObjectCommand({
            Bucket: USER_DATA_BUCKET,
            Key: s3Key,
            Body: embBytes,
            ContentType: 'application/octet-stream',
          }));

          // Update DynamoDB with s3EmbeddingKey and lastUpdatedAt so sync picks it up
          await ddb.send(new UpdateItemCommand({
            TableName: EMAILS_TABLE,
            Key: marshall({ PK: `USER#${userId}`, SK: `EMAIL#${ulid}` }),
            UpdateExpression: 'SET s3EmbeddingKey = :key, lastUpdatedAt = :ts',
            ExpressionAttributeValues: marshall({ ':key': s3Key, ':ts': new Date().toISOString() }),
            ConditionExpression: 'attribute_exists(PK)',
          }));
        }),
      );

      console.log(`[batch-processor] Processed batch ${batchId} with ${batch.embeddings.length} embeddings`);
    } catch (err) {
      console.error(`[batch-processor] Failed processing ${key}:`, err);
      throw err;  // Let Lambda retry
    }
  }
};
