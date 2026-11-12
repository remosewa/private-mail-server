// ---------------------------------------------------------------------------
// Crypto helpers (mirrors BlobCrypto.ts — must stay in sync with wire format)
// ---------------------------------------------------------------------------

const BLOB_VERSION_V1 = 0x01;
const BLOB_VERSION_V2 = 0x02;
const TAG_LEN = 16;
const IV_LEN = 12;

function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function gzipDecompress(data) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(data).then(() => writer.close());
    const chunks = [];
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

async function decryptHeaderBlob(base64Blob, privateKey) {
    const buf = base64ToBytes(base64Blob);
    let offset = 0;

    const version = buf[offset++];
    if (version !== BLOB_VERSION_V1 && version !== BLOB_VERSION_V2) return null;

    const encKeyLen = (buf[offset] << 8) | buf[offset + 1];
    offset += 2;

    const encKey = buf.slice(offset, offset + encKeyLen);
    offset += encKeyLen;

    const iv = buf.slice(offset, offset + IV_LEN);
    offset += IV_LEN;

    const authTag = buf.slice(offset, offset + TAG_LEN);
    offset += TAG_LEN;

    const ciphertext = buf.slice(offset);

    const rawAesKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, encKey);
    const aesKey = await crypto.subtle.importKey('raw', rawAesKey, { name: 'AES-GCM' }, false, ['decrypt']);

    const ciphertextWithTag = new Uint8Array(ciphertext.length + TAG_LEN);
    ciphertextWithTag.set(ciphertext, 0);
    ciphertextWithTag.set(authTag, ciphertext.length);

    const decrypted = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertextWithTag)
    );

    const plain = version === BLOB_VERSION_V2 ? await gzipDecompress(decrypted) : decrypted;
    return JSON.parse(new TextDecoder().decode(plain));
}

// ---------------------------------------------------------------------------
// IndexedDB key loader (mirrors KeyStore.ts)
// ---------------------------------------------------------------------------

function loadPrivateKey(userId) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('chase-email-keys', 1);
        req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('keys', 'readonly');
            const get = tx.objectStore('keys').get(`pk:${userId}`);
            get.onsuccess = () => { db.close(); resolve(get.result ?? null); };
            get.onerror = () => { db.close(); reject(get.error); };
        };
        req.onerror = () => reject(req.error);
    });
}

// ---------------------------------------------------------------------------
// Push handler
// ---------------------------------------------------------------------------

self.addEventListener('push', e => {
    const data = e.data?.json() ?? {};

    // Match the server-side TTL (4 hours). A notification held by the push
    // service while the device is offline should still show on delivery.
    const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000;
    const isStale = data.sentAt
        ? (Date.now() - new Date(data.sentAt).getTime()) > STALE_THRESHOLD_MS
        : false; // No sentAt = old server, always show

    e.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
            clients.forEach(client => client.postMessage({ type: 'NEW_EMAIL', ulid: data.ulid }));

            if (isStale) {
                // Browser requires showNotification when no clients are open — show a silent
                // placeholder that closes immediately to satisfy the push API contract.
                if (!clients.length) {
                    await self.registration.showNotification('', { silent: true, tag: 'stale-discard' });
                    const stale = await self.registration.getNotifications({ tag: 'stale-discard' });
                    stale.forEach(n => n.close());
                }
                return;
            }

            // Try to decrypt the header for a rich notification
            let notifTitle = data.title ?? 'New email';
            let notifBody = '';

            if (data.encryptedHeader && data.userId) {
                try {
                    const privateKey = await loadPrivateKey(data.userId);
                    if (privateKey) {
                        const header = await decryptHeaderBlob(data.encryptedHeader, privateKey);
                        if (header) {
                            const sender = header.fromName || header.fromAddress || 'Unknown';
                            notifTitle = header.subject || 'New email';
                            notifBody = sender;
                        }
                    }
                } catch {
                    // Decryption failed — fall back to generic notification
                }
            }

            // Use a per-email tag so each notification stacks separately instead of
            // silently overwriting the previous one. renotify ensures that even if two
            // emails somehow share a tag, the device still re-alerts.
            return self.registration.showNotification(notifTitle, {
                body: notifBody,
                icon: '/icon-192.png',
                tag: data.ulid || 'new-email',
                renotify: true,
                data: { ulid: data.ulid },
            });
        })
    );
});

// ---------------------------------------------------------------------------
// Notification click
// ---------------------------------------------------------------------------

self.addEventListener('notificationclick', e => {
    const ulid = e.notification.data?.ulid;
    e.notification.close();
    e.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async ws => {
            // Only reuse a window running the mail app (not a call or static page).
            const mailWindows = ws.filter(c => {
                const path = new URL(c.url).pathname;
                return !path.startsWith('/call/') && !path.startsWith('/static/');
            });
            const target = mailWindows.find(c => c.focused) ?? mailWindows[0];

            if (target) {
                await target.focus();
                target.postMessage({ type: 'NOTIFICATION_CLICKED', ulid });
                return;
            }

            // Cold start: a postMessage would arrive before the app is listening,
            // so pass the email in the URL and let MailPage open it on mount.
            const url = ulid ? `/?email=${encodeURIComponent(ulid)}` : '/';
            await self.clients.openWindow(url);
        })
    );
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

self.addEventListener('install', e => {
    e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', e => {
    e.waitUntil(self.clients.claim());
});

self.addEventListener('message', e => {
    if (e.data && e.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// Chrome on Android rotates push subscriptions periodically. Re-register
// automatically so the server always has a valid endpoint.
self.addEventListener('pushsubscriptionchange', e => {
    e.waitUntil(
        self.registration.pushManager.subscribe(e.oldSubscription.options)
            .then(newSub => {
                // Notify any open clients to re-POST the subscription to the server
                return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
                    .then(clients => {
                        const msg = { type: 'PUSH_SUBSCRIPTION_CHANGED', subscription: newSub.toJSON() };
                        if (clients.length) {
                            clients.forEach(c => c.postMessage(msg));
                        } else {
                            // No open clients — store in IndexedDB for the app to pick up on next open
                            const req = indexedDB.open('chase-email-push', 1);
                            req.onupgradeneeded = () => req.result.createObjectStore('pending');
                            req.onsuccess = () => {
                                const tx = req.result.transaction('pending', 'readwrite');
                                tx.objectStore('pending').put(newSub.toJSON(), 'subscription');
                            };
                        }
                    });
            })
    );
});
