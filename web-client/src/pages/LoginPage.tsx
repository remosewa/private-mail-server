import { useState, useRef, type FormEvent } from 'react';
import {
  generateKeyPair,
  deriveWrappingKey,
  wrapPrivateKey,
  unwrapPrivateKey,
  exportPublicKeyPem,
  importPublicKeyPem,
  generateArgon2Salt,
} from '../crypto/KeyManager';
import { login, submitTotpLogin, cancelPendingMfa, register, getKeyBundle } from '../api/auth';
import { useAuthStore, writeSession } from '../store/authStore';
import { savePrivateKey } from '../db/KeyStore';

type Tab = 'login' | 'register';

export default function LoginPage() {
  const [tab, setTab] = useState<Tab>('login');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // When Cognito returns a TOTP challenge we hold the partial credentials here
  // until the user submits their authenticator code.
  const [totpPending, setTotpPending] = useState(false);
  const partialLoginRef = useRef<{
    username: string;
    password: string;
  } | null>(null);

  const { setAuth, setKeys, setUserEmail, setIsAdmin } = useAuthStore();

  async function handleLogin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const username = fd.get('username') as string;
    const password = fd.get('password') as string;
    try {
      const result = await login(username, password);
      if (result.type === 'totp_required') {
        partialLoginRef.current = { username, password };
        setTotpPending(true);
        return;
      }
      await completeLogin(username, password, result.tokens);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleTotpSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const code = (fd.get('totp') as string).replace(/\s/g, '');
    const { username, password } = partialLoginRef.current!;
    try {
      const tokens = await submitTotpLogin(code);
      await completeLogin(username, password, tokens);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid code');
    } finally {
      setLoading(false);
    }
  }

  async function completeLogin(
    username: string,
    password: string,
    tokens: { accessToken: string; refreshToken: string; expiresAt: number },
  ) {
    setAuth({ userId: '', username, ...tokens });

    const bundle = await getKeyBundle();
    const salt = Uint8Array.from(atob(bundle.argon2Salt), c => c.charCodeAt(0));
    const wrappingKey = await deriveWrappingKey(password, salt);
    const privateKey = await unwrapPrivateKey(bundle.encryptedPrivateKey, wrappingKey);
    const publicKey = await importPublicKeyPem(bundle.publicKey);

    const [, payload] = tokens.accessToken.split('.');
    const { sub: userId } = JSON.parse(atob(payload!)) as { sub: string };

    setAuth({ userId, username, ...tokens });
    setKeys({ privateKey, publicKey, publicKeyPem: bundle.publicKey });
    setUserEmail(bundle.email);
    setIsAdmin(bundle.isAdmin);

    writeSession({
      userId,
      username,
      userEmail: bundle.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      publicKeyPem: bundle.publicKey,
      isAdmin: bundle.isAdmin,
    });
    await savePrivateKey(userId, privateKey);
  }

  async function handleRegister(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const username = fd.get('username') as string;
    const emailPrefix = fd.get('emailPrefix') as string;
    const email = `${emailPrefix}@${import.meta.env['VITE_MAIL_DOMAIN'] as string}`;
    const password = fd.get('password') as string;
    const inviteCode = fd.get('inviteCode') as string;
    try {
      const { privateKey, publicKey } = await generateKeyPair();
      const publicKeyPem = await exportPublicKeyPem(publicKey);

      const argon2SaltB64 = generateArgon2Salt();
      const salt = Uint8Array.from(atob(argon2SaltB64), c => c.charCodeAt(0));
      const wrappingKey = await deriveWrappingKey(password, salt);
      const encryptedPrivateKey = await wrapPrivateKey(privateKey, wrappingKey);

      const { userId } = await register({
        inviteCode, username, email, password,
        publicKey: publicKeyPem, encryptedPrivateKey, argon2Salt: argon2SaltB64,
      });

      const result = await login(username, password);
      // New accounts can't have MFA yet, so this will always be 'success'
      if (result.type !== 'success') throw new Error('Unexpected MFA challenge after registration');
      const tokens = result.tokens;
      const importedPublicKey = await importPublicKeyPem(publicKeyPem);

      setAuth({ userId, username, ...tokens });
      setKeys({ privateKey, publicKey: importedPublicKey, publicKeyPem });

      writeSession({
        userId,
        username,
        userEmail: email,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        publicKeyPem,
      });
      await savePrivateKey(userId, privateKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  // ── TOTP challenge screen ──────────────────────────────────────────────────
  if (totpPending) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-md p-8">
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">Two-factor authentication</h1>
          <p className="text-sm text-gray-500 mb-6">
            Enter the 6-digit code from your authenticator app.
          </p>

          {error && (
            <p className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
          )}

          <form onSubmit={handleTotpSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Authenticator code</label>
              <input
                name="totp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                autoFocus
                placeholder="000000"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-center
                           tracking-widest font-mono focus:outline-none focus:ring-2 focus:ring-blue-500
                           focus:border-transparent"
              />
            </div>
            <SubmitButton loading={loading} label="Verify" />
            <button
              type="button"
              onClick={() => { cancelPendingMfa(); setTotpPending(false); setError(''); partialLoginRef.current = null; }}
              className="w-full text-sm text-gray-500 hover:text-gray-700"
            >
              Back to login
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── Normal login / register ────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-md p-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-6">Private Mail</h1>

        <div className="flex border-b border-gray-200 mb-6">
          {(['login', 'register'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => { setTab(t); setError(''); }}
              className={`px-4 py-2 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ${tab === t
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
            >
              {t}
            </button>
          ))}
        </div>

        {error && (
          <p className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
        )}

        {tab === 'login' ? (
          <form onSubmit={handleLogin} className="space-y-4">
            <Field label="Username" name="username" type="text" required />
            <Field label="Password" name="password" type="password" required />
            <SubmitButton loading={loading} label="Sign in" />
          </form>
        ) : (
          <form onSubmit={handleRegister} className="space-y-4">
            <Field label="Invite code" name="inviteCode" type="text" required />
            <Field label="Username" name="username" type="text" required />
            <EmailPrefixField />
            <Field label="Password" name="password" type="password" required />
            <p className="text-xs text-gray-500">
              Your keys are generated locally. The server never sees your password.
              Key derivation (Argon2id) may take a few seconds.
            </p>
            <SubmitButton loading={loading} label="Create account" />
          </form>
        )}
      </div>
    </div>
  );
}

function Field({ label, name, type, required }: {
  label: string; name: string; type: string; required?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        name={name} type={type} required={required}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm
                   focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
    </div>
  );
}

function EmailPrefixField() {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">Email address</label>
      <div className="flex items-center gap-0">
        <input
          name="emailPrefix"
          type="text"
          required
          placeholder="username"
          pattern="[a-zA-Z0-9._-]+"
          title="Only letters, numbers, dots, hyphens, and underscores"
          className="flex-1 px-3 py-2 border border-gray-300 rounded-l-lg text-sm
                     focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
        <span className="px-3 py-2 bg-gray-100 border border-l-0 border-gray-300 rounded-r-lg text-sm text-gray-600">
          @{import.meta.env['VITE_MAIL_DOMAIN'] as string}
        </span>
      </div>
    </div>
  );
}

function SubmitButton({ loading, label }: { loading: boolean; label: string }) {
  return (
    <button
      type="submit" disabled={loading}
      className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300
                 text-white text-sm font-medium rounded-lg transition-colors"
    >
      {loading ? 'Please wait…' : label}
    </button>
  );
}
