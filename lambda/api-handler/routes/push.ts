/**
 * Push subscription routes — all require JWT auth.
 *
 * POST   /push/subscribe   — register or update a Web Push subscription for this device
 * DELETE /push/subscribe   — remove the push subscription for this device
 *
 * Push subscription items are stored in the emails DynamoDB table:
 *   PK: USER#<userId>   SK: PUSH#<deviceId>
 *   Attrs: endpoint, p256dh, auth, createdAt
 */

import { DynamoDBClient, PutItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { ApiEvent, ApiResult, PushSubscribeBody } from '../types';

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
  return event.requestContext.authorizer?.jwt?.claims?.['sub'] as string | undefined;
}

// ---------------------------------------------------------------------------
// POST /push/subscribe
// ---------------------------------------------------------------------------

export async function handlePushSubscribe(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  let body: Partial<PushSubscribeBody>;
  try {
    body = JSON.parse(event.body ?? '{}') as Partial<PushSubscribeBody>;
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const { deviceId, endpoint, p256dh, auth } = body;
  if (!deviceId || !endpoint || !p256dh || !auth) {
    return json(400, { error: 'Missing required fields: deviceId, endpoint, p256dh, auth' });
  }

  await ddb.send(new PutItemCommand({
    TableName: EMAILS_TABLE,
    Item: marshall({
      PK: `USER#${userId}`,
      SK: `PUSH#${deviceId}`,
      endpoint,
      p256dh,
      auth,
      createdAt: new Date().toISOString(),
    }),
  }));

  return { statusCode: 204 };
}

// ---------------------------------------------------------------------------
// DELETE /push/subscribe
// ---------------------------------------------------------------------------

export async function handlePushUnsubscribe(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  let body: Partial<Pick<PushSubscribeBody, 'deviceId'>>;
  try {
    body = JSON.parse(event.body ?? '{}') as Partial<Pick<PushSubscribeBody, 'deviceId'>>;
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  if (!body.deviceId) return json(400, { error: 'Missing deviceId' });

  await ddb.send(new DeleteItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({ PK: `USER#${userId}`, SK: `PUSH#${body.deviceId}` }),
  }));

  return { statusCode: 204 };
}
