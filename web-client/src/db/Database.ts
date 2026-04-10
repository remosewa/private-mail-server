/**
 * Database — sqlite-vec-wasm-demo via a custom dedicated worker.
 *
 * sqlite-vec-wasm-demo is a sqlite-wasm build with the sqlite-vec extension
 * compiled in.  Its sqlite3.mjs is a main-thread init module (not a Worker1
 * server), so we drive it from a dedicated worker (sqlite-vec-worker.ts) using
 * a minimal postMessage RPC protocol rather than the sqlite3Worker1Promiser.
 *
 * Persistence uses the OPFS SAH Pool VFS when available (no SharedArrayBuffer
 * required), falling back to in-memory.
 */

import { useAuthStore } from '../store/authStore';
import { getOrCreateDbKey } from './dbKeyManager';
import { remoteLogger } from '../api/logger';
import { useDbStore } from '../store/dbStore';

export interface SqliteDb {
  exec(sql: string, opts?: { bind?: unknown[] }): Promise<void>;
  selectObjects(sql: string, bind?: unknown[]): Promise<Record<string, unknown>[]>;
  selectValue(sql: string, bind?: unknown[]): Promise<unknown>;
  /** Run fn inside a BEGIN/COMMIT transaction, serialized against other transactions. */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
}

// ── RPC worker wrapper ───────────────────────────────────────────────────────

type RpcEntry = { resolve: (v: unknown) => void; reject: (e: Error) => void };

class VecDb implements SqliteDb {
  private readonly pending = new Map<number, RpcEntry>();
  private nextId = 1;
  /** Resolves once the worker signals `{ type: 'ready' }`. */
  readonly ready: Promise<void>;
  /** Serializes all RPC calls so only one message is in-flight at a time. */
  private rpcQueue: Promise<unknown> = Promise.resolve();
  /**
   * Transaction mutex: resolves when no transaction is active.
   * withTransaction() chains off this before issuing BEGIN, so only one
   * explicit transaction can be open at a time.
   */
  private txDone: Promise<void> = Promise.resolve();

  constructor(private readonly worker: Worker, rawDbKey: Uint8Array, userId: string, private readonly onCorrupt: () => void) {
    let resolveReady!: () => void;
    let rejectReady!: (e: Error) => void;
    this.ready = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });

    // Send the encryption key and userId before the worker opens the database.
    worker.postMessage({ type: 'init', key: rawDbKey, userId });

    worker.onmessage = (e: MessageEvent): void => {
      const { type, id, result, error } =
        e.data as { type?: string; id?: number; result?: unknown; error?: string };

      if (type === 'ready') { resolveReady(); return; }
      if (type === 'error') { rejectReady(new Error(error)); return; }
      if (type === 'opfs-failed') {
        // Another tab holds the OPFS handles. Broadcast 'release-db' so all
        // other tabs drop theirs, then tell this worker to retry after 600ms.
        dbChannel.postMessage({ type: 'release-db' });
        setTimeout(() => worker.postMessage({ type: 'opfs-retry' }), 600);
        return;
      }

      if (id !== undefined) {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          if (error) p.reject(new Error(error));
          else p.resolve(result as unknown);
        }
      }
    };
    worker.onerror = (e): void => {
      remoteLogger.error('Database worker crashed', { message: e.message });
      rejectReady(new Error(e.message));
    };
  }

  private rpc(data: Record<string, unknown>): Promise<unknown> {
    // Serialize all calls: each new call waits for the previous to finish.
    const call = this.rpcQueue.then(() =>
      this.ready.then(
        () => new Promise((resolve, reject) => {
          const id = this.nextId++;
          this.pending.set(id, { resolve, reject });
          this.worker.postMessage({ id, ...data });
        }),
      )
    );
    // Chain ignores errors so a failed call doesn't block subsequent ones.
    // Also detect corruption here — covers both query failures and ready rejection.
    this.rpcQueue = call.catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('SQLITE_CORRUPT') || msg.includes('result code 11')) {
        this.onCorrupt();
      }
    });
    return call;
  }

async exec(sql: string, opts?: { bind?: unknown[] }): Promise<void> {
    await this.rpc({ sql, bind: opts?.bind ?? [] });
}


  async selectObjects(sql: string, bind?: unknown[]): Promise<Record<string, unknown>[]> {
    return (await this.rpc({
      sql,
      bind: bind ?? [],
      rowMode: 'object',
      returnValue: 'resultRows',
    })) as Record<string, unknown>[];
  }

  async selectValue(sql: string, bind?: unknown[]): Promise<unknown> {
    const rows = (await this.rpc({
      sql,
      bind: bind ?? [],
      rowMode: 'array',
      returnValue: 'resultRows',
    })) as unknown[][];
    return rows?.[0]?.[0];
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    // Atomically claim the next transaction slot before any concurrent caller.
    const prevTx = this.txDone;
    let releaseTx!: () => void;
    this.txDone = new Promise<void>(res => { releaseTx = res; });

    // Wait for any previous transaction to finish, then run ours.
    await prevTx;
    await this.rpc({ sql: 'BEGIN', bind: [] });
    try {
      const result = await fn();
      await this.rpc({ sql: 'COMMIT', bind: [] });
      return result;
    } catch (err) {
      await this.rpc({ sql: 'ROLLBACK', bind: [] }).catch(() => {});
      throw err;
    } finally {
      releaseTx();
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let dbPromise: Promise<SqliteDb> | null = null;
let currentUserId: string | null = null;
let currentWorker: Worker | null = null;

// BroadcastChannel for cross-tab OPFS lock coordination.
// When a tab fails to open the SAH Pool (another tab holds the handles), it
// broadcasts 'release-db'. All tabs receiving this release their handles and
// enter disconnected mode (UI shows a banner, background writes are blocked).
// When a tab closes it broadcasts 'db-available' so the disconnected tab can
// reinitialize and take over.
const dbChannel = new BroadcastChannel('chase-db-coordination');
dbChannel.addEventListener('message', (e: MessageEvent) => {
  const { type } = e.data as { type?: string };
  if (type === 'release-db') {
    teardownDb();
    useDbStore.getState().setDisconnected(true);
  }
  if (type === 'db-available') {
    // Another tab released the lock — reinitialize so this tab takes over.
    useDbStore.getState().setDisconnected(false);
    dbPromise = null;       // force re-init on next getDb() call
    currentUserId = null;   // allow initDb to run again
  }
});

/**
 * Terminate the DB worker and clear all singleton state.
 *
 * Must be called on logout BEFORE clearing auth state so that the next login
 * can spin up a fresh worker with the new user's encryption key.  Terminating
 * the worker also wipes the worker-side module globals (db, initPromise, and
 * the `installed` guard in EncryptedOPFSHandle) because Workers share no
 * module state with the main thread or with each other.
 */
export function teardownDb(): void {
  currentWorker?.terminate();
  currentWorker = null;
  dbPromise = null;
  currentUserId = null;
}


// On page unload, terminate the worker synchronously so the browser releases
// its OPFS FileSystemSyncAccessHandle locks immediately. An async graceful
// shutdown keeps the worker alive while awaiting, which holds the locks and
// causes NoModificationAllowedError in the new page's worker on refresh.
// SQLite's WAL is crash-safe and recovers on next open, so hard termination
// is safe. gracefulShutdown() is still used for controlled logout.
window.addEventListener('pagehide', () => { teardownDb(); dbChannel.postMessage({ type: 'db-available' }); });
window.addEventListener('beforeunload', () => { teardownDb(); dbChannel.postMessage({ type: 'db-available' }); });

/**
 * Called when SQLITE_CORRUPT is detected on any query or on DB open.
 * Terminates the worker, resets the singleton, and deletes the OPFS files
 * so the next getDb() call starts with a clean database and re-syncs.
 */
async function recoverCorruptDb(userId: string): Promise<void> {
  console.error('[Database] SQLITE_CORRUPT detected — wiping database for user', userId, 'and starting fresh');
  remoteLogger.error('Database corruption detected — wiping local DB and resyncing', { userId });
  currentWorker?.terminate();
  currentWorker = null;
  dbPromise = null;
  currentUserId = null;
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(`.chase-email-enc-db-${userId}`, { recursive: true });
    console.warn('[Database] Corrupt database files deleted; next getDb() will start fresh and re-sync');
  } catch (deleteErr) {
    console.warn('[Database] Could not delete corrupt DB files (will attempt recovery on next open):', deleteErr);
  }
}

/**
 * Get the database instance for the current user.
 * Automatically resets when userId changes to prevent cross-user data leakage.
 */
export function getDb(): Promise<SqliteDb> {
  if (useDbStore.getState().disconnected) {
    return Promise.reject(new Error('DB offline: another tab holds the OPFS lock'));
  }

  const userId = useAuthStore.getState().userId;

  // If userId changed, reset the database
  if (userId && userId !== currentUserId) {
    teardownDb();
    currentUserId = userId;
  }

  if (!dbPromise) dbPromise = initDb();
  return dbPromise;
}

async function initDbInner(): Promise<SqliteDb> {
  const { userId, privateKey, publicKey } = useAuthStore.getState();
  if (!userId || !privateKey || !publicKey) throw new Error('initDb: not authenticated');

  const rawDbKey = await getOrCreateDbKey(userId, privateKey, publicKey);

  // Inline new URL so Vite statically bundles sqlite-vec-worker.ts.
  const worker = new Worker(new URL('./sqlite-vec-worker.ts', import.meta.url), { type: 'module' });
  currentWorker = worker;
  const db = new VecDb(worker, rawDbKey, userId, () => { void recoverCorruptDb(userId); });

  // All exec() calls below wait for the worker's 'ready' signal automatically.

  // ── Base schema ─────────────────────────────────────────────────────────
  await db.exec(`
    CREATE TABLE IF NOT EXISTS email_metadata (
      email_id         INTEGER PRIMARY KEY,
      ulid             TEXT NOT NULL UNIQUE,
      threadId         TEXT NOT NULL,
      folderId         TEXT NOT NULL DEFAULT 'INBOX',
      labelIds         TEXT NOT NULL DEFAULT '[]',
      receivedAt       TEXT NOT NULL,
      receivedMs       INTEGER NOT NULL,
      isRead           INTEGER NOT NULL DEFAULT 0,
      s3BodyKey        TEXT,
      s3TextKey        TEXT,
      s3EmbeddingKey   TEXT,
      s3AttachmentsKey TEXT,
      subject          TEXT,
      fromName         TEXT,
      fromAddress      TEXT,
      preview          TEXT,
      toAddresses      TEXT,
      ccAddresses      TEXT,
      bccAddresses     TEXT,
      indexed_at       TEXT,
      wrappedEmailKey  TEXT,
      listUnsubscribe     TEXT,
      listUnsubscribePost TEXT,
      lastUpdatedAt    TEXT,
      version          INTEGER NOT NULL DEFAULT 1,
      messageId        TEXT,
      hasAttachments   INTEGER NOT NULL DEFAULT 0
    )
  `);


  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_folder_received
      ON email_metadata(folderId, receivedMs DESC)
  `);

  // ── Schema migrations ────────────────────────────────────────────────────
  const version = (await db.selectValue('PRAGMA user_version')) as number;

  if (version < 2) {
    try { await db.exec('ALTER TABLE email_metadata ADD COLUMN indexed_at TEXT'); } catch (e) {
      const msg = (e as Error).message ?? "";
      if (!msg.includes("duplicate column name") && !msg.includes("already exists")) {
        throw e;  // re-throw anything unexpected
      }
    }

    await db.exec('DROP TABLE IF EXISTS email_fts');
    await db.exec(`
      CREATE VIRTUAL TABLE email_fts USING fts5(
        ulid,
        subject,
        fromName,
        fromAddress,
        preview,
        body_text,
        tokenize = 'porter unicode61'
      )
    `);
    await db.exec(`
      INSERT INTO email_fts(ulid, subject, fromName, fromAddress, preview, body_text)
        SELECT ulid, COALESCE(subject,''), COALESCE(fromName,''), COALESCE(fromAddress,''), COALESCE(preview,''), ''
        FROM email_metadata
    `);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS email_embeddings (
        ulid      TEXT PRIMARY KEY,
        model     TEXT NOT NULL,
        n_chunks  INTEGER NOT NULL,
        emb_data  BLOB NOT NULL
      )
    `);
    await db.exec('PRAGMA user_version = 2');
  }

  if (version < 3) {
    // vec0 virtual table: one row per embedding chunk for SQL-level ANN search.
    // vec0 is provided by the sqlite-vec extension compiled into the WASM binary.
    await db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS email_vecs USING vec0(
        +ulid      TEXT,
        +chunk_idx INTEGER,
        embedding  FLOAT[384]
      )
    `);

    // Migrate any embeddings already stored as packed blobs → per-chunk vec0 rows.
    const CHUNK_BYTES = 384 * 4; // 384 float32 values × 4 bytes
    const existing = await db.selectObjects(
      'SELECT ulid, n_chunks, emb_data FROM email_embeddings',
    );
    for (const row of existing) {
      const ulid = row['ulid'] as string;
      const nChunks = row['n_chunks'] as number;
      const emb_data = row['emb_data'] as Uint8Array;
      for (let i = 0; i < nChunks; i++) {
        const vec = emb_data.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
        await db.exec(
          'INSERT OR IGNORE INTO email_vecs(ulid, chunk_idx, embedding) VALUES (?, ?, ?)',
          { bind: [ulid, i, vec] },
        );
      }
    }

    await db.exec('PRAGMA user_version = 3');
  }

  if (version < 4) {
    try { await db.exec('ALTER TABLE email_metadata ADD COLUMN ccAddresses TEXT'); } catch { /* already exists */ }

    await db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        address   TEXT PRIMARY KEY,
        name      TEXT NOT NULL DEFAULT '',
        frequency INTEGER NOT NULL DEFAULT 1,
        lastSeen  TEXT NOT NULL
      )
    `);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_contacts_freq
        ON contacts(frequency DESC, lastSeen DESC)
    `);

    // Seed from existing email_metadata rows so already-synced emails contribute.
    await db.exec(`
      INSERT OR IGNORE INTO contacts(address, name, frequency, lastSeen)
        SELECT lower(fromAddress), COALESCE(fromName,''), 1, receivedAt
        FROM email_metadata
        WHERE fromAddress IS NOT NULL AND fromAddress != ''
    `);

    await db.exec('PRAGMA user_version = 4');
  }

  if (version < 5) {
    try { await db.exec('ALTER TABLE email_metadata ADD COLUMN bccAddresses TEXT'); } catch { /* already exists */ }
    await db.exec('PRAGMA user_version = 5');
  }

  if (version < 6) {
    try { await db.exec('ALTER TABLE email_metadata ADD COLUMN wrappedEmailKey TEXT'); } catch { /* already exists */ }
    await db.exec('PRAGMA user_version = 6');
  }

  if (version < 7) {
    try { await db.exec('ALTER TABLE email_metadata ADD COLUMN listUnsubscribe TEXT'); } catch { /* already exists */ }
    try { await db.exec('ALTER TABLE email_metadata ADD COLUMN listUnsubscribePost TEXT'); } catch { /* already exists */ }
    await db.exec('PRAGMA user_version = 7');
  }

  if (version < 8) {
    try { await db.exec('ALTER TABLE email_metadata ADD COLUMN lastUpdatedAt TEXT'); } catch { /* already exists */ }
    
    // Backfill lastUpdatedAt for existing emails using receivedAt
    await db.exec(`
      UPDATE email_metadata
      SET lastUpdatedAt = receivedAt
      WHERE lastUpdatedAt IS NULL
    `);
    
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_email_lastUpdatedAt
        ON email_metadata(lastUpdatedAt DESC)
    `);
    await db.exec('PRAGMA user_version = 8');
  }

  if (version < 9) {
    try { await db.exec('ALTER TABLE email_metadata ADD COLUMN version INTEGER NOT NULL DEFAULT 1'); } catch { /* already exists */ }
    
    // Backfill version for existing emails (start at 1)
    await db.exec(`
      UPDATE email_metadata
      SET version = 1
      WHERE version IS NULL OR version = 0
    `);
    
    await db.exec('PRAGMA user_version = 9');
  }

  if (version < 10) {
    try { await db.exec('ALTER TABLE email_metadata ADD COLUMN messageId TEXT'); } catch { /* already exists */ }
    await db.exec('PRAGMA user_version = 10');
  }

  if (version < 11) {
    try { await db.exec('ALTER TABLE email_metadata ADD COLUMN hasAttachments INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
    await db.exec('PRAGMA user_version = 11');
  }

  if (version < 12) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS labels (
        labelId      TEXT PRIMARY KEY,
        name         TEXT NOT NULL DEFAULT '',
        color        TEXT NOT NULL DEFAULT '',
        lastUpdatedAt TEXT NOT NULL
      )
    `);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS migration_status (
        migrationId  TEXT PRIMARY KEY,
        userId       TEXT NOT NULL,
        status       TEXT NOT NULL,
        progress     INTEGER NOT NULL DEFAULT 0,
        totalEmails  INTEGER NOT NULL DEFAULT 0,
        lastUpdatedAt TEXT NOT NULL
      )
    `);
    await db.exec('PRAGMA user_version = 12');
  }

  if (version < 13) {
    // Rebuild email_fts to add fromName column for sender name search.
    // Preserve existing body_text by saving it first, then repopulating.
    await db.exec(`CREATE TEMP TABLE fts_backup AS SELECT ulid, body_text FROM email_fts`);
    await db.exec(`DROP TABLE email_fts`);
    await db.exec(`
      CREATE VIRTUAL TABLE email_fts USING fts5(
        ulid,
        subject,
        fromName,
        fromAddress,
        preview,
        body_text,
        tokenize = 'porter unicode61'
      )
    `);
    await db.exec(`
      INSERT INTO email_fts(ulid, subject, fromName, fromAddress, preview, body_text)
        SELECT m.ulid, COALESCE(m.subject,''), COALESCE(m.fromName,''), COALESCE(m.fromAddress,''), COALESCE(m.preview,''), COALESCE(b.body_text,'')
        FROM email_metadata m
        LEFT JOIN fts_backup b ON b.ulid = m.ulid
    `);
    await db.exec(`DROP TABLE fts_backup`);
    await db.exec('PRAGMA user_version = 13');
  }

  if (version < 14) {
    // Wrap entire migration in a transaction — prevents half-migrated state on crash.
    await db.exec('BEGIN');
    try {
      // Add email_id INTEGER PRIMARY KEY to email_metadata as a stable rowid alias for FTS.
      // SQLite requires table recreation to add an INTEGER PRIMARY KEY.
      await db.exec(`
        CREATE TABLE email_metadata_new (
          email_id         INTEGER PRIMARY KEY,
          ulid             TEXT NOT NULL UNIQUE,
          threadId         TEXT NOT NULL,
          folderId         TEXT NOT NULL DEFAULT 'INBOX',
          labelIds         TEXT NOT NULL DEFAULT '[]',
          receivedAt       TEXT NOT NULL,
          receivedMs       INTEGER NOT NULL,
          isRead           INTEGER NOT NULL DEFAULT 0,
          s3BodyKey        TEXT,
          s3TextKey        TEXT,
          s3EmbeddingKey   TEXT,
          s3AttachmentsKey TEXT,
          subject          TEXT,
          fromName         TEXT,
          fromAddress      TEXT,
          preview          TEXT,
          toAddresses      TEXT,
          ccAddresses      TEXT,
          bccAddresses     TEXT,
          indexed_at       TEXT,
          wrappedEmailKey  TEXT,
          listUnsubscribe     TEXT,
          listUnsubscribePost TEXT,
          lastUpdatedAt    TEXT,
          version          INTEGER NOT NULL DEFAULT 1,
          messageId        TEXT,
          hasAttachments   INTEGER NOT NULL DEFAULT 0
        )
      `);
      await db.exec(`
        INSERT INTO email_metadata_new
          (ulid, threadId, folderId, labelIds, receivedAt, receivedMs, isRead,
           s3BodyKey, s3TextKey, s3EmbeddingKey, s3AttachmentsKey,
           subject, fromName, fromAddress, preview, toAddresses, ccAddresses, bccAddresses,
           indexed_at, wrappedEmailKey, listUnsubscribe, listUnsubscribePost,
           lastUpdatedAt, version, messageId, hasAttachments)
        SELECT
          ulid, threadId, folderId, labelIds, receivedAt, receivedMs, isRead,
          s3BodyKey, s3TextKey, s3EmbeddingKey, s3AttachmentsKey,
          subject, fromName, fromAddress, preview, toAddresses, ccAddresses, bccAddresses,
          indexed_at, wrappedEmailKey, listUnsubscribe, listUnsubscribePost,
          lastUpdatedAt, version, messageId, hasAttachments
        FROM email_metadata
      `);
      await db.exec(`DROP TABLE email_metadata`);
      await db.exec(`ALTER TABLE email_metadata_new RENAME TO email_metadata`);

      // Recreate ALL indexes (table rebuild drops them all)
      await db.exec(`CREATE INDEX idx_folder_received ON email_metadata(folderId, receivedMs DESC)`);
      await db.exec(`CREATE INDEX idx_email_lastUpdatedAt ON email_metadata(lastUpdatedAt DESC)`);

      // Rebuild email_fts as contentless with contentless_delete=1.
      // Stores only the inverted index (no text), but supports DELETE by rowid.
      // email_id is INTEGER PRIMARY KEY — stable rowid alias, safe across VACUUM.
      await db.exec(`DROP TABLE email_fts`);
      await db.exec(`
        CREATE VIRTUAL TABLE email_fts USING fts5(
          subject,
          fromName,
          fromAddress,
          preview,
          body_text,
          content='',
          contentless_delete=1,
          tokenize='porter unicode61'
        )
      `);
      await db.exec(`
        INSERT INTO email_fts(rowid, subject, fromName, fromAddress, preview, body_text)
          SELECT email_id, COALESCE(subject,''), COALESCE(fromName,''), COALESCE(fromAddress,''), COALESCE(preview,''), ''
          FROM email_metadata
      `);

      // Reset indexed_at so the indexer re-populates body_text into the new table
      await db.exec(`UPDATE email_metadata SET indexed_at = NULL`);

      await db.exec('PRAGMA user_version = 14');
      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }
  }

  if (version < 15) {
    // Drop userId column from labels (redundant — DB is per-user) and fix NOT NULL on name.
    try {
      await db.exec(`ALTER TABLE labels DROP COLUMN userId`);
    } catch { /* column may not exist */ }
    await db.exec('PRAGMA user_version = 15');
  }

  if (version < 16) {
    try { await db.exec('ALTER TABLE email_metadata ADD COLUMN attachmentFilenames TEXT'); } catch { /* already exists */ }
    await db.exec('PRAGMA user_version = 16');
  }

  return db;
}

async function initDb(): Promise<SqliteDb> {
  try {
    return await initDbInner();
  } catch (err) {
    remoteLogger.error('Database initialization failed', { error: String(err) });
    throw err;
  }
}
