/**
 * KeyManager — RSA keypair generation, Argon2id key derivation, and private-key
 * wrap/unwrap using the browser's Web Crypto API.
 *
 * Key derivation uses @noble/hashes/argon2 (pure JS) with the same Argon2id
 * parameters as the Android client so a key bundle registered from either
 * platform can be unlocked by the other.
 *
 * Argon2id params: t=3, m=65536 (64 MB), p=1, dkLen=32
 *
 * encryptedPrivateKey wire format (stored in DynamoDB / returned by key bundle):
 *   base64( iv[12] || AES-GCM-wrapped-PKCS8[...] )
 */

import { argon2id } from '@noble/hashes/argon2';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARGON2_PARAMS = { t: 3, m: 65536, p: 1, dkLen: 32 } as const;

// ---------------------------------------------------------------------------
// Argon2id key derivation → AES-256-GCM wrapping key
// ---------------------------------------------------------------------------

/**
 * Derive a 256-bit AES-GCM wrapping key from a user password and the stored
 * Argon2id salt.  The output CryptoKey is usable only for wrapKey/unwrapKey.
 */
export async function deriveWrappingKey(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const passBytes = new TextEncoder().encode(password);
  const rawKey = argon2id(passBytes, salt, ARGON2_PARAMS);   // returns Uint8Array (32 bytes)

  return crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM' },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

// ---------------------------------------------------------------------------
// RSA keypair generation
// ---------------------------------------------------------------------------

/** Generate a 4096-bit RSA-OAEP/SHA-256 keypair for email encryption. */
export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 4096,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------------------
// Private key wrap / unwrap
// ---------------------------------------------------------------------------

/**
 * Wrap the private key with the AES-GCM wrapping key.
 *
 * Returns the combined blob: base64( iv[12] || wrappedKey )
 * This is the string stored as `encryptedPrivateKey` in DynamoDB.
 */
export async function wrapPrivateKey(
  privateKey: CryptoKey,
  wrappingKey: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.wrapKey('pkcs8', privateKey, wrappingKey, {
    name: 'AES-GCM',
    iv,
  });
  const blob = new Uint8Array(12 + wrapped.byteLength);
  blob.set(iv, 0);
  blob.set(new Uint8Array(wrapped), 12);
  return btoa(String.fromCharCode(...blob));
}

/**
 * Unwrap the private key from the base64 blob returned by GET /auth/key-bundle.
 */
export async function unwrapPrivateKey(
  encryptedPrivateKeyB64: string,
  wrappingKey: CryptoKey,
): Promise<CryptoKey> {
  const blob = Uint8Array.from(atob(encryptedPrivateKeyB64), c => c.charCodeAt(0));
  const iv = blob.slice(0, 12);
  const wrapped = blob.slice(12);

  return crypto.subtle.unwrapKey(
    'pkcs8',
    wrapped,
    wrappingKey,
    { name: 'AES-GCM', iv },
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    true,
    ['decrypt'],
  );
}

// ---------------------------------------------------------------------------
// Public key import / export
// ---------------------------------------------------------------------------

/** Export a public CryptoKey as a PEM-encoded SPKI string. */
export async function exportPublicKeyPem(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
  const lines = b64.match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
}

/**
 * Import a PEM SPKI public key string for use in encryption.
 * The imported key is encrypt-only (public key).
 */
export async function importPublicKeyPem(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'spki',
    der,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
}

// ---------------------------------------------------------------------------
// Salt generation
// ---------------------------------------------------------------------------

/** Generate a fresh 16-byte random salt for Argon2id. Returns base64 string. */
export function generateArgon2Salt(): string {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...salt));
}

// ---------------------------------------------------------------------------
// Recovery key generation and derivation
// ---------------------------------------------------------------------------

/**
 * Generate a 256-bit random recovery key formatted as 8 groups of 8 uppercase hex chars.
 * Example: "A1B2C3D4-E5F6A7B8-C9D0E1F2-A3B4C5D6-E7F8A9B0-C1D2E3F4-A5B6C7D8-E9F0A1B2"
 */
export function generateRecoveryKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const groups = [];
  for (let i = 0; i < 64; i += 8) groups.push(hex.slice(i, i + 8));
  return groups.join('-');
}

/**
 * Derive an AES-256-GCM wrapping key from a recovery key string.
 * Uses the "enc:" domain prefix so the key material is distinct from the verification hash.
 */
export async function deriveWrappingKeyFromRecoveryKey(recoveryKey: string): Promise<CryptoKey> {
  const canonical = recoveryKey.replace(/-/g, '').toLowerCase();
  const input = new TextEncoder().encode('enc:' + canonical);
  const hash = await crypto.subtle.digest('SHA-256', input);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['wrapKey', 'unwrapKey']);
}

/**
 * Convert a display-format recovery key to a Cognito-compatible password.
 * The recovery key hex bytes are base64-encoded (44 chars), satisfying the
 * Cognito password policy (min length 16, no character class requirements).
 */
export function recoveryKeyToCognitoPassword(displayKey: string): string {
  const hex = displayKey.replace(/-/g, '');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return btoa(String.fromCharCode(...bytes));
}
