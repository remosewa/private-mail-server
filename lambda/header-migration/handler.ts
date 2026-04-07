/**
 * Header Migration Lambda
 * 
 * Migrates encrypted email headers from S3 to DynamoDB for faster sync performance.
 * Processes all email records in batches, fetching headers from S3 and storing them
 * in the headerBlob attribute of the DynamoDB record.
 * 
 * Usage: Invoke manually or via EventBridge schedule
 */

import { DynamoDBClient, ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});

const EMAILS_TABLE = process.env.EMAILS_TABLE_NAME!;
const USER_DATA_BUCKET = process.env.USER_DATA_BUCKET!;
const BATCH_SIZE = 25; // Process 25 records at a time

interface MigrationStats {
  scanned: number;
  migrated: number;
  skipped: number;
  errors: number;
}

export async function handler(event: any) {
  console.log('[HeaderMigration] Starting migration');
  
  const stats: MigrationStats = {
    scanned: 0,
    migrated: 0,
    skipped: 0,
    errors: 0,
  };

  let lastEvaluatedKey: Record<string, any> | undefined;
  
  do {
    // Scan for email records
    const scanResult = await ddb.send(new ScanCommand({
      TableName: EMAILS_TABLE,
      FilterExpression: 'begins_with(SK, :emailPrefix)',
      ExpressionAttributeValues: marshall({
        ':emailPrefix': 'EMAIL#',
      }),
      Limit: BATCH_SIZE,
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    const records = (scanResult.Items ?? []).map(item => unmarshall(item));
    stats.scanned += records.length;

    // Process records in parallel
    await Promise.all(
      records.map(async (rec) => {
        try {
          // Skip if headerBlob already exists
          if (rec['headerBlob']) {
            stats.skipped++;
            return;
          }

          // Skip if no s3HeaderKey
          if (!rec['s3HeaderKey']) {
            console.log(`[HeaderMigration] No s3HeaderKey for ${rec['SK']}`);
            stats.skipped++;
            return;
          }

          // Fetch header from S3
          const s3Res = await s3.send(new GetObjectCommand({
            Bucket: USER_DATA_BUCKET,
            Key: rec['s3HeaderKey'] as string,
          }));

          const bytes = await (s3Res.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
          const headerBlob = Buffer.from(bytes).toString('base64');

          // Update DynamoDB record with headerBlob
          await ddb.send(new UpdateItemCommand({
            TableName: EMAILS_TABLE,
            Key: marshall({
              PK: rec['PK'],
              SK: rec['SK'],
            }),
            UpdateExpression: 'SET headerBlob = :headerBlob',
            ExpressionAttributeValues: marshall({
              ':headerBlob': headerBlob,
            }),
          }));

          stats.migrated++;
          console.log(`[HeaderMigration] Migrated ${rec['SK']}`);
        } catch (error) {
          console.error(`[HeaderMigration] Error migrating ${rec['SK']}:`, error);
          stats.errors++;
        }
      })
    );

    lastEvaluatedKey = scanResult.LastEvaluatedKey;
    
    console.log('[HeaderMigration] Progress:', stats);
  } while (lastEvaluatedKey);

  console.log('[HeaderMigration] Migration complete:', stats);
  
  return {
    statusCode: 200,
    body: JSON.stringify(stats),
  };
}
