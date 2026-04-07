/**
 * BlobCrypto — encrypt and decrypt S3 email blobs in the browser.
 *
 * Wire format v1 (legacy, no compression):
 *   1 byte   — version = 0x01
 *   2 bytes  — encKeyLen (uint16 big-endian)
 *   N bytes  — RSA-OAEP/SHA-256 encrypted AES-256 key
 *  12 bytes  — AES-GCM IV
 *  16 bytes  — AES-GCM auth tag
 *   M bytes  — AES-GCM ciphertext
 *
 * Wire format v2 (current, gzip-compressed plaintext):
 *   Same layout as v1, but the AES-GCM plaintext is gzip-compressed.
 *   decryptBlob automatically detects version and decompresses as needed.
 *
 * Web Crypto note: crypto.subtle.encrypt(AES-GCM) returns [ciphertext || authTag]
 * and crypto.subtle.decrypt(AES-GCM) expects [ciphertext || authTag] as the data
 * parameter.  The tag is always the LAST 16 bytes of that combined buffer.
 */

const BLOB_VERSION_V1 = 0x01;
const BLOB_VERSION_V2 = 0x02; // gzip-compressed plaintext
const TAG_LEN = 16;
const IV_LEN = 12;

// ---------------------------------------------------------------------------
// Decrypt
// ---------------------------------------------------------------------------

/**
 * Decrypt a blob produced by the server's `hybridEncrypt` function.
 *
 * @param data       Raw bytes from S3 (fetched via presigned GET URL)
 * @param privateKey RSA-OAEP CryptoKey loaded from the key bundle
 * @returns          Decrypted plaintext (typically UTF-8 JSON)
 */
export async function decryptBlob(
  data: ArrayBuffer,
  privateKey: CryptoKey,
): Promise<Uint8Array> {
  const buf = new Uint8Array(data);
  let offset = 0;

  // Version byte
  const version = buf[offset++];
  if (version !== BLOB_VERSION_V1 && version !== BLOB_VERSION_V2) {
    throw new Error(`Unsupported blob version: ${version}`);
  }

  // encKeyLen (uint16 big-endian)
  const encKeyLen = (buf[offset]! << 8) | buf[offset + 1]!;
  offset += 2;

  // RSA-encrypted AES key
  const encKey = buf.slice(offset, offset + encKeyLen);
  offset += encKeyLen;

  // IV
  const iv = buf.slice(offset, offset + IV_LEN);
  offset += IV_LEN;

  // Auth tag
  const authTag = buf.slice(offset, offset + TAG_LEN);
  offset += TAG_LEN;

  // Ciphertext
  const ciphertext = buf.slice(offset);

  // Decrypt the AES key with our RSA private key
  const rawAesKey = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    privateKey,
    encKey,
  );

  const aesKey = await crypto.subtle.importKey(
    'raw',
    rawAesKey,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );

  // Web Crypto AES-GCM decrypt expects [ciphertext || authTag]
  const ciphertextWithTag = new Uint8Array(ciphertext.length + TAG_LEN);
  ciphertextWithTag.set(ciphertext, 0);
  ciphertextWithTag.set(authTag, ciphertext.length);

  const decrypted = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertextWithTag),
  );

  // v2: decompress gzip plaintext
  if (version === BLOB_VERSION_V2) {
    return gzipDecompress(decrypted);
  }

  return decrypted;
}

// ---------------------------------------------------------------------------
// Encrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt plaintext for upload (e.g. embedding blobs via PUT /emails/{ulid}/embedding).
 * Produces the v2 wire format (gzip-compressed) identical to the server's hybridEncrypt.
 *
 * @param plaintext  Bytes to encrypt
 * @param publicKey  RSA-OAEP CryptoKey (encrypt-only, from importPublicKeyPem)
 * @returns          Opaque binary blob in the version-2 wire format
 */
export async function encryptBlob(
  plaintext: Uint8Array,
  publicKey: CryptoKey,
): Promise<ArrayBuffer> {
  // Compress before encryption
  const compressed = await gzipCompress(plaintext);

  // Generate ephemeral AES-256 key and IV
  const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));

  // Encrypt compressed plaintext; Web Crypto returns [ciphertext || authTag]
  const ciphertextWithTag = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, compressed),
  );
  const ciphertext = ciphertextWithTag.slice(0, -TAG_LEN);
  const authTag    = ciphertextWithTag.slice(-TAG_LEN);

  // Encrypt the raw AES key with RSA-OAEP
  const rawAesKey = await crypto.subtle.exportKey('raw', aesKey);
  const encKey    = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawAesKey));

  // Assemble wire format
  const encKeyLen = new Uint8Array(2);
  new DataView(encKeyLen.buffer).setUint16(0, encKey.length, false); // big-endian

  const total = 1 + 2 + encKey.length + IV_LEN + TAG_LEN + ciphertext.length;
  const out = new Uint8Array(total);
  let pos = 0;
  out[pos++] = BLOB_VERSION_V2;
  out.set(encKeyLen, pos); pos += 2;
  out.set(encKey, pos);    pos += encKey.length;
  out.set(iv, pos);        pos += IV_LEN;
  out.set(authTag, pos);   pos += TAG_LEN;
  out.set(ciphertext, pos);

  return out.buffer;
}

// ---------------------------------------------------------------------------
// Compression helpers (browser CompressionStream / DecompressionStream)
// ---------------------------------------------------------------------------

async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  void writer.write(data).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  void writer.write(data).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Decode a decrypted blob as a UTF-8 JSON object. */
export function decodeJson<T>(bytes: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// Per-email key (attachment staging)
// ---------------------------------------------------------------------------

/** Generate a fresh random AES-256-GCM key for encrypting staged attachments. */
export async function generateEmailKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/**
 * Wrap the raw emailKey with the user's RSA-OAEP public key.
 * The result is stored in DynamoDB under COMPOSE#{emailId} by the server.
 * Only the client (holding the private key) can unwrap it.
 */
export async function wrapEmailKey(key: CryptoKey, publicKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, raw);
  return arrayBufferToBase64(wrapped);
}

/** Export the raw emailKey bytes as base64 (sent to the server at send time). */
export async function exportEmailKeyBase64(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return arrayBufferToBase64(raw);
}

/**
 * Unwrap an RSA-OAEP wrapped emailKey (base64) using the user's private key.
 * Returns an AES-256-GCM CryptoKey usable for decryptAttachment.
 */
export async function unwrapEmailKey(wrappedKeyBase64: string, privateKey: CryptoKey): Promise<CryptoKey> {
  const wrappedBytes = Uint8Array.from(atob(wrappedKeyBase64), c => c.charCodeAt(0));
  const rawKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, wrappedBytes);
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Decrypt an emailKey-encrypted blob (attachment binary or metadata blob).
 * Wire format: [iv (12 bytes)] [gzip-compressed ciphertext + authTag (last 16 bytes)]
 * Returns decompressed plaintext bytes.
 */
export async function decryptAttachment(data: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  const buf = new Uint8Array(data);
  const iv = buf.slice(0, IV_LEN);
  const ciphertextWithTag = buf.slice(IV_LEN);
  const decrypted = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertextWithTag),
  );
  return (await gzipDecompress(decrypted)).buffer;
}

/**
 * Encrypt file bytes for staging upload.
 * Gzip-compresses first, then AES-256-GCM encrypts with the per-email key.
 *
 * Wire format: [iv (12 bytes)] [compressed ciphertext + authTag (last 16 bytes)]
 * The server's decryptWithEmailKey + gunzipSync expects this exact layout.
 */
export async function encryptAttachment(data: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  const compressed = await gzipCompress(new Uint8Array(data));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ciphertextWithTag = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, compressed),
  );
  const out = new Uint8Array(IV_LEN + ciphertextWithTag.length);
  out.set(iv, 0);
  out.set(ciphertextWithTag, IV_LEN);
  return out.buffer;
}
