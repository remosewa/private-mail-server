/**
 * Admin routes — restricted to users with isAdmin: true in chase-users.
 *
 * GET    /admin/users                  — list all registered users
 * POST   /admin/invites                — create an invite code with audit fields
 * GET    /admin/invites                — list all invite codes
 * DELETE /admin/invites/{inviteCode}   — invalidate (soft-delete) an invite code
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { randomUUID } from 'crypto';
import type { ApiEvent, ApiResult } from '../types';

const ddb = new DynamoDBClient({});

const USERS_TABLE   = process.env.USERS_TABLE_NAME!;
const INVITES_TABLE = process.env.INVITES_TABLE_NAME!;

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
 * Verify the caller is an admin. Returns the user record if admin, null otherwise.
 */
async function requireAdmin(userId: string): Promise<Record<string, unknown> | null> {
  const res = await ddb.send(new GetItemCommand({
    TableName: USERS_TABLE,
    Key: marshall({ userId }),
    ProjectionExpression: 'userId, email, isAdmin',
  }));
  if (!res.Item) return null;
  const user = unmarshall(res.Item);
  return user['isAdmin'] === true ? user : null;
}

// ---------------------------------------------------------------------------
// GET /admin/users
// ---------------------------------------------------------------------------

export async function handleAdminListUsers(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const admin = await requireAdmin(userId);
  if (!admin) return json(403, { error: 'Forbidden' });

  const results: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(new ScanCommand({
      TableName: USERS_TABLE,
      ProjectionExpression: 'userId, email, username, createdAt, isAdmin',
      ExclusiveStartKey: lastKey ? marshall(lastKey) : undefined,
    }));
    for (const item of res.Items ?? []) {
      results.push(unmarshall(item));
    }
    lastKey = res.LastEvaluatedKey ? unmarshall(res.LastEvaluatedKey) : undefined;
  } while (lastKey);

  return json(200, { users: results });
}

// ---------------------------------------------------------------------------
// POST /admin/invites
// ---------------------------------------------------------------------------

export async function handleAdminCreateInvite(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const admin = await requireAdmin(userId);
  if (!admin) return json(403, { error: 'Forbidden' });

  let body: { expiresInDays?: number; note?: string };
  try {
    body = JSON.parse(event.body ?? '{}') as { expiresInDays?: number; note?: string };
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const expiresInDays = body.expiresInDays ?? 30;
  const inviteCode    = randomUUID();
  const now           = new Date();
  const expiresAt     = Math.floor(now.getTime() / 1000) + expiresInDays * 86400;

  const item: Record<string, unknown> = {
    inviteCode,
    createdAt:      now.toISOString(),
    createdBy:      userId,
    createdByEmail: admin['email'] as string,
    expiresAt,
  };
  if (body.note) item['note'] = body.note;

  await ddb.send(new PutItemCommand({
    TableName: INVITES_TABLE,
    Item: marshall(item),
    ConditionExpression: 'attribute_not_exists(inviteCode)',
  }));

  return json(201, { inviteCode, expiresAt });
}

// ---------------------------------------------------------------------------
// GET /admin/invites
// ---------------------------------------------------------------------------

export async function handleAdminListInvites(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const admin = await requireAdmin(userId);
  if (!admin) return json(403, { error: 'Forbidden' });

  const results: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(new ScanCommand({
      TableName: INVITES_TABLE,
      ExclusiveStartKey: lastKey ? marshall(lastKey) : undefined,
    }));
    for (const item of res.Items ?? []) {
      results.push(unmarshall(item));
    }
    lastKey = res.LastEvaluatedKey ? unmarshall(res.LastEvaluatedKey) : undefined;
  } while (lastKey);

  // Sort: unused first (by createdAt desc), used/invalidated last
  results.sort((a, b) => {
    const aUsed = !!(a['usedAt'] || a['invalidatedAt']);
    const bUsed = !!(b['usedAt'] || b['invalidatedAt']);
    if (aUsed !== bUsed) return aUsed ? 1 : -1;
    return ((b['createdAt'] as string) ?? '').localeCompare((a['createdAt'] as string) ?? '');
  });

  return json(200, { invites: results });
}

// ---------------------------------------------------------------------------
// DELETE /admin/invites/{inviteCode}
// ---------------------------------------------------------------------------

export async function handleAdminInvalidateInvite(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const admin = await requireAdmin(userId);
  if (!admin) return json(403, { error: 'Forbidden' });

  const inviteCode = event.pathParameters?.['inviteCode'];
  if (!inviteCode) return json(400, { error: 'Missing inviteCode' });

  // Soft-delete: set invalidatedAt + invalidatedBy, remove expiresAt so TTL won't clean it up
  await ddb.send(new UpdateItemCommand({
    TableName: INVITES_TABLE,
    Key: marshall({ inviteCode }),
    UpdateExpression: 'SET invalidatedAt = :ts, invalidatedBy = :uid REMOVE expiresAt',
    ExpressionAttributeValues: marshall({
      ':ts':  new Date().toISOString(),
      ':uid': userId,
    }),
    ConditionExpression: 'attribute_exists(inviteCode)',
  }));

  return { statusCode: 204, body: '' };
}
