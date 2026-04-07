/**
 * Draft routes — client-encrypted drafts stored server-side.
 *
 * PUT    /drafts/{ulid}  — create or update a draft
 * DELETE /drafts/{ulid}  — hard-delete draft
 *
 * All five metadata blobs (header, body, text, embedding, attachments-meta) are encrypted
 * by the client with the per-email AES-256 key ("emailKey") before upload.  The server
 * stores them verbatim.  The `wrappedEmailKey` (RSA-OAEP encrypted emailKey) is stored in
 * the EMAIL# DynamoDB item so the client can recover the key on draft resumption or after
 * viewing a sent email.
 *
 * S3 paths mirror those of inbound emails:
 *   {userId}/headers/{ulid}.enc
 *   {userId}/bodies/{ulid}.enc
 *   {userId}/text/{ulid}.enc
 *   {userId}/embeddings/{ulid}.enc
 *   {userId}/attachments/{ulid}.enc   ← attachments metadata blob
 *   {userId}/attachments/{ulid}/{attachmentId}  ← individual binary blobs (uploaded separately)
 */

import {
  DynamoDBClient,
  PutItemCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { ApiEvent, ApiResult } from '../types';

const ddb = new DynamoDBClient({});
const s3  = new S3Client({});

const EMAILS_TABLE     = process.env.EMAILS_TABLE_NAME!;
const USER_DATA_BUCKET = process.env.USER_DATA_BUCKET_NAME!;

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

interface SaveDraftBody {
  /** Base64-encoded blob encrypted with the per-email AES-256 key. */
  headerBlob:      string;
  bodyBlob:        string;
  textBlob:        string;
  attachmentsBlob: string;
  /** RSA-OAEP wrapped emailKey (base64) — stored in DDB for draft resumption. */
  wrappedEmailKey: string;
  receivedAt?:     string; // ISO-8601, supplied by client
}

// ---------------------------------------------------------------------------
// PUT /drafts/{ulid}
// ---------------------------------------------------------------------------

/**
 * Create or update a draft.  All blobs are already encrypted by the client with the
 * per-email key.  The server stores them verbatim and writes a DynamoDB metadata row
 * with folderId='DRAFTS'.  Subsequent calls with the same ULID overwrite the row
 * (idempotent upsert via PutItem).
 */
export async function handlePutDraft(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const ulid = event.pathParameters?.['ulid'];
  if (!ulid) return json(400, { error: 'Missing ulid' });

  let body: Partial<SaveDraftBody>;
  try {
    body = JSON.parse(event.body ?? '{}') as Partial<SaveDraftBody>;
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  if (!body.headerBlob || !body.bodyBlob || !body.textBlob || !body.attachmentsBlob || !body.wrappedEmailKey) {
    return json(400, { error: 'Missing required fields: headerBlob, bodyBlob, textBlob, attachmentsBlob, wrappedEmailKey' });
  }

  const receivedAt = body.receivedAt ?? new Date().toISOString();

  // Standard S3 key layout (same as inbound/sent emails)
  const headerKey      = `${userId}/headers/${ulid}.enc`;
  const bodyKey        = `${userId}/bodies/${ulid}.enc`;
  const textKey        = `${userId}/text/${ulid}.enc`;
  const embeddingKey   = `${userId}/embeddings/${ulid}.enc`;
  const attachmentsKey = `${userId}/attachments/${ulid}.enc`;

  await Promise.all([
    s3.send(new PutObjectCommand({
      Bucket: USER_DATA_BUCKET, Key: headerKey,
      ContentType: 'application/octet-stream',
      Body: Buffer.from(body.headerBlob, 'base64'),
    })),
    s3.send(new PutObjectCommand({
      Bucket: USER_DATA_BUCKET, Key: bodyKey,
      ContentType: 'application/octet-stream',
      Body: Buffer.from(body.bodyBlob, 'base64'),
    })),
    s3.send(new PutObjectCommand({
      Bucket: USER_DATA_BUCKET, Key: textKey,
      ContentType: 'application/octet-stream',
      Body: Buffer.from(body.textBlob, 'base64'),
    })),
    s3.send(new PutObjectCommand({
      Bucket: USER_DATA_BUCKET, Key: attachmentsKey,
      ContentType: 'application/octet-stream',
      Body: Buffer.from(body.attachmentsBlob, 'base64'),
    })),
  ]);

  // Parse attachments blob to determine if there are attachments
  let hasAttachments = 0;
  try {
    const attachmentsJson = Buffer.from(body.attachmentsBlob, 'base64').toString('utf8');
    const attachments = JSON.parse(attachmentsJson) as Array<any>;
    hasAttachments = attachments.length > 0 ? 1 : 0;
  } catch {
    hasAttachments = 0;
  }

  const now = new Date().toISOString();
  await ddb.send(new PutItemCommand({
    TableName: EMAILS_TABLE,
    Item: marshall({
      PK:              `USER#${userId}`,
      SK:              `EMAIL#${ulid}`,
      userId,                     // Required for UserUpdatesIndex GSI (sync)
      lastUpdatedAt:   now,       // Required for sync to detect this draft
      threadId:        `THREAD#${ulid}`,
      folderId:        'DRAFTS',
      labelIds:        [],
      read:            true,
      receivedAt,
      wrappedEmailKey: body.wrappedEmailKey,
      headerBlob:      body.headerBlob, // Inline for sync endpoint header decryption
      s3HeaderKey:      headerKey,
      s3BodyKey:        bodyKey,
      s3TextKey:        textKey,
      s3EmbeddingKey:   embeddingKey,
      s3AttachmentsKey: attachmentsKey,
      hasAttachments,
    }),
  }));

  return { statusCode: 204 };
}

// ---------------------------------------------------------------------------
// DELETE /drafts/{ulid}
// ---------------------------------------------------------------------------

/**
 * Hard-delete a draft (called after send or explicit discard).
 * Returns 204 whether or not the item existed.
 */
export async function handleDeleteDraft(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const ulid = event.pathParameters?.['ulid'];
  if (!ulid) return json(400, { error: 'Missing ulid' });

  await ddb.send(new DeleteItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({ PK: `USER#${userId}`, SK: `EMAIL#${ulid}` }),
    ConditionExpression: 'folderId = :drafts',
    ExpressionAttributeValues: marshall({ ':drafts': 'DRAFTS' }),
  })).catch(() => { /* not found or not a draft — ignore */ });

  return { statusCode: 204 };
}
