import { useEffect } from 'react';
import { useAuthStore } from '../store/authStore';
import { subscribePush } from '../api/emails';

const DEVICE_ID_KEY = 'chase-push-device-id';

function getOrCreateDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

function registerSubscription(sub: PushSubscriptionJSON): Promise<void> {
  const keys = sub.keys ?? {};
  return subscribePush({
    deviceId: getOrCreateDeviceId(),
    endpoint: sub.endpoint ?? '',
    p256dh: (keys as Record<string, string>)['p256dh'] ?? '',
    auth: (keys as Record<string, string>)['auth'] ?? '',
  });
}

// Pick up any subscription the SW stored in IndexedDB while the app was closed
// (happens when Chrome rotates the push subscription via pushsubscriptionchange).
function drainPendingSubscription(): Promise<PushSubscriptionJSON | null> {
  return new Promise(resolve => {
    const req = indexedDB.open('chase-email-push', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('pending');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('pending', 'readwrite');
      const store = tx.objectStore('pending');
      const get = store.get('subscription');
      get.onsuccess = () => {
        const sub = get.result as PushSubscriptionJSON | undefined;
        if (sub) store.delete('subscription');
        db.close();
        resolve(sub ?? null);
      };
      get.onerror = () => { db.close(); resolve(null); };
    };
    req.onerror = () => resolve(null);
  });
}

export function usePushSubscription() {
  const { accessToken } = useAuthStore();

  useEffect(() => {
    if (!accessToken || !('serviceWorker' in navigator) || !('PushManager' in window)) return;

    const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string;
    if (!vapidKey) return;

    // Handle subscription rotations that happened while the app was closed
    drainPendingSubscription().then(pending => {
      if (pending) return registerSubscription(pending);
    }).catch(console.error);

    // Listen for subscription rotations that happen while the app is open
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'PUSH_SUBSCRIPTION_CHANGED') {
        registerSubscription(e.data.subscription as PushSubscriptionJSON).catch(console.error);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);

    navigator.serviceWorker.register('/sw.js').then(reg => {
      Notification.requestPermission().then(perm => {
        if (perm !== 'granted') return;

        // Convert base64url VAPID public key to Uint8Array
        const padding = '='.repeat((4 - (vapidKey.length % 4)) % 4);
        const base64 = (vapidKey + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

        reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: raw,
        }).then(sub => registerSubscription(sub.toJSON())).catch(console.error);
      });
    }).catch(console.error);

    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [accessToken]);
}
