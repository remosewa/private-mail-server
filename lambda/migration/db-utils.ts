/**
 * DynamoDB utility functions for IMAP migration
 * 
 * This module provides helper functions for storing and retrieving
 * migration credentials and state from DynamoDB.
 */

import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { ulid } from 'ulid';
import { createHash } from 'crypto';

import {
  IMAPCredentials,
  MigrationStatus,
  MigrationState,
  MigrationCredentialsItem,
  MigrationStateItem,
  MIGRATION_SK,
  TTL_DURATION,
} from './types';

const ddb = new DynamoDBClient({});
const EMAILS_TABLE = process.env.EMAILS_TABLE_NAME || 'chase-emails';

// ============================================================================
// Hashing Utilities
// ============================================================================

/**
 * Generate deterministic folder/label ID from name and secret UUID
 * 
 * Uses SHA-256 to create a secure, deterministic hash that:
 * - Cannot be reversed to reveal the original name
 * - Is consistent for the same name + secretUUID combination
 * - Is unique across different migrations (different secretUUIDs)
 * 
 * CRITICAL: The secretUUID must never be logged or exposed
 * 
 * @param name - Folder or label name (plain text)
 * @param secretUUID - Secret UUID from migration record
 * @returns Base64url-encoded hash (12 characters, safe for use as ID)
 */
export function hashFolderOrLabelName(name: string, secretUUID: string): string {
  const hash = createHash('sha256')
    .update(`${secretUUID}:${name}`)
    .digest();
  
  // Take first 9 bytes and encode as base64url (12 characters)
  return hash.subarray(0, 9).toString('base64url');
}

// ============================================================================
// Credentials Management
// ============================================================================

/**
 * Store IMAP credentials in DynamoDB with 7-day TTL
 * 
 * @param userId - User ID
 * @param credentials - IMAP credentials
 * @throws Error if credentials already exist (concurrent migration)
 */
export async function storeCredentials(
  userId: string,
  credentials: IMAPCredentials
): Promise<void> {
  const item: MigrationCredentialsItem = {
    PK: `USER#${userId}`,
    SK: MIGRATION_SK.CREDENTIALS,
    ...credentials,
    ttl: Math.floor(Date.now() / 1000) + TTL_DURATION.CREDENTIALS,
    createdAt: new Date().toISOString(),
  };

  try {
    await ddb.send(new PutItemCommand({
      TableName: EMAILS_TABLE,
      Item: marshall(item),
      // Prevent overwriting if credentials already exist
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      throw new Error('Migration already in progress for this user');
    }
    throw error;
  }
}

/**
 * Retrieve IMAP credentials from DynamoDB
 * 
 * @param userId - User ID
 * @returns IMAP credentials or null if not found
 */
export async function getCredentials(
  userId: string
): Promise<IMAPCredentials | null> {
  const result = await ddb.send(new GetItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({
      PK: `USER#${userId}`,
      SK: MIGRATION_SK.CREDENTIALS,
    }),
  }));

  if (!result.Item) {
    return null;
  }

  const item = unmarshall(result.Item) as MigrationCredentialsItem;

  // Return only the credential fields
  return {
    server: item.server,
    port: item.port,
    username: item.username,
    password: item.password,
    useTLS: item.useTLS,
  };
}

/**
 * Delete IMAP credentials from DynamoDB
 * 
 * Called when migration completes or is cancelled.
 * 
 * @param userId - User ID
 */
export async function deleteCredentials(userId: string): Promise<void> {
  await ddb.send(new DeleteItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({
      PK: `USER#${userId}`,
      SK: MIGRATION_SK.CREDENTIALS,
    }),
  }));
}

// ============================================================================
// Migration State Management
// ============================================================================

/**
 * Initialize migration state in DynamoDB
 * 
 * @param userId - User ID
 * @param folders - List of IMAP folders to migrate (for IMAP migration)
 * @returns Migration ID (ULID)
 * @throws Error if migration already in progress
 */
export async function initializeMigrationState(
  userId: string,
  folders: string[]
): Promise<string> {
  const migrationId = ulid();

  const item: MigrationStateItem = {
    PK: `USER#${userId}`,
    SK: MIGRATION_SK.STATE,
    migrationId,
    state: 'validating',
    totalMessages: 0,
    processedMessages: 0,
    errorCount: 0,
    folders,
    currentFolderIndex: 0,
    lastFetchUID: '',
    startedAt: new Date().toISOString(),
  };

  try {
    await ddb.send(new PutItemCommand({
      TableName: EMAILS_TABLE,
      Item: marshall(item),
      // Allow new migration only if no state exists OR existing state is terminal
      ConditionExpression: 'attribute_not_exists(PK) OR #state IN (:completed, :failed)',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: marshall({
        ':completed': 'completed',
        ':failed': 'failed',
      }),
    }));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      throw new Error('Migration already in progress for this user');
    }
    throw error;
  }

  return migrationId;
}

/**
* Initialize mbox migration state in DynamoDB
*
* @param userId - User ID
* @param migrationName - User-provided name for this migration
* @returns Migration ID (ULID)
* @throws Error if migration already in progress
*/
export async function initializeMboxMigrationState(
  userId: string,
  migrationName: string
): Promise<string> {
  const migrationId = ulid();
  
  // Generate secret UUID for deterministic folder/label hashing
  // CRITICAL: Never log this value
  const secretUUID = crypto.randomUUID();

  const item: MigrationStateItem = {
    PK: `USER#${userId}`,
    SK: MIGRATION_SK.STATE,
    migrationId,
    migrationName,
    secretUUID,
    state: 'uploading',
    totalMessages: 0,
    processedMessages: 0,
    errorCount: 0,
    files: [],
    totalFiles: 0,
    processedFiles: 0,
    currentFileIndex: 0,
    startedAt: new Date().toISOString(),
  };

  try {
    await ddb.send(new PutItemCommand({
      TableName: EMAILS_TABLE,
      Item: marshall(item),
      // Allow new migration only if no state exists OR existing state is terminal
      ConditionExpression: 'attribute_not_exists(PK) OR #state IN (:completed, :failed)',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: marshall({
        ':completed': 'completed',
        ':failed': 'failed',
      }),
    }));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      throw new Error('Migration already in progress for this user');
    }
    throw error;
  }

  return migrationId;
}

/**
 * Get migration state from DynamoDB
 * 
 * @param userId - User ID
 * @returns Migration status or null if no migration exists
 */
export async function getMigrationState(
  userId: string
): Promise<MigrationStatus | null> {
  const result = await ddb.send(new GetItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({
      PK: `USER#${userId}`,
      SK: MIGRATION_SK.STATE,
    }),
  }));

  if (!result.Item) {
    return null;
  }

  const item = unmarshall(result.Item) as MigrationStateItem;

  // Return only the status fields (exclude PK, SK, ttl)
  return {
    migrationId: item.migrationId,
    migrationName: item.migrationName,
    secretUUID: item.secretUUID,
    state: item.state,
    totalMessages: item.totalMessages,
    processedMessages: item.processedMessages,
    errorCount: item.errorCount,
    folders: item.folders,
    currentFolderIndex: item.currentFolderIndex,
    lastFetchUID: item.lastFetchUID,
    files: item.files,
    totalFiles: item.totalFiles,
    processedFiles: item.processedFiles,
    currentFileIndex: item.currentFileIndex,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    errorMessage: item.errorMessage,
    lastUpdatedAt: item.lastUpdatedAt,
  };
}

/**
 * Update migration state
 * 
 * @param userId - User ID
 * @param state - New state
 */
export async function updateMigrationState(
  userId: string,
  state: MigrationState
): Promise<void> {
  const now = new Date().toISOString();

  await ddb.send(new UpdateItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({
      PK: `USER#${userId}`,
      SK: MIGRATION_SK.STATE,
    }),
    UpdateExpression: 'SET #state = :state, lastUpdatedAt = :now',
    ExpressionAttributeNames: { '#state': 'state' },
    ExpressionAttributeValues: marshall({
      ':state': state,
      ':now': now,
    }),
  }));
}

/**
 * Update migration progress after processing a batch
 * 
 * @param userId - User ID
 * @param processedCount - Number of messages processed in this batch
 * @param lastUID - Last IMAP UID processed (optional, only for IMAP migrations)
 * @param errorCount - Number of errors in this batch (default: 0)
 */
export async function updateMigrationProgress(
  userId: string,
  processedCount: number,
  lastUID: string = '',
  errorCount: number = 0
): Promise<void> {
  const updates: string[] = [
    'processedMessages = processedMessages + :processed',
  ];

  const values: Record<string, unknown> = {
    ':processed': processedCount,
  };

  // Only update lastFetchUID for IMAP migrations (when lastUID is provided)
  if (lastUID) {
    updates.push('lastFetchUID = :uid');
    values[':uid'] = lastUID;
  }

  if (errorCount > 0) {
    updates.push('errorCount = errorCount + :errors');
    values[':errors'] = errorCount;
  }

  await ddb.send(new UpdateItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({
      PK: `USER#${userId}`,
      SK: MIGRATION_SK.STATE,
    }),
    UpdateExpression: `SET ${updates.join(', ')}`,
    ExpressionAttributeValues: marshall(values),
  }));
}

/**
 * Update total message count after folder discovery
 * 
 * @param userId - User ID
 * @param totalMessages - Total messages across all folders
 */
export async function updateTotalMessages(
  userId: string,
  totalMessages: number
): Promise<void> {
  await ddb.send(new UpdateItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({
      PK: `USER#${userId}`,
      SK: MIGRATION_SK.STATE,
    }),
    UpdateExpression: 'SET totalMessages = :total',
    ExpressionAttributeValues: marshall({ ':total': totalMessages }),
  }));
}

/**
 * Move to next folder in migration
 * 
 * @param userId - User ID
 */
export async function moveToNextFolder(userId: string): Promise<void> {
  await ddb.send(new UpdateItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({
      PK: `USER#${userId}`,
      SK: MIGRATION_SK.STATE,
    }),
    UpdateExpression: 'SET currentFolderIndex = currentFolderIndex + :one, lastFetchUID = :empty',
    ExpressionAttributeValues: marshall({
      ':one': 1,
      ':empty': '',
    }),
  }));
}

/**
 * Update mbox file list after extraction
 * 
 * Sets state to 'indexing' while the indexer Lambdas scan files to count messages.
 * The indexers will transition to 'running' once scanning is complete.
 * 
 * @param userId - User ID
 * @param files - List of mbox filenames
 */
export async function updateMboxFileList(
  userId: string,
  files: string[]
): Promise<void> {
  const now = new Date().toISOString();

  await ddb.send(new UpdateItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({
      PK: `USER#${userId}`,
      SK: MIGRATION_SK.STATE,
    }),
    UpdateExpression: 'SET files = :files, totalFiles = :total, #state = :indexing, lastUpdatedAt = :now',
    ExpressionAttributeNames: { '#state': 'state' },
    ExpressionAttributeValues: marshall({
      ':files': files,
      ':total': files.length,
      ':indexing': 'indexing',
      ':now': now,
    }),
  }));
}

/**
 * Move to next file in mbox migration
 * 
 * Atomically increments both currentFileIndex and processedFiles,
 * and returns the new processedFiles count to enable race-free
 * completion detection.
 * 
 * @param userId - User ID
 * @returns New processedFiles count after increment
 */
export async function moveToNextFile(userId: string): Promise<number> {
  const result = await ddb.send(new UpdateItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({
      PK: `USER#${userId}`,
      SK: MIGRATION_SK.STATE,
    }),
    UpdateExpression: 'SET currentFileIndex = currentFileIndex + :one, processedFiles = processedFiles + :one',
    ExpressionAttributeValues: marshall({
      ':one': 1,
    }),
    ReturnValues: 'ALL_NEW',
  }));

  if (!result.Attributes) {
    throw new Error('moveToNextFile: no attributes returned');
  }

  const updated = unmarshall(result.Attributes) as MigrationStateItem;
  return updated.processedFiles ?? 0;
}

/**
 * Delete migration state from DynamoDB
 * 
 * Called when migration is cancelled to allow the user to start a new migration.
 * In-flight workers will skip processing when they can't find the state.
 * 
 * @param userId - User ID
 */
export async function deleteMigrationState(userId: string): Promise<void> {
  await ddb.send(new DeleteItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({
      PK: `USER#${userId}`,
      SK: MIGRATION_SK.STATE,
    }),
  }));
}

/**
 * Complete migration successfully
 * 
 * Sets state to 'completed', records completion time, and sets 30-day TTL.
 * 
 * @param userId - User ID
 */
export async function completeMigration(userId: string): Promise<void> {
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + TTL_DURATION.COMPLETED_MIGRATION;

  await ddb.send(new UpdateItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({
      PK: `USER#${userId}`,
      SK: MIGRATION_SK.STATE,
    }),
    UpdateExpression: 'SET #state = :completed, completedAt = :now, #ttl = :ttl, lastUpdatedAt = :now',
    ExpressionAttributeNames: {
      '#state': 'state',
      '#ttl': 'ttl',
    },
    ExpressionAttributeValues: marshall({
      ':completed': 'completed',
      ':now': now,
      ':ttl': ttl,
    }),
  }));
}

/**
 * Fail migration with error message
 * 
 * Sets state to 'failed', records completion time and error, and sets 30-day TTL.
 * 
 * @param userId - User ID
 * @param errorMessage - Error description
 */
export async function failMigration(
  userId: string,
  errorMessage: string
): Promise<void> {
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + TTL_DURATION.COMPLETED_MIGRATION;

  await ddb.send(new UpdateItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({
      PK: `USER#${userId}`,
      SK: MIGRATION_SK.STATE,
    }),
    UpdateExpression: 'SET #state = :failed, completedAt = :now, errorMessage = :error, #ttl = :ttl, lastUpdatedAt = :now',
    ExpressionAttributeNames: {
      '#state': 'state',
      '#ttl': 'ttl',
    },
    ExpressionAttributeValues: marshall({
      ':failed': 'failed',
      ':now': now,
      ':error': errorMessage,
      ':ttl': ttl,
    }),
  }));
}

/**
 * Pause migration
 * 
 * Sets state to 'paused'. Migration can be resumed later.
 * 
 * @param userId - User ID
 */
export async function pauseMigration(userId: string): Promise<void> {
  await updateMigrationState(userId, 'paused');
}

/**
 * Resume migration
 * 
 * Sets state back to 'running'.
 * 
 * @param userId - User ID
 */
export async function resumeMigration(userId: string): Promise<void> {
  await updateMigrationState(userId, 'running');
}

/**
 * Cancel migration
 * 
 * Deletes credentials and marks migration as failed with cancellation message.
 * 
 * @param userId - User ID
 */
export async function cancelMigration(userId: string): Promise<void> {
  // Delete credentials first
  await deleteCredentials(userId);

  // Mark as failed with cancellation message
  await failMigration(userId, 'Migration cancelled by user');
}

// ============================================================================
// Query Helpers
// ============================================================================

/**
 * Check if user has an active migration
 * 
 * @param userId - User ID
 * @returns True if migration is in progress (validating, running, or paused)
 */
export async function hasActiveMigration(userId: string): Promise<boolean> {
  const state = await getMigrationState(userId);

  if (!state) {
    return false;
  }

  return state.state === 'validating' ||
    state.state === 'running' ||
    state.state === 'paused';
}

/**
 * Check if user has an incomplete migration (running or paused)
 * 
 * Used on app restart to detect migrations that can be resumed.
 * 
 * @param userId - User ID
 * @returns Migration status if incomplete, null otherwise
 */
export async function getIncompleteMigration(
  userId: string
): Promise<MigrationStatus | null> {
  const state = await getMigrationState(userId);

  if (!state) {
    return null;
  }

  if (state.state === 'running' || state.state === 'paused') {
    return state;
  }

  return null;
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate migration state consistency
 * 
 * Checks for common inconsistencies and logs warnings.
 * Does not throw errors - allows self-correction.
 * 
 * @param state - Migration state to validate
 */
export function validateMigrationState(state: MigrationStatus): void {
  // Check processed <= total
  if (state.processedMessages > state.totalMessages && state.totalMessages > 0) {
    console.warn('Migration state inconsistency: processedMessages > totalMessages', {
      userId: state.migrationId,
      processed: state.processedMessages,
      total: state.totalMessages,
    });
  }

  // Check folder index in bounds (IMAP migration)
  if (state.folders && state.currentFolderIndex !== undefined && state.currentFolderIndex >= state.folders.length) {
    console.warn('Migration state inconsistency: currentFolderIndex out of bounds', {
      userId: state.migrationId,
      index: state.currentFolderIndex,
      folderCount: state.folders.length,
    });
  }

  // Check file index in bounds (mbox migration)
  if (state.files && state.currentFileIndex !== undefined && state.currentFileIndex >= state.files.length) {
    console.warn('Migration state inconsistency: currentFileIndex out of bounds', {
      userId: state.migrationId,
      index: state.currentFileIndex,
      fileCount: state.files.length,
    });
  }

  // Check processed files <= total files (mbox migration)
  if (state.totalFiles !== undefined && state.processedFiles !== undefined && state.processedFiles > state.totalFiles) {
    console.warn('Migration state inconsistency: processedFiles > totalFiles', {
      userId: state.migrationId,
      processed: state.processedFiles,
      total: state.totalFiles,
    });
  }

  // Check error count is non-negative
  if (state.errorCount < 0) {
    console.warn('Migration state inconsistency: negative errorCount', {
      userId: state.migrationId,
      errorCount: state.errorCount,
    });
  }
}

// ============================================================================
// Folder and Label Management
// ============================================================================

/**
 * Create or update a folder record with encrypted name
 * 
 * During migration, when a new folder is encountered:
 * 1. Hash the folder name with secretUUID to get deterministic ID
 * 2. Encrypt the folder name with user's public key
 * 3. Store as individual record with lastUpdatedAt and version
 * 
 * @param userId - User ID
 * @param folderId - Hashed folder ID (from hashFolderOrLabelName)
 * @param encryptedName - RSA-encrypted folder name (base64)
 * @param publicKeyPem - User's public key in PEM format
 */
export async function createOrUpdateFolder(
  userId: string,
  folderId: string,
  encryptedName: string
): Promise<void> {
  const now = new Date().toISOString();
  
  await ddb.send(new PutItemCommand({
    TableName: EMAILS_TABLE,
    Item: marshall({
      PK: `USER#${userId}`,
      SK: `FOLDER#${folderId}`,
      folderId,
      encryptedName,
      lastUpdatedAt: now,
      version: 1,
    }),
  }));
}

/**
 * Create or update a label record with encrypted name
 * 
 * During migration, when a new label is encountered:
 * 1. Hash the label name with secretUUID to get deterministic ID
 * 2. Encrypt the label name with user's public key
 * 3. Store as individual record with lastUpdatedAt and version
 * 
 * @param userId - User ID
 * @param labelId - Hashed label ID (from hashFolderOrLabelName)
 * @param encryptedName - RSA-encrypted label name (base64)
 * @param color - Label color (default: gray)
 */
export async function createOrUpdateLabel(
  userId: string,
  labelId: string,
  encryptedName: string,
  color: string = '#6B7280'
): Promise<void> {
  const now = new Date().toISOString();
  
  await ddb.send(new PutItemCommand({
    TableName: EMAILS_TABLE,
    Item: marshall({
      PK: `USER#${userId}`,
      SK: `LABEL#${labelId}`,
      labelId,
      encryptedName,
      color,
      lastUpdatedAt: now,
      version: 1,
    }),
  }));
}

/**
 * Update folder ordering record
 * 
 * Stores the ordering of all folders as a simple array of IDs.
 * No encryption needed since it's just IDs (which are already hashed).
 * 
 * @param userId - User ID
 * @param folderIds - Ordered array of folder IDs
 */
export async function updateFolderOrdering(
  userId: string,
  folderIds: string[]
): Promise<void> {
  const now = new Date().toISOString();
  
  await ddb.send(new PutItemCommand({
    TableName: EMAILS_TABLE,
    Item: marshall({
      PK: `USER#${userId}`,
      SK: 'FOLDER_ORDER#',
      folderIds,
      lastUpdatedAt: now,
      version: 1,
    }),
  }));
}

/**
 * Get user's public key from USERS_TABLE
 * 
 * @param userId - User ID
 * @returns Public key in PEM format
 */
export async function getUserPublicKey(userId: string): Promise<string> {
  const USERS_TABLE = process.env.USERS_TABLE_NAME || 'chase-users';
  
  const result = await ddb.send(new GetItemCommand({
    TableName: USERS_TABLE,
    Key: marshall({ userId }),
    ProjectionExpression: 'publicKey',
  }));
  
  if (!result.Item) {
    throw new Error(`User not found: ${userId}`);
  }
  
  const { publicKey } = unmarshall(result.Item);
  return publicKey as string;
}

/**
 * Encrypt a folder or label name with user's public key
 * 
 * Uses hybrid encryption (AES-256-GCM + RSA-OAEP) matching the rest of the system.
 * For short strings like folder names, we use version 1 (no gzip compression).
 * 
 * Wire format v1:
 *   1 byte   — version = 0x01
 *   2 bytes  — encKeyLen (uint16 big-endian)
 *   N bytes  — RSA-OAEP/SHA-256 encrypted AES-256 key
 *  12 bytes  — AES-GCM IV
 *  16 bytes  — AES-GCM auth tag
 *   M bytes  — AES-GCM ciphertext (NOT gzip-compressed)
 * 
 * @param plaintext - Folder or label name
 * @param publicKeyPem - User's public key in PEM format
 * @returns Base64-encoded encrypted blob
 */
export async function encryptName(plaintext: string, publicKeyPem: string): Promise<string> {
  const crypto = await import('crypto');
  const forge = await import('node-forge');
  
  const BLOB_VERSION = 0x01; // v1 = no gzip compression
  
  // Convert plaintext to buffer (no gzip compression for short strings)
  const plaintextBuffer = Buffer.from(plaintext, 'utf8');
  
  // Generate random AES key and IV
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  
  // Encrypt plaintext with AES-256-GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  
  // Wrap AES key with RSA-OAEP
  const rsaPub = forge.pki.publicKeyFromPem(publicKeyPem);
  const encKeyBinary = rsaPub.encrypt(aesKey.toString('binary'), 'RSA-OAEP', {
    md: forge.md.sha256.create(),
    mgf1: { md: forge.md.sha256.create() },
  });
  const encKey = Buffer.from(encKeyBinary, 'binary');
  
  // Build wire format
  const encKeyLen = Buffer.allocUnsafe(2);
  encKeyLen.writeUInt16BE(encKey.length);
  
  const encrypted = Buffer.concat([
    Buffer.from([BLOB_VERSION]),
    encKeyLen,
    encKey,
    iv,
    authTag,
    ciphertext,
  ]);
  
  return encrypted.toString('base64');
}
