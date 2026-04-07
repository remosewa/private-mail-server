/**
 * KeyStore — IndexedDB storage for CryptoKey objects.
 *
 * The browser's IndexedDB can store CryptoKey objects directly (structured
 * clone algorithm). This means the private key material never becomes a JS
 * string and is never exposed to the DOM — even with extractable: false.
 */

const DB_NAME    = 'chase-email-keys';
const DB_VERSION = 1;
const STORE      = 'keys';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function savePrivateKey(userId: string, key: CryptoKey): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(key, `pk:${userId}`);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

export async function loadPrivateKey(userId: string): Promise<CryptoKey | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(`pk:${userId}`);
    req.onsuccess = () => { db.close(); resolve((req.result as CryptoKey) ?? null); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

export async function deletePrivateKey(userId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(`pk:${userId}`);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

// ── DB encryption key (RSA-OAEP wrapped AES-256 raw bytes) ────────────────────

/**
 * Persist the RSA-OAEP-wrapped database encryption key for the given user.
 * The wrapped key is just opaque bytes — only the user's RSA private key can
 * unwrap it.
 */
export async function saveWrappedDbKey(userId: string, wrappedKey: ArrayBuffer): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(wrappedKey, `dbkey:${userId}`);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/** Load the wrapped database encryption key, or null if not yet generated. */
export async function loadWrappedDbKey(userId: string): Promise<ArrayBuffer | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(`dbkey:${userId}`);
    req.onsuccess = () => { db.close(); resolve((req.result as ArrayBuffer) ?? null); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}
