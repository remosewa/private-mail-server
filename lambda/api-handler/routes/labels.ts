/**
 * Label routes — all require JWT auth.
 *
 * GET    /labels/list — return all label records with encrypted names
 * PUT    /labels/:labelId — create or update individual label record
 * DELETE /labels/:labelId — delete individual label record
 *
 * Label names are RSA-encrypted so the server never sees them.
 */

import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { ApiEvent, ApiResult } from '../types';

const ddb = new DynamoDBClient({});
const EMAILS_TABLE = process.env.EMAILS_TABLE_NAME!;

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

// ---------------------------------------------------------------------------
// GET /labels/list
// ---------------------------------------------------------------------------

/**
 * Return all label records with encrypted names
 */
export async function handleGetLabelList(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  try {
    // Query all label records
    const queryResult = await ddb.send(new QueryCommand({
      TableName: EMAILS_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: marshall({
        ':pk': `USER#${userId}`,
        ':sk': 'LABEL#',
      }),
    }));

    const labels = (queryResult.Items ?? []).map(item => {
      const record = unmarshall(item);
      return {
        labelId: record.labelId,
        encryptedName: record.encryptedName,
        color: record.color,
        lastUpdatedAt: record.lastUpdatedAt,
        version: record.version,
      };
    });

    return json(200, { labels });
  } catch (error) {
    console.error('[labels] Error getting label list:', error);
    return json(500, { error: 'Failed to get labels' });
  }
}

// ---------------------------------------------------------------------------
// PUT /labels/:labelId
// ---------------------------------------------------------------------------

/**
 * Create or update individual label record
 */
export async function handlePutLabel(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const labelId = event.pathParameters?.labelId;
  if (!labelId) return json(400, { error: 'Missing labelId' });

  let body: { encryptedName?: string; color?: string };
  try {
    body = JSON.parse(event.body ?? '{}') as { encryptedName?: string; color?: string };
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  if (!body.encryptedName || typeof body.encryptedName !== 'string') {
    return json(400, { error: 'Missing required field: encryptedName' });
  }

  if (!body.color || typeof body.color !== 'string') {
    return json(400, { error: 'Missing required field: color' });
  }

  const now = new Date().toISOString();

  try {
    await ddb.send(new PutItemCommand({
      TableName: EMAILS_TABLE,
      Item: marshall({
        PK: `USER#${userId}`,
        SK: `LABEL#${labelId}`,
        labelId,
        encryptedName: body.encryptedName,
        color: body.color,
        lastUpdatedAt: now,
        version: 1, // TODO: Implement optimistic locking
      }),
    }));

    return { statusCode: 204 };
  } catch (error) {
    console.error('[labels] Error putting label:', error);
    return json(500, { error: 'Failed to save label' });
  }
}

// ---------------------------------------------------------------------------
// DELETE /labels/:labelId
// ---------------------------------------------------------------------------

/**
 * Delete individual label record
 */
export async function handleDeleteLabel(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const labelId = event.pathParameters?.labelId;
  if (!labelId) return json(400, { error: 'Missing labelId' });

  try {
    await ddb.send(new DeleteItemCommand({
      TableName: EMAILS_TABLE,
      Key: marshall({
        PK: `USER#${userId}`,
        SK: `LABEL#${labelId}`,
      }),
    }));

    return { statusCode: 204 };
  } catch (error) {
    console.error('[labels] Error deleting label:', error);
    return json(500, { error: 'Failed to delete label' });
  }
}
