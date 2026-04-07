/**
 * Blob #1 — Header blob (small; fetched with every message list row).
 * Contains all fields needed to render the inbox list view.
 */
export interface EmailHeaderBlob {
  subject: string;
  fromName: string;          // display name portion of From header (may be empty)
  fromAddress: string;       // bare email address from From header
  preview: string;           // first ~200 chars of plaintext body
  to: string[];              // recipient addresses from To header
  cc?:  string[];            // recipient addresses from Cc header (absent on older blobs)
  bcc?: string[];            // present only on draft blobs (server never sees BCC)
  date: string;              // ISO-8601
  listUnsubscribe?:     string; // raw List-Unsubscribe header value (inbound only)
  listUnsubscribePost?: string; // raw List-Unsubscribe-Post header (RFC 8058 one-click)
}

/**
 * Blob #2 — Body blob (large; only fetched when opening an email).
 * Full text + HTML; does not include attachments.
 */
export interface EmailBodyBlob {
  textBody: string;
  htmlBody: string;
}

/** Metadata for one attachment (no binary data). */
export interface AttachmentMeta {
  filename:     string;
  size:         number;
  contentType:  string;
  attachmentId: string;  // ULID; keys the binary blob at {userId}/attachments/{emailUlid}/{attachmentId}
  contentId?:   string;  // present on inline attachments (cid: references)
}

/**
 * Blob #3 — Text blob (for FTS5 full-text index rebuild on-device).
 * Wrapped in an object to keep the wire format consistent across all blobs.
 */
export interface EmailTextBlob {
  text: string;
}

/**
 * Blob #4 — Attachments blob: list of attachment metadata.
 * Filenames, sizes, MIME types — no binary data.
 */
export type EmailAttachmentsBlob = AttachmentMeta[];

/**
 * Blob #5 — Embedding stub written by the server at ingest time.
 * The Android client decrypts this, sees status='pending', computes real
 * chunk vectors locally, then uploads them via PUT /emails/{ulid}/embedding.
 */
export interface EmailEmbeddingStub {
  status: 'pending';
  emailUlid: string;
  createdAt: string;
}

/** Row from the `chase-users` DynamoDB table. */
export interface UserRecord {
  userId: string;
  email: string;
  /** PEM-encoded RSA public key (SPKI format, base64 PEM header/footer). */
  publicKey: string;
  encryptedPrivateKey: string;
  argon2Salt: string;
}

/**
 * Encrypted blob wire format (version 1).
 *
 * Layout (big-endian):
 *   1 byte  — version = 0x01
 *   2 bytes — encKeyLen (uint16): byte-length of the RSA-encrypted AES key
 *   N bytes — encKey: RSA-OAEP/SHA-256 ciphertext of the 32-byte AES-256 key
 *  12 bytes — iv: AES-256-GCM nonce
 *  16 bytes — authTag: AES-256-GCM authentication tag
 *   M bytes — ciphertext: AES-256-GCM encrypted JSON payload
 *
 * Android client decryption sequence:
 *   1. Read version byte, assert == 0x01
 *   2. Read encKeyLen (2 bytes), then read encKey (encKeyLen bytes)
 *   3. Decrypt encKey with device private key → 32-byte AES key
 *   4. Read iv (12 bytes), authTag (16 bytes), ciphertext (remaining bytes)
 *   5. AES-256-GCM decrypt ciphertext with {key, iv, authTag} → plaintext JSON
 *   6. Parse JSON as the appropriate blob type
 */
export const BLOB_VERSION = 0x01;
