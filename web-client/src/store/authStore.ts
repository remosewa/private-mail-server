/**
 * authStore — Zustand store for authentication state.
 *
 * Tokens (accessToken, refreshToken, expiresAt, userId, username, publicKeyPem)
 * are persisted to localStorage so a page refresh does not force re-login.
 *
 * The private CryptoKey is stored separately in IndexedDB (see KeyStore.ts)
 * using the browser's structured clone algorithm, meaning the key material
 * never becomes a JS string even with extractable: false.
 *
 * On startup, App.tsx hydrates the store from localStorage + IndexedDB before
 * rendering anything, so MailPage is shown immediately if a valid session exists.
 */

import { create } from 'zustand';
import { teardownDb } from '../db/Database';

// ---------------------------------------------------------------------------
// localStorage session helpers
// ---------------------------------------------------------------------------

const LS_KEY = 'chase:session';

export interface PersistedSession {
  userId:       string;
  username:     string;
  userEmail:    string;
  accessToken:  string;
  refreshToken: string;
  expiresAt:    number; // ms epoch
  publicKeyPem: string;
  isAdmin?:     boolean;
}

export function readSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as PersistedSession) : null;
  } catch {
    return null;
  }
}

export function writeSession(s: PersistedSession): void {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}

export function clearSession(): void {
  localStorage.removeItem(LS_KEY);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface AuthState {
  userId:       string | null;
  username:     string | null;
  userEmail:    string | null;
  accessToken:  string | null;
  refreshToken: string | null;
  expiresAt:    number | null; // ms epoch
  isAdmin:      boolean;
  hasRecoveryKey: boolean | null; // null = unknown (session predates this field)

  // RSA keypair — CryptoKey objects (private key held in IndexedDB too)
  privateKey:    CryptoKey | null;
  publicKey:     CryptoKey | null;
  publicKeyPem:  string | null;

  setAuth(params: {
    userId:       string;
    username:     string;
    accessToken:  string;
    refreshToken: string;
    expiresAt:    number;
  }): void;

  setUserEmail(email: string): void;
  setIsAdmin(isAdmin: boolean): void;
  setHasRecoveryKey(v: boolean): void;

  setKeys(params: {
    privateKey:   CryptoKey;
    publicKey:    CryptoKey;
    publicKeyPem: string;
  }): void;

  updateTokens(params: {
    accessToken:  string;
    refreshToken: string;
    expiresAt:    number;
  }): void;

  clearAuth(): void;
}

export const useAuthStore = create<AuthState>(set => ({
  userId:         null,
  username:       null,
  userEmail:      null,
  accessToken:    null,
  refreshToken:   null,
  expiresAt:      null,
  isAdmin:        false,
  hasRecoveryKey: null,
  privateKey:     null,
  publicKey:      null,
  publicKeyPem:   null,

  setAuth: ({ userId, username, accessToken, refreshToken, expiresAt }) =>
    set({ userId, username, accessToken, refreshToken, expiresAt }),

  setUserEmail: (email) => set({ userEmail: email }),
  setIsAdmin: (isAdmin) => set({ isAdmin }),
  setHasRecoveryKey: (v) => set({ hasRecoveryKey: v }),

  setKeys: ({ privateKey, publicKey, publicKeyPem }) =>
    set({ privateKey, publicKey, publicKeyPem }),

  updateTokens: ({ accessToken, refreshToken, expiresAt }) => {
    // Update localStorage session with new tokens
    const current = readSession();
    if (current) {
      writeSession({ ...current, accessToken, refreshToken, expiresAt });
    }
    set({ accessToken, refreshToken, expiresAt });
  },

  clearAuth: () => {
    teardownDb();
    clearSession();
    set({
      userId:         null,
      username:       null,
      userEmail:      null,
      accessToken:    null,
      refreshToken:   null,
      expiresAt:      null,
      isAdmin:        false,
      hasRecoveryKey: null,
      privateKey:     null,
      publicKey:      null,
      publicKeyPem:   null,
    });
  },
}));
