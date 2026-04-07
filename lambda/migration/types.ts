/**
 * Type definitions for IMAP Account Migration
 * 
 * This module defines the TypeScript interfaces and types used throughout
 * the migration feature, including DynamoDB schema types, API request/response
 * types, and internal data structures.
 */

// ============================================================================
// IMAP Connection Types
// ============================================================================

/**
 * IMAP credentials for connecting to external email server
 */
export interface IMAPCredentials {
  /** IMAP server hostname (e.g., "imap.gmail.com") */
  server: string;
  
  /** IMAP port (typically 993 for TLS, 143 for non-TLS) */
  port: number;
  
  /** IMAP username or email address */
  username: string;
  
  /** IMAP password or app-specific password */
  password: string;
  
  /** Use TLS encryption (default: true) */
  useTLS: boolean;
}

// ============================================================================
// Migration State Types
// ============================================================================

/**
 * Migration state values
 * 
 * State transitions:
 * uploading -> extracting -> indexing -> running -> completed
 *           -> extracting -> failed
 *           -> indexing -> failed
 *           -> running -> failed
 *           -> running -> paused -> running
 */
export type MigrationState = 
  | 'uploading'   // Initial state - uploading zip file to S3
  | 'extracting'  // Extracting mbox files from zip archive
  | 'indexing'    // Scanning mbox files to count messages (mbox only)
  | 'validating'  // Initial state - validating credentials and counting messages (IMAP only)
  | 'running'     // Active migration in progress
  | 'paused'      // Migration paused (connection lost, manual pause, or error)
  | 'completed'   // Migration completed successfully
  | 'failed';     // Migration failed after retries exhausted

/**
 * Migration progress and state tracking
 * 
 * This interface represents the migration state as stored in DynamoDB
 * and returned to the API/UI.
 */
export interface MigrationStatus {
  /** Unique identifier for this migration (ULID) */
  migrationId: string;
  
  /** User-provided name for this migration (max 20 characters) */
  migrationName?: string;
  
  /** Secret UUID for deterministic folder/label hashing (never logged) */
  secretUUID?: string;
  
  /** Current migration state */
  state: MigrationState;
  
  /** Total messages to migrate (0 until folder discovery completes) */
  totalMessages: number;
  
  /** Messages successfully processed so far */
  processedMessages: number;
  
  /** Number of individual message errors encountered */
  errorCount: number;
  
  /** List of IMAP folders being migrated (IMAP migration only) */
  folders?: string[];
  
  /** Index of folder currently being processed (IMAP migration only) */
  currentFolderIndex?: number;
  
  /** Last IMAP UID processed in current folder (IMAP migration only) */
  lastFetchUID?: string;
  
  /** List of mbox files being migrated (mbox migration only) */
  files?: string[];
  
  /** Total number of mbox files to process (mbox migration only) */
  totalFiles?: number;
  
  /** Number of mbox files processed so far (mbox migration only) */
  processedFiles?: number;
  
  /** Index of file currently being processed (mbox migration only) */
  currentFileIndex?: number;
  
  /** ISO-8601 timestamp when migration started */
  startedAt: string;
  
  /** ISO-8601 timestamp when migration completed or failed (optional) */
  completedAt?: string;
  
  /** Error description if state is 'failed' (optional) */
  errorMessage?: string;
  
  /** ISO-8601 UTC timestamp when migration status was last updated (optional) */
  lastUpdatedAt?: string;
}

// ============================================================================
// DynamoDB Schema Types
// ============================================================================

/**
 * DynamoDB item for migration credentials
 * 
 * Storage pattern: PK: USER#<userId>, SK: MIGRATION#CREDENTIALS
 * TTL: 7 days from creation
 */
export interface MigrationCredentialsItem extends IMAPCredentials {
  /** Partition key: "USER#<userId>" */
  PK: string;
  
  /** Sort key: "MIGRATION#CREDENTIALS" */
  SK: string;
  
  /** Unix epoch seconds - 7 days from creation (automatic cleanup) */
  ttl: number;
  
  /** ISO-8601 timestamp when credentials were stored */
  createdAt: string;
}

/**
 * DynamoDB item for migration state
 * 
 * Storage pattern: PK: USER#<userId>, SK: MIGRATION#STATE
 * TTL: 30 days after completion (only set when state is 'completed' or 'failed')
 */
export interface MigrationStateItem extends MigrationStatus {
  /** Partition key: "USER#<userId>" */
  PK: string;
  
  /** Sort key: "MIGRATION#STATE" */
  SK: string;
  
  /** Unix epoch seconds - 30 days after completion (optional, only for terminal states) */
  ttl?: number;
}

// ============================================================================
// SQS Message Types
// ============================================================================

/**
 * SQS message format for migration batch processing
 * 
 * Each message represents one batch of up to 100 emails to process.
 * The migration Lambda processes this message, downloads emails from IMAP,
 * stores them in S3, updates progress, and enqueues the next batch if needed.
 */
export interface MigrationMessage {
  /** User ID for this migration */
  userId: string;
  
  /** Migration ID (ULID) for tracking */
  migrationId: string;
  
  /** IMAP folder name being processed (e.g., "INBOX", "[Gmail]/Sent Mail") */
  folderName: string;
  
  /** Last IMAP UID processed (undefined for first batch of a folder) */
  lastFetchUID?: string;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

/**
 * Request body for POST /migration/start
 */
export interface StartMigrationRequest extends IMAPCredentials {}

/**
 * Response body for POST /migration/start
 */
export interface StartMigrationResponse {
  /** Unique migration ID (ULID) */
  migrationId: string;
  
  /** Initial migration status */
  status: MigrationStatus;
}

/**
 * Response body for GET /migration/status
 */
export interface GetMigrationStatusResponse extends MigrationStatus {
  /** Estimated completion time (ISO-8601) based on current processing rate */
  estimatedCompletion?: string;
}

/**
 * Response body for POST /migration/cancel
 */
export interface CancelMigrationResponse {
  /** Whether cancellation was successful */
  cancelled: boolean;
  
  /** Number of messages processed before cancellation */
  processedMessages: number;
  
  /** User-friendly message */
  message: string;
}

// ============================================================================
// IMAP Message Types
// ============================================================================

/**
 * IMAP message representation
 * 
 * This represents an email message retrieved from an IMAP server,
 * before conversion to .eml format for storage.
 */
export interface IMAPMessage {
  /** IMAP UID (unique within folder) */
  uid: string;
  
  /** Message-ID header (globally unique) */
  messageId: string;
  
  /** In-Reply-To header (optional, for threading) */
  inReplyTo?: string;
  
  /** Subject line */
  subject: string;
  
  /** From address */
  from: string;
  
  /** To addresses */
  to: string[];
  
  /** CC addresses (optional) */
  cc?: string[];
  
  /** Message date */
  date: Date;
  
  /** IMAP flags (e.g., ["\\Seen", "\\Flagged"]) */
  flags: string[];
  
  /** Full RFC 822 message body */
  body: string;
  
  /** Message size in bytes */
  size: number;
}

// ============================================================================
// Folder Mapping Types
// ============================================================================

/**
 * IMAP folder to local label mapping
 */
export interface FolderMapping {
  /** IMAP folder name (e.g., "INBOX", "[Gmail]/Sent Mail") */
  imapFolder: string;
  
  /** Local label/folder ID (e.g., "INBOX", "SENT") */
  chaseLabel: string;
  
  /** Total messages in this folder */
  messageCount: number;
  
  /** Messages processed so far */
  processed: number;
}

// ============================================================================
// Batch Processing Types
// ============================================================================

/**
 * Batch processing progress tracking
 * 
 * Used internally by the migration Lambda to track progress
 * of individual batches for logging and debugging.
 */
export interface BatchProgress {
  /** Unique batch ID (ULID) */
  batchId: string;
  
  /** User ID */
  userId: string;
  
  /** Folder name */
  folderName: string;
  
  /** Starting UID for this batch */
  startUID: string;
  
  /** Ending UID for this batch */
  endUID: string;
  
  /** Number of messages in this batch */
  messageCount: number;
  
  /** Number of messages successfully processed */
  successCount: number;
  
  /** Number of messages that failed */
  errorCount: number;
  
  /** ISO-8601 timestamp when batch was processed */
  processedAt: string;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Migration error categories
 */
export enum MigrationErrorType {
  /** IMAP connection error (server unreachable, timeout) */
  CONNECTION_ERROR = 'CONNECTION_ERROR',
  
  /** IMAP authentication error (invalid credentials) */
  AUTH_ERROR = 'AUTH_ERROR',
  
  /** Individual message processing error */
  MESSAGE_ERROR = 'MESSAGE_ERROR',
  
  /** Rate limit error from IMAP server */
  RATE_LIMIT_ERROR = 'RATE_LIMIT_ERROR',
  
  /** Storage error (S3, DynamoDB) */
  STORAGE_ERROR = 'STORAGE_ERROR',
  
  /** Unknown/unexpected error */
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

/**
 * Migration error details
 */
export interface MigrationError {
  /** Error type/category */
  type: MigrationErrorType;
  
  /** Error message */
  message: string;
  
  /** IMAP UID of message that failed (if applicable) */
  uid?: string;
  
  /** Folder name where error occurred */
  folderName?: string;
  
  /** ISO-8601 timestamp when error occurred */
  timestamp: string;
  
  /** Original error object (for logging) */
  originalError?: unknown;
}

// ============================================================================
// Validation Types
// ============================================================================

/**
 * Credential validation result
 */
export interface CredentialValidationResult {
  /** Whether credentials are valid */
  valid: boolean;
  
  /** Error message if invalid */
  error?: string;
  
  /** Error type if invalid */
  errorType?: MigrationErrorType;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * DynamoDB sort key constants
 */
export const MIGRATION_SK = {
  CREDENTIALS: 'MIGRATION#CREDENTIALS',
  STATE: 'MIGRATION#STATE',
} as const;

/**
 * TTL durations in seconds
 */
export const TTL_DURATION = {
  /** 7 days for credentials */
  CREDENTIALS: 7 * 24 * 60 * 60,
  
  /** 30 days for completed migrations */
  COMPLETED_MIGRATION: 30 * 24 * 60 * 60,
} as const;

/**
 * Migration configuration constants
 */
export const MIGRATION_CONFIG = {
  /** Number of messages to process per batch */
  BATCH_SIZE: 100,
  
  /** Maximum retry attempts for failed batches */
  MAX_RETRIES: 3,
  
  /** Delay between email retrievals (milliseconds) */
  RETRIEVAL_DELAY_MS: 100,
  
  /** Rate limit pause duration (seconds) */
  RATE_LIMIT_PAUSE_SECONDS: 60,
} as const;

/**
 * Default folder mappings
 */
export const DEFAULT_FOLDER_MAPPINGS: Record<string, string> = {
  'INBOX': 'INBOX',
  'Sent': 'SENT',
  'Sent Mail': 'SENT',
  '[Gmail]/Sent Mail': 'SENT',
  'Drafts': 'DRAFTS',
  '[Gmail]/Drafts': 'DRAFTS',
  'Trash': 'TRASH',
  '[Gmail]/Trash': 'TRASH',
  'Spam': 'SPAM',
  '[Gmail]/Spam': 'SPAM',
  'Junk': 'SPAM',
};
