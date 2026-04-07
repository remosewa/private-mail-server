# IMAP Migration DynamoDB Schema Extension

This document describes the DynamoDB schema extensions for IMAP account migration state persistence.

## Overview

The migration feature extends the existing `EmailsTable` with two new sort key patterns under the `USER#<userId>` partition key:
- `MIGRATION#CREDENTIALS` - Temporary storage for IMAP credentials
- `MIGRATION#STATE` - Migration progress and state tracking

Both patterns leverage the existing table's TTL attribute for automatic cleanup.

## Schema Patterns

### 1. Migration Credentials Storage

**Purpose**: Temporarily store IMAP credentials during active migration. Credentials are deleted upon migration completion or after 7 days (whichever comes first).

**Key Pattern**:
```
PK: USER#<userId>
SK: MIGRATION#CREDENTIALS
```

**Attributes**:
```typescript
{
  PK: string;              // "USER#<userId>"
  SK: string;              // "MIGRATION#CREDENTIALS"
  server: string;          // IMAP server address (e.g., "imap.gmail.com")
  port: number;            // IMAP port (e.g., 993)
  username: string;        // IMAP username/email
  password: string;        // IMAP password (unencrypted - see security note)
  useTLS: boolean;         // Whether to use TLS (default: true)
  ttl: number;             // Unix epoch seconds - 7 days from creation
  createdAt: string;       // ISO-8601 timestamp
}
```

**Security Note**: Credentials are stored unencrypted because:
- Lambda needs plaintext credentials to connect to IMAP servers
- Credentials are temporary (deleted on completion)
- DynamoDB encryption at rest provides baseline protection
- Access restricted via IAM policies
- TTL ensures automatic cleanup if deletion fails

**TTL Configuration**: 7 days from creation
```typescript
const ttl = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);
```

### 2. Migration State Storage

**Purpose**: Track migration progress, enable resume functionality, and provide status to the UI. Supports both IMAP-based and mbox-based migrations.

**Key Pattern**:
```
PK: USER#<userId>
SK: MIGRATION#STATE
```

**Attributes**:
```typescript
{
  PK: string;                    // "USER#<userId>"
  SK: string;                    // "MIGRATION#STATE"
  migrationId: string;           // ULID - unique identifier for this migration
  state: MigrationState;         // Current state (see enum below)
  totalMessages: number;         // Total messages to migrate (0 until counted)
  processedMessages: number;     // Messages successfully processed
  errorCount: number;            // Number of individual message failures
  
  // IMAP migration fields (optional)
  folders?: string[];            // List of IMAP folders to migrate
  currentFolderIndex?: number;   // Index of folder currently being processed
  lastFetchUID?: string;         // Last IMAP UID processed in current folder
  
  // Mbox migration fields (optional)
  files?: string[];              // List of mbox filenames to migrate
  totalFiles?: number;           // Total number of mbox files
  processedFiles?: number;       // Number of mbox files processed
  currentFileIndex?: number;     // Index of file currently being processed
  
  startedAt: string;             // ISO-8601 timestamp when migration started
  completedAt?: string;          // ISO-8601 timestamp when migration completed/failed
  errorMessage?: string;         // Error description if state is 'failed'
  ttl?: number;                  // Unix epoch seconds - 30 days after completion
}
```

**Migration State Enum**:
```typescript
type MigrationState = 
  | 'uploading'   // Initial state - uploading zip file (mbox only)
  | 'extracting'  // Extracting mbox files from zip (mbox only)
  | 'validating'  // Initial state - validating credentials (IMAP only)
  | 'running'     // Active migration in progress
  | 'paused'      // Migration paused (connection lost, manual pause)
  | 'completed'   // Migration successfully completed
  | 'failed';     // Migration failed (after retries exhausted)
```

**TTL Configuration**: 30 days after completion
```typescript
// Set TTL only when migration reaches terminal state (completed/failed)
if (state === 'completed' || state === 'failed') {
  const ttl = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
}
```

## Access Patterns

### 1. Store Credentials (Start Migration)
```typescript
await ddb.send(new PutItemCommand({
  TableName: EMAILS_TABLE,
  Item: marshall({
    PK: `USER#${userId}`,
    SK: 'MIGRATION#CREDENTIALS',
    server: credentials.server,
    port: credentials.port,
    username: credentials.username,
    password: credentials.password,
    useTLS: credentials.useTLS,
    ttl: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60),
    createdAt: new Date().toISOString(),
  }),
  // Prevent overwriting if credentials already exist (concurrent migration check)
  ConditionExpression: 'attribute_not_exists(PK)',
}));
```

### 2. Retrieve Credentials (Migration Lambda)
```typescript
const result = await ddb.send(new GetItemCommand({
  TableName: EMAILS_TABLE,
  Key: marshall({
    PK: `USER#${userId}`,
    SK: 'MIGRATION#CREDENTIALS',
  }),
}));

if (!result.Item) {
  throw new Error('Migration credentials not found');
}

const credentials = unmarshall(result.Item);
```

### 3. Delete Credentials (Migration Complete)
```typescript
await ddb.send(new DeleteItemCommand({
  TableName: EMAILS_TABLE,
  Key: marshall({
    PK: `USER#${userId}`,
    SK: 'MIGRATION#CREDENTIALS',
  }),
}));
```

### 4. Initialize Migration State

**IMAP Migration**:
```typescript
await ddb.send(new PutItemCommand({
  TableName: EMAILS_TABLE,
  Item: marshall({
    PK: `USER#${userId}`,
    SK: 'MIGRATION#STATE',
    migrationId: ulid(),
    state: 'validating',
    totalMessages: 0,
    processedMessages: 0,
    errorCount: 0,
    folders: [],
    currentFolderIndex: 0,
    lastFetchUID: '',
    startedAt: new Date().toISOString(),
  }),
  // Prevent concurrent migrations
  ConditionExpression: 'attribute_not_exists(PK) OR #state IN (:completed, :failed)',
  ExpressionAttributeNames: { '#state': 'state' },
  ExpressionAttributeValues: marshall({
    ':completed': 'completed',
    ':failed': 'failed',
  }),
}));
```

**Mbox Migration**:
```typescript
await ddb.send(new PutItemCommand({
  TableName: EMAILS_TABLE,
  Item: marshall({
    PK: `USER#${userId}`,
    SK: 'MIGRATION#STATE',
    migrationId: ulid(),
    state: 'uploading',
    totalMessages: 0,
    processedMessages: 0,
    errorCount: 0,
    files: [],
    totalFiles: 0,
    processedFiles: 0,
    currentFileIndex: 0,
    startedAt: new Date().toISOString(),
  }),
  // Prevent concurrent migrations
  ConditionExpression: 'attribute_not_exists(PK) OR #state IN (:completed, :failed)',
  ExpressionAttributeNames: { '#state': 'state' },
  ExpressionAttributeValues: marshall({
    ':completed': 'completed',
    ':failed': 'failed',
  }),
}));
```

### 5. Update Migration Progress
```typescript
await ddb.send(new UpdateItemCommand({
  TableName: EMAILS_TABLE,
  Key: marshall({
    PK: `USER#${userId}`,
    SK: 'MIGRATION#STATE',
  }),
  UpdateExpression: 'SET processedMessages = processedMessages + :count, lastFetchUID = :uid',
  ExpressionAttributeValues: marshall({
    ':count': batchSize,
    ':uid': lastUID,
  }),
}));
```

### 6. Get Migration Status (API)
```typescript
const result = await ddb.send(new GetItemCommand({
  TableName: EMAILS_TABLE,
  Key: marshall({
    PK: `USER#${userId}`,
    SK: 'MIGRATION#STATE',
  }),
}));

if (!result.Item) {
  return { state: 'idle' }; // No migration in progress
}

return unmarshall(result.Item);
```

### 7. Complete Migration (Set TTL)
```typescript
await ddb.send(new UpdateItemCommand({
  TableName: EMAILS_TABLE,
  Key: marshall({
    PK: `USER#${userId}`,
    SK: 'MIGRATION#STATE',
  }),
  UpdateExpression: 'SET #state = :completed, completedAt = :now, #ttl = :ttl',
  ExpressionAttributeNames: {
    '#state': 'state',
    '#ttl': 'ttl',
  },
  ExpressionAttributeValues: marshall({
    ':completed': 'completed',
    ':now': new Date().toISOString(),
    ':ttl': Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60),
  }),
}));
```

### 8. Detect Incomplete Migrations (App Restart)
```typescript
const result = await ddb.send(new GetItemCommand({
  TableName: EMAILS_TABLE,
  Key: marshall({
    PK: `USER#${userId}`,
    SK: 'MIGRATION#STATE',
  }),
}));

if (result.Item) {
  const state = unmarshall(result.Item);
  if (state.state === 'running' || state.state === 'paused') {
    // Offer user option to resume
    return state;
  }
}
```

## TypeScript Interfaces

```typescript
/**
 * IMAP credentials for connecting to external email server
 */
export interface IMAPCredentials {
  server: string;      // IMAP server hostname
  port: number;        // IMAP port (typically 993 for TLS)
  username: string;    // IMAP username/email
  password: string;    // IMAP password or app-specific password
  useTLS: boolean;     // Use TLS encryption (default: true)
}

/**
 * Migration state values
 */
export type MigrationState = 
  | 'validating'  // Validating credentials
  | 'running'     // Migration in progress
  | 'paused'      // Migration paused
  | 'completed'   // Migration completed successfully
  | 'failed';     // Migration failed

/**
 * Migration progress and state tracking
 */
export interface MigrationStatus {
  migrationId: string;           // Unique identifier (ULID)
  state: MigrationState;         // Current state
  totalMessages: number;         // Total messages to migrate
  processedMessages: number;     // Messages processed so far
  errorCount: number;            // Number of errors encountered
  folders: string[];             // List of folders being migrated
  currentFolderIndex: number;    // Current folder index
  lastFetchUID: string;          // Last processed IMAP UID
  startedAt: string;             // ISO-8601 start timestamp
  completedAt?: string;          // ISO-8601 completion timestamp
  errorMessage?: string;         // Error description if failed
}

/**
 * DynamoDB item for migration credentials
 */
export interface MigrationCredentialsItem extends IMAPCredentials {
  PK: string;          // "USER#<userId>"
  SK: string;          // "MIGRATION#CREDENTIALS"
  ttl: number;         // Unix epoch seconds (7 days)
  createdAt: string;   // ISO-8601 timestamp
}

/**
 * DynamoDB item for migration state
 */
export interface MigrationStateItem extends MigrationStatus {
  PK: string;          // "USER#<userId>"
  SK: string;          // "MIGRATION#STATE"
  ttl?: number;        // Unix epoch seconds (30 days after completion)
}
```

## Validation Rules

### Credentials Validation
- `server`: Non-empty string, valid hostname
- `port`: Integer between 1 and 65535
- `username`: Non-empty string
- `password`: Non-empty string
- `useTLS`: Boolean (default: true)

### State Validation
- `migrationId`: Valid ULID format
- `state`: One of the defined MigrationState values
- `totalMessages`: Non-negative integer
- `processedMessages`: Non-negative integer, ≤ totalMessages
- `errorCount`: Non-negative integer
- `folders`: Array of non-empty strings
- `currentFolderIndex`: Non-negative integer, < folders.length
- `lastFetchUID`: String (empty string for first batch)
- `startedAt`: Valid ISO-8601 timestamp
- `completedAt`: Valid ISO-8601 timestamp (if present)

## Error Handling

### Concurrent Migration Prevention
Use conditional writes to prevent multiple simultaneous migrations:
```typescript
ConditionExpression: 'attribute_not_exists(PK) OR #state IN (:completed, :failed)'
```

This ensures:
- New migration can only start if no state exists
- OR if existing state is in terminal state (completed/failed)

### Credential Not Found
If credentials are missing during migration:
- Log error with userId and migrationId
- Update state to 'failed' with error message
- Do not retry (credentials won't appear)

### State Corruption
If state is inconsistent (e.g., processedMessages > totalMessages):
- Log warning with full state object
- Continue processing (self-correcting)
- Update totalMessages if needed

## Monitoring

### CloudWatch Metrics
- `MigrationCredentialsStored`: Count of credentials stored
- `MigrationCredentialsDeleted`: Count of credentials deleted
- `MigrationStateUpdates`: Count of state updates
- `MigrationTTLExpired`: Count of items expired via TTL

### Alarms
- Credentials stored but not deleted within 8 days (TTL + 1 day buffer)
- State in 'running' for > 24 hours (possible stuck migration)

## Testing Considerations

### Unit Tests
- Validate credential storage with TTL
- Validate state initialization with conditional write
- Validate progress updates
- Validate completion with TTL setting
- Validate concurrent migration prevention

### Property Tests
- **Property 16: State Persistence** - Any stored state can be retrieved
- **Property 17: Incomplete Session Detection** - Running/paused states are detected

### Integration Tests
- End-to-end migration with credential lifecycle
- Resume flow with state persistence
- TTL expiration (use short TTL in test environment)
- Concurrent migration attempt (should fail with 409)

## Migration Path

This is a new feature with no existing data to migrate. The schema extension is additive and does not affect existing email, folder, label, or push subscription data in the EmailsTable.

## Rollback Plan

If the migration feature needs to be disabled:
1. Remove migration Lambda and API endpoints
2. Delete SQS queues
3. Existing credentials/state items will expire via TTL
4. No manual cleanup required (TTL handles it)
5. No impact on existing email functionality
