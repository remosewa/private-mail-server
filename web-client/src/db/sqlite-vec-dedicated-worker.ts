/**
 * sqlite-vec-dedicated-worker.ts — Dedicated worker per tab.
 *
 * Each tab spawns one of these. Only the "leader" tab's dedicated worker
 * actually opens the OPFS database. All other tabs route SQL through the
 * SharedWorker which relays to the leader's dedicated worker.
 *
 * Leader election uses the Web Locks API — the tab that holds the named
 * lock is the leader. When that tab closes the lock is released and another
 * tab's worker acquires it.
 *
 * Message protocol (from SharedWorker router)
 * -------------------------------------------
 *   { type: 'init', key: Uint8Array, userId: string }
 *   { type: 'recover-corrupt' }
 *   { id, sql, bind?, rowMode?, returnValue?, replyPort: MessagePort }  ← SQL query forwarded from another tab
 *
 * Message protocol (from own tab's Database.ts)
 * ----------------------------------------------
 *   { type: 'init', key: Uint8Array, userId: string }
 *   { type: 'recover-corrupt' }
 *   { id, sql, bind?, rowMode?, returnValue? }  ← direct SQL query
 *
 * Responses always go to the port that sent the query (replyPort or self).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import sqlite3InitModule from 'sqlite-vec-wasm-demo';
import { installEncryptionProxy } from './EncryptedOPFSHandle';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SqlReq = {
  id: number;
  sql: string;
  bind?: unknown[];
  rowMode?: 'object' | 'array';
  returnValue?: 'resultRows';
  replyPort?: MessagePort; // set when forwarded from SharedWorker
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let db: any = null;
let savedKey: Uint8Array | null = null;
let savedUserId: string | null = null;
let isLeader = false;

let pendingResolve!: () => void;
let pendingReject!: (e: Error) => void;
let readyPromise: Promise<void> = new Promise<void>((res, rej) => {
  pendingResolve = res;
  pendingReject = rej;
});

// Serial execution queue — transactions are serialised client-side via
// VecDb.withTransaction / txDone, so the dedicated worker just needs a
// simple FIFO queue with no per-port transaction tracking.
let execQueue: Promise<void> = Promise.resolve();

// ---------------------------------------------------------------------------
// DB open
// ---------------------------------------------------------------------------

function printErrFilter(msg: string) {
  if (msg.includes('OPFS') && (msg.includes('asyncer') || msg.includes('sqlite3_vfs'))) return;
  console.error('[dedicated-worker]', msg);
}

async function openDb(key: Uint8Array, userId: string, skipProxyInstall = false): Promise<any> {
  if (!skipProxyInstall) {
    try {
      installEncryptionProxy(key);
    } catch (proxyErr) {
      // On some Android builds, prototype mutation of FileSystemFileHandle is
      // rejected (strict context isolation).  Log and fall through to in-memory.
      console.warn('[dedicated-worker] installEncryptionProxy failed — will use in-memory DB:', proxyErr);
      return new (await sqlite3InitModule({ printErr: printErrFilter })).oo1.DB(':memory:', 'c');
    }
  }

  const sqlite3: any = await sqlite3InitModule({ printErr: printErrFilter });
  const directory = `.chase-email-enc-db-${userId}`;

  if (typeof sqlite3.installOpfsSAHPoolVfs === 'function') {
    try {
      await sqlite3.installOpfsSAHPoolVfs({ directory, capacity: 3 });
      return new sqlite3.oo1.DB({ filename: '/chase-email.db', vfs: 'opfs-sahpool' });
    } catch (opfsErr) {
      const msg = String(opfsErr);
      if (msg.includes('SQLITE_CORRUPT') || msg.includes('result code 11')) throw opfsErr;
      console.warn('[dedicated-worker] OPFS open failed, falling back to in-memory:', msg);
      return new sqlite3.oo1.DB(':memory:', 'c');
    }
  }

  console.warn('[dedicated-worker] OPFS unavailable — data will not persist.');
  return new sqlite3.oo1.DB(':memory:', 'c');
}

// ---------------------------------------------------------------------------
// Leader election
// ---------------------------------------------------------------------------

/** Called once the Web Lock is acquired. Opens the DB and holds the lock forever
 *  (until the worker is terminated). On failure, returns so the lock is released. */
async function becomeLeader() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isolated = (self as any).crossOriginIsolated;
  console.log('[dedicated-worker] Became leader — crossOriginIsolated=', isolated, ' SharedArrayBuffer=', typeof SharedArrayBuffer);

  // Signal immediately — before the heavy WASM init — so competing workers
  // can reset their steal timers and not steal a healthy leader mid-init.
  self.postMessage({ type: 'lock-acquired' });

  try {
    db = await openDb(savedKey!, savedUserId!);
    // Only mark as leader after the DB is ready — prevents runQuery from
    // calling db.exec() on a null db if a SQL message arrives during init.
    isLeader = true;
    pendingResolve();
    self.postMessage({ type: 'leader-ready' });
    // Hold the lock indefinitely — released only when the worker is terminated.
    // Use a periodic no-op timer so Android's background scheduler doesn't
    // treat this worker as frozen/idle and silently kill it.
    await new Promise<void>(() => { setInterval(() => {}, 30_000); });
  } catch (err) {
    console.error('[dedicated-worker] Failed to open DB — releasing leader lock:', err);
    pendingReject(err instanceof Error ? err : new Error(String(err)));
    self.postMessage({ type: 'leader-error', error: String(err) });
    // Return → lock is released → lets a fresh worker retry.
  }
}

function tryBecomeLeader() {
  console.log('[dedicated-worker] Requesting leader lock…');

  // Abort the normal request after 20 s and steal the lock instead.
  // 5 s was too aggressive — WASM init on mid-range Android takes 3–6 s,
  // so a healthy leader could be stolen while still in sqlite3InitModule.
  const controller = new AbortController();
  const stealTimer = setTimeout(() => {
    console.warn('[dedicated-worker] Lock not acquired after 20 s — stealing from stale holder');
    controller.abort();
  }, 20_000);

  navigator.locks
    .request('chase-email-sqlite-leader', { signal: controller.signal }, async () => {
      clearTimeout(stealTimer);
      await becomeLeader();
    })
    .catch((err: Error) => {
      if (err.name !== 'AbortError') {
        // Unexpected lock error (not a timeout).
        console.error('[dedicated-worker] Lock request failed:', err);
        pendingReject(err);
        self.postMessage({ type: 'leader-error', error: String(err) });
        return;
      }
      // Distinguish: if controller.signal.aborted, WE triggered the abort (5 s timeout)
      // → steal the lock from the stale holder.
      // If signal is NOT aborted, our lock was stolen BY someone else
      // → exit gracefully; don't steal back (that creates a mutual steal loop).
      if (controller.signal.aborted) {
        navigator.locks.request('chase-email-sqlite-leader', { steal: true }, () => becomeLeader());
      }
      // else: our lock was stolen — just exit, the thief is now responsible.
    });
}

// ---------------------------------------------------------------------------
// SQL execution
// ---------------------------------------------------------------------------

async function runQuery(replyPort: MessagePort | typeof self, req: SqlReq): Promise<void> {
  const { id, sql, bind, rowMode, returnValue } = req;
  try {
    if (returnValue === 'resultRows') {
      const rows: unknown[] = [];
      db.exec({ sql, bind, rowMode: rowMode ?? 'object', resultRows: rows });
      replyPort.postMessage({ id, result: rows });
    } else {
      if (bind && bind.length > 0) {
        db.exec(sql, { bind });
      } else {
        db.exec(sql);
      }
      replyPort.postMessage({ id, result: null });
    }
  } catch (err) {
    replyPort.postMessage({ id, error: String(err) });
  }
}

function enqueueQuery(replyPort: MessagePort | typeof self, req: SqlReq) {
  execQueue = execQueue
    .then(() => runQuery(replyPort, req))
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Corruption recovery
// ---------------------------------------------------------------------------

async function recoverCorrupt() {
  if (!savedUserId || !savedKey) return;
  console.error('[dedicated-worker] SQLITE_CORRUPT — wiping and resyncing');

  try { db?.close(); } catch { /* ignore */ }
  db = null;
  execQueue = Promise.resolve();

  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(`.chase-email-enc-db-${savedUserId}`, { recursive: true });
  } catch (err) {
    console.warn('[dedicated-worker] Could not delete corrupt DB files:', err);
  }

  readyPromise = new Promise<void>((res, rej) => {
    pendingResolve = res;
    pendingReject = rej;
  });
  execQueue = Promise.resolve();

  // Re-open (proxy already installed)
  try {
    db = await openDb(savedKey, savedUserId, true);
    pendingResolve();
    self.postMessage({ type: 'leader-ready' });
    // Signal that the wipe + re-open is fully complete so the main thread
    // can safely terminate this worker and spawn a fresh one.
    self.postMessage({ type: 'recover-complete' });
  } catch (err) {
    pendingReject(err instanceof Error ? err : new Error(String(err)));
    self.postMessage({ type: 'leader-error', error: String(err) });
    // Also signal completion on failure so the main thread doesn't wait forever.
    self.postMessage({ type: 'recover-complete' });
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = (ev: MessageEvent) => {
  const data = ev.data;

  if (data.type === 'init') {
    // Post back immediately — before any lock/WASM/SQLite code — so the main
    // thread can confirm this worker's onmessage handler was reached.
    // If the main thread never sees 'worker-ping', the worker crashed during
    // module evaluation (import of sqlite-vec-wasm-demo / @noble/ciphers).
    self.postMessage({ type: 'worker-ping' });
    savedKey = data.key as Uint8Array;
    savedUserId = data.userId as string;
    tryBecomeLeader();
    return;
  }

  if (data.type === 'recover-corrupt') {
    void recoverCorrupt();
    return;
  }

  // The SharedWorker sends us a port to listen on for forwarded queries from other tabs
  if (data.type === 'add-router-port') {
    const routerPort = data.port as MessagePort;
    routerPort.onmessage = (rev: MessageEvent) => {
      const req = rev.data as SqlReq;
      // replyPort is already set by the SharedWorker router
      readyPromise
        .then(() => enqueueQuery(req.replyPort ?? routerPort, req))
        .catch(err => (req.replyPort ?? routerPort).postMessage({ id: req.id, error: String(err) }));
    };
    routerPort.start();
    return;
  }

  // Direct SQL query from own tab
  const req = data as SqlReq;

  if (!isLeader) {
    self.postMessage({ id: req.id, error: 'This worker is not the DB leader' });
    return;
  }

  readyPromise
    .then(() => enqueueQuery(self as any, req))
    .catch(err => self.postMessage({ id: req.id, error: String(err) }));
};
