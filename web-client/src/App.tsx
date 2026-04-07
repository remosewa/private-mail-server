import { useState, useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore, readSession, writeSession } from './store/authStore';
import { loadPrivateKey } from './db/KeyStore';
import { refreshTokens } from './api/auth';
import { importPublicKeyPem } from './crypto/KeyManager';
import LoginPage from './pages/LoginPage';
import MailPage from './pages/MailPage';
import SettingsPage from './pages/SettingsPage';
import AdminPage from './pages/AdminPage';
import { useUiStore } from './store/uiStore';
import { useIndexStore } from './store/indexStore';
import { useDbStore } from './store/dbStore';
import { useFolderStore } from './store/folderStore';
import { useSettingsStore } from './store/settingsStore';
import { startIndexing } from './search/indexer';
import { SyncManager } from './sync/SyncManager';

// Load debug utilities in development
if (import.meta.env.DEV) {
  import('./debug');
}
import { loadSettings } from './sync/SettingsManager';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/** Returns true if a Cognito error indicates the refresh token itself is invalid/expired. */
function isRefreshTokenExpiredError(err: unknown): boolean {
  const code = (err as { code?: string; name?: string })?.code
    ?? (err as { code?: string; name?: string })?.name;
  return code === 'NotAuthorizedException' || code === 'UserNotFoundException';
}

/** Try to restore a session from localStorage + IndexedDB on page load. */
async function hydrateSession(): Promise<void> {
  const saved = readSession();
  if (!saved) return;

  const { setAuth, setKeys, setUserEmail, setIsAdmin, clearAuth } = useAuthStore.getState();
  let { userId, username, userEmail, accessToken, refreshToken, expiresAt, publicKeyPem, isAdmin } = saved;

  // Refresh tokens if within 5 minutes of expiry (or already expired)
  if (Date.now() > expiresAt - 5 * 60 * 1000) {
    try {
      const fresh = await refreshTokens(username, refreshToken);
      accessToken = fresh.accessToken;
      refreshToken = fresh.refreshToken;
      expiresAt = fresh.expiresAt;
      writeSession({ userId, username, userEmail, accessToken, refreshToken, expiresAt, publicKeyPem });
    } catch (err) {
      if (isRefreshTokenExpiredError(err)) {
        // Refresh token is genuinely invalid — must re-login.
        clearAuth();
        return;
      }
      // Transient error (network down, timeout, etc.) — continue with the
      // existing (possibly expired) access token; the 401 interceptor will
      // retry once the network comes back.
      console.warn('[hydrateSession] Token refresh failed (transient), continuing:', err);
    }
  }

  // Set tokens so the axios interceptor can send Authorization headers
  setAuth({ userId, username, accessToken, refreshToken, expiresAt });

  // Retrieve the CryptoKey from IndexedDB (never serialized, always non-extractable)
  const privateKey = await loadPrivateKey(userId);
  if (!privateKey) {
    // Key not found (different browser profile or manually cleared) — must log in again
    clearAuth();
    return;
  }

  const publicKey = await importPublicKeyPem(publicKeyPem);
  setKeys({ privateKey, publicKey, publicKeyPem });
  if (userEmail) setUserEmail(userEmail);
  setIsAdmin(isAdmin ?? false);

  // Load user settings
  try {
    await loadSettings(privateKey);
  } catch (err) {
    console.error('Failed to load settings:', err);
    // Non-fatal - continue with default settings
  }
}

export default function App() {
  const [ready, setReady] = useState(false);
  const userId = useAuthStore(s => s.userId);
  const { privateKey, publicKey, username, refreshToken, expiresAt } = useAuthStore();
  const { activePage, darkMode } = useUiStore();
  const dbDisconnected = useDbStore(s => s.disconnected);
  const { enabled, setProgress } = useIndexStore();
  const indexAbortRef = useRef<AbortController | null>(null);

  // Clear all user-scoped caches whenever the logged-in user changes (including logout).
  // This prevents User A's emails from leaking into User B's session via React Query
  // cache hits, or stale Zustand store data (folders, settings).
  useEffect(() => {
    queryClient.clear();
    useFolderStore.getState().reset();
    useSettingsStore.getState().clear();
  }, [userId]);

  // Load settings whenever privateKey becomes available (covers fresh login — hydrateSession
  // handles page reload, but LoginPage sets keys without calling loadSettings).
  useEffect(() => {
    if (!privateKey) return;
    if (useSettingsStore.getState().loaded) return; // already loaded by hydrateSession
    loadSettings(privateKey).catch(err => console.error('Failed to load settings:', err));
  }, [privateKey]);

  useEffect(() => {
    hydrateSession().finally(() => setReady(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  // Automatic token refresh — check every minute and refresh if within 10 minutes of expiry
  useEffect(() => {
    if (!userId || !username || !refreshToken || !expiresAt) return;

    const checkAndRefresh = async () => {
      const now = Date.now();
      const tenMinutes = 10 * 60 * 1000;

      // Refresh if token expires in less than 10 minutes
      if (now > expiresAt - tenMinutes) {
        try {
          const fresh = await refreshTokens(username, refreshToken);
          const { updateTokens } = useAuthStore.getState();
          updateTokens({
            accessToken: fresh.accessToken,
            refreshToken: fresh.refreshToken,
            expiresAt: fresh.expiresAt,
          });
          console.log('Token refreshed successfully');
        } catch (err) {
          if (isRefreshTokenExpiredError(err)) {
            // Refresh token is genuinely invalid — force re-login.
            useAuthStore.getState().clearAuth();
          } else {
            // Transient error — the 401 interceptor will handle it on the next request.
            console.warn('Token refresh failed (transient):', err);
          }
        }
      }
    };

    // Check immediately on mount
    checkAndRefresh();

    // Then check every minute
    const interval = setInterval(checkAndRefresh, 60 * 1000);
    return () => clearInterval(interval);
  }, [userId, username, refreshToken, expiresAt]);

  // Background indexer — lives here so it persists across page navigation
  useEffect(() => {
    indexAbortRef.current?.abort();
    indexAbortRef.current = null;

    if (!enabled || !privateKey || !publicKey) return;

    const controller = new AbortController();
    indexAbortRef.current = controller;

    startIndexing({
      privateKey,
      publicKey,
      signal: controller.signal,
      onProgress: (p) => setProgress(p),
    }).catch(() => { /* per-email errors handled inside startIndexing */ });

    return () => { controller.abort(); };
  }, [enabled, privateKey, publicKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Periodic sync polling — adaptive interval based on email count
  useEffect(() => {
    if (!userId || !privateKey) return;

    const syncManager = SyncManager.getInstance(privateKey);

    // Warm up OPFS so the first notification-triggered sync doesn't pay cold-start latency
    syncManager.warmup().catch(() => { });

    let intervalId: number;

    const runSync = async () => {
      try {
        await syncManager.sync();
      } catch (err) {
        console.error('[App] Sync failed:', err);
      }
    };

    // Initial sync
    runSync();

    // Start with 5-second interval (will adjust after first sync)
    intervalId = window.setInterval(runSync, 30000);

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [userId, privateKey]);

  if (!ready) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center dark:bg-gray-950">
        <svg className="w-8 h-8 text-blue-600 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      {dbDisconnected && (
        <div className="fixed top-0 inset-x-0 z-50 bg-yellow-500 text-white text-sm text-center py-2 px-4">
          This tab is inactive — another tab has the database open.
          {' '}<button className="underline font-medium" onClick={() => window.location.reload()}>Reload to activate</button>
        </div>
      )}
      {userId ? (
        activePage === 'settings' ? <SettingsPage /> :
          activePage === 'admin' ? <AdminPage /> :
            <MailPage />
      ) : <LoginPage />}
    </QueryClientProvider>
  );
}
