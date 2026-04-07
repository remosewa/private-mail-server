/**
 * sqlite-vec-worker.ts — custom SQLite dedicated worker.
 *
 * Encryption is applied at the OPFS layer via a SyncAccessHandle proxy
 * (EncryptedOPFSHandle.ts) installed BEFORE installOpfsSAHPoolVfs is called.
 * The proxy transparently encrypts every page write and decrypts every read
 * using AES-256-CTR keyed with the user's per-database key.
 *
 * Protocol:
 *   Main → Worker:  { type: 'init', key: Uint8Array, userId: string }  (sent once, before any query)
 *   Main → Worker:  { id, sql, bind?, rowMode?, returnValue? }
 *   Worker → Main:  { type: 'ready' }   (after DB opened successfully)
 *   Worker → Main:  { type: 'error', error: string }         (if init fails)
 *   Worker → Main:  { id, result } | { id, error }
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import sqlite3InitModule from 'sqlite-vec-wasm-demo';
import { installEncryptionProxy } from './EncryptedOPFSHandle';

type Req = {
    id: number;
    sql: string;
    bind?: unknown[];
    rowMode?: 'object' | 'array';
    returnValue?: 'resultRows';
};

let db: any = null;
let initPromise: Promise<void> | null = null;
let initFailed = false;

// Suppress the "OPFS asyncer" warning — sqlite3InitModule always tries to load
// the legacy async OPFS VFS helper worker on startup. It fails when the worker
// isn't co-located with the bundle (expected in our Vite setup) and logs a noisy
// warning. Since we use SAH Pool VFS exclusively this is harmless.
function printErrFilter(msg: string) {
    if (msg.includes('OPFS') && (msg.includes('asyncer') || msg.includes('sqlite3_vfs'))) return;
    console.error(msg);
}

async function init(keyBytes: Uint8Array, userId: string): Promise<void> {
    // Install the encryption proxy BEFORE SQLite touches any OPFS handles.
    installEncryptionProxy(keyBytes);

    const sqlite3: any = await sqlite3InitModule({ printErr: printErrFilter });

    // Use a per-user OPFS directory so each user has an isolated encrypted database.
    if (typeof sqlite3.installOpfsSAHPoolVfs === 'function') {
        const directory = `.chase-email-enc-db-${userId}`;

        // After a failed installOpfsSAHPoolVfs call, the sqlite3 module instance
        // is left in a partially-broken state and cannot be retried cleanly.
        // We must reinitialize the entire sqlite3 module on each attempt.
        // The encryption proxy (monkey-patch on FileSystemFileHandle.prototype)
        // is installed once above and persists across module reinitializations —
        // any SAH handles opened by subsequent sqlite3 instances go through it too.
        // Primary path: the main thread calls teardownDb() (worker.terminate())
        // synchronously on beforeunload/pagehide, so OPFS handles from the
        // previous session are released before we get here.
        //
        // NOTE: Do NOT retry installOpfsSAHPoolVfs on the same sqlite3 instance.
        // A failed attempt leaves partial internal state; the next call's cleanup
        // calls removeVfs() while OPFS files may still be locked by the old worker,
        // which SQLite says results in undefined behaviour and potential corruption.
        try {
            await sqlite3.installOpfsSAHPoolVfs({ directory, capacity: 6 });
            db = new sqlite3.oo1.DB({ filename: '/chase-email.db', vfs: 'opfs-sahpool' });
        } catch (opfsErr) {
            const errMsg = String(opfsErr);
            if (errMsg.includes('SQLITE_CORRUPT') || errMsg.includes('result code 11')) {
                throw opfsErr;
            }
            // Notify the main thread so it can broadcast 'release-db' to other tabs,
            // wait for them to drop their handles, then retry with a fresh worker.
            self.postMessage({ type: 'opfs-failed', error: errMsg });
            // Park here — main thread will terminate this worker and start a new one
            // if the retry succeeds, or proceed with in-memory if it gives up.
            await new Promise<void>(resolve => {
                self.addEventListener('message', function handler(e: MessageEvent) {
                    if ((e.data as { type?: string }).type === 'opfs-retry') {
                        self.removeEventListener('message', handler);
                        resolve();
                    }
                });
            });
            // Retry once with a fresh sqlite3 module (can't reuse the failed instance).
            try {
                const sqlite3Retry: any = await sqlite3InitModule({ printErr: printErrFilter });
                await sqlite3Retry.installOpfsSAHPoolVfs({ directory, capacity: 6 });
                db = new sqlite3Retry.oo1.DB({ filename: '/chase-email.db', vfs: 'opfs-sahpool' });
            } catch {
                console.warn('[sqlite-vec-worker] OPFS retry failed — falling back to in-memory');
                db = new sqlite3.oo1.DB(':memory:', 'c');
            }
        }
    } else if (sqlite3.capi.sqlite3_vfs_find('opfs')) {
        // The legacy OPFS VFS does not go through createSyncAccessHandle, so
        // the encryption proxy would not intercept its I/O. Fail hard rather
        // than silently write plaintext.
        throw new Error('SAH Pool VFS unavailable; cannot guarantee encrypted storage');
    } else {
        db = new sqlite3.oo1.DB(':memory:', 'c');
        console.warn('[sqlite-vec-worker] OPFS unavailable — data will not persist.');
    }

    self.postMessage({ type: 'ready' });
}

self.onmessage = (e: MessageEvent): void => {
    const data = e.data as { type?: string; key?: unknown; userId?: unknown } & Req;


    if (data.type === 'init') {
        // Validate key and userId before doing anything.
        if (!(data.key instanceof Uint8Array) || data.key.byteLength !== 32) {
            self.postMessage({ type: 'error', error: 'init requires a 32-byte Uint8Array key' });
            return;
        }
        if (typeof data.userId !== 'string' || !data.userId) {
            self.postMessage({ type: 'error', error: 'init requires a non-empty userId string' });
            return;
        }

        initPromise = init(data.key, data.userId).catch((err) => {
            initFailed = true;
            self.postMessage({ type: 'error', error: String(err) });
        });
        return;
    }

    // SQL query — must wait for init to complete.
    const { id, sql, bind, rowMode, returnValue } = data;

    const run = async (): Promise<void> => {
        if (!initPromise) {
            self.postMessage({ id, error: 'Worker not initialized — send init message first' });
            return;
        }

        await initPromise;

        if (initFailed || !db) {
            self.postMessage({ id, error: 'Database initialization failed' });
            return;
        }

        try {
            if (returnValue === 'resultRows') {
                const rows: unknown[] = [];
                db.exec({ sql, bind, rowMode: rowMode ?? 'object', resultRows: rows });
                self.postMessage({ id, result: rows });
            } else {
                if (bind && bind.length > 0) {
                    db.exec(sql, { bind });
                } else {
                    db.exec(sql);
                }
                self.postMessage({ id, result: null });
            }
        } catch (err) {
            self.postMessage({ id, error: String(err) });
        }
    };

    void run();
};
