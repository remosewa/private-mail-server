import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useUiStore } from '../store/uiStore';
import { useIndexStore } from '../store/indexStore';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';
import { saveSettings } from '../sync/SettingsManager';
import { getDb } from '../db/Database';
import {
  getMfaStatus,
  beginTotpSetup,
  verifyTotpSetup,
  enableTotp,
  disableTotp,
  generateAndStoreRecoveryCodes,
} from '../api/auth';
import MboxMigration from '../components/settings/MboxMigration';

// ── 2FA setup wizard steps ─────────────────────────────────────────────────

type TotpSetupStep =
  | { step: 'idle' }
  | { step: 'qr';      secretCode: string; qrDataUrl: string }
  | { step: 'verify';  secretCode: string }
  | { step: 'codes';   recoveryCodes: string[] };

export default function SettingsPage() {
  const { darkMode, setDarkMode, threadViewEnabled, setThreadViewEnabled, setActivePage } = useUiStore();
  const { enabled, setEnabled, total, indexed, running, modelReady, reset } = useIndexStore();
  const { accessToken, userEmail, publicKey, isAdmin } = useAuthStore();
  const { settings } = useSettingsStore();

  // ── Display name state ────────────────────────────────────────────────────
  const [displayName, setDisplayName] = useState('');
  const [displayNameSaving, setDisplayNameSaving] = useState(false);
  const [displayNameError, setDisplayNameError] = useState('');
  const [displayNameSuccess, setDisplayNameSuccess] = useState(false);

  // ── 2FA state ─────────────────────────────────────────────────────────────
  const [mfaEnabled, setMfaEnabled]     = useState<boolean | null>(null); // null = loading
  const [totpSetup, setTotpSetup]       = useState<TotpSetupStep>({ step: 'idle' });
  const [totpCode, setTotpCode]         = useState('');
  const [mfaError, setMfaError]         = useState('');
  const [mfaLoading, setMfaLoading]     = useState(false);
  const [disableConfirm, setDisableConfirm] = useState(false);
  const [copiedCodes, setCopiedCodes]   = useState(false);

  // Load display name from settings
  useEffect(() => {
    if (settings) {
      setDisplayName(settings.displayName || '');
    }
  }, [settings]);

  useEffect(() => {
    if (!accessToken) return;
    getMfaStatus(accessToken)
      .then(setMfaEnabled)
      .catch(() => setMfaEnabled(false));
  }, [accessToken]);

  async function handleSaveDisplayName() {
    if (!publicKey) return;
    setDisplayNameError('');
    setDisplayNameSuccess(false);
    setDisplayNameSaving(true);
    try {
      await saveSettings({ displayName: displayName.trim() }, publicKey);
      setDisplayNameSuccess(true);
      setTimeout(() => setDisplayNameSuccess(false), 2000);
    } catch (err) {
      setDisplayNameError(err instanceof Error ? err.message : 'Failed to save display name');
    } finally {
      setDisplayNameSaving(false);
    }
  }

  async function handleStartSetup() {
    if (!accessToken || !userEmail) return;
    setMfaError('');
    setMfaLoading(true);
    try {
      const secretCode = await beginTotpSetup(accessToken);
      const otpauthUrl =
        `otpauth://totp/PrivateMail:${encodeURIComponent(userEmail)}` +
        `?secret=${secretCode}&issuer=PrivateMail`;
      const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { width: 200, margin: 2 });
      setTotpSetup({ step: 'qr', secretCode, qrDataUrl });
    } catch (err) {
      setMfaError(err instanceof Error ? err.message : 'Failed to start setup');
    } finally {
      setMfaLoading(false);
    }
  }

  async function handleVerifyCode() {
    if (totpSetup.step !== 'qr' && totpSetup.step !== 'verify') return;
    if (!accessToken) return;
    const code = totpCode.replace(/\s/g, '');
    if (code.length !== 6) { setMfaError('Enter the 6-digit code'); return; }
    setMfaError('');
    setMfaLoading(true);
    try {
      await verifyTotpSetup(accessToken, code);
      await enableTotp(accessToken);
      const recoveryCodes = await generateAndStoreRecoveryCodes();
      setMfaEnabled(true);
      setTotpCode('');
      setTotpSetup({ step: 'codes', recoveryCodes });
    } catch (err) {
      setMfaError(err instanceof Error ? err.message : 'Invalid code — try again');
    } finally {
      setMfaLoading(false);
    }
  }

  async function handleDisable() {
    if (!accessToken) return;
    setMfaError('');
    setMfaLoading(true);
    try {
      await disableTotp(accessToken);
      setMfaEnabled(false);
      setDisableConfirm(false);
      setTotpSetup({ step: 'idle' });
    } catch (err) {
      setMfaError(err instanceof Error ? err.message : 'Failed to disable 2FA');
    } finally {
      setMfaLoading(false);
    }
  }

  function handleDoneWithCodes() {
    setTotpSetup({ step: 'idle' });
    setCopiedCodes(false);
  }

  async function handleCopyCodes() {
    if (totpSetup.step !== 'codes') return;
    await navigator.clipboard.writeText(totpSetup.recoveryCodes.join('\n'));
    setCopiedCodes(true);
    setTimeout(() => setCopiedCodes(false), 2000);
  }

  // ── Search index ──────────────────────────────────────────────────────────

  async function handleReindex() {
    const db = await getDb();
    await db.exec("UPDATE email_metadata SET indexed_at = NULL WHERE indexed_at IS NOT NULL");
    await db.exec("DELETE FROM email_embeddings");
    await db.exec("DELETE FROM email_vecs");
    // Clear body_text from FTS so indexer re-populates it (including fallback to body blob)
    await db.exec("DELETE FROM email_fts");
    await db.exec(`
      INSERT INTO email_fts(rowid, subject, fromName, fromAddress, preview, body_text)
        SELECT email_id, COALESCE(subject,''), COALESCE(fromName,''), COALESCE(fromAddress,''), COALESCE(preview,''), ''
        FROM email_metadata
    `);
    reset();
    setEnabled(false);
    setTimeout(() => setEnabled(true), 50);
  }

  const pct = total > 0 ? Math.round((indexed / total) * 100) : 0;
  const statusText = (() => {
    if (!enabled) return 'Disabled';
    if (!running && total === 0) return 'Index up to date';
    if (!modelReady && running && indexed === 0) return 'Downloading model…';
    if (running) return `Indexing ${indexed} of ${total}…`;
    return `Index up to date (${total} emails)`;
  })();

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <button
          onClick={() => setActivePage('mail')}
          className="mb-6 inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to Mail
        </button>

        <h1 className="text-2xl font-semibold">Settings</h1>

        {/* Display name */}
        <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-700 dark:bg-gray-900">
          <h2 className="text-base font-medium">Display name</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            This is the name others will see when receiving your emails (e.g., "Chase Wilson &lt;{userEmail}&gt;").
          </p>
          
          {displayNameError && (
            <p className="mt-3 text-sm text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
              {displayNameError}
            </p>
          )}
          
          {displayNameSuccess && (
            <p className="mt-3 text-sm text-green-600 bg-green-50 dark:bg-green-900/20 rounded-lg px-3 py-2">
              Display name saved successfully
            </p>
          )}
          
          <div className="mt-4 flex gap-2">
            <input
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="Your Name"
              className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm
                         bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleSaveDisplayName}
              disabled={displayNameSaving || !displayName.trim()}
              className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 
                         disabled:cursor-not-allowed text-white rounded-lg transition-colors"
            >
              {displayNameSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {/* Dark mode */}
        <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-medium">Dark mode</h2>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Use a darker color theme throughout the app.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={darkMode}
              onClick={() => setDarkMode(!darkMode)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${darkMode ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
            >
              <span className="sr-only">Toggle dark mode</span>
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${darkMode ? 'translate-x-5' : 'translate-x-1'}`} />
            </button>
          </div>
        </div>

        {/* Thread view */}
        <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-medium">Thread view</h2>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Group related messages into conversations. Messages in the same thread will appear as a single item in your inbox.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={threadViewEnabled}
              onClick={() => setThreadViewEnabled(!threadViewEnabled)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${threadViewEnabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
            >
              <span className="sr-only">Toggle thread view</span>
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${threadViewEnabled ? 'translate-x-5' : 'translate-x-1'}`} />
            </button>
          </div>
        </div>

        {/* Two-factor authentication */}
        <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-700 dark:bg-gray-900">
          <h2 className="text-base font-medium">Two-factor authentication</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Add an extra layer of security with a TOTP authenticator app (Google Authenticator, Authy, 1Password, etc.).
          </p>

          {mfaError && (
            <p className="mt-3 text-sm text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">{mfaError}</p>
          )}

          {/* Loading MFA status */}
          {mfaEnabled === null && (
            <p className="mt-3 text-sm text-gray-500">Checking status…</p>
          )}

          {/* 2FA already enabled */}
          {mfaEnabled === true && totpSetup.step === 'idle' && (
            <div className="mt-4">
              <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
                <svg className="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                Two-factor authentication is active.
              </div>

              {!disableConfirm ? (
                <button
                  onClick={() => setDisableConfirm(true)}
                  className="mt-3 text-sm text-red-600 hover:underline dark:text-red-400"
                >
                  Disable 2FA…
                </button>
              ) : (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20 p-3">
                  <p className="text-sm text-red-700 dark:text-red-300 mb-3">
                    Are you sure? You'll lose your extra login protection.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleDisable}
                      disabled={mfaLoading}
                      className="px-3 py-1.5 text-sm font-medium bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white rounded-lg transition-colors"
                    >
                      {mfaLoading ? 'Disabling…' : 'Yes, disable'}
                    </button>
                    <button
                      onClick={() => setDisableConfirm(false)}
                      className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-300"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 2FA not enabled — show enable button */}
          {mfaEnabled === false && totpSetup.step === 'idle' && (
            <button
              onClick={handleStartSetup}
              disabled={mfaLoading}
              className="mt-4 px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white rounded-lg transition-colors"
            >
              {mfaLoading ? 'Loading…' : 'Enable two-factor authentication'}
            </button>
          )}

          {/* Step 1: QR code */}
          {totpSetup.step === 'qr' && (
            <div className="mt-4 space-y-4">
              <p className="text-sm text-gray-700 dark:text-gray-300">
                Scan this QR code with your authenticator app, then enter the 6-digit code below.
              </p>
              <div className="flex justify-center">
                <img
                  src={totpSetup.qrDataUrl}
                  alt="TOTP QR code"
                  className="rounded-lg border border-gray-200 dark:border-gray-600"
                  width={200}
                  height={200}
                />
              </div>
              <details className="text-xs text-gray-500">
                <summary className="cursor-pointer hover:text-gray-700 dark:hover:text-gray-300">
                  Can't scan? Enter the key manually
                </summary>
                <code className="mt-1 block break-all rounded bg-gray-100 dark:bg-gray-800 px-2 py-1 font-mono">
                  {totpSetup.secretCode}
                </code>
              </details>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Verification code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={totpCode}
                  onChange={e => setTotpCode(e.target.value)}
                  placeholder="000000"
                  className="w-40 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm
                             text-center tracking-widest font-mono bg-white dark:bg-gray-800
                             focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleVerifyCode}
                  disabled={mfaLoading || totpCode.length < 6}
                  className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white rounded-lg transition-colors"
                >
                  {mfaLoading ? 'Verifying…' : 'Verify & enable'}
                </button>
                <button
                  onClick={() => { setTotpSetup({ step: 'idle' }); setTotpCode(''); setMfaError(''); }}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Step 2: Recovery codes */}
          {totpSetup.step === 'codes' && (
            <div className="mt-4 space-y-3">
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20 p-3">
                <svg className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                </svg>
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  <strong>Save these recovery codes now.</strong> They won't be shown again.
                  Use one if you lose access to your authenticator app.
                </p>
              </div>

              <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
                <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
                  {totpSetup.recoveryCodes.map((code, i) => (
                    <li key={i} className="text-gray-800 dark:text-gray-200">{code}</li>
                  ))}
                </ul>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleCopyCodes}
                  className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                >
                  {copiedCodes ? 'Copied!' : 'Copy all'}
                </button>
                <button
                  onClick={handleDoneWithCodes}
                  className="px-4 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Search index */}
        <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-medium">Search index</h2>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Build a full-text and semantic (AI) index for all your emails.
                The first time you enable this, the model (~23 MB) is downloaded
                and all emails are indexed. Subsequent devices download the
                pre-computed embeddings instead of recomputing them.
              </p>

              {enabled && (
                <div className="mt-3 space-y-1">
                  <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                    <span>{statusText}</span>
                    {total > 0 && <span>{pct}%</span>}
                  </div>
                  {total > 0 && (
                    <div className="h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-700">
                      <div
                        className="h-1.5 rounded-full bg-blue-600 transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  )}
                  {modelReady && !running && total > 0 && (
                    <button
                      onClick={handleReindex}
                      className="mt-2 text-xs text-blue-600 hover:underline dark:text-blue-400"
                    >
                      Re-index all emails
                    </button>
                  )}
                </div>
              )}
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled(!enabled)}
              className={`mt-0.5 relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
            >
              <span className="sr-only">Enable search index</span>
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-5' : 'translate-x-1'}`} />
            </button>
          </div>
        </div>

        {/* Email Archive Migration */}
        <div className="mt-4">
          <MboxMigration />
        </div>

        {/* Admin Panel link — only shown to admins */}
        {isAdmin && (
          <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={() => setActivePage('admin')}
              className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:underline"
            >
              Admin Panel →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
