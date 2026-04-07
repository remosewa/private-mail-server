/**
 * EncryptedOPFSHandle — monkey-patches FileSystemFileHandle.prototype.createSyncAccessHandle
 * so that every OPFS access handle transparently encrypts writes and decrypts reads.
 *
 * Cipher: AES-256-CTR (@noble/ciphers, synchronous)
 *   - Same-size output: no size expansion, works with in-place page rewrites
 *   - Deterministic per page: each file byte position maps to a unique keystream position
 *   - No authentication: trades integrity for compatibility (SQLite has its own checksums;
 *     threat model is passive device theft, not active tampering)
 *
 * Nonce scheme:
 *   nonce[0..3]  = 0x00 (reserved)
 *   nonce[4..11] = BigUint64 big-endian (blockIndex = floor(fileOffset / 16))
 *   nonce[12..15] = 0x00 (overflow counter used by AES-CTR for sequential blocks)
 *
 *   Any write at file offset `at` uses the keystream starting at AES block `at >> 4`,
 *   with a one-time skip of `at & 0xf` bytes for sub-block-aligned offsets.
 *   This means two operations at non-overlapping byte ranges NEVER share keystream bytes.
 *
 * Install BEFORE sqlite3.installOpfsSAHPoolVfs() so all pool handles are encrypted.
 */

import { ctr } from '@noble/ciphers/aes.js';

const AES_BLOCK = 16;

/** Build the CTR initial-counter nonce for the AES block that contains file byte `at`. */
function makeNonce(at: number): Uint8Array {
  const nonce = new Uint8Array(16);
  // Store the block index (floor(at / 16)) as a big-endian uint64 at bytes 4-11.
  new DataView(nonce.buffer).setBigUint64(4, BigInt(at) >> 4n, false);
  return nonce;
}

/**
 * Encrypt `plaintext` as if it lives at byte offset `at` in the encrypted file.
 * The output is the same length as the input.
 */
function encryptAt(key: Uint8Array, at: number, plaintext: Uint8Array): Uint8Array {
  const skip = at & (AES_BLOCK - 1); // at % 16
  const nonce = makeNonce(at);

  if (skip === 0) {
    return ctr(key, nonce).encrypt(plaintext);
  }

  // Sub-block-aligned: pad with `skip` zeros at the front so the keystream
  // starts at the block boundary, then drop the padding from the output.
  const padded = new Uint8Array(skip + plaintext.byteLength);
  padded.set(plaintext, skip);
  return ctr(key, nonce).encrypt(padded).subarray(skip);
}

/**
 * Decrypt `ciphertext` read from byte offset `at` of the encrypted file.
 * AES-CTR: decryption is identical to encryption.
 */
function decryptAt(key: Uint8Array, at: number, ciphertext: Uint8Array): Uint8Array {
  return encryptAt(key, at, ciphertext); // CTR is its own inverse
}

/** Wrap a real SyncAccessHandle with encrypt-on-write / decrypt-on-read. */
function makeEncryptedHandle(
  handle: FileSystemSyncAccessHandle,
  key: Uint8Array,
): FileSystemSyncAccessHandle {
  return new Proxy(handle, {
    get(target, prop, _receiver) {
      if (prop === 'read') {
        return (
          buffer: Uint8Array,
          options?: FileSystemReadWriteOptions,
        ): number => {
          if (options?.at === undefined) {
            throw new Error('EncryptedOPFSHandle: read without explicit `at` is not supported');
          }
          const at = options.at;
          // Read ciphertext into a temporary buffer of the same size.
          const tmp = new Uint8Array(buffer.byteLength);
          const bytesRead = target.read(tmp, options);
          if (bytesRead > 0) {
            const decrypted = decryptAt(key, at, tmp.subarray(0, bytesRead));
            // Write decrypted bytes into the caller-provided buffer.
            new Uint8Array(
              buffer.buffer,
              buffer.byteOffset,
              buffer.byteLength,
            ).set(decrypted);
          }
          return bytesRead;
        };
      }

      if (prop === 'write') {
        return (
          buffer: Uint8Array,
          options?: FileSystemReadWriteOptions,
        ): number => {
          if (options?.at === undefined) {
            throw new Error('EncryptedOPFSHandle: write without explicit `at` is not supported');
          }
          const at = options.at;
          const plaintext = new Uint8Array(
            buffer.buffer,
            buffer.byteOffset,
            buffer.byteLength,
          );
          const encrypted = encryptAt(key, at, plaintext);
          // Pass the same `options` (including `at`) — offset is unchanged.
          return target.write(encrypted, options);
        };
      }

      // For all other methods (close, flush, getSize, truncate, …) bind to
      // the real handle so the browser's internal brand check sees the native
      // FileSystemSyncAccessHandle as `this`, not the Proxy.
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Install the encryption proxy.
 *
 * Must be called BEFORE sqlite3.installOpfsSAHPoolVfs() so that every
 * FileSystemSyncAccessHandle created by the pool VFS goes through the proxy.
 *
 * @param keyBytes  Raw 32-byte AES-256 key derived from the user's RSA key.
 */
let installed = false;

export function installEncryptionProxy(keyBytes: Uint8Array): void {
  if (installed) throw new Error('EncryptedOPFSHandle: encryption proxy already installed');
  installed = true;

  // Freeze a copy so the key bytes can't be mutated after installation.
  const key = keyBytes.slice();

  const orig = FileSystemFileHandle.prototype.createSyncAccessHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (FileSystemFileHandle.prototype as any).createSyncAccessHandle = async function (
    options?: FileSystemSyncAccessHandleOpenOptions,
  ): Promise<FileSystemSyncAccessHandle> {
    const handle = await orig.call(this, options);
    return makeEncryptedHandle(handle, key);
  };
}
