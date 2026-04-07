import { S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { ulid } from 'ulid';
import { createHash } from 'crypto';
import { parseMbox, MboxMessage } from './mbox-parser';
import { mapFileToLabel } from '../migration/mbox-utils';
import {
  getMigrationState,
  updateMigrationProgress,
  moveToNextFile,
  completeMigration,
  failMigration,
} from '../migration/db-utils';

const s3 = new S3Client({});
const PROCESSING_BUCKET = process.env.PROCESSING_BUCKET_NAME || '';
const MBOX_BUCKET = process.env.MBOX_BUCKET_NAME || '';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '50', 10);

/**
 * Parse Lambda Handler
 * 
 * Triggered by S3 ObjectCreated events on migrationMboxBucket (mbox/ prefix).
 * 
 * Responsibilities:
 * 1. Download mbox file from S3
 * 2. Parse mbox format using streaming parser
 * 3. Extract individual email messages
 * 4. For each message:
 *    - Parse headers and body
 *    - Extract metadata (date, flags, from, to, subject)
 *    - Convert to RFC 822 .eml format
 *    - Write to processing bucket under migration/{userId}/{messageId}.eml
 *    - S3 event triggers inbound email processor
 * 5. Update migration progress in DynamoDB
 * 6. Mark file as processed
 * 7. If all files processed, mark migration as completed and trigger cleanup
 * 
 * Environment Variables:
 * - EMAILS_TABLE_NAME: DynamoDB table for migration state
 * - PROCESSING_BUCKET_NAME: S3 bucket for .eml files (rawEmailBucket)
 * - MBOX_BUCKET_NAME: S3 bucket for mbox files
 * - BATCH_SIZE: Number of messages to process before committing progress (default: 50)
 * 
 * @param event S3 event containing bucket and key information
 */
export async function handler(event: S3Event): Promise<void> {
  console.log('Parse Lambda triggered', JSON.stringify(event, null, 2));
  
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    
    console.log(`Processing mbox file: ${key}`);
    
    try {
      // Extract userId and migrationId from S3 key: mbox/{userId}/{migrationId}/{filename}.mbox
      const { userId, migrationId, filename } = parseS3Key(key);
      
      console.log(`Parsed key - userId: ${userId}, migrationId: ${migrationId}, filename: ${filename}`);
      
      // Download mbox file from S3
      const stream = await downloadMboxFile(bucket, key);
      
      // Process messages in batches
      let processedCount = 0;
      let errorCount = 0;
      let batchMessages: MboxMessage[] = [];
      
      // Map filename to label
      const labelName = mapFileToLabel(filename);
      console.log(`Mapped filename "${filename}" to label "${labelName}"`);
      
      // Parse mbox file and extract individual messages
      for await (const message of parseMbox(stream)) {
        batchMessages.push(message);
        
        // Process batch when it reaches BATCH_SIZE
        if (batchMessages.length >= BATCH_SIZE) {
          const result = await processBatch(userId, batchMessages, labelName);
          processedCount += result.successCount;
          errorCount += result.errorCount;
          
          // Update progress in DynamoDB
          await updateMigrationProgress(userId, result.successCount, undefined, result.errorCount);
          
          console.log(`Batch processed: ${result.successCount} success, ${result.errorCount} errors`);
          
          // Clear batch
          batchMessages = [];
        }
      }
      
      // Process remaining messages in final batch
      if (batchMessages.length > 0) {
        const result = await processBatch(userId, batchMessages, labelName);
        processedCount += result.successCount;
        errorCount += result.errorCount;
        
        // Update progress in DynamoDB
        await updateMigrationProgress(userId, result.successCount, undefined, result.errorCount);
        
        console.log(`Final batch processed: ${result.successCount} success, ${result.errorCount} errors`);
      }
      
      console.log(`File processing complete: ${processedCount} messages processed, ${errorCount} errors`);
      
      // Mark file as processed and increment processedFiles counter
      // This returns the new processedFiles count atomically
      const newProcessedFiles = await moveToNextFile(userId);
      
      // Check if all files are processed using the atomic return value
      const migrationState = await getMigrationState(userId);
      if (migrationState && newProcessedFiles === migrationState.totalFiles) {
        console.log('All files processed - marking migration as completed');
        await completeMigration(userId);
      }
      
    } catch (error) {
      console.error('Error processing mbox file:', error);
      
      // Try to extract userId from key for error reporting
      try {
        const { userId } = parseS3Key(key);
        await failMigration(userId, `Failed to process mbox file: ${error instanceof Error ? error.message : String(error)}`);
      } catch (parseError) {
        console.error('Failed to parse S3 key for error reporting:', parseError);
      }
      
      // Re-throw to trigger Lambda retry
      throw error;
    }
  }
}

/**
 * Parse S3 key to extract userId, migrationId, and filename
 * 
 * Expected format: mbox/{userId}/{migrationId}/{filename}.mbox
 * 
 * @param key S3 object key
 * @returns Parsed components
 */
function parseS3Key(key: string): { userId: string; migrationId: string; filename: string } {
  const parts = key.split('/');
  
  if (parts.length < 4 || parts[0] !== 'mbox') {
    throw new Error(`Invalid S3 key format: ${key}. Expected: mbox/{userId}/{migrationId}/{filename}.mbox`);
  }
  
  return {
    userId: parts[1],
    migrationId: parts[2],
    filename: parts[3],
  };
}

/**
 * Download mbox file from S3 as a readable stream
 * 
 * @param bucket S3 bucket name
 * @param key S3 object key
 * @returns Readable stream of mbox file content
 */
async function downloadMboxFile(bucket: string, key: string): Promise<Readable> {
  const response = await s3.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
  
  if (!response.Body) {
    throw new Error(`Failed to download mbox file: ${key}`);
  }
  
  return response.Body as Readable;
}

/**
 * Process a batch of messages
 * 
 * Converts each message to .eml format and uploads to processing bucket.
 * Wraps individual message processing in try-catch to isolate failures.
 * 
 * @param userId User ID
 * @param messages Batch of messages to process
 * @param labelName Label to apply to all messages in this batch
 * @returns Success and error counts
 */
async function processBatch(
  userId: string,
  messages: MboxMessage[],
  labelName: string
): Promise<{ successCount: number; errorCount: number }> {
  let successCount = 0;
  let errorCount = 0;
  
  for (const message of messages) {
    try {
      // Generate unique message ID
      const messageId = ulid();
      
      // Convert message to .eml format (RFC 822) with label
      const emlContent = convertToEml(message, labelName);
      
      // Upload to processing bucket
      const key = `migration/${userId}/${messageId}.eml`;
      await s3.send(new PutObjectCommand({
        Bucket: PROCESSING_BUCKET,
        Key: key,
        Body: emlContent,
        ContentType: 'message/rfc822',
      }));
      
      successCount++;
    } catch (error) {
      console.error('Error processing individual message:', error);
      errorCount++;
      // Continue processing remaining messages
    }
  }
  
  return { successCount, errorCount };
}

/**
 * Convert MboxMessage to RFC 822 .eml format
 * 
 * Adds custom X-Chase-* headers to preserve mbox flags and label:
 * - X-Chase-Read: true if message was read in original mailbox
 * - X-Chase-Starred: true if message was flagged/starred in original mailbox
 * - X-Chase-Label: label name derived from mbox filename
 * 
 * Also ensures every message has a Message-ID header for idempotency.
 * If the original message lacks a Message-ID, generates one based on
 * a hash of the message content to ensure stable duplicate detection.
 * 
 * @param message Parsed mbox message
 * @param labelName Label to apply to this message
 * @returns RFC 822 formatted email content with custom headers
 */
function convertToEml(message: MboxMessage, labelName: string): string {
  // Map mbox flags to Chase Email metadata
  const isRead = message.flags.includes('read');
  const isStarred = message.flags.includes('flagged');
  
  // Check if message has a Message-ID header
  const hasMessageId = message.headers['message-id'] || 
                       message.headers['Message-ID'] || 
                       message.headers['Message-Id'];
  
  // Add custom headers to preserve flag state and label
  let emlContent = message.raw;
  
  // Insert custom headers after the first line (usually the From: header)
  // This ensures they're part of the header section
  const firstNewline = emlContent.indexOf('\n');
  if (firstNewline !== -1) {
    const customHeaders = [];
    
    // If no Message-ID exists, generate one based on content hash
    // This ensures idempotency even for emails without Message-ID headers
    if (!hasMessageId) {
      const hash = createHash('sha256').update(message.raw).digest('hex');
      customHeaders.push(`Message-ID: <${hash}@migration.chase-email>`);
    }
    
    if (isRead) {
      customHeaders.push('X-Chase-Read: true');
    }
    if (isStarred) {
      customHeaders.push('X-Chase-Starred: true');
    }
    customHeaders.push(`X-Chase-Label: ${labelName}`);
    
    if (customHeaders.length > 0) {
      emlContent = 
        emlContent.substring(0, firstNewline + 1) +
        customHeaders.join('\n') + '\n' +
        emlContent.substring(firstNewline + 1);
    }
  }
  
  return emlContent;
}
