/**
 * DynamoDB Streams processor — cleans up S3 objects when email items are removed.
 *
 * Trigger: DynamoDB Streams on the emails table (OLD_IMAGE view).
 *
 * Only REMOVE events are handled (TTL expiry or direct deletes).
 * For each deleted EMAIL# item, the following S3 objects are deleted:
 *   - s3HeaderKey, s3BodyKey, s3TextKey, s3EmbeddingKey, s3AttachmentsKey
 *   - All attachment binaries under {userId}/attachments/{ulid}/
 */

import type { DynamoDBStreamEvent } from 'aws-lambda';
import {
  S3Client,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';

const s3 = new S3Client({});
const USER_DATA_BUCKET = process.env.USER_DATA_BUCKET_NAME!;

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  for (const record of event.Records) {
    if (record.eventName !== 'REMOVE') continue;

    const oldImage = record.dynamodb?.OldImage;
    if (!oldImage) continue;

    const item = unmarshall(oldImage as Record<string, AttributeValue>);

    // Only process EMAIL# items (skip COUNTS, PUSH#, etc.)
    const sk = item['SK'] as string | undefined;
    if (!sk?.startsWith('EMAIL#')) continue;

    const pk = item['PK'] as string | undefined; // USER#<userId>
    if (!pk) continue;

    const userId = pk.replace('USER#', '');
    const ulid   = sk.replace('EMAIL#', '');

    // Collect known S3 blob keys
    const blobKeys: string[] = [
      item['s3HeaderKey'],
      item['s3BodyKey'],
      item['s3TextKey'],
      item['s3EmbeddingKey'],
      item['s3AttachmentsKey'],
    ].filter((k): k is string => typeof k === 'string' && k.length > 0);

    // Delete known blobs in parallel (best-effort)
    await Promise.allSettled(
      blobKeys.map(key =>
        s3.send(new DeleteObjectCommand({ Bucket: USER_DATA_BUCKET, Key: key })),
      ),
    );

    // List and delete all attachment binaries under the email's attachment prefix
    const attPrefix = `${userId}/attachments/${ulid}/`;
    try {
      let continuationToken: string | undefined;
      do {
        const listRes = await s3.send(new ListObjectsV2Command({
          Bucket:            USER_DATA_BUCKET,
          Prefix:            attPrefix,
          ContinuationToken: continuationToken,
        }));

        const keys = (listRes.Contents ?? [])
          .map(obj => obj.Key)
          .filter((k): k is string => typeof k === 'string');

        if (keys.length > 0) {
          await s3.send(new DeleteObjectsCommand({
            Bucket: USER_DATA_BUCKET,
            Delete: { Objects: keys.map(Key => ({ Key })) },
          }));
        }

        continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
      } while (continuationToken);
    } catch (err) {
      // Best-effort — log so we can diagnose but don't fail the batch
      console.error(`[stream-processor] Failed to clean up attachments for ${attPrefix}:`, err);
    }
  }
};
