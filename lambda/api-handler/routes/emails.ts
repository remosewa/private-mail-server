/**
 * Email routes — all require JWT auth; userId is the Cognito `sub` claim.
 *
 * GET    /emails                              — paginated metadata list
 * GET    /emails/{ulid}/header               — presigned GET URL for encrypted header blob
 * GET    /emails/{ulid}/body                 — presigned GET URL for encrypted body blob
 * GET    /emails/{ulid}/text                 — presigned GET URL for encrypted text blob
 * GET    /emails/{ulid}/embedding            — presigned GET URL for encrypted embedding blob
 * PUT    /emails/{ulid}/embedding            — presigned PUT URL for client to upload embedding
 * GET    /emails/{ulid}/attachments          — presigned GET URL for encrypted attachments blob
 * GET    /emails/{ulid}/attachment/{index}   — presigned GET URL for an attachment binary blob
 * PUT    /emails/{ulid}/flags                — update read / folderId / labelIds
 * DELETE /emails/{ulid}                      — soft-delete (TRASH + 30-day TTL)
 * POST   /emails/send                        — send outbound email via SES
 * GET    /counts                             — unread counts
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  BatchGetItemCommand,
  type QueryCommandInput,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { createDecipheriv } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { monotonicFactory } from 'ulid';
import { wrapKeyRsa } from '../../shared/encrypt';
import type { ApiEvent, ApiResult, FlagsBody } from '../types';
import type { Readable } from 'stream';

const nextUlid = monotonicFactory();

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});
const ses = new SESClient({});

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const EMAILS_TABLE     = process.env.EMAILS_TABLE_NAME!;
const USERS_TABLE      = process.env.USERS_TABLE_NAME!;
const USER_DATA_BUCKET = process.env.USER_DATA_BUCKET_NAME!;

const PRESIGNED_TTL = 900; // 15 minutes

// ---------------------------------------------------------------------------
// Crypto helpers (server-side AES-256-GCM)
// ---------------------------------------------------------------------------

/**
 * Decrypt an attachment blob that was AES-256-GCM encrypted by the client.
 *
 * Wire format produced by the browser (Web Crypto API):
 *   [iv (12 bytes)] [ciphertext+authTag]
 * Web Crypto appends the 16-byte auth tag to the ciphertext in the output of
 * subtle.encrypt(AES-GCM, ...).  Node.js crypto requires the tag to be set
 * separately, so we split the last 16 bytes off.
 */
function decryptWithEmailKey(blob: Buffer, rawKey: Buffer): Buffer {
  if (blob.length < 12 + 16) throw new Error('Encrypted blob too short');
  const iv         = blob.subarray(0, 12);
  const authTag    = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(12, blob.length - 16);

  const decipher = createDecipheriv('aes-256-gcm', rawKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  // Client gzip-compresses before encrypting; decompress here.
  return gunzipSync(decrypted);
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// MIME builder (server-side, used when sending with attachments)
// ---------------------------------------------------------------------------

function toBase64Mime(str: string): string {
  return Buffer.from(str, 'utf8').toString('base64');
}

interface AttachmentPart {
  data:        Buffer;
  filename:    string;
  contentType: string;
}

function buildMime(
  from:        string,
  to:          string,
  cc:          string,
  bcc:         string,
  subject:     string,
  textBody:    string,
  htmlBody:    string,
  attachments: AttachmentPart[],
  messageId?:  string,
  inReplyTo?:  string,
): string {
  const date = new Date().toUTCString();

  if (attachments.length === 0) {
    const boundary = `----=_Part_${Date.now()}`;
    return [
      `From: ${from}`, `To: ${to}`,
      ...(cc  ? [`Cc: ${cc}`]   : []),
      ...(bcc ? [`Bcc: ${bcc}`] : []),
      `Subject: ${subject}`, `Date: ${date}`,
      ...(messageId ? [`Message-ID: ${messageId}`] : []),
      ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64', '',
      toBase64Mime(textBody), '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64', '',
      toBase64Mime(htmlBody), '',
      `--${boundary}--`,
    ].join('\r\n');
  }

  const outer = `----=_Mixed_${Date.now()}`;
  const inner = `----=_Alt_${Date.now() + 1}`;
  const parts: string[] = [
    `From: ${from}`, `To: ${to}`,
    ...(cc  ? [`Cc: ${cc}`]   : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${subject}`, `Date: ${date}`,
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${outer}"`,
    '',
    `--${outer}`,
    `Content-Type: multipart/alternative; boundary="${inner}"`, '',
    `--${inner}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '',
    toBase64Mime(textBody), '',
    `--${inner}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '',
    toBase64Mime(htmlBody), '',
    `--${inner}--`,
  ];

  for (const att of attachments) {
    const safe = att.filename.replace(/"/g, '\\"');
    parts.push(
      '', `--${outer}`,
      `Content-Type: ${att.contentType}; name="${safe}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${safe}"`, '',
      att.data.toString('base64'),
    );
  }

  parts.push('', `--${outer}--`);
  return parts.join('\r\n');
}

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

/**
 * Validates that a string is a valid ISO-8601 UTC timestamp.
 * Accepts formats ending with 'Z' or '+00:00' offset.
 */
function isValidUTCTimestamp(timestamp: string): boolean {
  if (!timestamp) return false;
  
  // Try to parse it first
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return false;
  
  // Check if it's a valid ISO-8601 format with UTC indicator
  // Accepts: 2024-01-15T10:30:45Z or 2024-01-15T10:30:45.123Z or 2024-01-15T10:30:45+00:00
  const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|\+00:00)$/;
  if (!isoRegex.test(timestamp)) return false;
  
  return true;
}

/** Verify the email belongs to the user and return its DynamoDB record. */
async function getEmailRecord(
  userId: string,
  ulid: string,
  projection: string,
): Promise<Record<string, unknown> | null> {
  const res = await ddb.send(new GetItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({ PK: `USER#${userId}`, SK: `EMAIL#${ulid}` }),
    ProjectionExpression: projection,
  }));
  return res.Item ? unmarshall(res.Item) : null;
}

/** Return a presigned GET URL for an S3 key stored in a DynamoDB record field. */
async function presignedGet(
  userId: string,
  ulid: string,
  s3KeyField: string,
): Promise<ApiResult> {
  const rec = await getEmailRecord(userId, ulid, s3KeyField);
  if (!rec) return json(404, { error: 'Email not found' });
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: USER_DATA_BUCKET, Key: rec[s3KeyField] as string }),
    { expiresIn: PRESIGNED_TTL },
  );
  return json(200, { url, expiresIn: PRESIGNED_TTL });
}

// ---------------------------------------------------------------------------
// GET /emails
// ---------------------------------------------------------------------------

/**
 * Returns a page of email metadata for the authenticated user.
 *
 * Query params:
 *   folderId  — folder ID to filter by (default: "INBOX")
 *   limit     — items per page, 1–100 (default 50)
 *   nextToken — opaque pagination cursor from a previous response
 *
 * Note: DynamoDB Limit applies before FilterExpression, so we over-fetch
 * by 3× to compensate. For most mailboxes (single folder per email) this
 * means the page is filled on the first DynamoDB request.
 */
export async function handleListEmails(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const qs = event.queryStringParameters ?? {};
  const folderId = qs['folderId']; // Optional folder filter
  const limit = Math.min(parseInt(qs['limit'] ?? '50', 10), 100);
  const nextToken = qs['nextToken'];
  const startFrom = qs['startFrom']; // Optional ULID to start from (exclusive)

  const queryInput: QueryCommandInput = {
    TableName: EMAILS_TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :email)',
    ExpressionAttributeValues: marshall({ 
      ':pk': `USER#${userId}`,
      ':email': 'EMAIL#'
    }),
    ScanIndexForward: false, // newest first (ULID-ordered SK)
    Limit: limit,
  };

  // Optional folder filter
  if (folderId) {
    queryInput.FilterExpression = 'folderId = :folderId';
    queryInput.ExpressionAttributeValues = marshall({ 
      ':pk': `USER#${userId}`,
      ':email': 'EMAIL#',
      ':folderId': folderId 
    });
  }

  if (nextToken) {
    try {
      queryInput.ExclusiveStartKey = JSON.parse(
        Buffer.from(nextToken, 'base64url').toString('utf8'),
      );
    } catch {
      return json(400, { error: 'Invalid nextToken' });
    }
  } else if (startFrom) {
    // Start from a specific ULID (exclusive) - used for tail sync
    queryInput.ExclusiveStartKey = marshall({
      PK: `USER#${userId}`,
      SK: `EMAIL#${startFrom}`,
    });
  }

  const res = await ddb.send(new QueryCommand(queryInput));

  const records = (res.Items ?? []).map(item => unmarshall(item));

  // Fetch all header blobs from S3 in parallel — avoids the client needing to
  // make N individual presigned-URL round-trips just to populate the inbox list.
  const headerBlobs = await Promise.all(
    records.map(async rec => {
      try {
        const s3Res = await s3.send(new GetObjectCommand({
          Bucket: USER_DATA_BUCKET,
          Key: rec['s3HeaderKey'] as string,
        }));
        const bytes = await (s3Res.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
        return Buffer.from(bytes).toString('base64');
      } catch {
        return null; // blob missing — client will render with empty header fields
      }
    }),
  );

  const items = records.map((rec, i) => ({
    ulid:             (rec['SK'] as string).replace('EMAIL#', ''),
    threadId:         rec['threadId'] ?? (rec['SK'] as string).replace('EMAIL#', ''), // fallback to ulid
    folderId:         rec['folderId'],
    labelIds:         rec['labelIds'] ?? [],
    read:             rec['read'],
    receivedAt:       rec['receivedAt'],
    headerBlob:       headerBlobs[i],   // base64 encrypted header blob, or null
    wrappedEmailKey:  rec['wrappedEmailKey'] ?? null, // present on draft/sent; absent on inbound
    s3BodyKey:        rec['s3BodyKey'],
    s3TextKey:        rec['s3TextKey'],
    s3EmbeddingKey:   rec['s3EmbeddingKey'],
    s3AttachmentsKey: rec['s3AttachmentsKey'],
  }));

  const responseNextToken = res.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(res.LastEvaluatedKey)).toString('base64url')
    : null;

  return json(200, { items, nextToken: responseNextToken });
}

// ---------------------------------------------------------------------------
// POST /emails/batch-get
// Fetch metadata for specific emails by ULID (up to 100 at a time)
// ---------------------------------------------------------------------------

export async function handleBatchGetEmails(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  let body: { ulids?: string[] };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const { ulids } = body;
  if (!ulids || !Array.isArray(ulids)) {
    return json(400, { error: 'ulids must be an array' });
  }

  if (ulids.length === 0) {
    return json(200, { items: [] });
  }

  if (ulids.length > 100) {
    return json(400, { error: 'Maximum 100 ULIDs per request' });
  }

  try {
    // Use BatchGetItem to fetch all emails at once
    const keys = ulids.map(ulid => ({
      PK: { S: `USER#${userId}` },
      SK: { S: `EMAIL#${ulid}` },
    }));

    const result = await ddb.send(new BatchGetItemCommand({
      RequestItems: {
        [EMAILS_TABLE]: {
          Keys: keys,
          ProjectionExpression: 'ulid, threadId, folderId, labelIds, #rd, receivedAt, lastUpdatedAt, #version, s3HeaderKey, headerBlob, wrappedEmailKey, s3BodyKey, s3TextKey, s3EmbeddingKey, s3AttachmentsKey, messageId, hasAttachments, attachmentFilenames',
          ExpressionAttributeNames: {
            '#rd': 'read',
            '#version': 'version',
          },
        },
      },
    }));

    const items = (result.Responses?.[EMAILS_TABLE] || []).map(item => {
      const email = unmarshall(item);
      // ulid is not stored as a separate DDB attribute — extract from SK (always returned as a key field)
      const ulid = (email['ulid'] as string | undefined)
        ?? (email['SK'] as string)?.replace('EMAIL#', '');
      return {
        ulid,
        threadId: email.threadId as string,
        folderId: email.folderId as string,
        labelIds: email.labelIds as string[],
        read: email.read as boolean,
        receivedAt: email.receivedAt as string,
        lastUpdatedAt: email.lastUpdatedAt as string,
        version: email.version as number,
        headerBlob: email.headerBlob as string | null, // Now included from DynamoDB
        wrappedEmailKey: email.wrappedEmailKey as string | null,
        s3BodyKey: email.s3BodyKey as string,
        s3TextKey: email.s3TextKey as string,
        s3EmbeddingKey: email.s3EmbeddingKey as string,
        s3AttachmentsKey: email.s3AttachmentsKey as string,
        messageId: email.messageId as string | null,
        hasAttachments: email.hasAttachments as number,
        attachmentFilenames: (email.attachmentFilenames as string | null) ?? null,
      };
    });

    return json(200, { items });
  } catch (error) {
    console.error('Failed to batch get emails:', error);
    return json(500, { error: 'Failed to fetch emails' });
  }
}

// ---------------------------------------------------------------------------
// GET /emails/{ulid}/header
// ---------------------------------------------------------------------------

export async function handleGetEmailHeader(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });
  const ulid = event.pathParameters?.['ulid'];
  if (!ulid) return json(400, { error: 'Missing ulid' });
  return presignedGet(userId, ulid, 's3HeaderKey');
}

// ---------------------------------------------------------------------------
// GET /emails/{ulid}/body
// ---------------------------------------------------------------------------

export async function handleGetEmailBody(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });
  const ulid = event.pathParameters?.['ulid'];
  if (!ulid) return json(400, { error: 'Missing ulid' });
  return presignedGet(userId, ulid, 's3BodyKey');
}

// ---------------------------------------------------------------------------
// GET /emails/{ulid}/text
// ---------------------------------------------------------------------------

export async function handleGetEmailText(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });
  const ulid = event.pathParameters?.['ulid'];
  if (!ulid) return json(400, { error: 'Missing ulid' });
  return presignedGet(userId, ulid, 's3TextKey');
}

// ---------------------------------------------------------------------------
// POST /emails/text/batch
// ---------------------------------------------------------------------------

/**
 * Batch fetch encrypted text blobs for multiple emails.
 * 
 * Body: { ulids: string[] } (1-50 items)
 * Returns: { texts: Array<{ ulid: string, encryptedText: string }> }
 * 
 * The Lambda fetches all text blobs from S3 in parallel and returns them
 * as base64-encoded strings. This eliminates multiple round trips for indexing.
 */
export async function handleBatchGetEmailText(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  let body: { ulids?: string[] };
  try {
    body = JSON.parse(event.body ?? '{}') as { ulids?: string[] };
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const ulids = body.ulids ?? [];
  if (!Array.isArray(ulids) || ulids.length === 0) {
    return json(400, { error: 'ulids must be a non-empty array' });
  }
  if (ulids.length > 50) {
    return json(400, { error: 'Maximum 50 ulids per request' });
  }

  try {
    // Batch get metadata from DynamoDB to get S3 keys
    const result = await ddb.send(new BatchGetItemCommand({
      RequestItems: {
        [EMAILS_TABLE]: {
          Keys: ulids.map(ulid => marshall({
            PK: `USER#${userId}`,
            SK: `EMAIL#${ulid}`,
          })),
          ProjectionExpression: 'SK, s3TextKey',
        },
      },
    }));

    const items = (result.Responses?.[EMAILS_TABLE] || []).map(item => unmarshall(item));
    
    // Fetch all text blobs from S3 in parallel
    const textFetches = items.map(async (item) => {
      const ulid = (item.SK as string).replace('EMAIL#', '');
      const s3TextKey = item.s3TextKey as string | null;
      
      if (!s3TextKey) {
        return { ulid, encryptedText: null };
      }

      try {
        const s3Res = await s3.send(new GetObjectCommand({
          Bucket: USER_DATA_BUCKET,
          Key: s3TextKey,
        }));
        
        const buffer = await streamToBuffer(s3Res.Body as Readable);
        const encryptedText = buffer.toString('base64');
        
        return { ulid, encryptedText };
      } catch (err) {
        console.error(`Failed to fetch text for ${ulid}:`, err);
        return { ulid, encryptedText: null };
      }
    });

    const texts = await Promise.all(textFetches);

    return json(200, { texts });
  } catch (error) {
    console.error('Failed to batch get email texts:', error);
    return json(500, { error: 'Failed to fetch email texts' });
  }
}

// ---------------------------------------------------------------------------
// GET /emails/{ulid}/embedding
// ---------------------------------------------------------------------------

export async function handleGetEmailEmbedding(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });
  const ulid = event.pathParameters?.['ulid'];
  if (!ulid) return json(400, { error: 'Missing ulid' });
  return presignedGet(userId, ulid, 's3EmbeddingKey');
}

// ---------------------------------------------------------------------------
// PUT /emails/{ulid}/embedding
// ---------------------------------------------------------------------------

/**
 * Register an embedding batch and return a presigned PUT URL.
 *
 * All emails in the batch share the same S3 key. The server immediately stamps
 * s3EmbeddingKey on every DynamoDB record before returning, so
 * GET /emails/{ulid}/embedding works as soon as the client finishes uploading.
 *
 * Body: { ulids: string[] } (1–100 items)
 * Returns: { uploadUrl, expiresIn }
 */
export async function handlePutEmailEmbedding(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  let body: { ulids?: string[] };
  try {
    body = JSON.parse(event.body ?? '{}') as { ulids?: string[] };
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const { ulids } = body;
  if (!ulids || !Array.isArray(ulids) || ulids.length === 0) {
    return json(400, { error: 'ulids must be a non-empty array' });
  }
  if (ulids.length > 100) {
    return json(400, { error: 'Maximum 100 ulids per request' });
  }

  // Verify ownership of all emails in one BatchGet.
  const batchRes = await ddb.send(new BatchGetItemCommand({
    RequestItems: {
      [EMAILS_TABLE]: {
        Keys: ulids.map(ulid => marshall({ PK: `USER#${userId}`, SK: `EMAIL#${ulid}` })),
        ProjectionExpression: 'SK',
      },
    },
  }));
  const found = batchRes.Responses?.[EMAILS_TABLE] ?? [];
  if (found.length !== ulids.length) {
    return json(404, { error: 'Some emails not found' });
  }

  // Shared S3 key for this batch.
  const batchId = nextUlid();
  const s3Key = `${userId}/embedding-batches/${batchId}`;

  // Stamp s3EmbeddingKey on every email so the GET handler can find the blob.
  const now = new Date().toISOString();
  await Promise.all(
    ulids.map(ulid =>
      ddb.send(new UpdateItemCommand({
        TableName: EMAILS_TABLE,
        Key: marshall({ PK: `USER#${userId}`, SK: `EMAIL#${ulid}` }),
        UpdateExpression: 'SET s3EmbeddingKey = :key, lastUpdatedAt = :ts',
        ExpressionAttributeValues: marshall({ ':key': s3Key, ':ts': now }),
      })),
    ),
  );

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: USER_DATA_BUCKET,
      Key: s3Key,
      ContentType: 'application/octet-stream',
    }),
    { expiresIn: PRESIGNED_TTL },
  );

  return json(200, { uploadUrl, s3EmbeddingKey: s3Key, expiresIn: PRESIGNED_TTL });
}

// ---------------------------------------------------------------------------
// GET /emails/{ulid}/attachments
// ---------------------------------------------------------------------------

export async function handleGetEmailAttachments(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });
  const ulid = event.pathParameters?.['ulid'];
  if (!ulid) return json(400, { error: 'Missing ulid' });
  return presignedGet(userId, ulid, 's3AttachmentsKey');
}

// ---------------------------------------------------------------------------
// GET /emails/{ulid}/attachment/{attachmentId}
// ---------------------------------------------------------------------------

/**
 * Returns a presigned GET URL for an individual attachment binary blob.
 * The S3 key is {userId}/attachments/{ulid}/{attachmentId} for all email types
 * (inbound RSA-hybrid encrypted, and draft/sent emailKey-encrypted).
 * Ownership is verified by confirming the EMAIL# record exists for this user.
 */
export async function handleGetEmailAttachmentBlob(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const ulid         = event.pathParameters?.['ulid'];
  const attachmentId = event.pathParameters?.['attachmentId'];
  if (!ulid || !attachmentId) return json(400, { error: 'Missing ulid or attachmentId' });

  // Verify the email belongs to this user (ownership check)
  const rec = await getEmailRecord(userId, ulid, 'PK');
  if (!rec) return json(404, { error: 'Email not found' });

  const s3Key = `${userId}/attachments/${ulid}/${attachmentId}`;
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: USER_DATA_BUCKET, Key: s3Key }),
    { expiresIn: PRESIGNED_TTL },
  );

  return json(200, { url, expiresIn: PRESIGNED_TTL });
}

// ---------------------------------------------------------------------------
// PUT /emails/{ulid}/flags
// ---------------------------------------------------------------------------

export async function handlePutEmailFlags(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const ulid = event.pathParameters?.['ulid'];
  if (!ulid) return json(400, { error: 'Missing ulid' });

  let body: Partial<FlagsBody>;
  try {
    body = JSON.parse(event.body ?? '{}') as Partial<FlagsBody>;
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  // Validate version if provided (required for optimistic locking)
  if (body.version !== undefined && typeof body.version !== 'number') {
    return json(400, { error: 'Invalid version: must be a number' });
  }

  const setParts: string[] = [];
  const attrNames: Record<string, string> = {};
  const attrValues: Record<string, unknown> = {};

  if (body.read !== undefined) {
    setParts.push('#read = :read');
    attrNames['#read'] = 'read';
    attrValues[':read'] = body.read;
  }
  if (body.folderId !== undefined) {
    setParts.push('folderId = :folderId');
    attrValues[':folderId'] = body.folderId;
  }
  if (body.labelIds !== undefined) {
    if (!Array.isArray(body.labelIds)) return json(400, { error: 'labelIds must be an array' });
    setParts.push('labelIds = :labelIds');
    attrValues[':labelIds'] = body.labelIds;
  }

  if (!setParts.length) return json(400, { error: 'Provide at least one of: read, folderId, labelIds' });

  // Adjust unread counter when read state or folder changes
  if (body.read !== undefined || body.folderId === 'TRASH') {
    try {
      const currentRes = await ddb.send(new GetItemCommand({
        TableName: EMAILS_TABLE,
        Key: marshall({ PK: `USER#${userId}`, SK: `EMAIL#${ulid}` }),
        ProjectionExpression: '#rd, folderId',
        ExpressionAttributeNames: { '#rd': 'read' },
      }));
      if (currentRes.Item) {
        const cur = unmarshall(currentRes.Item);
        const wasUnread = cur['read'] === false;
        const isInbox = cur['folderId'] === 'INBOX';

        let delta = 0;
        if (body.read !== undefined && isInbox) {
          // Marking read: -1; marking unread: +1
          if (wasUnread && body.read === true) delta = -1;
          else if (!wasUnread && body.read === false) delta = 1;
        }
        if (body.folderId === 'TRASH' && wasUnread && isInbox) {
          // Moving unread INBOX message to trash: -1
          delta = -1;
        }

        if (delta !== 0) {
          await ddb.send(new UpdateItemCommand({
            TableName: EMAILS_TABLE,
            Key: marshall({ PK: `USER#${userId}`, SK: 'COUNTS' }),
            UpdateExpression: 'ADD unreadInbox :delta',
            ExpressionAttributeValues: marshall({ ':delta': delta }),
          })).catch(() => { /* counter update is non-fatal */ });
        }
      }
    } catch {
      // Counter update failure is non-fatal — flags still apply
    }
  }

  // Set new lastUpdatedAt timestamp and increment version
  const now = new Date().toISOString();
  setParts.push('lastUpdatedAt = :now');
  setParts.push('#version = #version + :one');
  attrNames['#version'] = 'version';
  attrValues[':now'] = now;
  attrValues[':one'] = 1;

  // Build condition expression for optimistic locking
  let conditionExpression = 'attribute_exists(PK)';
  if (body.version !== undefined) {
    // Optimistic lock: verify client's version matches current server version
    conditionExpression += ' AND #version = :clientVersion';
    attrValues[':clientVersion'] = body.version;
  }

  try {
    const result = await ddb.send(new UpdateItemCommand({
      TableName: EMAILS_TABLE,
      Key: marshall({ PK: `USER#${userId}`, SK: `EMAIL#${ulid}` }),
      UpdateExpression: `SET ${setParts.join(', ')}`,
      ExpressionAttributeNames: attrNames,
      ExpressionAttributeValues: marshall(attrValues),
      ConditionExpression: conditionExpression,
      ReturnValues: 'ALL_NEW',
    }));

    const updated = result.Attributes ? unmarshall(result.Attributes) : {};
    return json(200, { 
      lastUpdatedAt: now,
      version: updated.version as number,
    });
  } catch (error: unknown) {
    // Handle optimistic lock failure
    if (error && typeof error === 'object' && 'name' in error && error.name === 'ConditionalCheckFailedException') {
      // Fetch current record to get the actual version
      const currentRes = await ddb.send(new GetItemCommand({
        TableName: EMAILS_TABLE,
        Key: marshall({ PK: `USER#${userId}`, SK: `EMAIL#${ulid}` }),
        ProjectionExpression: '#version, lastUpdatedAt',
        ExpressionAttributeNames: { '#version': 'version' },
      }));

      const current = currentRes.Item ? unmarshall(currentRes.Item) : {};

      return json(409, {
        error: 'CONFLICT',
        message: 'Record was modified by another client',
        currentVersion: current.version as number,
        currentLastUpdatedAt: current.lastUpdatedAt as string,
      });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// DELETE /emails/{ulid}
// ---------------------------------------------------------------------------

/**
 * Soft-delete: moves the email to the TRASH system folder and sets a 30-day TTL.
 * Stores prevFolderId so the email can be restored to its original folder.
 * DynamoDB TTL handles the hard-delete automatically (stream processor cleans up S3).
 */
export async function handleDeleteEmail(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const ulid = event.pathParameters?.['ulid'];
  if (!ulid) return json(400, { error: 'Missing ulid' });

  // Fetch current folderId and read status to save prevFolderId + adjust unread counter
  const currentRes = await ddb.send(new GetItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({ PK: `USER#${userId}`, SK: `EMAIL#${ulid}` }),
    ProjectionExpression: 'folderId, #rd',
    ExpressionAttributeNames: { '#rd': 'read' },
  }));
  if (!currentRes.Item) return json(404, { error: 'Email not found' });

  const cur = unmarshall(currentRes.Item);
  const prevFolderId = cur['folderId'] as string;
  const wasUnread = cur['read'] === false;
  const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days

  await ddb.send(new UpdateItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({ PK: `USER#${userId}`, SK: `EMAIL#${ulid}` }),
    UpdateExpression: 'SET folderId = :trash, #ttl = :ttl, prevFolderId = :prev',
    ExpressionAttributeNames: { '#ttl': 'ttl' },
    ExpressionAttributeValues: marshall({ ':trash': 'TRASH', ':ttl': ttl, ':prev': prevFolderId }),
    ConditionExpression: 'attribute_exists(PK)',
  }));

  // Decrement unread counter if we moved an unread inbox message to trash
  if (wasUnread && prevFolderId === 'INBOX') {
    await ddb.send(new UpdateItemCommand({
      TableName: EMAILS_TABLE,
      Key: marshall({ PK: `USER#${userId}`, SK: 'COUNTS' }),
      UpdateExpression: 'ADD unreadInbox :delta',
      ExpressionAttributeValues: marshall({ ':delta': -1 }),
    })).catch(() => { /* counter update is non-fatal */ });
  }

  return { statusCode: 204 };
}

// ---------------------------------------------------------------------------
// POST /emails/{ulid}/restore
// ---------------------------------------------------------------------------

/**
 * Restore a trashed email back to its previous folder.
 * Clears TTL and prevFolderId. Defaults to INBOX if prevFolderId was not saved.
 */
export async function handleRestoreEmail(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const ulid = event.pathParameters?.['ulid'];
  if (!ulid) return json(400, { error: 'Missing ulid' });

  const currentRes = await ddb.send(new GetItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({ PK: `USER#${userId}`, SK: `EMAIL#${ulid}` }),
    ProjectionExpression: 'folderId, prevFolderId, #rd',
    ExpressionAttributeNames: { '#rd': 'read' },
  }));
  if (!currentRes.Item) return json(404, { error: 'Email not found' });

  const cur = unmarshall(currentRes.Item);
  if (cur['folderId'] !== 'TRASH') return json(400, { error: 'Email is not in trash' });

  const restoreTo = (cur['prevFolderId'] as string | undefined) ?? 'INBOX';
  const wasUnread = cur['read'] === false;

  await ddb.send(new UpdateItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({ PK: `USER#${userId}`, SK: `EMAIL#${ulid}` }),
    UpdateExpression: 'SET folderId = :folder REMOVE #ttl, prevFolderId',
    ExpressionAttributeNames: { '#ttl': 'ttl' },
    ExpressionAttributeValues: marshall({ ':folder': restoreTo }),
    ConditionExpression: 'attribute_exists(PK)',
  }));

  // Increment unread counter if restoring an unread message to INBOX
  if (wasUnread && restoreTo === 'INBOX') {
    await ddb.send(new UpdateItemCommand({
      TableName: EMAILS_TABLE,
      Key: marshall({ PK: `USER#${userId}`, SK: 'COUNTS' }),
      UpdateExpression: 'ADD unreadInbox :delta',
      ExpressionAttributeValues: marshall({ ':delta': 1 }),
    })).catch(() => { /* counter update is non-fatal */ });
  }

  return json(200, { restoredTo: restoreTo });
}

// ---------------------------------------------------------------------------
// POST /emails/send
// ---------------------------------------------------------------------------

/**
 * Send an outbound email.
 *
 * The client:
 *   1. Generated a per-email AES-256 key ("emailKey") and encrypted ALL blobs
 *      (header, body, text, embedding, attachments-meta, attachment binaries)
 *      with it before uploading them to S3 via PUT /drafts/{ulid}.
 *   2. Sends the raw emailKey (base64) to the server so it can decrypt and build MIME.
 *
 * The server:
 *   1. Validates the emailKey (32 bytes).
 *   2. Fetches the email's existing DDB record to get S3 keys.
 *   3. Fetches and decrypts the header, body, and attachments-meta blobs.
 *   4. Fetches and decrypts each attachment binary.
 *   5. Builds a complete MIME message.
 *   6. Sends via SES.
 *   7. Computes wrappedEmailKey = RSA-OAEP(emailKey, publicKey) and stores it in the
 *      SENT EMAIL# DDB item so the client can decrypt blobs later.
 *
 * The S3 blobs are NOT re-encrypted — they stay at their draft paths and are
 * simply re-used for the Sent folder view.
 */
export async function handleSendEmail(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  let body: { emailId?: string; emailKey?: string; displayName?: string };
  try {
    body = JSON.parse(event.body ?? '{}') as { emailId?: string; emailKey?: string; displayName?: string };
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const { emailId, emailKey: emailKeyB64, displayName } = body;
  if (!emailId || !emailKeyB64) return json(400, { error: 'Missing required fields: emailId, emailKey' });

  const rawEmailKey = Buffer.from(emailKeyB64, 'base64');
  if (rawEmailKey.length !== 32) return json(400, { error: 'emailKey must be 32 bytes (AES-256)' });

  // ── Fetch draft record + user record in parallel ────────────────────────
  const [draftRec, userRes] = await Promise.all([
    getEmailRecord(userId, emailId, 's3HeaderKey, s3BodyKey, s3TextKey, s3EmbeddingKey, s3AttachmentsKey'),
    ddb.send(new GetItemCommand({
      TableName: USERS_TABLE,
      Key: marshall({ userId }),
      ProjectionExpression: 'email, publicKey, username',
    })),
  ]);
  if (!draftRec) return json(404, { error: 'Draft not found — save the draft before sending' });
  if (!userRes.Item) return json(404, { error: 'User not found' });

  const s3HeaderKey      = draftRec['s3HeaderKey'] as string;
  const s3BodyKey        = draftRec['s3BodyKey'] as string;
  const s3TextKey        = draftRec['s3TextKey'] as string;
  const s3EmbeddingKey   = draftRec['s3EmbeddingKey'] as string;
  const s3AttachmentsKey = draftRec['s3AttachmentsKey'] as string;

  const { email: fromEmail, publicKey: publicKeyPem, username } =
    unmarshall(userRes.Item) as { email: string; publicKey: string; username: string };

  // ── Decrypt metadata blobs ───────────────────────────────────────────────
  const fetchAndDecrypt = async (key: string) => {
    const res = await s3.send(new GetObjectCommand({ Bucket: USER_DATA_BUCKET, Key: key }));
    const buf = await streamToBuffer(res.Body as Readable);
    return decryptWithEmailKey(buf, rawEmailKey);
  };

  // Fetch header separately: keep the raw encrypted bytes for DDB storage (headerBlob),
  // then decrypt for MIME building. Body and attachments only need decrypted form.
  const [headerEncryptedBuf, bodyBuf, attMetaBuf] = await Promise.all([
    s3.send(new GetObjectCommand({ Bucket: USER_DATA_BUCKET, Key: s3HeaderKey }))
      .then(res => streamToBuffer(res.Body as Readable)),
    fetchAndDecrypt(s3BodyKey),
    fetchAndDecrypt(s3AttachmentsKey).catch(() => Buffer.from('[]', 'utf8')),
  ]);
  const headerBlobBase64 = headerEncryptedBuf.toString('base64');
  const headerBuf = decryptWithEmailKey(headerEncryptedBuf, rawEmailKey);

  const header = JSON.parse(headerBuf.toString('utf8')) as {
    subject: string; to: string[]; cc?: string[]; bcc?: string[];
    fromName: string; fromAddress: string; date: string; preview: string;
    messageId?: string; inReplyTo?: string; // Threading headers
  };
  const { textBody, htmlBody } = JSON.parse(bodyBuf.toString('utf8')) as { textBody: string; htmlBody: string };
  const attMeta = JSON.parse(attMetaBuf.toString('utf8')) as Array<{
    filename: string; size: number; contentType: string; attachmentId?: string;
  }>;
  const hasAttachments = attMeta.length > 0 ? 1 : 0;
  const attachmentFilenames = JSON.stringify(attMeta.map(a => a.filename));

  console.log('[handleSendEmail] emailId:', emailId, 'hasInReplyTo:', !!header.inReplyTo);

  // ── Resolve threadId using In-Reply-To (same logic as inbound processor) ──
  let threadId: string;
  if (header.inReplyTo) {
    // Query LSI_MessageId to find parent message and inherit its threadId
    const parentRes = await ddb.send(new QueryCommand({
      TableName: EMAILS_TABLE,
      IndexName: 'LSI_MessageId',
      KeyConditionExpression: 'PK = :pk AND messageId = :mid',
      ExpressionAttributeValues: marshall({
        ':pk': `USER#${userId}`,
        ':mid': header.inReplyTo,
      }),
      ProjectionExpression: 'threadId',
      Limit: 1,
    }));

    console.log('[handleSendEmail] Parent lookup: foundParent=', !!parentRes.Items?.length);

    if (parentRes.Items?.length) {
      const parent = unmarshall(parentRes.Items[0]) as { threadId: string };
      threadId = parent.threadId;
    } else {
      // Parent not found (might be in a different folder or deleted) — start new thread
      threadId = `THREAD#${emailId}`;
    }
  } else {
    // Not a reply — start new thread
    threadId = `THREAD#${emailId}`;
  }

  console.log('[handleSendEmail] Resolved threadId (prefix):', threadId.slice(0, 15));
  // ── Fetch and decrypt attachment binaries ────────────────────────────────
  const attParts: Array<{ filename: string; contentType: string; data: Buffer }> = [];
  const missing: string[] = [];
  await Promise.all(
    attMeta
      .filter(a => a.attachmentId)
      .map(async a => {
        try {
          const res = await s3.send(new GetObjectCommand({
            Bucket: USER_DATA_BUCKET,
            Key: `${userId}/attachments/${emailId}/${a.attachmentId!}`,
          }));
          const encrypted = await streamToBuffer(res.Body as Readable);
          const decrypted = decryptWithEmailKey(encrypted, rawEmailKey);
          attParts.push({ filename: a.filename, contentType: a.contentType, data: decrypted });
        } catch {
          missing.push(a.attachmentId!);
        }
      }),
  );

  if (missing.length > 0) {
    return json(422, { code: 'ATTACHMENTS_MISSING', missing });
  }

  // ── Build MIME and send via SES ─────────────────────────────────────────
  const toStr  = header.to.join(', ');
  const ccStr  = (header.cc  ?? []).join(', ');
  const bccStr = (header.bcc ?? []).join(', ');
  
  // Format From header with display name if provided
  const fromHeader = displayName && displayName.trim()
    ? `"${displayName.trim()}" <${fromEmail}>`
    : fromEmail;
  
  const mimeStr = buildMime(
    fromHeader, toStr, ccStr, bccStr, header.subject, textBody, htmlBody, attParts,
    header.messageId, // Include Message-ID so SES doesn't generate its own
    header.inReplyTo, // Include In-Reply-To for threading
  );

  const result = await ses.send(new SendRawEmailCommand({
    Source: fromEmail,
    Destinations: [...header.to, ...(header.bcc ?? [])],
    RawMessage: { Data: Buffer.from(mimeStr, 'utf8') },
  }));

  // ── Update DDB: folderId SENT + wrappedEmailKey + threadId + messageId ──
  const now = new Date().toISOString();
  const wrappedEmailKey = wrapKeyRsa(rawEmailKey, publicKeyPem);
  await ddb.send(new PutItemCommand({
    TableName: EMAILS_TABLE,
    Item: marshall({
      PK: `USER#${userId}`, SK: `EMAIL#${emailId}`,
      userId, // Required for UserUpdatesIndex GSI
      threadId, // Use resolved threadId (inherited from parent or new)
      folderId: 'SENT', labelIds: [], read: true,
      receivedAt: header.date,
      lastUpdatedAt: now, // Required for sync to detect this email
      wrappedEmailKey,
      headerBlob: headerBlobBase64, // Inline for sync endpoint (avoids S3 round-trip on next sync)
      s3HeaderKey, s3BodyKey, s3TextKey, s3EmbeddingKey, s3AttachmentsKey,
      hasAttachments, attachmentFilenames,
      ...(header.messageId ? { messageId: header.messageId } : {}), // Store Message-ID for threading
    }),
  }));

  return json(202, { messageId: result.MessageId, lastUpdatedAt: now });
}

// ---------------------------------------------------------------------------
// GET /counts
// ---------------------------------------------------------------------------

export async function handleGetCounts(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const res = await ddb.send(new GetItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({ PK: `USER#${userId}`, SK: 'COUNTS' }),
    ProjectionExpression: 'unreadInbox',
  }));

  const rec = res.Item ? unmarshall(res.Item) : {};
  return json(200, { unreadInbox: (rec['unreadInbox'] as number | undefined) ?? 0 });
}
// ---------------------------------------------------------------------------
// POST /emails/bulk-update
// ---------------------------------------------------------------------------

/**
 * Bulk update email flags (folder, labels, read status) for up to 100 emails.
 *
 * Body: {
 *   updates: Array<{
 *     ulid: string;
 *     folderId?: string;
 *     labelIds?: string[];
 *     read?: boolean;
 *     version: number; // Required for optimistic locking
 *   }>
 * }
 *
 * Returns: {
 *   results: Array<{
 *     ulid: string;
 *     success: boolean;
 *     version?: number;
 *     lastUpdatedAt?: string;
 *     error?: string;
 *     currentVersion?: number;
 *   }>
 * }
 *
 * For failed updates due to version conflicts, performs a consistent read
 * to verify if the email already has the desired state. Only reports as
 * failure if the email still doesn't match the desired state.
 */
export async function handleBulkUpdateEmails(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  let body: {
    updates?: Array<{
      ulid: string;
      folderId?: string;
      labelIds?: string[];
      read?: boolean;
      version: number;
    }>;
  };

  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const { updates } = body;
  if (!updates || !Array.isArray(updates)) {
    return json(400, { error: 'updates must be an array' });
  }

  if (updates.length === 0) {
    return json(400, { error: 'updates array cannot be empty' });
  }

  if (updates.length > 100) {
    return json(400, { error: 'Maximum 100 updates per request' });
  }

  // Validate all updates
  for (const update of updates) {
    if (!update.ulid) {
      return json(400, { error: 'Each update must have a ulid' });
    }
    if (typeof update.version !== 'number') {
      return json(400, { error: 'Each update must have a version number' });
    }
    if (update.folderId === undefined && update.labelIds === undefined && update.read === undefined) {
      return json(400, { error: 'Each update must specify at least one of: folderId, labelIds, read' });
    }
    if (update.labelIds !== undefined && !Array.isArray(update.labelIds)) {
      return json(400, { error: 'labelIds must be an array' });
    }
  }

  // Process updates sequentially to handle counter updates correctly
  const results: Array<{
    ulid: string;
    success: boolean;
    version?: number;
    lastUpdatedAt?: string;
    error?: string;
    currentVersion?: number;
    currentFolderId?: string;
    currentLabelIds?: string[];
    currentRead?: boolean;
    currentLastUpdatedAt?: string;
  }> = [];

  for (const update of updates) {
    try {
      const setParts: string[] = [];
      const attrNames: Record<string, string> = {};
      const attrValues: Record<string, unknown> = {};

      if (update.read !== undefined) {
        setParts.push('#read = :read');
        attrNames['#read'] = 'read';
        attrValues[':read'] = update.read;
      }
      if (update.folderId !== undefined) {
        setParts.push('folderId = :folderId');
        attrValues[':folderId'] = update.folderId;
      }
      if (update.labelIds !== undefined) {
        setParts.push('labelIds = :labelIds');
        attrValues[':labelIds'] = update.labelIds;
      }

      // Adjust unread counter when read state or folder changes
      if (update.read !== undefined || update.folderId === 'TRASH') {
        try {
          const currentRes = await ddb.send(new GetItemCommand({
            TableName: EMAILS_TABLE,
            Key: marshall({ PK: `USER#${userId}`, SK: `EMAIL#${update.ulid}` }),
            ProjectionExpression: '#rd, folderId',
            ExpressionAttributeNames: { '#rd': 'read' },
          }));
          if (currentRes.Item) {
            const cur = unmarshall(currentRes.Item);
            const wasUnread = cur['read'] === false;
            const isInbox = cur['folderId'] === 'INBOX';

            let delta = 0;
            if (update.read !== undefined && isInbox) {
              if (wasUnread && update.read === true) delta = -1;
              else if (!wasUnread && update.read === false) delta = 1;
            }
            if (update.folderId === 'TRASH' && wasUnread && isInbox) {
              delta = -1;
            }

            if (delta !== 0) {
              await ddb.send(new UpdateItemCommand({
                TableName: EMAILS_TABLE,
                Key: marshall({ PK: `USER#${userId}`, SK: 'COUNTS' }),
                UpdateExpression: 'ADD unreadInbox :delta',
                ExpressionAttributeValues: marshall({ ':delta': delta }),
              })).catch(() => { /* counter update is non-fatal */ });
            }
          }
        } catch {
          // Counter update failure is non-fatal
        }
      }

      // Set new lastUpdatedAt timestamp and increment version
      const now = new Date().toISOString();
      setParts.push('lastUpdatedAt = :now');
      setParts.push('#version = #version + :one');
      attrNames['#version'] = 'version';
      attrValues[':now'] = now;
      attrValues[':one'] = 1;
      attrValues[':clientVersion'] = update.version;

      const result = await ddb.send(new UpdateItemCommand({
        TableName: EMAILS_TABLE,
        Key: marshall({ PK: `USER#${userId}`, SK: `EMAIL#${update.ulid}` }),
        UpdateExpression: `SET ${setParts.join(', ')}`,
        ExpressionAttributeNames: attrNames,
        ExpressionAttributeValues: marshall(attrValues),
        ConditionExpression: 'attribute_exists(PK) AND #version = :clientVersion',
        ReturnValues: 'ALL_NEW',
      }));

      const updated = result.Attributes ? unmarshall(result.Attributes) : {};
      results.push({
        ulid: update.ulid,
        success: true,
        version: updated.version as number,
        lastUpdatedAt: now,
      });
    } catch (error: unknown) {
      // Handle optimistic lock failure
      if (error && typeof error === 'object' && 'name' in error && error.name === 'ConditionalCheckFailedException') {
        // Perform consistent read to check if email already has desired state
        try {
          const currentRes = await ddb.send(new GetItemCommand({
            TableName: EMAILS_TABLE,
            Key: marshall({ PK: `USER#${userId}`, SK: `EMAIL#${update.ulid}` }),
            ProjectionExpression: 'folderId, labelIds, #rd, #version, lastUpdatedAt',
            ExpressionAttributeNames: { '#rd': 'read', '#version': 'version' },
            ConsistentRead: true,
          }));

          if (!currentRes.Item) {
            results.push({
              ulid: update.ulid,
              success: false,
              error: 'Email not found',
            });
            continue;
          }

          const current = unmarshall(currentRes.Item);

          // Check if email already has the desired state
          let alreadyMatches = true;

          if (update.folderId !== undefined && current.folderId !== update.folderId) {
            alreadyMatches = false;
          }

          if (update.read !== undefined && current.read !== update.read) {
            alreadyMatches = false;
          }

          if (update.labelIds !== undefined) {
            const currentLabels = (current.labelIds as string[] || []).sort();
            const desiredLabels = [...update.labelIds].sort();
            if (JSON.stringify(currentLabels) !== JSON.stringify(desiredLabels)) {
              alreadyMatches = false;
            }
          }

          if (alreadyMatches) {
            // Email already has the desired state, consider it a success
            results.push({
              ulid: update.ulid,
              success: true,
              version: current.version as number,
              lastUpdatedAt: current.lastUpdatedAt as string,
            });
          } else {
            // Email doesn't match desired state, report conflict with current metadata
            results.push({
              ulid: update.ulid,
              success: false,
              error: 'CONFLICT',
              currentVersion: current.version as number,
              currentFolderId: current.folderId as string,
              currentLabelIds: current.labelIds as string[],
              currentRead: current.read as boolean,
              currentLastUpdatedAt: current.lastUpdatedAt as string,
            });
          }
        } catch (readError) {
          results.push({
            ulid: update.ulid,
            success: false,
            error: 'Failed to verify email state',
          });
        }
      } else {
        results.push({
          ulid: update.ulid,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  return json(200, { results });
}

// ---------------------------------------------------------------------------
// GET /counts
// ---------------------------------------------------------------------------
