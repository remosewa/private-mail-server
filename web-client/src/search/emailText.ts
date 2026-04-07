/**
 * Shared utility for fetching and decrypting email body text.
 * Used by the indexer and debug tools.
 */

import { getEmailText, batchGetEmailText } from '../api/emails';
import { decryptBlob, decryptAttachment, unwrapEmailKey } from '../crypto/BlobCrypto';
import { remoteLogger } from '../api/logger';

/**
 * Fetch and decrypt the plain text body for a single email.
 */
export async function fetchEmailText(
  ulid: string,
  privateKey: CryptoKey,
  wrappedEmailKey?: string | null,
): Promise<string> {
  const encBuf = await getEmailText(ulid);
  let plainBytes: Uint8Array;
  if (wrappedEmailKey) {
    const emailKey = await unwrapEmailKey(wrappedEmailKey, privateKey);
    plainBytes = new Uint8Array(await decryptAttachment(encBuf, emailKey));
  } else {
    plainBytes = await decryptBlob(encBuf, privateKey);
  }
  return new TextDecoder().decode(plainBytes);
}

/**
 * Batch fetch and decrypt plain text for multiple emails.
 * Returns a map of ulid → decrypted text.
 */
export async function batchFetchEmailText(
  entries: Array<{ ulid: string; wrappedEmailKey?: string | null }>,
  privateKey: CryptoKey,
): Promise<Map<string, string>> {
  const textMap = new Map<string, string>();
  if (entries.length === 0) return textMap;

  const ulids = entries.map(e => e.ulid);
  const wrappedKeyMap = new Map(
    entries.filter(e => e.wrappedEmailKey).map(e => [e.ulid, e.wrappedEmailKey!])
  );

  // Chunk into batches of 50
  const chunks: string[][] = [];
  for (let i = 0; i < ulids.length; i += 50) chunks.push(ulids.slice(i, i + 50));

  const batchResults = (await Promise.all(chunks.map(c => batchGetEmailText(c)))).flat();

  for (const result of batchResults) {
    if (!result.encryptedText) continue;
    try {
      const encBytes = Uint8Array.from(atob(result.encryptedText), c => c.charCodeAt(0));
      const wrappedKey = wrappedKeyMap.get(result.ulid);
      let plainBytes: Uint8Array;
      if (wrappedKey) {
        const emailKey = await unwrapEmailKey(wrappedKey, privateKey);
        plainBytes = new Uint8Array(await decryptAttachment(encBytes.buffer, emailKey));
      } else {
        plainBytes = await decryptBlob(encBytes.buffer, privateKey);
      }
      textMap.set(result.ulid, new TextDecoder().decode(plainBytes));
    } catch (err) {
      remoteLogger.warn('Failed to decrypt text blob', { ulid: result.ulid, error: String(err) });
    }
  }

  return textMap;
}
