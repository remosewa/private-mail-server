/**
 * Migration routes
 *
 * GET  /migration/upload-url  — presigned PUT URL for mbox zip upload
 * GET  /migration/status      — query migration progress
 * POST /migration/cancel      — cancel active migration
 *
 * Architecture
 * ────────────
 * The migration feature enables users to upload a zip file containing mbox archives
 * for one-time migration into the Chase Email system. The process is:
 * 
 * 1. Client requests upload URL (GET /migration/upload-url)
 * 2. Server generates presigned S3 URL and initializes migration state
 * 3. Client uploads zip file directly to S3
 * 4. S3 event triggers Unzip Lambda to extract mbox files
 * 5. S3 events trigger Parse Lambda for each mbox file
 * 6. Client polls status endpoint (GET /migration/status) for progress
 * 7. User can cancel at any time (POST /migration/cancel)
 */

import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ApiEvent, ApiResult } from '../types';
import {
  initializeMboxMigrationState,
  getMigrationState,
  failMigration,
  hasActiveMigration,
  deleteMigrationState,
} from '../../migration/db-utils';

const s3 = new S3Client({});

const UPLOAD_BUCKET = process.env.UPLOAD_BUCKET_NAME!;
const MBOX_BUCKET = process.env.MBOX_BUCKET_NAME!;

/** Presigned PUT URLs are valid for 1 hour. */
const UPLOAD_URL_TTL = 3600;

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
// GET /migration/upload-url
// ---------------------------------------------------------------------------

/**
 * Generate presigned S3 URL for zip file upload and initialize migration state.
 * 
 * Query parameters:
 * - name: Migration name (required, max 20 characters)
 * 
 * Returns:
 * - uploadUrl: Presigned S3 PUT URL for zip upload
 * - migrationId: Unique migration ID (ULID)
 * - expiresIn: URL expiration time in seconds
 * 
 * Errors:
 * - 400: Bad request (missing or invalid migration name)
 * - 401: Unauthorized (no JWT)
 * - 409: Conflict (migration already in progress)
 * - 500: Internal server error
 */
export async function handleGetUploadUrl(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  // Extract and validate migration name from query parameters
  const migrationName = event.queryStringParameters?.name?.trim();
  
  if (!migrationName) {
    return json(400, { error: 'Migration name is required' });
  }
  
  if (migrationName.length > 20) {
    return json(400, { error: 'Migration name must be 20 characters or less' });
  }
  
  if (!/^[a-zA-Z0-9\s\-_]+$/.test(migrationName)) {
    return json(400, { error: 'Migration name can only contain letters, numbers, spaces, hyphens, and underscores' });
  }

  try {
    // Check for existing active migration
    const hasActive = await hasActiveMigration(userId);
    if (hasActive) {
      return json(409, { error: 'Migration already in progress' });
    }

    // Initialize migration state with name
    const migrationId = await initializeMboxMigrationState(userId, migrationName);

    // Generate presigned URL for zip upload
    const s3Key = `uploads/${userId}/${migrationId}.zip`;
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: UPLOAD_BUCKET,
        Key: s3Key,
        ContentType: 'application/zip',
      }),
      { expiresIn: UPLOAD_URL_TTL },
    );

    return json(200, {
      uploadUrl,
      migrationId,
      expiresIn: UPLOAD_URL_TTL,
    });
  } catch (error) {
    console.error('[migration] Error generating upload URL:', error);
    return json(500, { error: 'Failed to generate upload URL' });
  }
}

// ---------------------------------------------------------------------------
// GET /migration/status
// ---------------------------------------------------------------------------

/**
 * Query migration state and calculate estimated completion time.
 * 
 * Returns:
 * - state: Current migration state
 * - totalFiles: Total mbox files to process
 * - processedFiles: Files processed so far
 * - totalMessages: Total messages to migrate
 * - processedMessages: Messages processed so far
 * - errorCount: Number of errors encountered
 * - currentFile: Current file being processed (optional)
 * - startedAt: ISO-8601 timestamp when migration started
 * - completedAt: ISO-8601 timestamp when migration completed (optional)
 * - estimatedCompletion: ISO-8601 estimated completion time (optional)
 * - errorMessage: Error description if failed (optional)
 * 
 * Errors:
 * - 401: Unauthorized (no JWT)
 * - 404: No migration found
 * - 500: Internal server error
 */
export async function handleGetStatus(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  try {
    const state = await getMigrationState(userId);
    
    if (!state) {
      return json(404, { error: 'No migration found' });
    }

    // Calculate estimated completion time based on processing rate
    let estimatedCompletion: string | undefined;
    if (state.state === 'running' && state.processedMessages > 0 && state.totalMessages > 0) {
      const elapsed = Date.now() - new Date(state.startedAt).getTime();
      const rate = state.processedMessages / elapsed; // messages per ms
      const remaining = state.totalMessages - state.processedMessages;
      
      if (remaining > 0 && rate > 0) {
        const estimatedMs = remaining / rate;
        estimatedCompletion = new Date(Date.now() + estimatedMs).toISOString();
      }
    }

    // Get current file name if available
    let currentFile: string | undefined;
    if (state.files && state.currentFileIndex !== undefined && state.currentFileIndex < state.files.length) {
      currentFile = state.files[state.currentFileIndex];
    }

    return json(200, {
      migrationId: state.migrationId,
      state: state.state,
      totalFiles: state.totalFiles || 0,
      processedFiles: state.processedFiles || 0,
      totalMessages: state.totalMessages,
      processedMessages: state.processedMessages,
      errorCount: state.errorCount,
      currentFile,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      estimatedCompletion,
      errorMessage: state.errorMessage,
    });
  } catch (error) {
    console.error('[migration] Error getting status:', error);
    return json(500, { error: 'Failed to get migration status' });
  }
}

// ---------------------------------------------------------------------------
// POST /migration/cancel
// ---------------------------------------------------------------------------

/**
 * Cancel active migration and trigger cleanup.
 * 
 * Deletes the migration state record to allow the user to start a new migration.
 * Any in-flight SQS messages will be ignored by workers when they check for
 * the migration state.
 * 
 * Also deletes all mbox files from S3 to free up storage.
 * 
 * Already-imported emails are preserved.
 * 
 * Returns:
 * - cancelled: true
 * - processedMessages: Number of messages processed before cancellation
 * - message: User-friendly confirmation message
 * 
 * Errors:
 * - 401: Unauthorized (no JWT)
 * - 404: No active migration found
 * - 500: Internal server error
 */
export async function handleCancelMigration(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  try {
    const state = await getMigrationState(userId);
    
    if (!state) {
      return json(404, { error: 'No migration found' });
    }

    // Only allow cancellation of active migrations
    if (state.state === 'completed' || state.state === 'failed') {
      return json(400, { error: 'Migration already completed or failed' });
    }

    const processedMessages = state.processedMessages;

    // Delete mbox files from S3 (best effort - don't fail if this errors)
    await deleteMigrationFiles(userId, state.migrationId);

    // Delete the migration state record to allow new migrations
    // This also causes in-flight workers to skip processing
    await deleteMigrationState(userId);

    return json(200, {
      cancelled: true,
      processedMessages,
      message: 'Migration cancelled. All migration files and records have been deleted. Processed messages have been preserved.',
    });
  } catch (error) {
    console.error('[migration] Error cancelling migration:', error);
    return json(500, { error: 'Failed to cancel migration' });
  }
}

// ---------------------------------------------------------------------------
// POST /migration/complete
// ---------------------------------------------------------------------------

/**
 * Delete all mbox files for a migration from S3.
 * 
 * Deletes all objects under the prefix: mbox/{userId}/{migrationId}/
 * 
 * Note: The original zip file (uploads/{userId}/{migrationId}.zip) is already
 * deleted by the unzip Lambda after extraction, so we only need to clean up
 * the extracted mbox files here.
 */
async function deleteMigrationFiles(userId: string, migrationId: string): Promise<void> {
  const prefix = `mbox/${userId}/${migrationId}/`;
  
  console.log(`[migration] Deleting S3 objects with prefix: ${prefix}`);
  
  try {
    // List all objects with the prefix
    const listResponse = await s3.send(new ListObjectsV2Command({
      Bucket: MBOX_BUCKET,
      Prefix: prefix,
    }));
    
    const objects = listResponse.Contents || [];
    
    if (objects.length === 0) {
      console.log(`[migration] No S3 objects found for prefix: ${prefix}`);
      return;
    }
    
    console.log(`[migration] Found ${objects.length} objects to delete`);
    
    // Delete objects in batches of 1000 (S3 limit)
    const batchSize = 1000;
    for (let i = 0; i < objects.length; i += batchSize) {
      const batch = objects.slice(i, i + batchSize);
      
      await s3.send(new DeleteObjectsCommand({
        Bucket: MBOX_BUCKET,
        Delete: {
          Objects: batch.map(obj => ({ Key: obj.Key! })),
          Quiet: true,
        },
      }));
      
      console.log(`[migration] Deleted batch of ${batch.length} objects`);
    }
    
    console.log(`[migration] Successfully deleted all ${objects.length} objects`);
  } catch (error) {
    console.error(`[migration] Error deleting S3 objects for prefix ${prefix}:`, error);
    // Don't throw - we still want to delete the DynamoDB record even if S3 cleanup fails
  }
}

/**
 * Complete migration and delete the migration record (including secretUUID).
 * 
 * This endpoint should be called after a migration successfully completes.
 * It permanently deletes the migration state record, which includes the
 * secretUUID used for hashing folder/label names.
 * 
 * Once deleted, the secretUUID is gone forever, making it impossible to
 * reverse the hashes back to original folder/label names.
 * 
 * Also deletes all mbox files from S3 to free up storage.
 * 
 * Returns:
 * - completed: true
 * - message: User-friendly confirmation message
 * 
 * Errors:
 * - 401: Unauthorized (no JWT)
 * - 404: No migration found
 * - 400: Migration not in completed state
 * - 500: Internal server error
 */
export async function handleCompleteMigration(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  try {
    const state = await getMigrationState(userId);
    
    if (!state) {
      return json(404, { error: 'No migration found' });
    }

    // Allow completion if migration is in 'completed'/'failed' state OR if all messages have been processed
    if (state.state !== 'completed' && state.state !== 'failed' &&
        !(state.state === 'running' && state.processedMessages >= state.totalMessages)) {
      return json(400, { 
        error: 'Migration must be completed or have all messages processed',
        currentState: state.state,
        progress: `${state.processedMessages}/${state.totalMessages}`
      });
    }

    // Delete mbox files from S3 (best effort - don't fail if this errors)
    await deleteMigrationFiles(userId, state.migrationId);

    // Delete the migration state record (including secretUUID)
    // This makes the hash irreversible
    await deleteMigrationState(userId);

    return json(200, {
      completed: true,
      message: 'Migration completed and cleaned up. All migration files and records have been permanently deleted.',
    });
  } catch (error) {
    console.error('[migration] Error completing migration:', error);
    return json(500, { error: 'Failed to complete migration' });
  }
}
