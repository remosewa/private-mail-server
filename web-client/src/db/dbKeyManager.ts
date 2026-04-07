/**
 * dbKeyManager — provision and unwrap the local database encryption key.
 *
 * The database key is a random 32-byte AES-256 value.  It is stored wrapped
 * (RSA-OAEP encrypted) with the user's RSA public key so that only the holder
 * of the matching private key can recover the raw bytes.  The wrapped key is
 * persisted in IndexedDB alongside the private key.
 *
 * Flow:
 *   First session:
 *     1. Generate 32 random bytes.
 *     2. Encrypt with RSA-OAEP public key → wrappedKey (ArrayBuffer).
 *     3. Save wrappedKey to IndexedDB.
 *     4. Return raw 32 bytes.
 *
 *   Subsequent sessions:
 *     1. Load wrappedKey from IndexedDB.
 *     2. Decrypt with RSA-OAEP private key (non-extractable — this is allowed
 *        because decrypt() is a use operation, not an export).
 *     3. Return raw 32 bytes.
 */

import { saveWrappedDbKey, loadWrappedDbKey } from './KeyStore';

/**
 * Return the raw 32-byte database encryption key for the given user,
 * creating and persisting it on the first call.
 *
 * Requires the user's RSA-OAEP keypair (both held in authStore at session start).
 */
export async function getOrCreateDbKey(
  userId: string,
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<Uint8Array> {
  const existing = await loadWrappedDbKey(userId);

  if (existing) {
    // Unwrap the stored key using the private key.
    const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, existing);
    return new Uint8Array(raw);
  }

  // First time: generate a random 32-byte key and wrap it for storage.
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const wrappedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawKey);
  await saveWrappedDbKey(userId, wrappedKey);
  return rawKey;
}
