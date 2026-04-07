/**
 * Mbox Indexer Lambda
 * 
 * Scans mbox files to find message boundaries (From_ lines) and creates
 * a work queue of byte ranges for parallel processing.
 * 
 * This allows processing arbitrarily large mbox files without loading them
 * into memory - each worker Lambda only reads its assigned byte range.
 * 
 * Triggered by: S3 ObjectCreated on mbox bucket
 * 
 * Flow:
 * 1. Stream mbox file from S3
 * 2. Scan for "From " line boundaries
 * 3. Record byte offsets for each message
 * 4. Create batches of messages (e.g., 50 messages per batch)
 * 5. Write batch metadata to DynamoDB
 * 6. Send SQS message for each batch
 * 7. Worker Lambdas process batches in parallel using byte-range requests
 */

import { S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Readable } from 'stream';
import { ulid } from 'ulid';
import { 
  getMigrationState, 
  hashFolderOrLabelName, 
  getUserPublicKey, 
  encryptName,
  createOrUpdateFolder,
  createOrUpdateLabel,
} from '../migration/db-utils';

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});

const EMAILS_TABLE = process.env.EMAILS_TABLE_NAME!;
const WORKER_QUEUE_URL = process.env.WORKER_QUEUE_URL!;
const MESSAGES_PER_BATCH = 100; // Process 100 messages per worker invocation

interface MessageBoundary {
  startByte: number;
  endByte: number;
  messageIndex: number;
}

interface BatchMetadata {
  batchId: string;
  bucket: string;
  key: string;
  userId: string;
  migrationId: string;
  filename: string;
  startByte: number;
  endByte: number;
  messageCount: number;
  messageIndices: number[];
}

/**
 * Parse S3 key to extract metadata
 * Format: mbox/{userId}/{migrationId}/{filename}.mbox
 */
function parseS3Key(key: string): { userId: string; migrationId: string; filename: string } {
  const parts = key.split('/');
  if (parts.length !== 4 || parts[0] !== 'mbox') {
    throw new Error(`Invalid S3 key format: ${key}`);
  }
  return {
    userId: parts[1],
    migrationId: parts[2],
    filename: parts[3],
  };
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
 * - "Unread" = read status (ignored here, just collecting names)
 */
interface FolderLabels {
  folder: string | null;
  labels: string[];
}

function extractFolderAndLabels(message: string): FolderLabels {
  // Extract X-Folder header
  const xFolderMatch = message.match(/^X-Folder:\s*(.+)$/im);
  if (xFolderMatch) {
    const folder = xFolderMatch[1].trim();
    return { folder, labels: [] };
  }
  
  // Extract X-Gmail-Labels header
  const xGmailLabelsMatch = message.match(/^X-Gmail-Labels:\s*(.+)$/im);
  
  if (xGmailLabelsMatch) {
    const labelsStr = xGmailLabelsMatch[1].trim();
    const parts = labelsStr.split(',').map(s => s.trim()).filter(Boolean);
    
    let folder: string | null = null;
    const labels: string[] = [];
    
    for (const part of parts) {
      if (part === 'Unread') {
        // Skip - not a folder or label name
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
    
    return { folder, labels };
  }
  
  // No headers found - return defaults
  return { folder: null, labels: [] };
}

/**
 * Scan mbox file to find message boundaries AND extract unique folders/labels
 * 
 * Mbox format uses "From " at the start of a line as the message separator.
 * We track byte offsets carefully to support byte-range requests.
 * 
 * Boundaries are aligned to newlines (specifically, to "From " lines) to
 * avoid splitting UTF-8 multi-byte characters. This works because mbox
 * messages are line-oriented and "From " always starts a new line.
 * 
 * Also collects unique folder and label names for encryption.
 */
async function scanMessageBoundaries(
  bucket: string, 
  key: string
): Promise<{ boundaries: MessageBoundary[]; folders: Set<string>; labels: Set<string> }> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const stream = response.Body as Readable;

  const boundaries: MessageBoundary[] = [];
  const folders = new Set<string>();
  const labels = new Set<string>();
  
  let absoluteOffset = 0;
  let currentMessageStart = 0;
  let messageIndex = 0;
  let isFirstLine = true;
  let byteBuffer = Buffer.alloc(0);
  let currentMessageLines: string[] = [];

  for await (const chunk of stream) {
    // ✅ Work on raw bytes — never decode to string for offset tracking
    byteBuffer = Buffer.concat([byteBuffer, Buffer.from(chunk)]);

    let newlineIdx: number;
    while ((newlineIdx = byteBuffer.indexOf(0x0a)) !== -1) {
      // Extract line bytes (including the \n)
      const lineBytes = byteBuffer.subarray(0, newlineIdx + 1);
      const lineByteLength = lineBytes.length;
      const lineStr = lineBytes.toString('utf-8');

      if (lineStr.startsWith('From ')) {
        if (!isFirstLine) {
          // Process previous message to extract folders/labels
          const messageContent = currentMessageLines.join('\n');
          const { folder, labels: msgLabels } = extractFolderAndLabels(messageContent);
          
          // Collect unique folder names (skip reserved folders)
          if (folder) {
            const normalizedFolder = folder.toUpperCase();
            const reservedFolders = ['INBOX', 'SENT', 'SENT ITEMS', 'SENT MESSAGES', 'SENT MAIL', 
                                     'ARCHIVE', 'TRASH', 'DELETED', 'DELETED ITEMS', 'SPAM', 'JUNK'];
            if (!reservedFolders.includes(normalizedFolder)) {
              folders.add(folder);
            }
          }
          
          // Collect unique label names
          for (const label of msgLabels) {
            labels.add(label);
          }
          
          boundaries.push({
            startByte: currentMessageStart,
            endByte: absoluteOffset - 1,
            messageIndex: messageIndex++,
          });
          
          currentMessageLines = [];
        }
        currentMessageStart = absoluteOffset;
        isFirstLine = false;
      } else {
        // Collect lines for folder/label extraction (only need headers, but simpler to collect all)
        currentMessageLines.push(lineStr);
      }

      absoluteOffset += lineByteLength;
      byteBuffer = byteBuffer.subarray(newlineIdx + 1);
    }
  }

  // Handle remaining bytes (last line with no trailing newline)
  if (byteBuffer.length > 0) {
    const lastLineStr = byteBuffer.toString('utf-8');
    currentMessageLines.push(lastLineStr);
    absoluteOffset += byteBuffer.length;
  }

  // Final message
  if (!isFirstLine) {
    // Process last message
    const messageContent = currentMessageLines.join('\n');
    const { folder, labels: msgLabels } = extractFolderAndLabels(messageContent);
    
    if (folder) {
      const normalizedFolder = folder.toUpperCase();
      const reservedFolders = ['INBOX', 'SENT', 'SENT ITEMS', 'SENT MESSAGES', 'SENT MAIL', 
                               'ARCHIVE', 'TRASH', 'DELETED', 'DELETED ITEMS', 'SPAM', 'JUNK'];
      if (!reservedFolders.includes(normalizedFolder)) {
        folders.add(folder);
      }
    }
    
    for (const label of msgLabels) {
      labels.add(label);
    }
    
    boundaries.push({
      startByte: currentMessageStart,
      endByte: absoluteOffset - 1,
      messageIndex: messageIndex,
    });
  }

  console.log(`Found ${boundaries.length} messages, ${folders.size} unique folders, ${labels.size} unique labels`);
  return { boundaries, folders, labels };
}


/**
 * Create encrypted folder and label records
 * 
 * This runs ONCE per mbox file in the indexer, avoiding the throttling
 * issues that occurred when 50 concurrent workers tried to create the
 * same folders/labels.
 */
async function createFolderAndLabelRecords(
  userId: string,
  migrationName: string,
  folders: Set<string>,
  labels: Set<string>,
  secretUUID: string,
  publicKeyPem: string
): Promise<void> {
  console.log(`Creating ${folders.size} folders and ${labels.size} labels (+ migration label)`);
  
  // Create folder records
  for (const folderName of folders) {
    const folderId = hashFolderOrLabelName(folderName, secretUUID);
    const encryptedName = await encryptName(folderName, publicKeyPem);
    await createOrUpdateFolder(userId, folderId, encryptedName);
  }
  
  // Create label records
  for (const labelName of labels) {
    const labelId = hashFolderOrLabelName(labelName, secretUUID);
    const encryptedName = await encryptName(labelName, publicKeyPem);
    await createOrUpdateLabel(userId, labelId, encryptedName);
  }
  
  // Create migration name label
  const migrationLabelId = hashFolderOrLabelName(migrationName, secretUUID);
  const encryptedMigrationName = await encryptName(migrationName, publicKeyPem);
  await createOrUpdateLabel(userId, migrationLabelId, encryptedMigrationName);
  
  console.log('Successfully created all folder and label records');
}

/**
 * Create batches of messages for parallel processing
 */
function createBatches(
  boundaries: MessageBoundary[],
  bucket: string,
  key: string,
  userId: string,
  migrationId: string,
  filename: string
): BatchMetadata[] {
  const batches: BatchMetadata[] = [];
  
  for (let i = 0; i < boundaries.length; i += MESSAGES_PER_BATCH) {
    const batchMessages = boundaries.slice(i, i + MESSAGES_PER_BATCH);
    const batchId = ulid();
    
    batches.push({
      batchId,
      bucket,
      key,
      userId,
      migrationId,
      filename,
      startByte: batchMessages[0].startByte,
      endByte: batchMessages[batchMessages.length - 1].endByte,
      messageCount: batchMessages.length,
      messageIndices: batchMessages.map(m => m.messageIndex),
    });
  }
  
  console.log(`Created ${batches.length} batches from ${boundaries.length} messages`);
  return batches;
}

/**
 * Store batch metadata in DynamoDB for tracking
 * 
 * Note: This function is currently unused. We don't store BATCH# records
 * because with thousands of batches per migration, it creates unnecessary
 * DDB writes and storage. Progress is tracked atomically via the aggregate
 * processedMessages counter in the MIGRATION#STATE record.
 */
async function storeBatchMetadata(batch: BatchMetadata): Promise<void> {
  await ddb.send(new PutItemCommand({
    TableName: EMAILS_TABLE,
    Item: marshall({
      PK: `USER#${batch.userId}`,
      SK: `BATCH#${batch.batchId}`,
      migrationId: batch.migrationId,
      filename: batch.filename,
      bucket: batch.bucket,
      key: batch.key,
      startByte: batch.startByte,
      endByte: batch.endByte,
      messageCount: batch.messageCount,
      messageIndices: batch.messageIndices,
      status: 'pending',
      createdAt: new Date().toISOString(),
    }),
  }));
}

/**
 * Enqueue batch for processing by worker Lambda
 */
async function enqueueBatch(batch: BatchMetadata): Promise<void> {
  await sqs.send(new SendMessageCommand({
    QueueUrl: WORKER_QUEUE_URL,
    MessageBody: JSON.stringify({
      batchId: batch.batchId,
      userId: batch.userId,
      migrationId: batch.migrationId,
      bucket: batch.bucket,
      key: batch.key,
      startByte: batch.startByte,
      endByte: batch.endByte,
      messageCount: batch.messageCount,
    }),
    MessageAttributes: {
      userId: { DataType: 'String', StringValue: batch.userId },
      migrationId: { DataType: 'String', StringValue: batch.migrationId },
    },
  }));
}

/**
 * Update migration state with total message count
 * 
 * Also transitions from 'indexing' to 'running' state to indicate
 * that message counting is complete and processing can begin.
 */
async function updateMigrationTotalMessages(
  userId: string,
  totalMessages: number
): Promise<void> {
  const now = new Date().toISOString();
  
  // Use ADD to increment totalMessages atomically
  // This handles concurrent updates from multiple mbox files
  // Also transition to 'running' state (idempotent - safe to set multiple times)
  await ddb.send(new UpdateItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({
      PK: `USER#${userId}`,
      SK: 'MIGRATION#STATE',
    }),
    UpdateExpression: 'ADD totalMessages :count SET #state = :running, lastUpdatedAt = :now',
    ExpressionAttributeNames: {
      '#state': 'state',
    },
    ExpressionAttributeValues: marshall({
      ':count': totalMessages,
      ':running': 'running',
      ':now': now,
    }),
  }));
}

export async function handler(event: S3Event): Promise<void> {
  console.log('Mbox Indexer triggered', JSON.stringify(event, null, 2));
  
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    
    try {
      // Parse S3 key
      const { userId, migrationId, filename } = parseS3Key(key);
      console.log(`Indexing mbox file for userId=${userId}, migrationId=${migrationId}`);
      
      // Get migration state to retrieve secretUUID and migration name
      const migrationState = await getMigrationState(userId);
      
      if (!migrationState) {
        console.error(`Migration not found for user ${userId}, skipping file ${key}`);
        return;
      }
      
      const secretUUID = migrationState.secretUUID;
      const migrationName = migrationState.migrationName || 'Migration';
      
      if (!secretUUID) {
        console.error(`Migration ${migrationId} missing secretUUID, cannot process file`);
        throw new Error('Migration missing secretUUID');
      }
      
      // Get user's public key for encrypting folder/label names
      const publicKeyPem = await getUserPublicKey(userId);
      
      // Scan file to find message boundaries AND extract unique folders/labels
      const { boundaries, folders, labels } = await scanMessageBoundaries(bucket, key);
      
      if (boundaries.length === 0) {
        console.warn(`No messages found in ${key}`);
        continue;
      }
      
      // Create all folder and label records ONCE (before workers start)
      // This eliminates throttling from 50 concurrent workers writing the same records
      await createFolderAndLabelRecords(
        userId,
        migrationName,
        folders,
        labels,
        secretUUID,
        publicKeyPem
      );
      
      // Create batches for parallel processing
      const batches = createBatches(
        boundaries,
        bucket,
        key,
        userId,
        migrationId,
        filename
      );
      
      // Enqueue batches for processing
      // Note: We don't store BATCH# metadata in DDB to avoid thousands of
      // unnecessary writes. Progress is tracked via aggregate counters.
      for (const batch of batches) {
        await enqueueBatch(batch);
      }
      
      // Update migration state with total message count
      await updateMigrationTotalMessages(userId, boundaries.length);
      
      console.log(`Successfully indexed ${boundaries.length} messages in ${batches.length} batches`);
      
    } catch (error) {
      console.error(`Error indexing mbox file ${key}:`, error);
      throw error;
    }
  }
}
