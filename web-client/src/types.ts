/**
 * Shared TypeScript interfaces mirroring the server-side blob schemas.
 * These are the shapes of JSON payloads *after* decryption.
 */

export interface EmailHeaderBlob {
  subject:     string;
  fromName:    string;
  fromAddress: string;
  preview:     string;
  to:          string[];
  cc?:         string[]; // absent on blobs created before this field was added
  bcc?:        string[]; // present only on draft blobs (server never sees BCC)
  date:        string;   // ISO-8601
  listUnsubscribe?:     string; // raw List-Unsubscribe header value (inbound only)
  listUnsubscribePost?: string; // raw List-Unsubscribe-Post header (RFC 8058 one-click)
}

export interface EmailBodyBlob {
  textBody: string;
  htmlBody: string;
}

export interface AttachmentMeta {
  filename:     string;
  size:         number;
  contentType:  string;
  attachmentId: string;  // ULID — keys the binary at {userId}/attachments/{emailUlid}/{attachmentId}
  contentId?:   string;
}

export type EmailAttachmentsBlob = AttachmentMeta[];
