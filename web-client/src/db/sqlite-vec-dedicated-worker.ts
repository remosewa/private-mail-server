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

// Serial execution queue + transaction lock
let execQueue: Promise<void> = Promise.resolve();
let txOwnerPort: MessagePort | null = null;
const deferredMessages: Array<{ port: MessagePort; req: SqlReq }> = [];

// ---------------------------------------------------------------------------
// DB open
// ---------------------------------------------------------------------------

function printErrFilter(msg: string) {
  if (msg.includes('OPFS') && (msg.includes('asyncer') || msg.includes('sqlite3_vfs'))) return;
  console.error('[dedicated-worker]', msg);
}

async function openDb(key: Uint8Array, userId: string, skipProxyInstall = false): Promise<any> {
  if (!skipProxyInstall) installEncryptionProxy(key);

  const sqlite3: any = await sqlite3InitModule({ printErr: printErrFilter });
  const directory = `.chase-email-enc-db-${userId}`;

  if (typeof sqlite3.installOpfsSAHPoolVfs === 'function') {
    try {
      await sqlite3.installOpfsSAHPoolVfs({ directory, capacity: 6 });
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

function tryBecomeLeader(key: Uint8Array, userId: string) {
  navigator.locks.request('chase-email-sqlite-leader', async () => {
    isLeader = true;
    console.log('[dedicated-worker] Became leader, opening DB...');

    try {
      db = await openDb(key, userId);
      pendingResolve();
      self.postMessage({ type: 'leader-ready' });
    } catch (err) {
      pendingReject(err instanceof Error ? err : new Error(String(err)));
      self.postMessage({ type: 'leader-error', error: String(err) });
    }

    // Hold the lock indefinitely — released when worker is terminated
    await new Promise<void>(() => {});
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
  const portKey = replyPort as MessagePort;

  if (txOwnerPort !== null && portKey !== txOwnerPort) {
    deferredMessages.push({ port: portKey, req });
    return;
  }

  if (req.sql === 'BEGIN') txOwnerPort = portKey;

  execQueue = execQueue
    .then(async () => {
      await runQuery(replyPort, req);
      if (req.sql === 'COMMIT' || req.sql === 'ROLLBACK') {
        txOwnerPort = null;
        for (const { port: p, req: r } of deferredMessages.splice(0)) {
          enqueueQuery(p, r);
        }
      }
    })
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
  txOwnerPort = null;
  deferredMessages.splice(0);

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
  } catch (err) {
    pendingReject(err instanceof Error ? err : new Error(String(err)));
    self.postMessage({ type: 'leader-error', error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = (ev: MessageEvent) => {
  const data = ev.data;

  if (data.type === 'init') {
    savedKey = data.key as Uint8Array;
    savedUserId = data.userId as string;
    tryBecomeLeader(savedKey, savedUserId);
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
