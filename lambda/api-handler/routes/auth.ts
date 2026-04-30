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
  AdminDeleteUserCommand,
  AdminSetUserMFAPreferenceCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { createHash } from 'crypto';
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
const RECOVERY_USER_POOL_ID = process.env.RECOVERY_USER_POOL_ID!;
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

  const { inviteCode, username, email, publicKey, encryptedPrivateKey, argon2Salt, password, recoveryEncryptedPrivateKey, cognitoRecoveryPassword } = body;
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

  // ── 5. Create recovery Cognito user if recovery key was provided (best-effort) ──
  let recoveryBlob: string | undefined;
  if (recoveryEncryptedPrivateKey && cognitoRecoveryPassword) {
    try {
      await cognito.send(new AdminCreateUserCommand({
        UserPoolId: RECOVERY_USER_POOL_ID,
        Username: username,
        MessageAction: 'SUPPRESS',
        TemporaryPassword: cognitoRecoveryPassword,
      }));
      await cognito.send(new AdminSetUserPasswordCommand({
        UserPoolId: RECOVERY_USER_POOL_ID,
        Username: username,
        Password: cognitoRecoveryPassword,
        Permanent: true,
      }));
      recoveryBlob = recoveryEncryptedPrivateKey;
    } catch (err) {
      console.warn('[register] recovery user creation failed (non-fatal):', err);
    }
  }

  // ── 6. Persist user record ─────────────────────────────────────────────────
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
      ...(recoveryBlob ? { recoveryEncryptedPrivateKey: recoveryBlob } : {}),
    }),
    // Guard against duplicate registrations for the same Cognito sub
    ConditionExpression: 'attribute_not_exists(userId)',
  }));

  // ── 7. Create per-user SNS notification topic (best-effort) ───────────────
  try {
    await sns.send(new CreateTopicCommand({ Name: `chase-email-new-${userId}` }));
  } catch (snsErr) {
    console.warn('[register] SNS topic creation failed (non-fatal):', snsErr);
  }

  // ── 8. Mark invite as used (remove expiresAt so TTL doesn't erase the audit record) ──
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
    ProjectionExpression: 'encryptedPrivateKey, argon2Salt, publicKey, email, isAdmin, recoveryEncryptedPrivateKey',
  }));
  if (!res.Item) return json(404, { error: 'User not found' });

  const { encryptedPrivateKey, argon2Salt, publicKey, email, isAdmin, recoveryEncryptedPrivateKey } = unmarshall(res.Item);
  return json(200, {
    encryptedPrivateKey,
    argon2Salt,
    publicKey,
    email,
    isAdmin: isAdmin === true,
    hasRecoveryKey: !!recoveryEncryptedPrivateKey,
  });
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

/**
 * PUT /auth/recovery-key  (JWT required)
 *
 * Creates a {username}__recovery Cognito user and stores the recovery-encrypted
 * private key blob. One-time write: fails with 409 if already set.
 *
 * Body: { recoveryEncryptedPrivateKey: string, cognitoRecoveryPassword: string }
 */
export async function handleStoreRecoveryKey(event: ApiEvent): Promise<ApiResult> {
  // @ts-expect-error - authorizer is added by API Gateway JWT authorizer at runtime
  const userId = event.requestContext.authorizer?.jwt?.claims?.['sub'] as string | undefined;
  if (!userId) return json(401, { error: 'Unauthorized' });

  let body: { recoveryEncryptedPrivateKey?: unknown; cognitoRecoveryPassword?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}') as typeof body;
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { recoveryEncryptedPrivateKey, cognitoRecoveryPassword } = body;
  if (typeof recoveryEncryptedPrivateKey !== 'string' || !recoveryEncryptedPrivateKey) {
    return json(400, { error: 'recoveryEncryptedPrivateKey is required' });
  }
  if (typeof cognitoRecoveryPassword !== 'string' || !cognitoRecoveryPassword) {
    return json(400, { error: 'cognitoRecoveryPassword is required' });
  }

  // Look up the username (needed to form the recovery Cognito username)
  const userRes = await ddb.send(new GetItemCommand({
    TableName: USERS_TABLE,
    Key: marshall({ userId }),
    ProjectionExpression: 'username',
  }));
  if (!userRes.Item) return json(404, { error: 'User not found' });
  const { username } = unmarshall(userRes.Item) as { username: string };

  // Create the recovery Cognito user in the recovery pool (existence = recovery key is set)
  try {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: RECOVERY_USER_POOL_ID,
      Username: username,
      MessageAction: 'SUPPRESS',
      TemporaryPassword: cognitoRecoveryPassword,
    }));
    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: RECOVERY_USER_POOL_ID,
      Username: username,
      Password: cognitoRecoveryPassword,
      Permanent: true,
    }));
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'UsernameExistsException') {
      return json(409, { error: 'A recovery key is already set for this account.' });
    }
    throw err;
  }

  // Store the blob in DDB (one-time write condition as a safety net)
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: USERS_TABLE,
      Key: marshall({ userId }),
      UpdateExpression: 'SET recoveryEncryptedPrivateKey = :blob',
      ConditionExpression: 'attribute_exists(userId) AND attribute_not_exists(recoveryEncryptedPrivateKey)',
      ExpressionAttributeValues: marshall({ ':blob': recoveryEncryptedPrivateKey }),
    }));
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // DDB already had the blob but Cognito user was just created — clean up
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: RECOVERY_USER_POOL_ID, Username: username })).catch(() => {});
      return json(409, { error: 'A recovery key is already set for this account.' });
    }
    throw err;
  }

  console.log(`[recovery-key] stored for userId=${userId}`);
  return { statusCode: 204, body: '' };
}

// ---------------------------------------------------------------------------
// Recovery flow — authenticated via the {username}__recovery Cognito user
// ---------------------------------------------------------------------------

/** Resolve the main user's DynamoDB userId from their Cognito username. */
async function resolveUserId(mainUsername: string): Promise<string | null> {
  try {
    const res = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: mainUsername }));
    return res.UserAttributes?.find(a => a.Name === 'sub')?.Value ?? null;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'UserNotFoundException') return null;
    throw err;
  }
}

/**
 * GET /auth/recover/bundle  (JWT from {username}__recovery Cognito user required)
 *
 * Returns the recovery-encrypted private key blob so the client can decrypt it
 * locally and re-encrypt with a new password.
 */
export async function handleFetchRecoveryBundle(event: ApiEvent): Promise<ApiResult> {
  // @ts-expect-error - authorizer is added by API Gateway JWT authorizer at runtime
  const mainUsername = event.requestContext.authorizer?.jwt?.claims?.['username'] as string | undefined;
  if (!mainUsername) return json(401, { error: 'Unauthorized' });

  const userId = await resolveUserId(mainUsername);
  if (!userId) return json(404, { error: 'User not found' });

  const res = await ddb.send(new GetItemCommand({
    TableName: USERS_TABLE,
    Key: marshall({ userId }),
    ProjectionExpression: 'recoveryEncryptedPrivateKey',
  }));
  if (!res.Item) return json(404, { error: 'User not found' });

  const { recoveryEncryptedPrivateKey } = unmarshall(res.Item);
  if (!recoveryEncryptedPrivateKey) return json(404, { error: 'No recovery key set for this account' });

  return json(200, { recoveryEncryptedPrivateKey });
}

/**
 * POST /auth/recover/rekey  (JWT from {username}__recovery Cognito user required)
 *
 * Resets the main account's Cognito password and updates the encrypted private
 * key in DynamoDB. Deletes the recovery Cognito user on success so the old
 * recovery key is invalidated and hasRecoveryKey goes back to false.
 *
 * Body: { newPassword, newEncryptedPrivateKey, newArgon2Salt }
 */
export async function handleRekeyAccount(event: ApiEvent): Promise<ApiResult> {
  // @ts-expect-error - authorizer is added by API Gateway JWT authorizer at runtime
  const mainUsername = event.requestContext.authorizer?.jwt?.claims?.['username'] as string | undefined;
  if (!mainUsername) return json(401, { error: 'Unauthorized' });

  let body: { newPassword?: unknown; newEncryptedPrivateKey?: unknown; newArgon2Salt?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}') as typeof body;
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { newPassword, newEncryptedPrivateKey, newArgon2Salt } = body;
  if (typeof newPassword !== 'string' || !newPassword) return json(400, { error: 'newPassword is required' });
  if (typeof newEncryptedPrivateKey !== 'string' || !newEncryptedPrivateKey) return json(400, { error: 'newEncryptedPrivateKey is required' });
  if (typeof newArgon2Salt !== 'string' || !newArgon2Salt) return json(400, { error: 'newArgon2Salt is required' });

  const userId = await resolveUserId(mainUsername);
  if (!userId) return json(404, { error: 'User not found' });

  // Reset the main account's Cognito password
  try {
    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: USER_POOL_ID,
      Username: mainUsername,
      Password: newPassword,
      Permanent: true,
    }));
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'InvalidPasswordException') {
      return json(400, { error: (err as Error).message });
    }
    throw err;
  }

  // Update the encrypted private key and clear the recovery blob from DynamoDB
  await ddb.send(new UpdateItemCommand({
    TableName: USERS_TABLE,
    Key: marshall({ userId }),
    UpdateExpression: 'SET encryptedPrivateKey = :key, argon2Salt = :salt REMOVE recoveryEncryptedPrivateKey',
    ExpressionAttributeValues: marshall({ ':key': newEncryptedPrivateKey, ':salt': newArgon2Salt }),
  }));

  // Delete the recovery Cognito user — invalidates the old recovery key
  await cognito.send(new AdminDeleteUserCommand({ UserPoolId: RECOVERY_USER_POOL_ID, Username: mainUsername }));

  console.log(`[recover/rekey] password reset for userId=${userId}`);
  return { statusCode: 204, body: '' };
}

/**
 * POST /auth/recover/mfa  (no JWT — user is locked out of their authenticator)
 *
 * Validates a backup recovery code, disables TOTP for the account, and burns
 * the used code so it can't be reused.
 *
 * Body: { username, recoveryCode }
 */
export async function handleRecoverMfa(event: ApiEvent): Promise<ApiResult> {
  let body: { username?: unknown; recoveryCode?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}') as typeof body;
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { username, recoveryCode } = body;
  if (typeof username !== 'string' || !username) return json(400, { error: 'username is required' });
  if (typeof recoveryCode !== 'string' || !recoveryCode) return json(400, { error: 'recoveryCode is required' });

  const userId = await resolveUserId(username);
  if (!userId) return json(404, { error: 'User not found' });

  const res = await ddb.send(new GetItemCommand({
    TableName: USERS_TABLE,
    Key: marshall({ userId }),
    ProjectionExpression: 'recoveryCodeHashes',
  }));
  if (!res.Item) return json(404, { error: 'User not found' });

  const { recoveryCodeHashes } = unmarshall(res.Item) as { recoveryCodeHashes?: string[] };
  if (!recoveryCodeHashes?.length) return json(404, { error: 'No recovery codes set for this account' });

  const submittedHash = createHash('sha256').update(recoveryCode.toLowerCase()).digest('hex');
  if (!recoveryCodeHashes.includes(submittedHash)) return json(401, { error: 'Invalid recovery code' });

  // Burn the used code
  const remaining = recoveryCodeHashes.filter(h => h !== submittedHash);
  await ddb.send(new UpdateItemCommand({
    TableName: USERS_TABLE,
    Key: marshall({ userId }),
    UpdateExpression: 'SET recoveryCodeHashes = :remaining',
    ExpressionAttributeValues: marshall({ ':remaining': remaining }),
  }));

  // Disable TOTP so the next login attempt doesn't require a code
  await cognito.send(new AdminSetUserMFAPreferenceCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
    SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
  }));

  console.log(`[recover/mfa] TOTP disabled for userId=${userId}, ${remaining.length} codes remaining`);
  return { statusCode: 204, body: '' };
}
