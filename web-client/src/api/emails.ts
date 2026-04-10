/**
 * Email API — all calls are authenticated (accessToken injected by apiClient interceptor).
 */

import { apiClient } from './client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailMeta {
  ulid:             string;
  threadId:         string;
  folderId:         string;
  labelIds:         string[];
  read:             boolean;
  receivedAt:       string; // ISO-8601
  lastUpdatedAt:    string; // ISO-8601 UTC - last modification time
  version:          number; // Version counter for optimistic locking
  headerBlob:       string | null; // base64 encrypted header blob (inlined by server)
  /** Present for draft/sent emails (encrypted with emailKey). Absent for inbound (RSA-hybrid). */
  wrappedEmailKey:  string | null;
  s3BodyKey:        string;
  s3TextKey:        string;
  s3EmbeddingKey:   string;
  s3AttachmentsKey: string;
  messageId:           string | null; // Message-ID header for threading
  hasAttachments:      number; // 1 if email has attachments, 0 otherwise
  attachmentFilenames: string | null; // JSON array of original filenames, e.g. '["resume.pdf","photo.jpg"]'
}

export interface ListEmailsResponse {
  items:     EmailMeta[];
  nextToken: string | null;
}

export interface FlagsBody {
  read?:    boolean;
  folderId?: string;
  labelIds?: string[];
  version:  number; // Optimistic lock version counter
}

export interface SendEmailBody {
  /** Client-generated email ULID — identifies the draft blobs already saved in S3. */
  emailId:  string;
  /** Raw 32-byte AES-256 emailKey, base64-encoded. */
  emailKey: string;
  /** Optional display name for the From header (e.g., "John Doe") */
  displayName?: string;
}

export interface Label {
  labelId:       string;
  encryptedName: string;
  color:         string;
  lastUpdatedAt: string;
}

export interface MigrationStatus {
  userId:        string;
  migrationId:   string;
  status:        'pending' | 'processing' | 'completed' | 'failed';
  progress:      number;
  totalEmails:   number;
  lastUpdatedAt: string;
}

export interface SyncResponse {
  emails:     EmailMeta[];
  labels:     Label[];
  migrations: MigrationStatus[];
  nextToken:  string | null;
  serverTime: string; // Current server UTC time for client clock sync
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listEmails(
  folderId?: string,
  nextToken?: string,
  limit = 50,
  startFrom?: string,
): Promise<ListEmailsResponse> {
  const params: Record<string, string | number> = { limit };
  if (folderId) params['folderId'] = folderId;
  if (nextToken) params['nextToken'] = nextToken;
  if (startFrom) params['startFrom'] = startFrom;
  const res = await apiClient.get<ListEmailsResponse>('/emails', { params });
  return res.data;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Get all updates since a given timestamp (head sync).
 * Implements retry logic with exponential backoff for network errors.
 * 
 * @param since - ISO-8601 UTC timestamp to get updates since
 * @param nextToken - Optional pagination token
 * @param limit - Optional limit (default 100, max 500)
 * @returns SyncResponse with emails, labels, migrations, and pagination token
 */
export async function getUpdates(
  since: string,
  nextToken?: string,
  limit = 100,
): Promise<SyncResponse> {
  const params: Record<string, string | number> = { since, limit };
  if (nextToken) params['nextToken'] = nextToken;
  
  // Retry logic with exponential backoff: 1s, 2s, 4s, 8s, 16s max
  const maxRetries = 5;
  const baseDelay = 1000; // 1 second
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await apiClient.get<SyncResponse>('/sync', { params });
      return res.data;
    } catch (error: any) {
      // Only retry on network errors, not on 4xx/5xx responses
      const isNetworkError = !error.response || error.code === 'ECONNABORTED' || error.code === 'ENOTFOUND';
      const isLastAttempt = attempt === maxRetries;
      
      if (!isNetworkError || isLastAttempt) {
        throw error;
      }
      
      // Exponential backoff with cap at 16 seconds
      const delay = Math.min(baseDelay * Math.pow(2, attempt), 16000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  // This should never be reached due to throw in loop, but TypeScript needs it
  throw new Error('Max retries exceeded');
}

/**
 * Get all updates before a given timestamp (tail sync - backfilling older emails).
 * Implements retry logic with exponential backoff for network errors.
 * 
 * @param before - ISO-8601 UTC timestamp to get updates before
 * @param nextToken - Optional pagination token
 * @param limit - Optional limit (default 100, max 500)
 * @returns SyncResponse with emails, labels, migrations, and pagination token
 */
export async function getUpdatesBefore(
  before: string,
  nextToken?: string,
  limit = 100,
): Promise<SyncResponse> {
  const params: Record<string, string | number> = { before, limit };
  if (nextToken) params['nextToken'] = nextToken;
  
  // Retry logic with exponential backoff: 1s, 2s, 4s, 8s, 16s max
  const maxRetries = 5;
  const baseDelay = 1000; // 1 second
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await apiClient.get<SyncResponse>('/sync', { params });
      return res.data;
    } catch (error: any) {
      // Only retry on network errors, not on 4xx/5xx responses
      const isNetworkError = !error.response || error.code === 'ECONNABORTED' || error.code === 'ENOTFOUND';
      const isLastAttempt = attempt === maxRetries;
      
      if (!isNetworkError || isLastAttempt) {
        throw error;
      }
      
      // Exponential backoff with cap at 16 seconds
      const delay = Math.min(baseDelay * Math.pow(2, attempt), 16000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  // This should never be reached due to throw in loop, but TypeScript needs it
  throw new Error('Max retries exceeded');
}

// ---------------------------------------------------------------------------
// Presigned blob URLs + fetch
// ---------------------------------------------------------------------------

/** Fetch a presigned GET URL then download the raw blob bytes. */
async function fetchPresignedBlob(presignedApiPath: string): Promise<ArrayBuffer> {
  const res = await apiClient.get<{ url: string }>(`/emails/${presignedApiPath}`);
  const { url } = res.data;
  const s3Res = await fetch(url);
  if (!s3Res.ok) throw new Error(`S3 fetch failed: ${s3Res.status}`);
  return s3Res.arrayBuffer();
}

export const getEmailHeader      = (ulid: string) => fetchPresignedBlob(`${ulid}/header`);
export const getEmailBody        = (ulid: string) => fetchPresignedBlob(`${ulid}/body`);
export const getEmailText        = (ulid: string) => fetchPresignedBlob(`${ulid}/text`);
export const getEmailEmbedding   = (ulid: string) => fetchPresignedBlob(`${ulid}/embedding`);
export const getEmailAttachments = (ulid: string) => fetchPresignedBlob(`${ulid}/attachments`);
export const getAttachmentBlob   = (ulid: string, attachmentId: string) => fetchPresignedBlob(`${ulid}/attachment/${attachmentId}`);

// ---------------------------------------------------------------------------
// Batch text fetch
// ---------------------------------------------------------------------------

export interface BatchTextResult {
  ulid: string;
  encryptedText: string | null;
}

/**
 * Batch fetch encrypted text blobs for multiple emails (up to 50 at a time).
 * The Lambda fetches all text blobs from S3 in parallel and returns them as base64.
 * This eliminates multiple round trips for indexing.
 */
export async function batchGetEmailText(ulids: string[]): Promise<BatchTextResult[]> {
  if (ulids.length === 0) {
    return [];
  }

  if (ulids.length > 50) {
    throw new Error('Maximum 50 ULIDs per request');
  }

  const res = await apiClient.post<{ texts: BatchTextResult[] }>('/emails/text/batch', { ulids });
  return res.data.texts;
}

// ---------------------------------------------------------------------------
// Presigned PUT for embedding batch upload
// ---------------------------------------------------------------------------

/**
 * Upload an encrypted embedding batch blob to S3.
 *
 * The server sets s3EmbeddingKey on every ulid in the batch to the same S3
 * key before returning the presigned URL, so GET /emails/{ulid}/embedding will
 * find the blob for any email in the batch.
 *
 * @param ulids         ULIDs of all emails included in this batch (max 100).
 * @param encryptedBlob Pre-encrypted batch blob from encryptBlob().
 */
export async function uploadEmbeddingsBatch(
  ulids: string[],
  encryptedBlob: ArrayBuffer,
): Promise<string> {
  if (ulids.length === 0) throw new Error('uploadEmbeddingsBatch: ulids must not be empty');

  // Ask the server to register the batch and return a presigned PUT URL.
  // The server updates s3EmbeddingKey for all ulids in a single call.
  const res = await apiClient.put<{ uploadUrl: string; s3EmbeddingKey: string }>(
    `/emails/${ulids[0]}/embedding`,
    { ulids },
  );

  const putRes = await fetch(res.data.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: encryptedBlob,
  });

  if (!putRes.ok) throw new Error(`Batch embedding upload failed: ${putRes.status}`);

  return res.data.s3EmbeddingKey;
}

// ---------------------------------------------------------------------------
// Flags / delete / send
// ---------------------------------------------------------------------------

export async function putEmailFlags(ulid: string, flags: FlagsBody): Promise<{ lastUpdatedAt: string; version: number }> {
  const res = await apiClient.put<{ lastUpdatedAt: string; version: number }>(`/emails/${ulid}/flags`, flags);
  return res.data;
}

export async function deleteEmail(ulid: string): Promise<void> {
  await apiClient.delete(`/emails/${ulid}`);
}

export async function restoreEmail(ulid: string): Promise<{ restoredTo: string }> {
  const res = await apiClient.post<{ restoredTo: string }>(`/emails/${ulid}/restore`);
  return res.data;
}

export async function sendEmail(body: SendEmailBody): Promise<{ messageId: string; lastUpdatedAt: string }> {
  const res = await apiClient.post<{ messageId: string; lastUpdatedAt: string }>('/emails/send', body);
  return res.data;
}

// ---------------------------------------------------------------------------
// Attachment staging (direct S3 upload)
// ---------------------------------------------------------------------------

/**
 * Request a presigned PUT URL for a client-encrypted attachment.
 * The server generates a ULID for the attachment and returns it alongside the upload URL.
 */
export async function getAttachmentUploadUrl(params: {
  emailId:     string;
  filename:    string;
  contentType: string;
  size:        number;
}): Promise<{ attachmentId: string; uploadUrl: string }> {
  const res = await apiClient.post<{ attachmentId: string; uploadUrl: string }>(
    '/attachments/upload-url',
    params,
  );
  return res.data;
}

/**
 * Upload AES-GCM encrypted attachment bytes directly to S3 via the presigned URL.
 * Reports progress via the onProgress callback (0–100).
 */
export function uploadEncryptedAttachment(
  uploadUrl: string,
  encryptedBytes: ArrayBuffer,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(`Upload failed: HTTP ${xhr.status}`));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
    xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));
    xhr.send(encryptedBytes);
  });
}

/** Remove a staged attachment (e.g. user removed it before sending). */
export async function deleteAttachment(emailId: string, attachmentId: string): Promise<void> {
  await apiClient.delete(`/attachments/${emailId}/${attachmentId}`).catch(() => { /* best effort */ });
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export interface SaveDraftBody {
  headerBlob:      string; // base64 AES-GCM encrypted with emailKey
  bodyBlob:        string;
  textBlob:        string;
  attachmentsBlob: string;
  wrappedEmailKey: string; // RSA-OAEP wrapped emailKey (base64)
  receivedAt?:     string; // ISO-8601
}

export async function saveDraft(ulid: string, body: SaveDraftBody): Promise<void> {
  await apiClient.put(`/drafts/${ulid}`, body);
}

export async function deleteDraft(ulid: string): Promise<void> {
  await apiClient.delete(`/drafts/${ulid}`);
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

export async function getCounts(): Promise<{ unreadInbox: number }> {
  const res = await apiClient.get<{ unreadInbox: number }>('/counts');
  return res.data;
}
// ---------------------------------------------------------------------------
// Bulk update
// ---------------------------------------------------------------------------

export interface BulkUpdateRequest {
  ulid: string;
  folderId?: string;
  labelIds?: string[];
  read?: boolean;
  version: number;
}

export interface BulkUpdateResult {
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
}

export interface BulkUpdateResponse {
  results: BulkUpdateResult[];
}

/**
 * Bulk update email flags for up to 100 emails.
 *
 * For failed updates due to version conflicts, the server performs a consistent
 * read to verify if the email already has the desired state. Only reports as
 * failure if the email still doesn't match the desired state.
 *
 * @param updates - Array of email updates (max 100)
 * @returns Results for each update with success/failure status
 */
export async function bulkUpdateEmails(updates: BulkUpdateRequest[]): Promise<BulkUpdateResponse> {
  if (updates.length === 0) {
    return { results: [] };
  }

  if (updates.length <= 100) {
    const res = await apiClient.post<BulkUpdateResponse>('/emails/bulk-update', { updates });
    return res.data;
  }

  // More than 100 — send sequential batches and merge results.
  const allResults: BulkUpdateResponse['results'] = [];
  for (let i = 0; i < updates.length; i += 100) {
    const res = await apiClient.post<BulkUpdateResponse>('/emails/bulk-update', { updates: updates.slice(i, i + 100) });
    allResults.push(...res.data.results);
  }
  return { results: allResults };
}

/**
 * Batch get email metadata for specific ULIDs (up to 100 at a time).
 * Used to refresh stale local data when version conflicts occur.
 */
export async function batchGetEmails(ulids: string[]): Promise<{ items: EmailMeta[] }> {
  if (ulids.length === 0) {
    return { items: [] };
  }

  if (ulids.length > 100) {
    throw new Error('Maximum 100 ULIDs per request');
  }

  const res = await apiClient.post<{ items: EmailMeta[] }>('/emails/batch-get', { ulids });
  return res.data;
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Push subscriptions
// ---------------------------------------------------------------------------

export interface PushSubscribePayload {
  deviceId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function subscribePush(payload: PushSubscribePayload): Promise<void> {
  await apiClient.post('/push/subscribe', payload);
}

export async function unsubscribePush(deviceId: string): Promise<void> {
  await apiClient.delete('/push/subscribe', { data: { deviceId } });
}
