/**
 * Shared hybrid encryption used by both the inbound-email-processor and the
 * api-handler (for Sent-folder blobs). Produces the version-2 wire format
 * (gzip-compressed plaintext) that the browser client and Android app decrypt
 * with the user's private key.
 *
 * Wire format v2:
 *   1 byte   — version = 0x02
 *   2 bytes  — encKeyLen (uint16 big-endian)
 *   N bytes  — RSA-OAEP/SHA-256 encrypted AES-256 key
 *  12 bytes  — AES-GCM IV
 *  16 bytes  — AES-GCM auth tag
 *   M bytes  — AES-GCM ciphertext of gzip-compressed plaintext
 */

import { randomBytes, createCipheriv } from 'crypto';
import { gzipSync } from 'zlib';
import * as forge from 'node-forge';

const BLOB_VERSION = 0x02;

/**
 * RSA-OAEP/SHA-256 wrap a raw AES key with the user's public key.
 * Returns the wrapped key as a base64 string (same format the browser produces
 * with crypto.subtle.encrypt('RSA-OAEP', publicKey, rawAesKey)).
 * Used by the send handler to store wrappedEmailKey in the SENT email's DDB item.
 */
export function wrapKeyRsa(rawKey: Buffer, publicKeyPem: string): string {
  const rsaPub = forge.pki.publicKeyFromPem(publicKeyPem);
  const wrappedBinary = rsaPub.encrypt(rawKey.toString('binary'), 'RSA-OAEP', {
    md: forge.md.sha256.create(),
    mgf1: { md: forge.md.sha256.create() },
  });
  return Buffer.from(wrappedBinary, 'binary').toString('base64');
}

export function hybridEncrypt(plaintext: Buffer, publicKeyPem: string): Buffer {
  // Compress before encryption — text/HTML blobs shrink by 60-80%
  const compressed = gzipSync(plaintext, { level: 6 });

  const aesKey = randomBytes(32);
  const iv = randomBytes(12);

  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const rsaPub = forge.pki.publicKeyFromPem(publicKeyPem);
  const encKeyBinary = rsaPub.encrypt(aesKey.toString('binary'), 'RSA-OAEP', {
    md: forge.md.sha256.create(),
    mgf1: { md: forge.md.sha256.create() },
  });
  const encKey = Buffer.from(encKeyBinary, 'binary');

  const encKeyLen = Buffer.allocUnsafe(2);
  encKeyLen.writeUInt16BE(encKey.length);

  return Buffer.concat([
    Buffer.from([BLOB_VERSION]),
    encKeyLen,
    encKey,
    iv,
    authTag,
    ciphertext,
  ]);
}
