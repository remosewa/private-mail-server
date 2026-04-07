/**
 * admin-delete-user Lambda
 *
 * Trigger: Manual invocation by admin with { userId: "..." }
 *
 * Efficiently deletes all user data from S3 and DynamoDB:
 * - All S3 objects under {userId}/ prefix (emails, attachments, embeddings, etc.)
 * - All DynamoDB items with PK = USER#{userId}
 * - User record from Users table
 */

import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, QueryCommand, BatchWriteItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { SNSClient, DeleteTopicCommand } from '@aws-sdk/client-sns';
import { marshall } from '@aws-sdk/util-dynamodb';

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});
const sns = new SNSClient({});

const USER_DATA_BUCKET = process.env.USER_DATA_BUCKET_NAME!;
const EMAILS_TABLE = process.env.EMAILS_TABLE_NAME!;
const USERS_TABLE = process.env.USERS_TABLE_NAME!;
const SNS_TOPIC_ARN_PREFIX = process.env.SNS_TOPIC_ARN_PREFIX!;

interface DeleteUserEvent {
  userId: string;
}

interface DeleteUserResult {
  userId: string;
  s3ObjectsDeleted: number;
  dynamoItemsDeleted: number;
  durationMs: number;
}

export const handler = async (event: DeleteUserEvent): Promise<DeleteUserResult> => {
  const startTime = Date.now();
  const { userId } = event;

  if (!userId) {
    throw new Error('userId is required');
  }

  console.log(`[admin-delete-user] Starting deletion for user: ${userId}`);

  // Delete S3 objects, DynamoDB items, and SNS topic in parallel
  const [s3Count, dynamoCount] = await Promise.all([
    deleteS3Objects(userId),
    deleteDynamoItems(userId),
    deleteSNSTopic(userId),
  ]);

  const durationMs = Date.now() - startTime;

  console.log(`[admin-delete-user] Completed deletion for ${userId}:`, {
    s3ObjectsDeleted: s3Count,
    dynamoItemsDeleted: dynamoCount,
    durationMs,
  });

  return {
    userId,
    s3ObjectsDeleted: s3Count,
    dynamoItemsDeleted: dynamoCount,
    durationMs,
  };
};

/**
 * Delete all S3 objects under {userId}/ prefix.
 * Uses batch deletion (up to 1000 objects per request).
 */
async function deleteS3Objects(userId: string): Promise<number> {
  let totalDeleted = 0;
  let continuationToken: string | undefined;

  do {
    // List up to 1000 objects
    const listRes = await s3.send(new ListObjectsV2Command({
      Bucket: USER_DATA_BUCKET,
      Prefix: `${userId}/`,
      MaxKeys: 1000,
      ContinuationToken: continuationToken,
    }));

    const objects = listRes.Contents ?? [];
    if (objects.length === 0) break;

    // Delete in batch (max 1000 per request)
    await s3.send(new DeleteObjectsCommand({
      Bucket: USER_DATA_BUCKET,
      Delete: {
        Objects: objects.map(obj => ({ Key: obj.Key! })),
        Quiet: true,
      },
    }));

    totalDeleted += objects.length;
    continuationToken = listRes.NextContinuationToken;

    console.log(`[admin-delete-user] Deleted ${objects.length} S3 objects (total: ${totalDeleted})`);
  } while (continuationToken);

  return totalDeleted;
}

/**
 * Delete per-user SNS notification topic.
 * Best-effort - logs warning if topic doesn't exist or deletion fails.
 */
async function deleteSNSTopic(userId: string): Promise<void> {
  try {
    const topicArn = `${SNS_TOPIC_ARN_PREFIX}${userId}`;
    await sns.send(new DeleteTopicCommand({ TopicArn: topicArn }));
    console.log(`[admin-delete-user] Deleted SNS topic: ${topicArn}`);
  } catch (err) {
    // Non-fatal - topic may not exist or already deleted
    console.warn(`[admin-delete-user] Failed to delete SNS topic (non-fatal):`, err);
  }
}

/**
 * Delete all DynamoDB items with PK = USER#{userId}.
 * Uses batch write (up to 25 items per request).
 */
async function deleteDynamoItems(userId: string): Promise<number> {
  let totalDeleted = 0;
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  // Query all items for this user
  do {
    const queryRes = await ddb.send(new QueryCommand({
      TableName: EMAILS_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: marshall({ ':pk': `USER#${userId}` }),
      ProjectionExpression: 'PK, SK',
      Limit: 100,  // Fetch 100 at a time
      ExclusiveStartKey: lastEvaluatedKey as any,
    }));

    const items = queryRes.Items ?? [];
    if (items.length === 0) break;

    // Delete in batches of 25 (DynamoDB BatchWriteItem limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      
      await ddb.send(new BatchWriteItemCommand({
        RequestItems: {
          [EMAILS_TABLE]: batch.map(item => ({
            DeleteRequest: { Key: item },
          })),
        },
      }));

      totalDeleted += batch.length;
    }

    lastEvaluatedKey = queryRes.LastEvaluatedKey as any;

    console.log(`[admin-delete-user] Deleted ${items.length} DynamoDB items (total: ${totalDeleted})`);
  } while (lastEvaluatedKey);

  // Delete user record from Users table
  try {
    await ddb.send(new DeleteItemCommand({
      TableName: USERS_TABLE,
      Key: marshall({ userId }),
    }));
    totalDeleted++;
    console.log(`[admin-delete-user] Deleted user record from Users table`);
  } catch (err) {
    console.warn(`[admin-delete-user] Failed to delete user record:`, err);
  }

  return totalDeleted;
}
