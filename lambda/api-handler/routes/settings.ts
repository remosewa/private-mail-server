/**
 * Settings routes — all require JWT auth; userId is the Cognito `sub` claim.
 *
 * GET  /settings        — get user settings (returns encrypted blob)
 * PUT  /settings        — update user settings (stores encrypted blob)
 */

import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

type ApiEvent = APIGatewayProxyEventV2;
type ApiResult = APIGatewayProxyResultV2;

const ddb = new DynamoDBClient({});
const EMAILS_TABLE = process.env.EMAILS_TABLE_NAME!;

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

// ---------------------------------------------------------------------------
// GET /settings
// ---------------------------------------------------------------------------

export async function handleGetSettings(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const res = await ddb.send(new GetItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({ PK: `USER#${userId}`, SK: 'SETTINGS' }),
    ProjectionExpression: 'settingsBlob, lastUpdatedAt, #version',
    ExpressionAttributeNames: { '#version': 'version' },
  }));

  if (!res.Item) {
    // No settings yet - return empty
    return json(200, {
      settingsBlob: null,
      lastUpdatedAt: null,
      version: 0,
    });
  }

  const item = unmarshall(res.Item);
  return json(200, {
    settingsBlob: item.settingsBlob as string,
    lastUpdatedAt: item.lastUpdatedAt as string,
    version: item.version as number,
  });
}

// ---------------------------------------------------------------------------
// PUT /settings
// ---------------------------------------------------------------------------

export async function handlePutSettings(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  let body: { settingsBlob?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const { settingsBlob } = body;
  if (!settingsBlob || typeof settingsBlob !== 'string') {
    return json(400, { error: 'settingsBlob is required and must be a string' });
  }

  // DynamoDB item limit is 400 KB; settings blob should be well under 100 KB
  const MAX_BLOB_BYTES = 100 * 1024;
  if (Buffer.byteLength(settingsBlob, 'utf8') > MAX_BLOB_BYTES) {
    return json(400, { error: 'settingsBlob too large (max 100 KB)' });
  }

  const now = new Date().toISOString();

  // Upsert with atomic version increment so clients can detect concurrent writes
  const res = await ddb.send(new UpdateItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({ PK: `USER#${userId}`, SK: 'SETTINGS' }),
    UpdateExpression: 'SET settingsBlob = :blob, lastUpdatedAt = :now, #v = if_not_exists(#v, :zero) + :one',
    ExpressionAttributeNames: { '#v': 'version' },
    ExpressionAttributeValues: marshall({
      ':blob': settingsBlob,
      ':now': now,
      ':zero': 0,
      ':one': 1,
    }),
    ReturnValues: 'UPDATED_NEW',
  }));

  const newVersion = unmarshall(res.Attributes ?? {}).version as number ?? 1;

  return json(200, {
    lastUpdatedAt: now,
    version: newVersion,
  });
}
