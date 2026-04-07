/**
 * inbound-email-processor Lambda
 *
 * Trigger: S3 ObjectCreated on raw-email-bucket, prefix `incoming/`
 *
 * Pipeline:
 *   1. Fetch raw .eml from S3.
 *   2. Parse with mailparser (subject, from, to, date, text, html, inReplyTo).
 *   3. Look up recipient's user record via UserEmailIndex GSI.
 *   4. Generate a ULID for this email.
 *   5. Resolve threadId — query LSI_MessageId for the In-Reply-To parent;
 *      inherit parent's threadId, or assign THREAD#<ulid> for a new root.
 *   6. Hybrid-encrypt (AES-256-GCM + RSA-OAEP) the parsed JSON payload.
 *   7. Write encrypted blobs → user-data-bucket (header, body, text, embedding, attachments,
 *      plus one blob per attachment binary at attachment-data/{emailUlid}/{index}.enc).
 *   8. Write metadata row to DynamoDB emails table.
 *   9. Increment unreadInbox counter on the COUNTS item (ADD — atomic).
 *  10. Send Web Push notification to each registered device.
 *  11. Publish SNS notification to per-user topic (best-effort).
 *  12. Delete raw .eml from raw-email-bucket.
 *
 * Error handling:
 *   Any exception → copy raw .eml to `dead-letter/` prefix, then delete from `incoming/`.
 *   Never silently drops email.
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import {
  DynamoDBClient,
  QueryCommand,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { simpleParser, type AddressObject } from 'mailparser';
import { monotonicFactory } from 'ulid';
import webpush from 'web-push';
import type { S3Event } from 'aws-lambda';
import type { Readable } from 'stream';

/** Strip HTML tags and decode entities for use as plain-text preview. */
function htmlToPlainText(html: string): string {
  return html
    // Drop non-visible blocks entirely
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    // Block elements → newline so words don't run together
    .replace(/<\/?(p|div|br|tr|li|h[1-6]|blockquote|pre)[^>]*>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode numeric entities (&#8199; &#x200B; etc.)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const cp = parseInt(hex, 16);
      // Drop invisible/zero-width/combining codepoints
      if (cp === 0 || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2060 && cp <= 0x206f) ||
          (cp >= 0x300 && cp <= 0x36f) || cp === 0xfeff || cp === 0xad) return '';
      return String.fromCodePoint(cp);
    })
    .replace(/&#([0-9]+);/gi, (_, dec) => {
      const cp = parseInt(dec, 10);
      if (cp === 0 || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2060 && cp <= 0x206f) ||
          (cp >= 0x300 && cp <= 0x36f) || cp === 0xfeff || cp === 0xad) return '';
      return String.fromCodePoint(cp);
    })
    // Named entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rdquo;/g, '\u201d')
    .replace(/&ldquo;/g, '\u201c')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '')
    // Final collapse to single line for preview
    .replace(/\s+/g, ' ')
    .trim();
}

import { hybridEncrypt } from '../shared/encrypt';
import type {
  EmailHeaderBlob,
  EmailBodyBlob,
  EmailTextBlob,
  EmailAttachmentsBlob,
  EmailEmbeddingStub,
  UserRecord,
} from './types';

// ---------------------------------------------------------------------------
// Module-level singletons — reused across warm invocations
// ---------------------------------------------------------------------------

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});
const sns = new SNSClient({});
const ssm = new SSMClient({});

// monotonicFactory() guarantees ULIDs are strictly increasing within one process.
const nextUlid = monotonicFactory();

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const RAW_BUCKET = process.env.RAW_EMAIL_BUCKET_NAME!;
const USER_DATA_BUCKET = process.env.USER_DATA_BUCKET_NAME!;
const EMAILS_TABLE = process.env.EMAILS_TABLE_NAME!;
const USERS_TABLE = process.env.USERS_TABLE_NAME!;
// Prefix for per-user SNS topics, e.g. "arn:aws:sns:us-east-1:123456789012:chase-email-new-"
const SNS_TOPIC_ARN_PREFIX = process.env.SNS_TOPIC_ARN_PREFIX!;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY!;
const VAPID_PRIVATE_KEY_PARAM = process.env.VAPID_PRIVATE_KEY_PARAM!;
// Domain used to identify the local recipient when To header contains a forwarded address
const RECIPIENT_DOMAIN = (process.env.RECIPIENT_DOMAIN ?? '').toLowerCase();

// ---------------------------------------------------------------------------
// Cold-start: fetch VAPID private key from SSM and configure web-push.
// This runs once per Lambda container; subsequent invocations reuse the result.
// ---------------------------------------------------------------------------

let vapidReady = false;

async function ensureVapidConfigured(): Promise<void> {
  if (vapidReady) return;
  const res = await ssm.send(new GetParameterCommand({
    Name: VAPID_PRIVATE_KEY_PARAM,
    WithDecryption: true,
  }));
  const vapidPrivateKey = res.Parameter?.Value;
  if (!vapidPrivateKey) throw new Error('VAPID private key not found in SSM');
  webpush.setVapidDetails(
    `mailto:${process.env['VAPID_ADMIN_EMAIL'] ?? `admin@${process.env['RECIPIENT_DOMAIN']}`}`,
    VAPID_PUBLIC_KEY,
    vapidPrivateKey,
  );
  vapidReady = true;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event: S3Event): Promise<void> => {
  await ensureVapidConfigured();

  for (const record of event.Records) {
    // S3 URL-encodes the key; spaces become '+' in some SDKs.
    const rawKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    try {
      await processEmail(rawKey);
    } catch (err) {
      console.error(`[ingest] Failed processing ${rawKey}:`, err);
      await moveToDeadLetter(rawKey);
      // Re-throw so Lambda marks this invocation as failed and retries
      throw err;
    }
  }
};

// ---------------------------------------------------------------------------
// Core pipeline
// ---------------------------------------------------------------------------

async function processEmail(rawKey: string): Promise<void> {
  // ── 1. Fetch raw .eml ────────────────────────────────────────────────────
  const getRes = await s3.send(new GetObjectCommand({ Bucket: RAW_BUCKET, Key: rawKey }));
  const rawEml = await streamToBuffer(getRes.Body as Readable);

  // ── 2. Parse ─────────────────────────────────────────────────────────────
  const parsed = await simpleParser(rawEml);

  const subject = parsed.subject ?? '(no subject)';
  const fromAddr = parsed.from?.value?.[0];
  const fromName = fromAddr?.name ?? '';
  const fromAddress = fromAddr?.address ?? '';
  const messageId = parsed.messageId ?? rawKey;
  const inReplyTo = parsed.inReplyTo ?? undefined; // absent on thread roots
  const receivedAt = (parsed.date ?? new Date()).toISOString();
  const htmlBody = typeof parsed.html === 'string' ? parsed.html : '';
  // Prefer HTML-extracted text: it always has the full content (including styled
  // headers, destination names, etc. that marketing emails omit from their
  // plain-text alternative). Fall back to parsed.text for plain-text-only emails.
  const htmlText = htmlBody ? htmlToPlainText(htmlBody) : '';
  const textBody = htmlText || parsed.text || '';
  const preview = textBody.replace(/\s+/g, ' ').trim().slice(0, 200);

  // Flatten To and Cc address objects into plain email strings.
  const toAddresses = flattenAddresses(
    parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]) : [],
  );
  const ccAddresses = flattenAddresses(
    parsed.cc ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]) : [],
  );

  // Attachment metadata (no binary data) and binary buffers.
  // Generate a ULID for each attachment so binaries can be addressed by ID rather than index.
  const attachments = (parsed.attachments ?? []);
  const attachmentMeta: EmailAttachmentsBlob = attachments.map(a => ({
    filename:     typeof a.filename === 'string' ? a.filename : 'attachment',
    size:         a.size,
    contentType:  a.contentType,
    attachmentId: nextUlid(),
    ...(typeof a.contentId === 'string' ? { contentId: a.contentId } : {}),
  }));

  // ── 2b. Extract List-Unsubscribe headers ─────────────────────────────────
  // Stored encrypted in the header blob so the client can render an unsubscribe
  // button without ever exposing the value server-side.
const luLine = parsed.headerLines?.find(h => h.key === 'list-unsubscribe');
const listUnsubscribe = luLine
  ? luLine.line.replace(/^list-unsubscribe\s*:\s*/i, '').trim() || undefined
  : undefined;

const luPostLine = parsed.headerLines?.find(h => h.key === 'list-unsubscribe-post');
const listUnsubscribePost = luPostLine
  ? luPostLine.line.replace(/^list-unsubscribe-post\s*:\s*/i, '').trim() || undefined
  : undefined;

  // ── 2c. Extract Chase Email custom headers (migration flags) ─────────────
  // X-Chase-Read is added by the Worker Lambda during migration to preserve
  // mbox flag state (read status).
  // X-Chase-Folder contains the folder name for migration emails.
  // X-Chase-Label contains the label name(s) - can have multiple headers for
  // multiple labels (e.g., folder label + STAR label for flagged messages).
  // X-Chase-Thread-Id contains the thread ID for thread grouping.
  const chaseRead = String(parsed.headers.get('x-chase-read') ?? '').trim().toLowerCase();
  const chaseFolder = String(parsed.headers.get('x-chase-folder') ?? '').trim();
  const chaseLabels = parsed.headers.get('x-chase-label');
  const chaseThreadId = String(parsed.headers.get('x-chase-thread-id') ?? '').trim();
  const isReadFromMigration = chaseRead === 'true';
  
  // Handle multiple X-Chase-Label headers (e.g., folder + STAR)
  const labelsFromMigration: string[] = [];
  if (chaseLabels) {
    if (Array.isArray(chaseLabels)) {
      // Multiple headers
      labelsFromMigration.push(...chaseLabels.map(l => String(l).trim()).filter(Boolean));
    } else {
      // Single header
      const label = String(chaseLabels).trim();
      if (label) labelsFromMigration.push(label);
    }
  }

  // ── 2d. Detect spam/virus via SES verdict headers ────────────────────────
  // SES adds X-SES-Spam-Verdict and X-SES-Virus-Verdict to every email before
  // delivering it to S3 (distinct from the scanEnabled receipt-rule filter,
  // which only rejects the most obviously malicious mail before storage).
  const spamVerdict  = String(parsed.headers.get('x-ses-spam-verdict')  ?? '').trim().toUpperCase();
  const virusVerdict = String(parsed.headers.get('x-ses-virus-verdict') ?? '').trim().toUpperCase();
  const isSpam = spamVerdict === 'FAIL' || virusVerdict === 'FAIL';
  
  // For migration emails, use X-Chase-Folder if present, otherwise default to INBOX
  // For incoming emails, use spam detection
  let folderId = isSpam ? 'SPAM' : 'INBOX';

  // ── 3. Determine user(s) (migration vs incoming) ─────────────────────────────
  // Migration emails are stored at: migration/{userId}/{messageId}.eml
  // Incoming emails are stored at: incoming/{messageId}.eml
  
  interface RecipientInfo {
    userId: string;
    publicKey: string;
    recipientEmail: string;
  }
  
  const recipients: RecipientInfo[] = [];
  const isMigration = rawKey.startsWith('migration/');
  
  if (isMigration) {
    // Migration email - extract userId from path
    const pathParts = rawKey.split('/');
    if (pathParts.length !== 3) {
      throw new Error(`Invalid migration key format: ${rawKey}`);
    }
    const userId = pathParts[1];
    
    // Look up user by ID to get public key
    const user = await lookupUserById(userId);
    if (!user) {
      throw new Error(`No user record for userId ${userId}`);
    }
    
    recipients.push({
      userId: user.userId,
      publicKey: user.publicKey,
      recipientEmail: user.email,
    });
    
    // Use X-Chase-Folder for migration emails if present
    if (chaseFolder) {
      const defaultFolders = ['INBOX', 'SENT', 'ARCHIVE', 'TRASH', 'SPAM', 'DRAFTS'];
      const normalized = chaseFolder.toUpperCase();
      if (defaultFolders.includes(normalized)) {
        folderId = normalized;
      } else if (/^[a-zA-Z0-9_-]{1,64}$/.test(chaseFolder)) {
        // Custom folder ID: allow alphanumeric, hyphens, underscores, max 64 chars
        folderId = chaseFolder;
      }
      // Invalid format: silently fall through to default folderId (INBOX)
    }
  } else {
    // Incoming email — extract ALL local recipients on our domain
    const deliveredTo = String(parsed.headers.get('delivered-to') ?? '').trim();
    const xOriginalTo = String(parsed.headers.get('x-original-to') ?? '').trim();
    const xForwardedTo = String(parsed.headers.get('x-forwarded-to') ?? '').trim();

    // Proton Mail SRS Return-Path: remosewa=pm.me+chase=wilsonhq.net@forward.protonmail.ch
    const returnPath = String(parsed.headers.get('return-path') ?? '').trim();
    const srsMatch = returnPath.match(/\+([^=@+]+)=([^@+]+)@/);
    const srsRecipient = srsMatch ? `${srsMatch[1]}@${srsMatch[2]}` : undefined;

    // Received header may contain: "for chase@wilsonhq.net"
    const receivedHeader = String(parsed.headers.get('received') ?? '').trim();
    const receivedForMatch = receivedHeader.match(/\bfor\s+<?([^\s>;]+@[^\s>;>]+)>?/i);
    const receivedForRecipient = receivedForMatch ? receivedForMatch[1] : undefined;

    const allCandidates: string[] = [
      ...toAddresses,
      ...ccAddresses,
      ...(deliveredTo ? [deliveredTo] : []),
      ...(xOriginalTo ? [xOriginalTo] : []),
      ...(xForwardedTo ? [xForwardedTo] : []),
      ...(srsRecipient ? [srsRecipient] : []),
      ...(receivedForRecipient ? [receivedForRecipient] : []),
    ];

    // Extract ALL addresses on our domain (deduplicated)
    const localAddresses = RECIPIENT_DOMAIN
      ? [...new Set(allCandidates.filter(a => a.toLowerCase().endsWith(`@${RECIPIENT_DOMAIN}`)))]
      : [];
    
    // If no local addresses found, fall back to first candidate (backward compatibility)
    const recipientEmails = localAddresses.length > 0 ? localAddresses : [allCandidates[0]];

    if (!recipientEmails.length || !recipientEmails[0]) {
      throw new Error(`No recognisable To address in message ${messageId}`);
    }

    // Look up all local recipients
    for (const recipientEmail of recipientEmails) {
      const user = await lookupUserByEmail(recipientEmail);
      if (user) {
        recipients.push({
          userId: user.userId,
          publicKey: user.publicKey,
          recipientEmail,
        });
      } else {
        console.warn(`[ingest] No user record for recipient <${recipientEmail}>, skipping`);
      }
    }

    if (recipients.length === 0) {
      throw new Error(`No valid user records found for any recipients in message ${messageId}`);
    }
  }

  console.log(`[ingest] Processing message ${messageId} for ${recipients.length} recipient(s)`);

  // ── 4-12. Process email for each recipient ────────────────────────────────
  for (const recipient of recipients) {
    await processEmailForRecipient({
      recipient,
      messageId,
      subject,
      fromName,
      fromAddress,
      toAddresses,
      ccAddresses,
      receivedAt,
      textBody,
      htmlBody,
      preview,
      attachments,
      attachmentMeta,
      listUnsubscribe,
      listUnsubscribePost,
      inReplyTo,
      chaseThreadId,
      isReadFromMigration,
      labelsFromMigration,
      folderId,
      isSpam,
      isMigration,
    });
  }

  // ── 13. Delete raw .eml ────────────────────────────────────────────────────
  await s3.send(new DeleteObjectCommand({ Bucket: RAW_BUCKET, Key: rawKey }));

  console.log(`[ingest] OK message=${messageId} recipients=${recipients.length}`);
}

// ---------------------------------------------------------------------------
// Process email for a single recipient
// ---------------------------------------------------------------------------

interface ProcessRecipientParams {
  recipient: {
    userId: string;
    publicKey: string;
    recipientEmail: string;
  };
  messageId: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  receivedAt: string;
  textBody: string;
  htmlBody: string;
  preview: string;
  attachments: any[];
  attachmentMeta: EmailAttachmentsBlob;
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
  inReplyTo?: string;
  chaseThreadId: string;
  isReadFromMigration: boolean;
  labelsFromMigration: string[];
  folderId: string;
  isSpam: boolean;
  isMigration: boolean;
}

async function processEmailForRecipient(params: ProcessRecipientParams): Promise<void> {
  const {
    recipient,
    messageId,
    subject,
    fromName,
    fromAddress,
    toAddresses,
    ccAddresses,
    receivedAt,
    textBody,
    htmlBody,
    preview,
    attachments,
    attachmentMeta,
    listUnsubscribe,
    listUnsubscribePost,
    inReplyTo,
    chaseThreadId,
    isReadFromMigration,
    labelsFromMigration,
    folderId,
    isSpam,
    isMigration,
  } = params;

  const { userId, publicKey } = recipient;

  // ── 3b. Idempotency guard ─────────────────────────────────────────────────
  // If this message was already processed for this user (e.g. Lambda retry or DLQ redrive)
  // skip silently.
  const dupCheck = await ddb.send(new QueryCommand({
    TableName: EMAILS_TABLE,
    IndexName: 'LSI_MessageId',
    KeyConditionExpression: 'PK = :pk AND messageId = :mid',
    ExpressionAttributeValues: marshall({ ':pk': `USER#${userId}`, ':mid': messageId }),
    Limit: 1,
    ProjectionExpression: 'SK',
  }));
  if (dupCheck.Items?.length) {
    console.log(`[ingest] Duplicate: ${messageId} already stored for ${userId}. Skipping.`);
    return;
  }

  // ── 4. Generate ULID ──────────────────────────────────────────────────────
  const emailUlid = nextUlid();

  // ── 5. Resolve threadId ───────────────────────────────────────────────────
  let threadId: string;
  
  if (chaseThreadId) {
    threadId = `mig-${chaseThreadId}`;
  } else {
    threadId = await resolveThreadId(userId, inReplyTo);
  }

  // ── 6. Encrypt all 5 metadata blobs ──────────────────────────────────────
  const enc = (obj: unknown) =>
    hybridEncrypt(Buffer.from(JSON.stringify(obj), 'utf8'), publicKey);

  const headerBlob: EmailHeaderBlob = {
    subject, fromName, fromAddress, preview,
    to: toAddresses,
    ...(ccAddresses.length ? { cc: ccAddresses } : {}),
    date: receivedAt,
    ...(listUnsubscribe     ? { listUnsubscribe }     : {}),
    ...(listUnsubscribePost ? { listUnsubscribePost } : {}),
  };
  const bodyBlob: EmailBodyBlob = { textBody, htmlBody };
  const textBlob: EmailTextBlob = { text: textBody };
  const attachmentsBlob: EmailAttachmentsBlob = attachmentMeta;
  const embeddingStub: EmailEmbeddingStub = { status: 'pending', emailUlid, createdAt: receivedAt };

  const headerKey      = `${userId}/headers/${emailUlid}.enc`;
  const bodyKey        = `${userId}/bodies/${emailUlid}.enc`;
  const textKey        = `${userId}/text/${emailUlid}.enc`;
  const attachmentsKey = `${userId}/attachments/${emailUlid}.enc`;

  // ── 7. Write all blobs to user-data-bucket ─────────────────────────────────
  const putBlob = (key: string, body: Buffer, tag: string) =>
    s3.send(new PutObjectCommand({
      Bucket: USER_DATA_BUCKET,
      Key: key,
      Body: body,
      ContentType: 'application/octet-stream',
      Tagging: `type=${tag}`,
    }));

  // Encrypt and upload attachment binaries
  const attachmentBinaryUploads = attachments.map((a, i) =>
    putBlob(
      `${userId}/attachments/${emailUlid}/${attachmentMeta[i]!.attachmentId}`,
      hybridEncrypt(a.content, publicKey),
      'attachment-data',
    ),
  );

  // Encrypt header blob and store for DynamoDB
  const encryptedHeader = enc(headerBlob);
  const headerBlobBase64 = encryptedHeader.toString('base64');

  await Promise.all([
    putBlob(headerKey,      encryptedHeader,      'header'),
    putBlob(bodyKey,        enc(bodyBlob),        'body'),
    putBlob(textKey,        enc(textBlob),        'text'),
    putBlob(attachmentsKey, enc(attachmentsBlob), 'attachments'),
    ...attachmentBinaryUploads,
  ]);

  // ── 7b. Apply migration labels ──────────────────────────────────────────────
  const labelIds: string[] = labelsFromMigration;
  
  const now = new Date();
  const lastUpdatedAt = isMigration
    ? new Date(now.getTime() + 120000).toISOString() // 2 minutes in future for migrations
    : now.toISOString();
  
  const isTrash = folderId === 'TRASH';
  const ttl = isTrash 
    ? Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)
    : undefined;
  const restoreFolderId = isTrash ? 'INBOX' : undefined;
  
  // ── 8. Write DynamoDB metadata ─────────────────────────────────────────────
  await ddb.send(
    new PutItemCommand({
      TableName: EMAILS_TABLE,
      Item: marshall({
        PK: `USER#${userId}`,
        SK: `EMAIL#${emailUlid}`,
        userId,
        folderId,
        labelIds,
        messageId,
        threadId,
        s3HeaderKey:      headerKey,
        headerBlob:       headerBlobBase64, // Store encrypted header inline for fast sync
        s3BodyKey:        bodyKey,
        s3TextKey:        textKey,
        s3EmbeddingKey:   null,
        s3AttachmentsKey: attachmentsKey,
        hasAttachments:   attachmentMeta.length > 0 ? 1 : 0,
        read: isReadFromMigration,
        receivedAt,
        lastUpdatedAt,
        version: 1,
        ...(restoreFolderId ? { restoreFolderId } : {}),
        ...(ttl ? { ttl } : {}),
      }),
      ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
    }),
  );

  // ── 9. Increment unreadInbox counter ──────────────────────────────────────
  if (!isSpam && !isReadFromMigration && !isMigration) {
    try {
      await ddb.send(new UpdateItemCommand({
        TableName: EMAILS_TABLE,
        Key: marshall({ PK: `USER#${userId}`, SK: 'COUNTS' }),
        UpdateExpression: 'ADD unreadInbox :one',
        ExpressionAttributeValues: marshall({ ':one': 1 }),
      }));
    } catch (cntErr) {
      console.warn(`[ingest] Failed to increment unread counter for user ${userId}:`, cntErr);
    }
  }

  // ── 10. Send Web Push ─────────────────────────────────────────────────────
  if (!isSpam && !isMigration) {
    try {
      const pushSubs = await fetchPushSubscriptions(userId);
      const payload = JSON.stringify({
        title: 'New email',
        ulid: emailUlid,
        userId,
        // Encrypted header blob — service worker decrypts client-side using IndexedDB key.
        // Server never transmits plaintext content.
        encryptedHeader: headerBlobBase64,
        sentAt: new Date().toISOString(), // Used by SW to discard stale notifications on startup
      });
      await Promise.all(pushSubs.map(sub => sendPushNotification(userId, sub, payload)));
    } catch (pushErr) {
      console.warn(`[ingest] Push notification failed for user ${userId}:`, pushErr);
    }
  }

  // ── 11. Notify client via SNS ─────────────────────────────────────────────
  if (!isSpam && !isMigration) {
    try {
      await sns.send(
        new PublishCommand({
          TopicArn: `${SNS_TOPIC_ARN_PREFIX}${userId}`,
          Message: JSON.stringify({ userId, emailUlid, folderId, receivedAt, threadId }),
          MessageAttributes: {
            userId: { DataType: 'String', StringValue: userId },
            eventType: { DataType: 'String', StringValue: 'NEW_EMAIL' },
          },
        }),
      );
    } catch (snsErr) {
      console.warn(`[ingest] SNS publish failed for user ${userId}:`, snsErr);
    }
  }

  console.log(`[ingest] OK emailUlid=${emailUlid} folderId=${folderId} threadId=${threadId} user=${userId}`);
}

// ---------------------------------------------------------------------------
// Web Push helpers
// ---------------------------------------------------------------------------

interface PushSubscriptionRecord {
  deviceId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

async function fetchPushSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: EMAILS_TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: marshall({
      ':pk': `USER#${userId}`,
      ':prefix': 'PUSH#',
    }),
    ProjectionExpression: 'SK, endpoint, p256dh, #auth',
    ExpressionAttributeNames: { '#auth': 'auth' },
  }));

  return (res.Items ?? []).map(item => {
    const rec = unmarshall(item);
    return {
      deviceId: (rec['SK'] as string).replace('PUSH#', ''),
      endpoint: rec['endpoint'] as string,
      p256dh: rec['p256dh'] as string,
      auth: rec['auth'] as string,
    };
  });
}

async function sendPushNotification(
  userId: string,
  sub: PushSubscriptionRecord,
  payload: string,
): Promise<void> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload,
    );
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 410) {
      // Subscription expired — TTL-expire the stale record
      try {
        await ddb.send(new UpdateItemCommand({
          TableName: EMAILS_TABLE,
          Key: marshall({ PK: `USER#${userId}`, SK: `PUSH#${sub.deviceId}` }),
          UpdateExpression: 'SET #ttl = :ttl',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: marshall({ ':ttl': Math.floor(Date.now() / 1000) + 60 }),
        }));
      } catch {
        // best-effort cleanup
      }
    }
    console.warn(`[ingest] Push send failed for device ${sub.deviceId}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Thread resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the threadId for an incoming message.
 *
 * Queries LSI_MessageId within the user's partition to find the parent message
 * identified by `inReplyTo`. If the parent exists, its threadId is inherited
 * (correct even for deeply nested threads, since each reply inherits the root's
 * threadId transitively). If there is no In-Reply-To header or the parent has
 * not yet arrived, a fresh THREAD#<ulid> is assigned.
 */
async function resolveThreadId(
  userId: string,
  inReplyTo: string | undefined,
): Promise<string> {
  if (inReplyTo) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: EMAILS_TABLE,
        IndexName: 'LSI_MessageId',
        KeyConditionExpression: 'PK = :pk AND messageId = :mid',
        ExpressionAttributeValues: marshall({
          ':pk': `USER#${userId}`,
          ':mid': inReplyTo,
        }),
        ProjectionExpression: 'threadId',
        Limit: 1,
      }),
    );

    if (res.Items?.length) {
      const { threadId } = unmarshall(res.Items[0]) as { threadId: string };
      if (threadId) return threadId;
    }
  }

  // Thread root: no In-Reply-To, or parent not found in this mailbox yet.
  return `THREAD#${nextUlid()}`;
}

// ---------------------------------------------------------------------------
// DynamoDB helper
// ---------------------------------------------------------------------------

async function lookupUserByEmail(email: string): Promise<UserRecord | null> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: 'UserEmailIndex',
      KeyConditionExpression: 'email = :email',
      ExpressionAttributeValues: marshall({ ':email': email }),
      Limit: 1,
    }),
  );

  if (!res.Items?.length) return null;

  const it = res.Items[0];
  return {
    userId: it['userId']?.S ?? '',
    email: it['email']?.S ?? '',
    publicKey: it['publicKey']?.S ?? '',
    encryptedPrivateKey: it['encryptedPrivateKey']?.S ?? '',
    argon2Salt: it['argon2Salt']?.S ?? '',
  };
}

async function lookupUserById(userId: string): Promise<UserRecord | null> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: USERS_TABLE,
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: marshall({ ':userId': userId }),
      Limit: 1,
    }),
  );

  if (!res.Items?.length) return null;

  const it = res.Items[0];
  return {
    userId: it['userId']?.S ?? '',
    email: it['email']?.S ?? '',
    publicKey: it['publicKey']?.S ?? '',
    encryptedPrivateKey: it['encryptedPrivateKey']?.S ?? '',
    argon2Salt: it['argon2Salt']?.S ?? '',
  };
}

// ---------------------------------------------------------------------------
// Dead-letter handling
// ---------------------------------------------------------------------------

async function moveToDeadLetter(key: string): Promise<void> {
  // Copy to dead-letter/ for inspection but do NOT delete from the source.
  // Keeping the object in the source allows Lambda retries (and DLQ redrives)
  // to find it. The 7-day lifecycle rule provides final cleanup.
  
  // Strip the prefix (incoming/ or migration/) to get the base filename
  const baseKey = key.replace(/^(incoming|migration)\//, '');
  const destKey = `dead-letter/${baseKey}`;
  
  try {
    await s3.send(
      new CopyObjectCommand({
        Bucket: RAW_BUCKET,
        CopySource: `${RAW_BUCKET}/${key}`,
        Key: destKey,
      }),
    );
    console.error(`[ingest] Copied failed email to dead-letter: ${destKey}`);
  } catch (err) {
    console.error(`[ingest] Could not copy ${key} to dead-letter:`, err);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function flattenAddresses(addrObjects: AddressObject[]): string[] {
  return addrObjects
    .flatMap((ao) => ao.value)
    .map((a) => a.address)
    .filter((a): a is string => Boolean(a));
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}
