/**
 * Cognito authentication using amazon-cognito-identity-js.
 *
 * Tokens are stored in-memory only via a custom IStorage implementation that
 * wraps a Map — this avoids XSS token theft via localStorage.
 *
 * On every page load, the user must re-authenticate; the private key is
 * re-derived from the password and held in Zustand (never persisted).
 */

import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
} from 'amazon-cognito-identity-js';
import { apiClient } from './client';

// ---------------------------------------------------------------------------
// In-memory Cognito storage (no localStorage)
// ---------------------------------------------------------------------------

const memoryStore = new Map<string, string>();

const memoryStorage: Storage = {
  setItem:    (k, v) => { memoryStore.set(k, v); },
  getItem:    (k) => memoryStore.get(k) ?? null,
  removeItem: (k) => { memoryStore.delete(k); },
  clear:      () => { memoryStore.clear(); },
  key:        (i) => [...memoryStore.keys()][i] ?? null,
  get length() { return memoryStore.size; },
};

// ---------------------------------------------------------------------------
// Cognito pool — configured from Vite env vars
// ---------------------------------------------------------------------------

const userPool = new CognitoUserPool({
  UserPoolId: import.meta.env['VITE_COGNITO_USER_POOL_ID'] as string,
  ClientId:   import.meta.env['VITE_COGNITO_CLIENT_ID'] as string,
  Storage:    memoryStorage,
});

// Region derived from pool ID prefix (e.g. "us-west-2_jFbitvDRO" → "us-west-2")
const awsRegion = (import.meta.env['VITE_COGNITO_USER_POOL_ID'] as string).split('_')[0]!;
const COGNITO_ENDPOINT = `https://cognito-idp.${awsRegion}.amazonaws.com/`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CognitoTokens {
  accessToken:  string;
  refreshToken: string;
  expiresAt:    number; // ms epoch
}

export type LoginResult =
  | { type: 'success'; tokens: CognitoTokens }
  | { type: 'totp_required' };

export interface RegisterBody {
  inviteCode:          string;
  username:            string;
  email:               string;
  publicKey:           string; // PEM SPKI
  encryptedPrivateKey: string; // base64(iv || wrapped PKCS8)
  argon2Salt:          string; // base64
  password:            string;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

// Holds the in-progress MFA CognitoUser across the TOTP challenge step
let pendingMfaUser: CognitoUser | null = null;

export function login(username: string, password: string): Promise<LoginResult> {
  return new Promise((resolve, reject) => {
    const user    = new CognitoUser({ Username: username, Pool: userPool, Storage: memoryStorage });
    const details = new AuthenticationDetails({ Username: username, Password: password });

    user.authenticateUser(details, {
      onSuccess: session => resolve({
        type: 'success',
        tokens: {
          accessToken:  session.getAccessToken().getJwtToken(),
          refreshToken: session.getRefreshToken().getToken(),
          expiresAt:    session.getAccessToken().getExpiration() * 1000,
        },
      }),
      onFailure: reject,
      totpRequired: () => {
        pendingMfaUser = user;
        resolve({ type: 'totp_required' });
      },
    });
  });
}

/** Cancel a pending MFA session (e.g. user clicks "Back to login"). */
export function cancelPendingMfa(): void {
  pendingMfaUser = null;
}

/** Submit the TOTP code after a `totp_required` login result. */
export function submitTotpLogin(totpCode: string): Promise<CognitoTokens> {
  return new Promise((resolve, reject) => {
    if (!pendingMfaUser) return reject(new Error('No pending MFA session'));
    const user = pendingMfaUser;
    user.sendMFACode(
      totpCode,
      {
        onSuccess: session => {
          pendingMfaUser = null;
          resolve({
            accessToken:  session.getAccessToken().getJwtToken(),
            refreshToken: session.getRefreshToken().getToken(),
            expiresAt:    session.getAccessToken().getExpiration() * 1000,
          });
        },
        onFailure: err => {
          // Don't clear pendingMfaUser — the Cognito session stays valid so
          // the user can retry with a fresh code without starting over.
          reject(err as Error);
        },
      },
      'SOFTWARE_TOKEN_MFA',
    );
  });
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

/** Call POST /auth/register (server creates the Cognito user and DynamoDB record). */
export async function register(body: RegisterBody): Promise<{ userId: string }> {
  const res = await apiClient.post<{ userId: string }>('/auth/register', body);
  return res.data;
}

// ---------------------------------------------------------------------------
// Key bundle (fetched after login to unwrap the private key)
// ---------------------------------------------------------------------------

export interface KeyBundle {
  publicKey:           string; // PEM SPKI
  encryptedPrivateKey: string; // base64(iv || wrapped PKCS8)
  argon2Salt:          string; // base64
  email:               string;
  isAdmin:             boolean;
}

export async function getKeyBundle(): Promise<KeyBundle> {
  const res = await apiClient.get<KeyBundle>('/auth/key-bundle');
  return res.data;
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

export function refreshTokens(username: string, currentRefreshToken: string): Promise<CognitoTokens> {
  return new Promise((resolve, reject) => {
    import('amazon-cognito-identity-js').then(({ CognitoRefreshToken }) => {
      const user  = new CognitoUser({ Username: username, Pool: userPool, Storage: memoryStorage });
      const token = new CognitoRefreshToken({ RefreshToken: currentRefreshToken });
      user.refreshSession(token, (err, session) => {
        if (err) return reject(err);
        resolve({
          accessToken:  session.getAccessToken().getJwtToken(),
          refreshToken: session.getRefreshToken().getToken(),
          expiresAt:    session.getAccessToken().getExpiration() * 1000,
        });
      });
    }).catch(reject);
  });
}

// ---------------------------------------------------------------------------
// TOTP management — direct Cognito HTTP API calls (no extra SDK needed)
// ---------------------------------------------------------------------------

async function cognitoIdpCall(target: string, body: object): Promise<unknown> {
  const res = await fetch(COGNITO_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json() as { message?: string; __type?: string };
  if (!res.ok) throw new Error(data.message ?? 'Cognito request failed');
  return data;
}

/** Step 1 of TOTP setup: get the base32 secret to encode as a QR code. */
export async function beginTotpSetup(accessToken: string): Promise<string> {
  const result = await cognitoIdpCall('AssociateSoftwareToken', { AccessToken: accessToken }) as { SecretCode: string };
  return result.SecretCode;
}

/** Step 2 of TOTP setup: verify the first code from the authenticator app. */
export async function verifyTotpSetup(accessToken: string, totpCode: string): Promise<void> {
  await cognitoIdpCall('VerifySoftwareToken', {
    AccessToken:        accessToken,
    UserCode:           totpCode,
    FriendlyDeviceName: 'Authenticator App',
  });
}

/** Step 3 of TOTP setup: mark TOTP as enabled and preferred. */
export async function enableTotp(accessToken: string): Promise<void> {
  await cognitoIdpCall('SetUserMFAPreference', {
    AccessToken:              accessToken,
    SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
  });
}

/** Disable TOTP MFA for the current user. */
export async function disableTotp(accessToken: string): Promise<void> {
  await cognitoIdpCall('SetUserMFAPreference', {
    AccessToken:              accessToken,
    SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
  });
}

/** Returns true if the user currently has TOTP MFA enabled. */
export async function getMfaStatus(accessToken: string): Promise<boolean> {
  const result = await cognitoIdpCall('GetUser', { AccessToken: accessToken }) as {
    UserMFASettingList?: string[];
  };
  return (result.UserMFASettingList ?? []).includes('SOFTWARE_TOKEN_MFA');
}

// ---------------------------------------------------------------------------
// Recovery codes — generated client-side, stored server-side as SHA-256 hashes
// ---------------------------------------------------------------------------

/** Generate 8 random recovery codes and store their SHA-256 hashes via the API.
 *  Returns the plaintext codes — show these to the user exactly once. */
export async function generateAndStoreRecoveryCodes(): Promise<string[]> {
  const codes: string[] = [];
  for (let i = 0; i < 8; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    const hex   = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    // Format as XXXXX-XXXXX for readability
    codes.push(`${hex.slice(0, 5)}-${hex.slice(5, 10)}-${hex.slice(10, 15)}-${hex.slice(15, 20)}`);
  }

  const encoder = new TextEncoder();
  const codeHashes = await Promise.all(
    codes.map(async code => {
      const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(code.toLowerCase()));
      return [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
    }),
  );

  await apiClient.post('/auth/recovery-codes', { codeHashes });
  return codes;
}
