/**
 * Auth routes
 *
 * POST /auth/register  — invite-gated user registration (no JWT required)
 * GET  /auth/key-bundle — return encrypted key bundle for new-device login (JWT required)
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { SNSClient, CreateTopicCommand } from '@aws-sdk/client-sns';
import type { ApiEvent, ApiResult, RegisterBody } from '../types';

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

const ddb = new DynamoDBClient({});
const cognito = new CognitoIdentityProviderClient({});
const sns = new SNSClient({});

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const USERS_TABLE = process.env.USERS_TABLE_NAME!;
const INVITES_TABLE = process.env.INVITES_TABLE_NAME!;
const USER_POOL_ID = process.env.USER_POOL_ID!;
const SNS_TOPIC_ARN_PREFIX = process.env.SNS_TOPIC_ARN_PREFIX!;

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

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * POST /auth/register
 *
 * 1. Validate invite code (DynamoDB).
 * 2. Create Cognito user + set permanent password.
 * 3. Store user record (public key, encrypted private key, argon2 salt).
 * 4. Create per-user SNS notification topic.
 * 5. Mark invite as used.
 */
export async function handleRegister(event: ApiEvent): Promise<ApiResult> {
  let body: Partial<RegisterBody>;
  try {
    body = JSON.parse(event.body ?? '{}') as Partial<RegisterBody>;
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { inviteCode, username, email, publicKey, encryptedPrivateKey, argon2Salt, password } = body;
  if (!inviteCode || !username || !email || !publicKey || !encryptedPrivateKey || !argon2Salt || !password) {
    return json(400, { error: 'Missing required fields: inviteCode, username, email, publicKey, encryptedPrivateKey, argon2Salt, password' });
  }

  // ── 1. Validate invite ────────────────────────────────────────────────────
  const inviteRes = await ddb.send(new GetItemCommand({
    TableName: INVITES_TABLE,
    Key: marshall({ inviteCode }),
  }));
  const invite = inviteRes.Item ? unmarshall(inviteRes.Item) : null;

  if (
    !invite ||
    invite['usedAt'] ||
    invite['invalidatedAt'] ||
    (invite['expiresAt'] && Date.now() > (invite['expiresAt'] as number) * 1000)
  ) {
    return json(403, { error: 'Invalid or expired invite code.' });
  }

  // ── 2. Create Cognito user ─────────────────────────────────────────────────
  try {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      MessageAction: 'SUPPRESS', // don't send a welcome email
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ],
      TemporaryPassword: password, // overridden to permanent below
    }));
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === 'UsernameExistsException') return json(409, { error: 'Username already exists.' });
    if (name === 'InvalidPasswordException') return json(400, { error: (err as Error).message });
    throw err;
  }

  // ── 3. Promote to permanent password (avoids FORCE_CHANGE_PASSWORD flow) ──
  try {
    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      Password: password,
      Permanent: true,
    }));
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'InvalidPasswordException') {
      return json(400, { error: (err as Error).message });
    }
    throw err;
  }

  // ── 4. Fetch Cognito sub — used as our stable userId everywhere ────────────
  const userAttrRes = await cognito.send(new AdminGetUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
  }));
  const userId = userAttrRes.UserAttributes?.find(a => a.Name === 'sub')?.Value;
  if (!userId) throw new Error('Cognito user created but sub attribute missing');

  // ── 5. Persist user record ─────────────────────────────────────────────────
  await ddb.send(new PutItemCommand({
    TableName: USERS_TABLE,
    Item: marshall({
      userId,
      email,
      username,
      publicKey,
      encryptedPrivateKey,
      argon2Salt,
      createdAt: new Date().toISOString(),
    }),
    // Guard against duplicate registrations for the same Cognito sub
    ConditionExpression: 'attribute_not_exists(userId)',
  }));

  // ── 6. Create per-user SNS notification topic (best-effort) ───────────────
  try {
    await sns.send(new CreateTopicCommand({ Name: `chase-email-new-${userId}` }));
  } catch (snsErr) {
    console.warn('[register] SNS topic creation failed (non-fatal):', snsErr);
  }

  // ── 7. Mark invite as used (remove expiresAt so TTL doesn't erase the audit record) ──
  await ddb.send(new UpdateItemCommand({
    TableName: INVITES_TABLE,
    Key: marshall({ inviteCode }),
    UpdateExpression: 'SET usedAt = :now, assignedUserId = :uid, assignedUserEmail = :email REMOVE expiresAt',
    ExpressionAttributeValues: marshall({
      ':now':   Math.floor(Date.now() / 1000),
      ':uid':   userId,
      ':email': email,
    }),
  }));

  console.log(`[register] OK userId=${userId} username=${username}`);
  return json(201, { userId });
}

/**
 * GET /auth/key-bundle  (JWT required)
 *
 * Returns the encrypted private key and Argon2 salt so a new device can
 * restore access to the mailbox after authenticating with Cognito.
 */
export async function handleKeyBundle(event: ApiEvent): Promise<ApiResult> {
      // @ts-expect-error - authorizer is added by API Gateway JWT authorizer at runtime
  const userId = event.requestContext.authorizer?.jwt?.claims?.['sub'] as string | undefined;
  if (!userId) return json(401, { error: 'Unauthorized' });

  const res = await ddb.send(new GetItemCommand({
    TableName: USERS_TABLE,
    Key: marshall({ userId }),
    ProjectionExpression: 'encryptedPrivateKey, argon2Salt, publicKey, email, isAdmin',
  }));
  if (!res.Item) return json(404, { error: 'User not found' });

  const { encryptedPrivateKey, argon2Salt, publicKey, email, isAdmin } = unmarshall(res.Item);
  return json(200, { encryptedPrivateKey, argon2Salt, publicKey, email, isAdmin: isAdmin === true });
}

/**
 * POST /auth/recovery-codes  (JWT required)
 *
 * Stores SHA-256 hashes of the user's recovery codes.
 * The plaintext codes are generated and shown client-side exactly once;
 * only hashes reach the server so the server never holds usable codes.
 *
 * Body: { codeHashes: string[] }   (hex-encoded SHA-256, 8 codes expected)
 */
export async function handleStoreRecoveryCodes(event: ApiEvent): Promise<ApiResult> {
      // @ts-expect-error - authorizer is added by API Gateway JWT authorizer at runtime
  const userId = event.requestContext.authorizer?.jwt?.claims?.['sub'] as string | undefined;
  if (!userId) return json(401, { error: 'Unauthorized' });

  let body: { codeHashes?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}') as { codeHashes?: unknown };
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { codeHashes } = body;
  if (
    !Array.isArray(codeHashes) ||
    codeHashes.length === 0 ||
    codeHashes.some(h => typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h))
  ) {
    return json(400, { error: 'codeHashes must be an array of 64-char hex SHA-256 strings' });
  }

  await ddb.send(new UpdateItemCommand({
    TableName: USERS_TABLE,
    Key: marshall({ userId }),
    UpdateExpression: 'SET recoveryCodeHashes = :hashes, recoveryCodesCreatedAt = :ts',
    ExpressionAttributeValues: marshall({
      ':hashes': codeHashes,
      ':ts':     new Date().toISOString(),
    }),
  }));

  console.log(`[recovery-codes] stored ${codeHashes.length} code hashes for userId=${userId}`);
  return { statusCode: 204, body: '' };
}
