/**
 * Attachment upload routes
 *
 * POST   /attachments/upload-url            — presigned PUT URL for a client-encrypted attachment
 * DELETE /attachments/{emailId}/{attachmentId} — remove an attachment (e.g. user removed it)
 *
 * Architecture
 * ─────────────
 * The client generates a random per-email AES-256 key ("emailKey") at compose time and
 * uses it to encrypt ALL email blobs (header, body, text, embedding, attachments-meta) as
 * well as each attachment binary.  Only encrypted bytes ever reach S3 — the server never
 * sees plaintext.
 *
 * Attachment path: {userId}/attachments/{emailId}/{attachmentId}
 * This same path is used for inbound, draft, and sent emails so there is one canonical
 * location per attachment regardless of how the email was created.
 *
 * When a draft is saved, `wrappedEmailKey` (RSA-OAEP encrypted emailKey) is stored in the
 * EMAIL# DynamoDB item alongside the S3 keys.  The server uses the raw emailKey (sent by
 * the client at send-time) to decrypt blobs and build the outgoing MIME message.
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { monotonicFactory } from 'ulid';
import type { ApiEvent, ApiResult } from '../types';

const s3       = new S3Client({});
const nextUlid = monotonicFactory();

const USER_DATA_BUCKET = process.env.USER_DATA_BUCKET_NAME!;

/** 25 MB per-file ceiling. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Presigned PUT URLs are valid for 15 minutes. */
const UPLOAD_URL_TTL = 900;

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
// POST /attachments/upload-url
// ---------------------------------------------------------------------------

interface UploadUrlBody {
  /** Client-generated email ULID — groups all attachments for one email. */
  emailId:     string;
  filename:    string;
  contentType: string;
  /** Original (pre-encryption) file size in bytes — validated against the 25 MB limit. */
  size:        number;
}

/**
 * Returns a presigned S3 PUT URL for the client to upload a client-encrypted attachment
 * blob directly to the user-data bucket at its permanent location.
 * The server generates a ULID for the attachment and returns it so the client can reference
 * it in the AttachmentMeta stored in the attachments blob.
 */
export async function handleGetAttachmentUploadUrl(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  let body: Partial<UploadUrlBody>;
  try {
    body = JSON.parse(event.body ?? '{}') as Partial<UploadUrlBody>;
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const { emailId, filename, contentType, size } = body;
  if (!emailId || !filename || !contentType || size === undefined) {
    return json(400, { error: 'Missing required fields: emailId, filename, contentType, size' });
  }
  if (typeof size !== 'number' || size <= 0 || size > MAX_ATTACHMENT_BYTES) {
    return json(400, { error: `size must be 1–${MAX_ATTACHMENT_BYTES} bytes`, maxBytes: MAX_ATTACHMENT_BYTES });
  }

  const attachmentId = nextUlid();
  const s3Key = `${userId}/attachments/${emailId}/${attachmentId}`;

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: USER_DATA_BUCKET,
      Key: s3Key,
      ContentType: 'application/octet-stream',
    }),
    { expiresIn: UPLOAD_URL_TTL },
  );

  return json(200, { attachmentId, uploadUrl, expiresIn: UPLOAD_URL_TTL });
}

// ---------------------------------------------------------------------------
// DELETE /attachments/{emailId}/{attachmentId}
// ---------------------------------------------------------------------------

/**
 * Removes an attachment when the user deletes it from the compose window.
 * Returns 204 whether or not the object existed.
 */
export async function handleDeleteAttachment(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const { emailId, attachmentId } = event.pathParameters ?? {};
  if (!emailId || !attachmentId) return json(400, { error: 'Missing emailId or attachmentId' });

  await s3.send(new DeleteObjectCommand({
    Bucket: USER_DATA_BUCKET,
    Key: `${userId}/attachments/${emailId}/${attachmentId}`,
  })).catch(() => { /* already gone — ignore */ });

  return { statusCode: 204 };
}
