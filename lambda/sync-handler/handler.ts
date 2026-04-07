/**
 * sync-handler Lambda
 *
 * Trigger: API Gateway HTTP API (v2 payload format)
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
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

type ApiEvent = APIGatewayProxyEventV2;
type ApiResult = APIGatewayProxyResultV2;

const ddb = new DynamoDBClient({});
const EMAILS_TABLE = process.env.EMAILS_TABLE_NAME || 'chase-emails';

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
 * 
 * @param userId - The user ID to query for
 * @param since - ISO-8601 UTC timestamp to query from (exclusive)
 * @param limit - Maximum number of items to return
 * @param nextToken - Optional pagination token (base64-encoded JSON)
 * @returns Object containing items array and optional nextToken for pagination
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

  // Unmarshall items
  const items = (result.Items ?? []).map(item => unmarshall(item));

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
 * Query the Labels table for all label updates since a given timestamp.
 * 
 * Note: Currently labels are stored as part of email metadata (labelIds array).
 * This function is a placeholder for when labels become separate entities with lastUpdatedAt.
 * For now, it returns an empty array as labels don't have their own lastUpdatedAt tracking.
 * 
 * @param userId - The user ID to query for
 * @param since - ISO-8601 UTC timestamp to query from (exclusive)
 * @returns Object containing items array (currently empty)
 */
async function queryLabelUpdates(
  userId: string,
  since: string
): Promise<{ items: unknown[] }> {
  // TODO: Implement when Labels table is created with lastUpdatedAt field
  // For now, return empty array as labels are part of email metadata
  return { items: [] };
}

/**
 * Query the MigrationStatus table for migration status updates since a given timestamp.
 * 
 * Migration status is stored in the EmailsTable with SK pattern "MIGRATION#STATE".
 * This function retrieves the migration status if it has been updated since the given timestamp.
 * 
 * @param userId - The user ID to query for
 * @param since - ISO-8601 UTC timestamp to query from (exclusive)
 * @returns Object containing items array with migration status (if updated since timestamp)
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
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event: ApiEvent): Promise<ApiResult> => {
  // Extract userId from JWT
  const userId = getUserId(event);
  if (!userId) {
    return json(401, { error: 'Unauthorized' });
  }

  // Extract and validate query parameters
  const since = event.queryStringParameters?.since;
  if (!since) {
    return json(400, { error: 'Missing required parameter: since' });
  }

  if (!isValidUTCTimestamp(since)) {
    return json(400, { error: 'Invalid since parameter: must be ISO-8601 UTC timestamp' });
  }

  const limit = Math.min(
    parseInt(event.queryStringParameters?.limit ?? '100', 10),
    500
  );
  const nextToken = event.queryStringParameters?.nextToken;

  // Query GSI for email updates
  try {
    const emailsResult = await queryEmailUpdates(userId, since, limit, nextToken);
    const labelsResult = await queryLabelUpdates(userId, since);
    const migrationsResult = await queryMigrationUpdates(userId, since);

    // Return response with current server time
    return json(200, {
      emails: emailsResult.items,
      labels: labelsResult.items,
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
};
