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

export function usePushSubscription() {
  const { accessToken } = useAuthStore();

  useEffect(() => {
    if (!accessToken || !('serviceWorker' in navigator) || !('PushManager' in window)) return;

    const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string;
    if (!vapidKey) return;

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
        }).then(sub => {
          const json = sub.toJSON();
          const keys = json.keys ?? {};
          subscribePush({
            deviceId: getOrCreateDeviceId(),
            endpoint: json.endpoint ?? '',
            p256dh: keys['p256dh'] ?? '',
            auth: keys['auth'] ?? '',
          }).catch(console.error);
        }).catch(console.error);
      });
    }).catch(console.error);
  }, [accessToken]);
}
