/**
 * Mbox Worker Lambda
 * 
 * Processes batches of messages from mbox files using S3 byte-range requests.
 * This allows parallel processing of large mbox files without loading them
 * into memory.
 * 
 * Triggered by: SQS messages from Indexer Lambda
 * 
 * Flow:
 * 1. Receive batch metadata from SQS
 * 2. Use S3 GetObject with Range header to read only the assigned bytes
 * 3. Parse messages from the byte range
 * 4. Convert each message to .eml format with custom headers
 * 5. Upload to processing bucket for inbound processor
 * 6. Update progress in DynamoDB (with retry on conflict)
 */

import { SQSEvent, SQSRecord } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Readable } from 'stream';
import { ulid } from 'ulid';
import { createHash } from 'crypto';
import { 
  getMigrationState, 
  hashFolderOrLabelName,
} from '../migration/db-utils';
import { extractMboxFlags } from '../parse-lambda/mbox-parser';

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});

const EMAILS_TABLE = process.env.EMAILS_TABLE_NAME!;
const PROCESSING_BUCKET = process.env.PROCESSING_BUCKET_NAME!;
const MAX_RETRIES = 3;

interface BatchMessage {
  batchId: string;
  userId: string;
  migrationId: string;
  bucket: string;
  key: string;
  startByte: number;
  endByte: number;
  messageCount: number;
}

/**
 * Read a byte range from S3
 * 
 * Note: Byte ranges may split UTF-8 multi-byte characters at boundaries.
 * The indexer aligns boundaries to newlines to minimize this, but it can
 * still happen if a line is extremely long. Broken characters are replaced
 * with U+FFFD (�) which is acceptable for email content.
 */
async function readByteRange(
  bucket: string,
  key: string,
  startByte: number,
  endByte: number
): Promise<string> {
  console.log(`Reading bytes ${startByte}-${endByte} from s3://${bucket}/${key}`);
  
  const response = await s3.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    Range: `bytes=${startByte}-${endByte}`,
  }));
  
  const stream = response.Body as Readable;
  const chunks: Buffer[] = [];
  
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Split mbox content into individual messages
 * 
 * The content may contain multiple messages separated by "From " lines.
 * Uses array accumulation instead of string concatenation for better performance.
 */
function splitMessages(content: string): string[] {
  const messages: string[] = [];
  const currentLines: string[] = [];
  let inMessage = false;

  const lines = content.split('\n');

  for (const line of lines) {
    if (line.startsWith('From ')) {
      if (currentLines.length > 0) {
        messages.push(currentLines.join('\n'));
      }
      currentLines.length = 0;
      inMessage = true;
      // Skip the From_ envelope line
    } else {
      // ✅ Collect lines even before the first "From " line
      // The byte range may start mid-message, so the first fragment
      // is a valid partial message that begins with headers
      if (!inMessage && line.trim() === '') continue; // skip leading blank lines only
      currentLines.push(line);
      inMessage = true; // treat pre-"From_" content as a message fragment
    }
  }

  if (currentLines.length > 0) {
    messages.push(currentLines.join('\n'));
  }

  return messages;
}

/**
 * Extract folder and labels from email headers
 * 
 * Priority:
 * 1. X-Folder header (if present, use as folder)
 * 2. X-Gmail-Labels header (parse for folder and labels)
 * 
 * X-Gmail-Labels format: "Spam,Category Personal,Unread"
 * - First non-"Category X" value = folder
 * - "Category X" values = labels
 * - "Unread" = read status
 * 
 * Also extracts X-GM-THRID for Gmail thread ID preservation
 */
interface FolderLabels {
  folder: string | null;
  labels: string[];
  isRead: boolean;
  threadId: string | null;
}

function extractFolderAndLabels(message: string): FolderLabels {
  // Extract X-Folder header
  const xFolderMatch = message.match(/^X-Folder:\s*(.+)$/im);
  if (xFolderMatch) {
    const folder = xFolderMatch[1].trim();
    
    // Also check for Gmail thread ID
    const gmailThreadIdMatch = message.match(/^X-GM-THRID:\s*(\d+)$/im);
    const threadId = gmailThreadIdMatch ? gmailThreadIdMatch[1].trim() : null;
    
    return { folder, labels: [], isRead: true, threadId };
  }
  
  // Extract X-Gmail-Labels header
  const xGmailLabelsMatch = message.match(/^X-Gmail-Labels:\s*(.+)$/im);
  
  // Extract Gmail thread ID
  const gmailThreadIdMatch = message.match(/^X-GM-THRID:\s*(\d+)$/im);
  const threadId = gmailThreadIdMatch ? gmailThreadIdMatch[1].trim() : null;
  
  if (xGmailLabelsMatch) {
    const labelsStr = xGmailLabelsMatch[1].trim();
    const parts = labelsStr.split(',').map(s => s.trim()).filter(Boolean);
    
    let folder: string | null = null;
    const labels: string[] = [];
    let isRead = true; // Default to read
    
    for (const part of parts) {
      if (part === 'Unread') {
        isRead = false;
      } else if (part.startsWith('Category ')) {
        // Extract category name (e.g., "Category Personal" -> "Personal")
        const categoryName = part.substring(9).trim();
        if (categoryName) {
          labels.push(categoryName);
        }
      } else if (!folder) {
        // First non-category, non-unread value is the folder
        folder = part;
      }
    }
    
    return { folder, labels, isRead, threadId };
  }
  
  // No headers found - return defaults
  return { folder: null, labels: [], isRead: true, threadId };
}

/**
 * Add custom headers to preserve metadata
 * 
 * Strips the mbox "From " envelope line if present, then injects
 * custom headers at the beginning of the RFC 822 message.
 * 
 * IMPORTANT: Folder and label names are hashed with secretUUID to create
 * deterministic IDs. The actual names are encrypted and stored separately
 * by the indexer Lambda (not here).
 */
async function addCustomHeaders(
  message: string, 
  flags: string[], 
  migrationName: string,
  secretUUID: string
): Promise<string> {
  // Strip mbox "From " envelope line if present
  // Format: "From sender@example.com Mon Jan 01 00:00:00 2024"
  let rfc822Message = message;
  if (message.startsWith('From ')) {
    const firstNewline = message.indexOf('\n');
    if (firstNewline !== -1) {
      rfc822Message = message.slice(firstNewline + 1);
    }
  }
  
  // Extract folder and labels from email headers
  const { folder, labels, isRead: isReadFromHeaders, threadId } = extractFolderAndLabels(rfc822Message);
  
  // Check if message has Message-ID
  const hasMessageId = /^Message-ID:/im.test(rfc822Message);
  
  const customHeaders: string[] = [];
  
  // Generate stable Message-ID if missing
  if (!hasMessageId) {
    const hash = createHash('sha256').update(rfc822Message).digest('hex');
    customHeaders.push(`Message-ID: <${hash}@migration.chase-email>`);
  }
  
  // Add Gmail thread ID if present (for thread grouping in inbound processor)
  if (threadId) {
    customHeaders.push(`X-Chase-Thread-Id: ${threadId}`);
  }
  
  // Add folder as primary label if present
  if (folder) {
    const normalizedFolder = folder.toUpperCase();
    
    // Map common variations to default folders
    const folderMappings: Record<string, string> = {
      'INBOX': 'INBOX',
      'SENT': 'SENT',
      'SENT ITEMS': 'SENT',
      'SENT MESSAGES': 'SENT',
      'SENT MAIL': 'SENT',
      'ARCHIVE': 'ARCHIVE',
      'TRASH': 'TRASH',
      'DELETED': 'TRASH',
      'DELETED ITEMS': 'TRASH',
      'SPAM': 'SPAM',
      'JUNK': 'SPAM',
    };
    
    const mappedFolder = folderMappings[normalizedFolder];
    
    if (mappedFolder) {
      // Use reserved folder ID directly
      customHeaders.push(`X-Chase-Folder: ${mappedFolder}`);
    } else {
      // Hash custom folder name with secretUUID (folder record already created by indexer)
      const folderId = hashFolderOrLabelName(folder, secretUUID);
      customHeaders.push(`X-Chase-Folder: ${folderId}`);
    }
  }
  
  // Add category labels (hash each one - label records already created by indexer)
  for (const label of labels) {
    const labelId = hashFolderOrLabelName(label, secretUUID);
    customHeaders.push(`X-Chase-Label: ${labelId}`);
  }
  
  // Add STAR label if message is flagged
  const isStarred = flags.includes('flagged');
  if (isStarred) {
    customHeaders.push('X-Chase-Label: STAR');
  }
  
  // Determine read status: use header value if available, otherwise use mbox flags
  const isRead = isReadFromHeaders || flags.includes('read');
  if (isRead) {
    customHeaders.push('X-Chase-Read: true');
  }
  
  // Add migration name as a label (hash it - label record already created by indexer)
  if (migrationName) {
    const migrationLabelId = hashFolderOrLabelName(migrationName, secretUUID);
    customHeaders.push(`X-Chase-Label: ${migrationLabelId}`);
  }
  
  // Insert headers at the beginning of the RFC 822 message
  if (customHeaders.length > 0) {
    return customHeaders.join('\n') + '\n' + rfc822Message;
  }
  
  return rfc822Message;
}

/**
 * Process a single message
 */
async function processMessage(
  message: string,
  userId: string,
  migrationName: string,
  secretUUID: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Extract mbox flags (read status, etc.)
    const flags = extractMboxFlags(message);
    
    // Add custom headers (extracts folder/labels from message headers and hashes them)
    const emlContent = await addCustomHeaders(
      message, 
      flags, 
      migrationName, 
      secretUUID
    );
    
    // Generate unique message ID for S3 key
    const messageId = ulid();
    const key = `migration/${userId}/${messageId}.eml`;
    
    // Upload to processing bucket
    await s3.send(new PutObjectCommand({
      Bucket: PROCESSING_BUCKET,
      Key: key,
      Body: emlContent,
      ContentType: 'message/rfc822',
    }));
    
    return { success: true };
  } catch (error) {
    console.error('Error processing message:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Update migration progress with retry on conflict
 */
async function updateProgress(
  userId: string,
  successCount: number,
  errorCount: number,
  retryCount: number = 0
): Promise<void> {
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: EMAILS_TABLE,
      Key: marshall({
        PK: `USER#${userId}`,
        SK: 'MIGRATION#STATE',
      }),
      UpdateExpression: 'ADD processedMessages :success, errorCount :errors',
      ExpressionAttributeValues: marshall({
        ':success': successCount,
        ':errors': errorCount,
      }),
    }));
  } catch (error: any) {
    // Retry on throttling or conflict
    if (retryCount < MAX_RETRIES && 
        (error.name === 'ProvisionedThroughputExceededException' || 
         error.name === 'ThrottlingException')) {
      console.warn(`DynamoDB throttled, retrying (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      
      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 100));
      
      return updateProgress(userId, successCount, errorCount, retryCount + 1);
    }
    
    throw error;
  }
}

// Note: completeBatch function removed - batch-level tracking is unnecessary
// since we track aggregate progress atomically via updateProgress.

/**
 * Process a single SQS record
 */
async function processBatch(record: SQSRecord): Promise<void> {
  const batch: BatchMessage = JSON.parse(record.body);
  
  console.log(`Processing batch ${batch.batchId} with ${batch.messageCount} messages`);
  
  try {
    // Check if migration still exists (user may have cancelled)
    const migrationState = await getMigrationState(batch.userId);
    
    if (!migrationState) {
      console.log(`Migration cancelled for user ${batch.userId}, skipping batch ${batch.batchId}`);
      return; // Skip processing
    }
    
    // Get migration name and secretUUID for labeling and hashing
    const migrationName = migrationState.migrationName || 'Migration';
    const secretUUID = migrationState.secretUUID;
    
    if (!secretUUID) {
      console.error(`Migration ${batch.migrationId} missing secretUUID, cannot process batch`);
      throw new Error('Migration missing secretUUID');
    }
    
    // Read byte range from S3
    const content = await readByteRange(
      batch.bucket,
      batch.key,
      batch.startByte,
      batch.endByte
    );
    
    // Split into individual messages
    const messages = splitMessages(content);
    
    console.log(`Split byte range into ${messages.length} messages (expected ${batch.messageCount})`);
    
    // Process each message in parallel (they're independent S3 uploads)
    const results = await Promise.allSettled(
      messages.map(message => processMessage(
        message, 
        batch.userId,
        migrationName, 
        secretUUID
      ))
    );
    
    let successCount = 0;
    let errorCount = 0;
    
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.success) {
        successCount++;
      } else {
        if(result.status === 'rejected') {
        console.error(`ERROR while ingesting mbox message ${result.reason}.`);
      }
        errorCount++;
      }
    }
    
    console.log(`Batch ${batch.batchId}: ${successCount} success, ${errorCount} errors`);
    
    // Update progress (with retry on conflict)
    await updateProgress(batch.userId, successCount, errorCount);
    
    // Note: We don't write individual BATCH# completion records to DDB.
    // With thousands of batches per migration, that would create unnecessary
    // writes and storage. The aggregate progress is tracked atomically via
    // updateProgress (processedMessages counter).
    
  } catch (error) {
    console.error(`Error processing batch ${batch.batchId}:`, error);
    throw error; // Let SQS retry
  }
}

export async function handler(event: SQSEvent): Promise<void> {
  console.log(`Mbox Worker processing ${event.Records.length} batches`);
  
  // Process batches sequentially to avoid overwhelming DynamoDB
  // SQS will invoke multiple Lambda instances in parallel anyway
  for (const record of event.Records) {
    await processBatch(record);
  }
}
