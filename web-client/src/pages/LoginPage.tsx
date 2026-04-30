import { useState, useRef } from 'react';
import {
  generateKeyPair,
  deriveWrappingKey,
  wrapPrivateKey,
  unwrapPrivateKey,
  exportPublicKeyPem,
  importPublicKeyPem,
  generateArgon2Salt,
  generateRecoveryKey,
  deriveWrappingKeyFromRecoveryKey,
  recoveryKeyToCognitoPassword,
} from '../crypto/KeyManager';
import {
  login, loginForRecovery, submitTotpLogin, cancelPendingMfa, register, getKeyBundle,
  fetchRecoveryBundle, rekeyAccount, recoverMfa,
} from '../api/auth';
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
  const [mfaRecovery, setMfaRecovery] = useState(false);
  const partialLoginRef = useRef<{
    username: string;
    password: string;
  } | null>(null);

  const { setAuth, setKeys, setUserEmail, setIsAdmin, setHasRecoveryKey } = useAuthStore();

  // After registration, hold the recovery key here so the user can save it
  // before we complete the login flow.
  const [recoveryKeyScreen, setRecoveryKeyScreen] = useState<{
    key: string;
    proceed: () => Promise<void>;
  } | null>(null);

  // Forgot password flow — two steps
  const [forgotStep, setForgotStep] = useState<'entry' | 'new-password' | 'success' | null>(null);
  const forgotDataRef = useRef<{
    username: string;
    recoveryAccessToken: string;
    privateKey: CryptoKey;
  } | null>(null);

  async function handleLogin(e: { preventDefault(): void; currentTarget: HTMLFormElement }) {
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

  async function handleTotpSubmit(e: { preventDefault(): void; currentTarget: HTMLFormElement }) {
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
    setHasRecoveryKey(bundle.hasRecoveryKey);

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

  async function handleRegister(e: { preventDefault(): void; currentTarget: HTMLFormElement }) {
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

      const recoveryKey = generateRecoveryKey();
      const recoveryWrappingKey = await deriveWrappingKeyFromRecoveryKey(recoveryKey);
      const cognitoRecoveryPassword = recoveryKeyToCognitoPassword(recoveryKey);
      const recoveryEncryptedPrivateKey = await wrapPrivateKey(privateKey, recoveryWrappingKey);

      const { userId } = await register({
        inviteCode, username, email, password,
        publicKey: publicKeyPem, encryptedPrivateKey, argon2Salt: argon2SaltB64,
        recoveryEncryptedPrivateKey, cognitoRecoveryPassword,
      });

      setRecoveryKeyScreen({
        key: recoveryKey,
        proceed: async () => {
          const result = await login(username, password);
          if (result.type !== 'success') throw new Error('Unexpected MFA challenge after registration');
          const tokens = result.tokens;
          const importedPublicKey = await importPublicKeyPem(publicKeyPem);

          setAuth({ userId, username, ...tokens });
          setKeys({ privateKey, publicKey: importedPublicKey, publicKeyPem });
          setUserEmail(email);
          setHasRecoveryKey(true);

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
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleMfaRecovery(e: { preventDefault(): void; currentTarget: HTMLFormElement }) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const recoveryCode = (fd.get('recoveryCode') as string).trim();
    const { username, password } = partialLoginRef.current!;
    try {
      await recoverMfa(username, recoveryCode);
      // TOTP is now disabled — retry login normally
      const result = await login(username, password);
      if (result.type !== 'success') throw new Error('Unexpected MFA challenge after recovery');
      cancelPendingMfa();
      setTotpPending(false);
      setMfaRecovery(false);
      await completeLogin(username, password, result.tokens);
    } catch (err) {
      console.error('[handleMfaRecovery]', err);
      setError(err instanceof Error ? err.message : 'Recovery failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotEntry(e: { preventDefault(): void; currentTarget: HTMLFormElement }) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const username = fd.get('username') as string;
    const recoveryKey = (fd.get('recoveryKey') as string).trim();
    try {
      const cognitoPassword = recoveryKeyToCognitoPassword(recoveryKey);
      const loginResult = await loginForRecovery(username, cognitoPassword);
      if (loginResult.type !== 'success') throw new Error('Unexpected MFA challenge on recovery login');
      const recoveryAccessToken = loginResult.tokens.accessToken;
      const bundle = await fetchRecoveryBundle(recoveryAccessToken);
      const wrappingKey = await deriveWrappingKeyFromRecoveryKey(recoveryKey);
      const privateKey = await unwrapPrivateKey(bundle.recoveryEncryptedPrivateKey, wrappingKey);
      forgotDataRef.current = { username, recoveryAccessToken, privateKey };
      setForgotStep('new-password');
    } catch (err) {
      console.error('[handleForgotEntry]', err);
      const msg = err instanceof Error ? err.message : 'Recovery failed';
      const isWrongKey = msg.toLowerCase().includes('incorrect') || msg.toLowerCase().includes('not authorized');
      setError(isWrongKey ? 'Invalid recovery key.' : msg);
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotNewPassword(e: { preventDefault(): void; currentTarget: HTMLFormElement }) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const newPassword = fd.get('newPassword') as string;
    const { recoveryAccessToken, privateKey } = forgotDataRef.current!;
    try {
      const newArgon2SaltB64 = generateArgon2Salt();
      const newSalt = Uint8Array.from(atob(newArgon2SaltB64), c => c.charCodeAt(0));
      const newWrappingKey = await deriveWrappingKey(newPassword, newSalt);
      const newEncryptedPrivateKey = await wrapPrivateKey(privateKey, newWrappingKey);
      await rekeyAccount({ recoveryAccessToken, newPassword, newEncryptedPrivateKey, newArgon2Salt: newArgon2SaltB64 });
      forgotDataRef.current = null;
      setForgotStep('success');
    } catch (err) {
      console.error('[handleForgotNewPassword]', err);
      setError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  }

  // ── Recovery key download screen (shown immediately after registration) ──────
  if (recoveryKeyScreen) {
    return (
      <RecoveryKeyDownloadScreen
        recoveryKey={recoveryKeyScreen.key}
        onConfirm={async () => {
          setLoading(true);
          setError('');
          try {
            await recoveryKeyScreen.proceed();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Login failed');
            setLoading(false);
          }
        }}
        loading={loading}
        error={error}
      />
    );
  }

  // ── Forgot password: success ──────────────────────────────────────────────
  if (forgotStep === 'success') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-md p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">Password reset</h1>
          <p className="text-sm text-gray-500 mb-6">
            Your password has been updated. You can now sign in with your new password.
            <br /><br />
            Your recovery key has been invalidated — set up a new one after signing in.
          </p>
          <button
            onClick={() => { setForgotStep(null); setTab('login'); setError(''); }}
            className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Go to sign in
          </button>
        </div>
      </div>
    );
  }

  // ── Forgot password: step 1 — enter username + recovery key ──────────────
  if (forgotStep === 'entry') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-xl p-8">
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">Recover your account</h1>
          <p className="text-sm text-gray-500 mb-6">
            Enter your username and recovery key to regain access.
          </p>
          {error && <p className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <form onSubmit={handleForgotEntry} className="space-y-4">
            <Field label="Username" name="username" type="text" required />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Recovery key</label>
              <textarea
                name="recoveryKey"
                required
                autoComplete="off"
                rows={2}
                placeholder="XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono
                           resize-none focus:outline-none focus:ring-2 focus:ring-blue-500
                           focus:border-transparent"
              />
            </div>
            <SubmitButton loading={loading} label="Continue" />
            <button type="button" onClick={() => { setForgotStep(null); setError(''); }}
              className="w-full text-sm text-gray-500 hover:text-gray-700">
              Back to login
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── Forgot password: step 2 — set new password ────────────────────────────
  if (forgotStep === 'new-password') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-md p-8">
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">Set a new password</h1>
          <p className="text-sm text-gray-500 mb-6">
            Your recovery key was accepted. Choose a new password for your account.
          </p>
          {error && <p className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <form onSubmit={handleForgotNewPassword} className="space-y-4">
            <Field label="New password" name="newPassword" type="password" required />
            <SubmitButton loading={loading} label="Reset password" />
          </form>
        </div>
      </div>
    );
  }

  // ── TOTP challenge screen ──────────────────────────────────────────────────
  if (totpPending) {
    function backToLogin() { cancelPendingMfa(); setTotpPending(false); setMfaRecovery(false); setError(''); partialLoginRef.current = null; }
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-md p-8">
          {!mfaRecovery ? (
            <>
              <h1 className="text-2xl font-semibold text-gray-900 mb-2">Two-factor authentication</h1>
              <p className="text-sm text-gray-500 mb-6">Enter the 6-digit code from your authenticator app.</p>
              {error && <p className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
              <form onSubmit={handleTotpSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Authenticator code</label>
                  <input
                    name="totp" type="text" inputMode="numeric" autoComplete="one-time-code"
                    maxLength={6} required autoFocus placeholder="000000"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-center
                               tracking-widest font-mono focus:outline-none focus:ring-2 focus:ring-blue-500
                               focus:border-transparent"
                  />
                </div>
                <SubmitButton loading={loading} label="Verify" />
                <button type="button" onClick={() => { setMfaRecovery(true); setError(''); }}
                  className="w-full text-sm text-gray-500 hover:text-gray-700">
                  Use a recovery code instead
                </button>
                <button type="button" onClick={backToLogin} className="w-full text-sm text-gray-400 hover:text-gray-600">
                  Back to login
                </button>
              </form>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-semibold text-gray-900 mb-2">Use a recovery code</h1>
              <p className="text-sm text-gray-500 mb-6">
                Enter one of the backup codes you saved when you set up two-factor authentication.
                This will disable 2FA on your account.
              </p>
              {error && <p className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
              <form onSubmit={handleMfaRecovery} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Recovery code</label>
                  <input
                    name="recoveryCode" type="text" required autoFocus autoComplete="off"
                    placeholder="xxxxx-xxxxx-xxxxx-xxxxx"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono
                               focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <SubmitButton loading={loading} label="Verify recovery code" />
                <button type="button" onClick={() => { setMfaRecovery(false); setError(''); }}
                  className="w-full text-sm text-gray-500 hover:text-gray-700">
                  Back to authenticator code
                </button>
                <button type="button" onClick={backToLogin} className="w-full text-sm text-gray-400 hover:text-gray-600">
                  Back to login
                </button>
              </form>
            </>
          )}
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
            <button type="button" onClick={() => { setForgotStep('entry'); setError(''); }}
              className="w-full text-sm text-gray-500 hover:text-gray-700">
              Forgot password?
            </button>
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

function RecoveryKeyDownloadScreen({
  recoveryKey, onConfirm, loading, error,
}: {
  recoveryKey: string;
  onConfirm: () => void;
  loading: boolean;
  error: string;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(recoveryKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleDownload() {
    const blob = new Blob([`Chase Email Recovery Key\n\n${recoveryKey}\n\nStore this somewhere safe. It cannot be shown again.\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chase-email-recovery-key.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-xl p-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">Save your recovery key</h1>
        <p className="text-sm text-gray-600 mb-6">
          If you ever forget your password, this key is the <strong>only way</strong> to
          recover access to your encrypted mail. It cannot be shown again.
        </p>

        <div className="bg-gray-100 rounded-lg px-4 py-3 font-mono text-sm tracking-widest
                        text-gray-800 text-center select-all mb-3 break-all">
          {recoveryKey}
        </div>

        <div className="flex gap-2 mb-6">
          <button
            onClick={handleDownload}
            className="flex-1 py-2 px-3 border border-gray-300 rounded-lg text-sm
                       text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Download .txt
          </button>
          <button
            onClick={handleCopy}
            className="flex-1 py-2 px-3 border border-gray-300 rounded-lg text-sm
                       text-gray-700 hover:bg-gray-50 transition-colors"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>

        {error && (
          <p className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
        )}

        <label className="flex items-start gap-3 text-sm text-gray-600 mb-5 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600"
            checked={confirmed}
            onChange={e => setConfirmed(e.target.checked)}
          />
          I have saved my recovery key in a safe place
        </label>

        <button
          onClick={onConfirm}
          disabled={!confirmed || loading}
          className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300
                     text-white text-sm font-medium rounded-lg transition-colors"
        >
          {loading ? 'Please wait…' : 'Continue to your inbox'}
        </button>
      </div>
    </div>
  );
}
