/**
 * Folder routes — all require JWT auth.
 *
 * GET    /folders/list — return all folder records with encrypted names + ordering
 * PUT    /folders/:folderId — create or update individual folder record
 * DELETE /folders/:folderId — delete individual folder record
 * PUT    /folders/ordering — update folder ordering (debounced on client)
 *
 * Folder names are RSA-encrypted so the server never sees them.
 * Ordering is stored separately as an array of IDs (no encryption needed).
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { ApiEvent, ApiResult } from '../types';
import { hasActiveMigration } from '../../migration/db-utils';

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
// GET /folders/list
// ---------------------------------------------------------------------------

/**
 * Return all folder records with encrypted names + ordering
 */
export async function handleGetFolderList(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  try {
    // Query all folder records
    const queryResult = await ddb.send(new QueryCommand({
      TableName: EMAILS_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: marshall({
        ':pk': `USER#${userId}`,
        ':sk': 'FOLDER#',
      }),
    }));

    const folders = (queryResult.Items ?? []).map(item => {
      const record = unmarshall(item);
      return {
        folderId: record.folderId,
        encryptedName: record.encryptedName,
        lastUpdatedAt: record.lastUpdatedAt,
        version: record.version,
      };
    });

    // Get folder ordering
    const orderingResult = await ddb.send(new GetItemCommand({
      TableName: EMAILS_TABLE,
      Key: marshall({
        PK: `USER#${userId}`,
        SK: 'FOLDER_ORDER#',
      }),
    }));

    const ordering = orderingResult.Item
      ? (unmarshall(orderingResult.Item).folderIds as string[])
      : [];

    return json(200, { folders, ordering });
  } catch (error) {
    console.error('[folders] Error getting folder list:', error);
    return json(500, { error: 'Failed to get folders' });
  }
}

// ---------------------------------------------------------------------------
// PUT /folders/:folderId
// ---------------------------------------------------------------------------

/**
 * Create or update individual folder record
 */
export async function handlePutFolder(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const folderId = event.pathParameters?.folderId;
  if (!folderId) return json(400, { error: 'Missing folderId' });

  let body: { encryptedName?: string };
  try {
    body = JSON.parse(event.body ?? '{}') as { encryptedName?: string };
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  if (!body.encryptedName || typeof body.encryptedName !== 'string') {
    return json(400, { error: 'Missing required field: encryptedName' });
  }

  const now = new Date().toISOString();

  try {
    await ddb.send(new PutItemCommand({
      TableName: EMAILS_TABLE,
      Item: marshall({
        PK: `USER#${userId}`,
        SK: `FOLDER#${folderId}`,
        folderId,
        encryptedName: body.encryptedName,
        lastUpdatedAt: now,
        version: 1, // TODO: Implement optimistic locking
      }),
    }));

    return { statusCode: 204 };
  } catch (error) {
    console.error('[folders] Error putting folder:', error);
    return json(500, { error: 'Failed to save folder' });
  }
}

// ---------------------------------------------------------------------------
// DELETE /folders/:folderId
// ---------------------------------------------------------------------------

/**
 * Delete individual folder record
 */
export async function handleDeleteFolder(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const folderId = event.pathParameters?.folderId;
  if (!folderId) return json(400, { error: 'Missing folderId' });

  // Prevent deletion of system folders
  const systemFolders = ['INBOX', 'SENT', 'DRAFTS', 'ARCHIVE', 'SPAM', 'TRASH'];
  if (systemFolders.includes(folderId)) {
    return json(400, { error: 'Cannot delete system folders' });
  }

  try {
    // Check if there's an active migration
    const migrationActive = await hasActiveMigration(userId);
    if (migrationActive) {
      return json(409, {
        error: 'Cannot delete folders during an active migration',
      });
    }

    // Check if folder is empty before deletion
    const emailsResult = await ddb.send(new QueryCommand({
      TableName: EMAILS_TABLE,
      IndexName: 'UserFolderIndex',
      KeyConditionExpression: 'userId = :userId AND folderId = :folderId',
      ExpressionAttributeValues: marshall({
        ':userId': userId,
        ':folderId': folderId,
      }),
      Limit: 1,
      ProjectionExpression: 'SK',
    }));

    if (emailsResult.Items && emailsResult.Items.length > 0) {
      return json(400, {
        error: 'Folder is not empty. Move all emails before deleting.',
      });
    }

    // Delete the folder record
    await ddb.send(new DeleteItemCommand({
      TableName: EMAILS_TABLE,
      Key: marshall({
        PK: `USER#${userId}`,
        SK: `FOLDER#${folderId}`,
      }),
    }));

    return { statusCode: 204 };
  } catch (error) {
    console.error('[folders] Error deleting folder:', error);
    return json(500, { error: 'Failed to delete folder' });
  }
}

// ---------------------------------------------------------------------------
// PUT /folders/ordering
// ---------------------------------------------------------------------------

/**
 * Update folder ordering (just IDs, no encryption needed).
 * 
 * This endpoint is called when the user reorders folders via drag-and-drop
 * or move up/down buttons. It's debounced on the client to avoid spamming
 * the server during rapid reordering.
 * 
 * Body: { folderIds: string[] }
 * 
 * Returns: 204 No Content on success
 */
export async function handlePutFolderOrdering(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  let body: { folderIds?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}') as { folderIds?: unknown };
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  if (!Array.isArray(body.folderIds) || body.folderIds.some(id => typeof id !== 'string')) {
    return json(400, { error: 'folderIds must be an array of strings' });
  }

  const now = new Date().toISOString();

  try {
    await ddb.send(new PutItemCommand({
      TableName: EMAILS_TABLE,
      Item: marshall({
        PK: `USER#${userId}`,
        SK: 'FOLDER_ORDER#',
        folderIds: body.folderIds,
        lastUpdatedAt: now,
        version: 1, // TODO: Implement optimistic locking
      }),
    }));

    return { statusCode: 204 };
  } catch (error) {
    console.error('[folders] Error saving folder ordering:', error);
    return json(500, { error: 'Failed to save folder ordering' });
  }
}
