/**
 * Database — SQLite via a SharedWorker.
 *
 * The SharedWorker (sqlite-vec-shared-worker.ts) owns the single OPFS
 * SAH-pool connection and is shared across every tab on the same origin.
 * This eliminates the "another tab holds the lock" problem entirely.
 *
 * Each tab communicates with the worker through its own MessagePort.
 * All queries are serialised inside the worker; explicit transactions
 * additionally hold a per-port lock so no other tab can interleave.
 */

import { useAuthStore } from '../store/authStore';
import { getOrCreateDbKey } from './dbKeyManager';
import { remoteLogger } from '../api/logger';
import SharedDbWorker from './sqlite-vec-shared-worker?sharedworker';
import DedicatedDbWorker from './sqlite-vec-dedicated-worker?worker';

export interface SqliteDb {
  exec(sql: string, opts?: { bind?: unknown[] }): Promise<void>;
  selectObjects(sql: string, bind?: unknown[]): Promise<Record<string, unknown>[]>;
  selectValue(sql: string, bind?: unknown[]): Promise<unknown>;
  /** Run fn inside a BEGIN/COMMIT transaction, serialised against other callers. */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
}

// ── RPC client over MessagePort ──────────────────────────────────────────────

type RpcEntry = { resolve: (v: unknown) => void; reject: (e: Error) => void };

class VecDb implements SqliteDb {
  private readonly pending = new Map<number, RpcEntry>();
  private nextId = 1;
  readonly ready: Promise<void>;
  private rpcQueue: Promise<unknown> = Promise.resolve();
  private txDone: Promise<void> = Promise.resolve();
  /** True once the dedicated worker wins the leader lock. */
  private isLeader = false;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    /** The dedicated worker for this tab — SQL goes here if we are the leader. */
    readonly dedicatedWorker: Worker,
    /** The SharedWorker port — SQL is routed here when we are NOT the leader. */
    readonly port: MessagePort,
    rawDbKey: Uint8Array,
    userId: string,
    private readonly onCorrupt: () => void,
  ) {
    let resolveReady!: () => void;
    let rejectReady!: (e: Error) => void;
    this.ready = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });

    // Surface worker startup failures (module load error, WASM crash, etc.)
    dedicatedWorker.onerror = (e: ErrorEvent): void => {
      console.error('[Database] Dedicated worker crashed:', e.message, e.filename, e.lineno);
      rejectReady(new Error(`Dedicated worker crashed: ${e.message}`));
    };

    // Listen for SQL replies from the dedicated worker (leader path)
    dedicatedWorker.onmessage = (e: MessageEvent): void => {
      const { type, id, result, error } =
        e.data as { type?: string; id?: number; result?: unknown; error?: string };

      if (type === 'worker-ping') {
        console.log('[Database] Dedicated worker reached onmessage — module loaded OK');
        return;
      }

      if (type === 'lock-acquired') {
        // The current lock holder just entered becomeLeader before WASM init.
        // Logged for observability — the 20 s steal timeout is the actual guard
        // against stealing a healthy-but-slow leader.
        console.log('[Database] Lock holder signalled lock-acquired — WASM init in progress');
        return;
      }

      if (type === 'leader-ready') {
        // Wire the dedicated worker into the SharedWorker router via a
        // MessageChannel so non-leader tabs can forward SQL queries here.
        // Doing this here (not in initDbInner) ensures there's exactly one
        // listener and no orphaned addEventListener closures on retry.
        const { port1, port2 } = new MessageChannel();
        dedicatedWorker.postMessage({ type: 'add-router-port', port: port1 }, [port1]);
        port.postMessage({ type: 'i-am-leader', leaderPort: port2 }, [port2]);

        this.isLeader = true;
        resolveReady();
        // Send periodic heartbeats so the SharedWorker can detect if this tab
        // crashes or is killed without sending 'leader-closed'.
        this.heartbeatInterval = setInterval(() => {
          this.port.postMessage({ type: 'heartbeat' });
        }, 5_000);
        return;
      }
      if (type === 'leader-error') {
        console.error('[Database] Dedicated worker failed to open DB:', error);
        rejectReady(new Error(error));
        return;
      }

      if (id !== undefined) {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          if (error) entry.reject(new Error(error));
          else entry.resolve(result as unknown);
        }
        return;
      }
    };

    // Listen for coordination messages AND SQL replies (non-leader path) from the SharedWorker
    port.onmessage = (e: MessageEvent): void => {
      const data = e.data as { type?: string; id?: number; result?: unknown; error?: string };
      if (data.type) {
        // Coordination message (do-sync, sync-done, etc.)
        dispatchWorkerMessage(data as Record<string, unknown>);

        // Non-leader: SharedWorker signals that a leader is now available — we're ready
        if (data.type === 'leader-available' && !this.isLeader) {
          resolveReady();
        }
        return;
      }
      // SQL reply routed back from the SharedWorker (non-leader path)
      if (data.id !== undefined) {
        const entry = this.pending.get(data.id);
        if (entry) {
          this.pending.delete(data.id);
          if (data.error) entry.reject(new Error(data.error));
          else entry.resolve(data.result as unknown);
        }
      }
    };

    port.addEventListener('messageerror', (e: MessageEvent): void => {
      remoteLogger.error('Database port error', { message: String(e.data) });
      rejectReady(new Error(String(e.data)));
    });

    // Start the dedicated worker — it will race for the leader lock
    dedicatedWorker.postMessage({ type: 'init', key: rawDbKey, userId });

    // Register with the SharedWorker — it will trigger a sync and notify us
    // if a leader is already present (so non-leader tabs become ready immediately)
    port.postMessage({ type: 'register' });
  }

  private rpc(data: Record<string, unknown>): Promise<unknown> {
    const call = this.rpcQueue.then(() =>
      this.ready.then(
        () => new Promise((resolve, reject) => {
          const id = this.nextId++;
          this.pending.set(id, { resolve, reject });
          if (this.isLeader) {
            // Leader: send directly to our own dedicated worker
            this.dedicatedWorker.postMessage({ id, ...data });
          } else {
            // Non-leader: route through the SharedWorker to the leader
            this.port.postMessage({ id, ...data });
          }
        }),
      ),
    );
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
    const prevTx = this.txDone;
    let releaseTx!: () => void;
    this.txDone = new Promise<void>(res => { releaseTx = res; });

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

  close(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    // Only the leader should send leader-closed — non-leader tabs closing must
    // not null out the SharedWorker's leaderPort and break other tabs' routing.
    if (this.isLeader) {
      this.port.postMessage({ type: 'leader-closed' });
    }
    this.port.close();
    this.dedicatedWorker.terminate();
  }

  /**
   * Prepare this instance for corruption recovery: stop the heartbeat, reject
   * all in-flight RPCs, and install a one-shot onmessage that terminates the
   * worker once it signals recover-complete (wipe done, lock released).
   * Does NOT terminate the worker immediately — it must finish the OPFS wipe first.
   */
  prepareForRecovery(reason: string, onComplete: () => void): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const [, entry] of this.pending) {
      entry.reject(new Error(reason));
    }
    this.pending.clear();
    // Replace onmessage with a one-shot handler: terminate the worker once the
    // wipe is done so the Web Lock is released and a fresh worker can acquire it.
    this.dedicatedWorker.onmessage = (e: MessageEvent) => {
      if (e.data?.type === 'recover-complete' || e.data?.type === 'leader-error') {
        this.dedicatedWorker.terminate();
        onComplete();
      }
    };
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let dbPromise: Promise<SqliteDb> | null = null;
let currentUserId: string | null = null;
let currentDb: VecDb | null = null;
/** Sync timer used in no-SharedWorker mode — cleared on teardown to prevent leaks. */
let noSharedWorkerSyncInterval: ReturnType<typeof setInterval> | null = null;

/** True when SharedWorker is unavailable (e.g. Android Chrome). */
const sharedWorkerSupported = typeof SharedWorker !== 'undefined';

// ── Worker communication helpers ─────────────────────────────────────────────

/** Send a fire-and-forget message to the SharedWorker (no-op when unsupported). */
export function sendToWorker(msg: Record<string, unknown>): void {
  if (sharedWorkerSupported) {
    currentDb?.port.postMessage(msg);
  } else {
    // In no-SharedWorker mode the dedicated worker drives sync directly;
    // simulate the response messages that the shared worker would broadcast.
    if (msg.type === 'sync-result') {
      dispatchWorkerMessage({ type: 'sync-done', synced: msg.synced ?? 0 });
      // Trigger index after sync completes (mirrors shared worker behaviour)
      dispatchWorkerMessage({ type: 'do-index' });
    }
  }
}

type WorkerHandler = (msg: Record<string, unknown>) => void;
const workerHandlers = new Set<WorkerHandler>();

/** Subscribe to non-RPC messages from the SharedWorker (e.g. sync-done, do-sync). */
export function subscribeToWorker(handler: WorkerHandler): () => void {
  workerHandlers.add(handler);
  return () => workerHandlers.delete(handler);
}

/** Called from VecDb.port.onmessage for non-RPC messages — routes to subscribers. */
function dispatchWorkerMessage(msg: Record<string, unknown>): void {
  for (const h of workerHandlers) {
    try { h(msg); } catch { /* individual handler errors should not break others */ }
  }
}

export function teardownDb(): void {
  if (noSharedWorkerSyncInterval) {
    clearInterval(noSharedWorkerSyncInterval);
    noSharedWorkerSyncInterval = null;
  }
  currentDb?.close();
  currentDb = null;
  dbPromise = null;
  currentUserId = null;
}

export function getDb(): Promise<SqliteDb> {
  const userId = useAuthStore.getState().userId;

  if (userId && userId !== currentUserId) {
    teardownDb();
    currentUserId = userId;
  }

  if (!dbPromise) {
    dbPromise = initDb();
    // Reset on failure so the next call retries. Use setTimeout(0) so all
    // current waiters receive the rejection before dbPromise is cleared —
    // prevents a burst of concurrent callers from each spawning a new initDb().
    dbPromise.catch(() => { setTimeout(() => { dbPromise = null; }, 0); });
  }
  return dbPromise;
}

// ── Corruption recovery ───────────────────────────────────────────────────────

async function recoverCorruptDb(userId: string): Promise<void> {
  console.error('[Database] SQLITE_CORRUPT — sending recover-corrupt to dedicated worker');
  remoteLogger.error('Database corruption detected — wiping local DB and resyncing', { userId });

  const dying = currentDb;
  currentDb = null;
  // Don't clear dbPromise yet — clear it only once the worker signals
  // recover-complete, so getDb() callers wait rather than spawning a new
  // worker that would immediately contend for the still-held Web Lock.
  currentUserId = null;

  if (dying) {
    const recoveryTimeout = setTimeout(() => {
      console.warn('[Database] Recovery timed out — forcing dbPromise reset');
      dbPromise = null;
    }, 30_000);

    dying.prepareForRecovery('Database corruption recovery in progress', () => {
      clearTimeout(recoveryTimeout);
      dbPromise = null;
    });

    if (sharedWorkerSupported) {
      dying.port.postMessage({ type: 'recover-corrupt' });
    } else {
      dying.dedicatedWorker.postMessage({ type: 'recover-corrupt' });
    }
    dying.port.close();
  } else {
    dbPromise = null;
  }
}

// ── Schema init ───────────────────────────────────────────────────────────────

async function initDbInner(): Promise<SqliteDb> {
  const { userId, privateKey, publicKey } = useAuthStore.getState();
  if (!userId || !privateKey || !publicKey) throw new Error('initDb: not authenticated');

  const rawDbKey = await getOrCreateDbKey(userId, privateKey, publicKey);

  // Terminate any stale db instance left over from a previous failed initDb attempt.
  if (currentDb) {
    currentDb.close();
    currentDb = null;
  }

  // Spawn the dedicated worker for this tab — it will race for the leader lock
  const dedicated = new DedicatedDbWorker({ name: `chase-email-db-dedicated-${userId}` });

  if (!sharedWorkerSupported) {
    // ── No-SharedWorker fallback (e.g. Android Chrome) ──────────────────────
    // Use a MessageChannel as a fake "shared worker port" so VecDb's constructor
    // works unchanged. The dedicated worker IS the leader; VecDb's leader-ready
    // handler wires up add-router-port automatically.
    const { port1, port2 } = new MessageChannel();
    port1.start();
    port2.start();
    // Drain messages sent to port2 (e.g. i-am-leader) so the channel doesn't back up.
    // Close any transferred ports to avoid leaks.
    port2.onmessage = (e: MessageEvent) => {
      if (e.data?.leaderPort) (e.data.leaderPort as MessagePort).close();
    };

    const db = new VecDb(dedicated, port1, rawDbKey, userId, () => { void recoverCorruptDb(userId); });
    currentDb = db;
    await db.ready;
    await applySchema(db);

    // Kick off periodic sync (mirrors SharedWorker behaviour)
    const SYNC_INTERVAL_MS = 30_000;
    dispatchWorkerMessage({ type: 'do-sync' });
    noSharedWorkerSyncInterval = setInterval(() => dispatchWorkerMessage({ type: 'do-sync' }), SYNC_INTERVAL_MS);

    return db;
  }

  // ── Normal path: SharedWorker available ─────────────────────────────────
  // Connect to the SharedWorker router. VecDb's constructor handles the
  // leader-ready → add-router-port + i-am-leader handshake internally;
  // no duplicate addEventListener needed here.
  const shared = new SharedDbWorker({ name: 'chase-email-db' });
  shared.onerror = (e: ErrorEvent) => {
    remoteLogger.error('SharedWorker failed to load', { message: e.message });
    console.error('[Database] SharedWorker failed to load:', e);
  };
  shared.port.start();

  const db = new VecDb(dedicated, shared.port, rawDbKey, userId, () => { void recoverCorruptDb(userId); });
  currentDb = db;
  await db.ready;
  await applySchema(db);
  return db;
}

// ── Schema creation + migrations ──────────────────────────────────────────────

async function applySchema(db: VecDb): Promise<void> {
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
      const msg = (e as Error).message ?? '';
      if (!msg.includes('duplicate column name') && !msg.includes('already exists')) throw e;
    }
    await db.exec('DROP TABLE IF EXISTS email_fts');
    await db.exec(`
      CREATE VIRTUAL TABLE email_fts USING fts5(
        ulid, subject, fromName, fromAddress, preview, body_text,
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
    await db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS email_vecs USING vec0(
        +ulid      TEXT,
        +chunk_idx INTEGER,
        embedding  FLOAT[384]
      )
    `);
    const CHUNK_BYTES = 384 * 4;
    const existing = await db.selectObjects('SELECT ulid, n_chunks, emb_data FROM email_embeddings');
    for (const row of existing) {
      const ulid = row['ulid'] as string;
      const nChunks = row['n_chunks'] as number;
      const emb_data = row['emb_data'] as Uint8Array;
      for (let i = 0; i < nChunks; i++) {
        const vec = emb_data.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
        await db.exec('INSERT OR IGNORE INTO email_vecs(ulid, chunk_idx, embedding) VALUES (?, ?, ?)', { bind: [ulid, i, vec] });
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
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_freq ON contacts(frequency DESC, lastSeen DESC)`);
    await db.exec(`
      INSERT OR IGNORE INTO contacts(address, name, frequency, lastSeen)
        SELECT lower(fromAddress), COALESCE(fromName,''), 1, receivedAt
        FROM email_metadata WHERE fromAddress IS NOT NULL AND fromAddress != ''
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
    await db.exec(`UPDATE email_metadata SET lastUpdatedAt = receivedAt WHERE lastUpdatedAt IS NULL`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_email_lastUpdatedAt ON email_metadata(lastUpdatedAt DESC)`);
    await db.exec('PRAGMA user_version = 8');
  }

  if (version < 9) {
    try { await db.exec('ALTER TABLE email_metadata ADD COLUMN version INTEGER NOT NULL DEFAULT 1'); } catch { /* already exists */ }
    await db.exec(`UPDATE email_metadata SET version = 1 WHERE version IS NULL OR version = 0`);
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
        labelId       TEXT PRIMARY KEY,
        name          TEXT NOT NULL DEFAULT '',
        color         TEXT NOT NULL DEFAULT '',
        lastUpdatedAt TEXT NOT NULL
      )
    `);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS migration_status (
        migrationId   TEXT PRIMARY KEY,
        userId        TEXT NOT NULL,
        status        TEXT NOT NULL,
        progress      INTEGER NOT NULL DEFAULT 0,
        totalEmails   INTEGER NOT NULL DEFAULT 0,
        lastUpdatedAt TEXT NOT NULL
      )
    `);
    await db.exec('PRAGMA user_version = 12');
  }

  if (version < 13) {
    await db.exec(`CREATE TEMP TABLE fts_backup AS SELECT ulid, body_text FROM email_fts`);
    await db.exec(`DROP TABLE email_fts`);
    await db.exec(`
      CREATE VIRTUAL TABLE email_fts USING fts5(
        ulid, subject, fromName, fromAddress, preview, body_text,
        tokenize = 'porter unicode61'
      )
    `);
    await db.exec(`
      INSERT INTO email_fts(ulid, subject, fromName, fromAddress, preview, body_text)
        SELECT m.ulid, COALESCE(m.subject,''), COALESCE(m.fromName,''), COALESCE(m.fromAddress,''), COALESCE(m.preview,''), COALESCE(b.body_text,'')
        FROM email_metadata m LEFT JOIN fts_backup b ON b.ulid = m.ulid
    `);
    await db.exec(`DROP TABLE fts_backup`);
    await db.exec('PRAGMA user_version = 13');
  }

  if (version < 14) {
    await db.withTransaction(async () => {
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
      await db.exec(`CREATE INDEX idx_folder_received ON email_metadata(folderId, receivedMs DESC)`);
      await db.exec(`CREATE INDEX idx_email_lastUpdatedAt ON email_metadata(lastUpdatedAt DESC)`);
      await db.exec(`DROP TABLE email_fts`);
      await db.exec(`
        CREATE VIRTUAL TABLE email_fts USING fts5(
          subject, fromName, fromAddress, preview, body_text,
          content='', contentless_delete=1, tokenize='porter unicode61'
        )
      `);
      await db.exec(`
        INSERT INTO email_fts(rowid, subject, fromName, fromAddress, preview, body_text)
          SELECT email_id, COALESCE(subject,''), COALESCE(fromName,''), COALESCE(fromAddress,''), COALESCE(preview,''), ''
          FROM email_metadata
      `);
      await db.exec(`UPDATE email_metadata SET indexed_at = NULL`);
      await db.exec('PRAGMA user_version = 14');
    });
  }

  if (version < 15) {
    try { await db.exec(`ALTER TABLE labels DROP COLUMN userId`); } catch { /* column may not exist */ }
    await db.exec('PRAGMA user_version = 15');
  }

  if (version < 16) {
    try { await db.exec('ALTER TABLE email_metadata ADD COLUMN attachmentFilenames TEXT'); } catch { /* already exists */ }
    await db.exec('PRAGMA user_version = 16');
  }
}

async function initDb(): Promise<SqliteDb> {
  console.log('[Database] initDb starting…');
  try {
    const db = await initDbInner();
    console.log('[Database] initDb succeeded');
    return db;
  } catch (err) {
    console.error('[Database] initDb failed:', String(err));
    remoteLogger.error('Database initialization failed', { error: String(err) });
    throw err;
  }
}
