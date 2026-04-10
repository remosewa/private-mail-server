/**
 * Sync route handler
 *
 * Endpoint: GET /sync
 *
 * Purpose: Returns all email, label, and migration updates since a given timestamp.
 * Clients poll this endpoint every 30 seconds to stay synchronized with server changes.
 *
 * Query Parameters:
 *   - since: ISO-8601 UTC timestamp (required) - return all updates after this time
 *   - limit: number (optional, default 100, max 500) - pagination limit
 *   - nextToken: string (optional) - pagination token for continuing a previous query
 *
 * Response:
 *   {
 *     emails: EmailMeta[],
 *     labels: Label[],
 *     migrations: MigrationStatus[],
 *     nextToken: string | null,
 *     serverTime: string  // Current server UTC time for client clock sync
 *   }
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient, QueryCommand, GetItemCommand, type QueryCommandInput } from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import https from 'https';

type ApiEvent = APIGatewayProxyEventV2;
type ApiResult = APIGatewayProxyResultV2;

const ddb = new DynamoDBClient({});
// Increase HTTPS connection pool — default 50 is too low for 100 parallel S3 fetches per sync page
const s3 = new S3Client({
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 3000,
    socketTimeout: 5000,
    httpAgent: new (require('http').Agent)({ keepAlive: true, maxSockets: 200 }),
    httpsAgent: new (require('https').Agent)({ keepAlive: true, maxSockets: 200 }),
  }),
});
const EMAILS_TABLE = process.env.EMAILS_TABLE_NAME || 'chase-emails';
const USER_DATA_BUCKET = process.env.USER_DATA_BUCKET_NAME || '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(status: number, body: unknown): ApiResult {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function getUserId(event: ApiEvent): string | undefined {
  // @ts-expect-error - authorizer is added by API Gateway JWT authorizer at runtime
  return event.requestContext.authorizer?.jwt?.claims?.['sub'] as string | undefined;
}

/**
 * Validates that a string is a valid ISO-8601 UTC timestamp.
 * Accepts formats ending with 'Z' or '+00:00' offset.
 */
function isValidUTCTimestamp(timestamp: string): boolean {
  if (!timestamp) return false;
  
  // Try to parse it first
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return false;
  
  // Check if it's a valid ISO-8601 format with UTC indicator
  // Accepts: 2024-01-15T10:30:45Z or 2024-01-15T10:30:45.123Z or 2024-01-15T10:30:45+00:00
  const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|\+00:00)$/;
  if (!isoRegex.test(timestamp)) return false;
  
  return true;
}

/**
 * Query the UserUpdatesIndex GSI for all email updates since a given timestamp.
 */
async function queryEmailUpdates(
  userId: string,
  since: string,
  limit: number,
  nextToken?: string
): Promise<{ items: unknown[], nextToken: string | null }> {
  const queryInput: QueryCommandInput = {
    TableName: EMAILS_TABLE,
    IndexName: 'UserUpdatesIndex',
    KeyConditionExpression: 'userId = :userId AND lastUpdatedAt > :since',
    ExpressionAttributeValues: marshall({
      ':userId': userId,
      ':since': since,
    }),
    Limit: limit,
    ScanIndexForward: false, // Descending order (newest first)
  };

  // Decode nextToken if provided
  if (nextToken) {
    try {
      const decoded = Buffer.from(nextToken, 'base64').toString('utf8');
      queryInput.ExclusiveStartKey = JSON.parse(decoded);
    } catch (error) {
      throw new Error('Invalid nextToken format');
    }
  }

  const result = await ddb.send(new QueryCommand(queryInput));

  // Unmarshall items and filter out non-email records (e.g., SETTINGS)
  const allRecords = (result.Items ?? []).map(item => unmarshall(item));
  const now = new Date().toISOString();
  const records = allRecords.filter(rec => {
    const sk = rec['SK']?.toString() ?? '';
    // Only include EMAIL# records, exclude SETTINGS and other metadata
    if (!sk.startsWith('EMAIL#')) return false;
    
    // Filter out future-dated emails (migration propagation delay)
    const lastUpdatedAt = rec['lastUpdatedAt'] as string;
    if (lastUpdatedAt && lastUpdatedAt > now) {
      return false;
    }
    
    return true;
  });

  // Format items with header blobs from DynamoDB (no S3 fetch needed)
  const items = records.map(rec => {
    const ulid = rec['SK']?.toString().replace('EMAIL#', '') ?? rec['ulid']; // Extract from SK or fallback to ulid field
    return {
      ulid,
      threadId:         rec['threadId'] ?? ulid, // fallback to ulid
      folderId:         rec['folderId'],
      labelIds:         rec['labelIds'] ?? [],
      read:             rec['read'],
      receivedAt:       rec['receivedAt'],
      lastUpdatedAt:    rec['lastUpdatedAt'],
      headerBlob:       rec['headerBlob'] ?? null, // base64 encrypted header blob from DynamoDB
      wrappedEmailKey:  rec['wrappedEmailKey'] ?? null, // present on draft/sent; absent on inbound
      s3BodyKey:        rec['s3BodyKey'],
      s3TextKey:        rec['s3TextKey'],
      s3EmbeddingKey:   rec['s3EmbeddingKey'],
      s3AttachmentsKey: rec['s3AttachmentsKey'],
      messageId:        rec['messageId'] ?? null, // Message-ID for threading
      version:          rec['version'] ?? 1,
      hasAttachments:       rec['hasAttachments'] ?? 0, // 1 if has attachments, 0 otherwise
      attachmentFilenames:  (rec['attachmentFilenames'] as string | null) ?? null,
    };
  });

  // Encode LastEvaluatedKey as base64 JSON if present
  const encodedNextToken = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
    : null;

  return {
    items,
    nextToken: encodedNextToken,
  };
}

/**
 * Query the UserUpdatesIndex GSI for all email updates before a given timestamp.
 * Used for tail sync (backfilling older emails).
 */
async function queryEmailUpdatesBefore(
  userId: string,
  before: string,
  limit: number,
  nextToken?: string
): Promise<{ items: unknown[], nextToken: string | null }> {
  const queryInput: QueryCommandInput = {
    TableName: EMAILS_TABLE,
    IndexName: 'UserUpdatesIndex',
    KeyConditionExpression: 'userId = :userId AND lastUpdatedAt < :before',
    ExpressionAttributeValues: marshall({
      ':userId': userId,
      ':before': before,
    }),
    Limit: limit,
    ScanIndexForward: false, // Descending order (newest first, even when going backwards)
  };

  // Decode nextToken if provided
  if (nextToken) {
    try {
      const decoded = Buffer.from(nextToken, 'base64').toString('utf8');
      queryInput.ExclusiveStartKey = JSON.parse(decoded);
    } catch (error) {
      throw new Error('Invalid nextToken format');
    }
  }

  const result = await ddb.send(new QueryCommand(queryInput));

  // Unmarshall items and filter out non-email records (e.g., SETTINGS)
  const allRecords = (result.Items ?? []).map(item => unmarshall(item));
  const now = new Date().toISOString();
  const records = allRecords.filter(rec => {
    const sk = rec['SK']?.toString() ?? '';
    // Only include EMAIL# records, exclude SETTINGS and other metadata
    if (!sk.startsWith('EMAIL#')) return false;
    
    // Filter out future-dated emails (migration propagation delay)
    const lastUpdatedAt = rec['lastUpdatedAt'] as string;
    if (lastUpdatedAt && lastUpdatedAt > now) {
      return false;
    }
    
    return true;
  });

  // Format items with header blobs from DynamoDB (no S3 fetch needed)
  const items = records.map(rec => {
    const ulid = rec['SK']?.toString().replace('EMAIL#', '') ?? rec['ulid']; // Extract from SK or fallback to ulid field
    return {
      ulid,
      threadId:         rec['threadId'] ?? ulid, // fallback to ulid
      folderId:         rec['folderId'],
      labelIds:         rec['labelIds'] ?? [],
      read:             rec['read'],
      receivedAt:       rec['receivedAt'],
      lastUpdatedAt:    rec['lastUpdatedAt'],
      headerBlob:       rec['headerBlob'] ?? null, // base64 encrypted header blob from DynamoDB
      wrappedEmailKey:  rec['wrappedEmailKey'] ?? null, // present on draft/sent; absent on inbound
      s3BodyKey:        rec['s3BodyKey'],
      s3TextKey:        rec['s3TextKey'],
      s3EmbeddingKey:   rec['s3EmbeddingKey'],
      s3AttachmentsKey: rec['s3AttachmentsKey'],
      messageId:        rec['messageId'] ?? null, // Message-ID for threading
      version:          rec['version'] ?? 1,
      hasAttachments:       rec['hasAttachments'] ?? 0, // 1 if has attachments, 0 otherwise
      attachmentFilenames:  (rec['attachmentFilenames'] as string | null) ?? null,
    };
  });

  // Encode LastEvaluatedKey as base64 JSON if present
  const encodedNextToken = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
    : null;

  return {
    items,
    nextToken: encodedNextToken,
  };
}

/**
 * Query individual folder and label records for sync.
 * Returns all folder/label records with lastUpdatedAt > since.
 */
async function queryFolderAndLabelUpdates(
  userId: string,
  since: string
): Promise<{ folders: unknown[], labels: unknown[] }> {
  // Query all FOLDER# and LABEL# records updated since timestamp
  const result = await ddb.send(new QueryCommand({
    TableName: EMAILS_TABLE,
    KeyConditionExpression: 'PK = :pk AND SK > :sk',
    FilterExpression: 'lastUpdatedAt > :since',
    ExpressionAttributeValues: marshall({
      ':pk': `USER#${userId}`,
      ':sk': 'FOLDER#', // This will match both FOLDER# and LABEL# records
      ':since': since,
    }),
  }));

  const records = (result.Items ?? []).map(item => unmarshall(item));
  
  // Separate folders and labels
  const folders = records
    .filter(r => r.SK.startsWith('FOLDER#'))
    .map(r => ({
      folderId: r.folderId,
      encryptedName: r.encryptedName,
      lastUpdatedAt: r.lastUpdatedAt,
      version: r.version,
    }));
  
  const labels = records
    .filter(r => r.SK.startsWith('LABEL#'))
    .map(r => ({
      labelId: r.labelId,
      encryptedName: r.encryptedName,
      color: r.color,
      lastUpdatedAt: r.lastUpdatedAt,
      version: r.version,
    }));
  
  return { folders, labels };
}

/**
 * Query the MigrationStatus table for migration status updates since a given timestamp.
 */
async function queryMigrationUpdates(
  userId: string,
  since: string
): Promise<{ items: unknown[] }> {
  const result = await ddb.send(new GetItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({
      PK: `USER#${userId}`,
      SK: 'MIGRATION#STATE',
    }),
  }));

  if (!result.Item) {
    return { items: [] };
  }

  const migrationStatus = unmarshall(result.Item);
  
  // Check if lastUpdatedAt exists and is greater than since
  if (migrationStatus.lastUpdatedAt && migrationStatus.lastUpdatedAt > since) {
    return { items: [migrationStatus] };
  }

  return { items: [] };
}

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

export async function handleGetSync(event: ApiEvent): Promise<ApiResult> {
  // Extract userId from JWT
  const userId = getUserId(event);
  if (!userId) {
    return json(401, { error: 'Unauthorized' });
  }

  // Extract and validate query parameters
  // Support two modes: head sync (since) and tail sync (before)
  const since = event.queryStringParameters?.since;
  const before = event.queryStringParameters?.before;

  if (!since && !before) {
    return json(400, { error: 'Missing required parameter: either "since" or "before" must be provided' });
  }

  if (since && before) {
    return json(400, { error: 'Cannot specify both "since" and "before" parameters' });
  }

  const timestamp = since || before;
  if (!isValidUTCTimestamp(timestamp!)) {
    return json(400, { error: 'Invalid timestamp parameter: must be ISO-8601 UTC timestamp' });
  }

  const limit = Math.min(
    parseInt(event.queryStringParameters?.limit ?? '100', 10),
    500
  );
  const nextToken = event.queryStringParameters?.nextToken;

  // Query GSI for email updates
  try {
    // Parallelize independent queries
    const [emailsResult, foldersLabels, migrationsResult] = await Promise.all([
      since
        ? queryEmailUpdates(userId, since, limit, nextToken)
        : queryEmailUpdatesBefore(userId, before!, limit, nextToken),
      since
        ? queryFolderAndLabelUpdates(userId, since)
        : Promise.resolve({ folders: [], labels: [] }),
      since
        ? queryMigrationUpdates(userId, since)
        : Promise.resolve({ items: [] }),
    ]);

    // Return response with current server time
    return json(200, {
      emails: emailsResult.items,
      folders: foldersLabels.folders,
      labels: foldersLabels.labels,
      migrations: migrationsResult.items,
      nextToken: emailsResult.nextToken,
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid nextToken format') {
      return json(400, { error: 'Invalid nextToken parameter' });
    }
    throw error;
  }
}
