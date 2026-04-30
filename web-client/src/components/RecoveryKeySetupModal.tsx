import { useRef, useState } from 'react';
import {
  generateRecoveryKey,
  deriveWrappingKeyFromRecoveryKey,
  recoveryKeyToCognitoPassword,
  deriveWrappingKey,
  unwrapPrivateKey,
  wrapPrivateKey,
} from '../crypto/KeyManager';
import { getKeyBundle, storeRecoveryKey } from '../api/auth';

export default function RecoveryKeySetupModal({ onClose, onSuccess }: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [step, setStep] = useState<'intro' | 'key'>('intro');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const passwordRef = useRef<HTMLInputElement>(null);

  async function handleGenerate() {
    const password = passwordRef.current?.value ?? '';
    if (!password) { setError('Password is required.'); return; }

    setLoading(true);
    setError('');
    try {
      // Re-derive private key from the server bundle + password so we get an
      // extractable CryptoKey regardless of how the in-memory key was imported.
      const bundle = await getKeyBundle();
      const salt = Uint8Array.from(atob(bundle.argon2Salt), c => c.charCodeAt(0));
      const wrappingKey = await deriveWrappingKey(password, salt);
      const privateKey = await unwrapPrivateKey(bundle.encryptedPrivateKey, wrappingKey);

      const key = generateRecoveryKey();
      const recoveryWrappingKey = await deriveWrappingKeyFromRecoveryKey(key);
      const cognitoRecoveryPassword = recoveryKeyToCognitoPassword(key);
      const recoveryEncryptedPrivateKey = await wrapPrivateKey(privateKey, recoveryWrappingKey);
      await storeRecoveryKey(recoveryEncryptedPrivateKey, cognitoRecoveryPassword);
      setRecoveryKey(key);
      setStep('key');
    } catch (err: unknown) {
      console.error('[RecoveryKeySetupModal] handleGenerate failed:', err);
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 409) {
        setError('A recovery key is already set for this account.');
      } else {
        // DOMException (wrong password) shows as an unhelpful message — give a clear hint
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg.toLowerCase().includes('operation') ? 'Incorrect password.' : msg);
      }
    } finally {
      setLoading(false);
    }
  }

  function handleCopy() {
    void navigator.clipboard.writeText(recoveryKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleDownload() {
    const blob = new Blob(
      [`Chase Email Recovery Key\n\n${recoveryKey}\n\nStore this somewhere safe. It cannot be shown again.\n`],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chase-email-recovery-key.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl border border-gray-200
                      dark:border-gray-700 w-full max-w-xl p-8">

        {step === 'intro' ? (
          <>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
              Set up a recovery key
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-5">
              A recovery key lets you regain access to your encrypted mail if you ever
              forget your password. Enter your current password to confirm.
            </p>

            <div className="mb-5">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Current password
              </label>
              <input
                ref={passwordRef}
                type="password"
                autoFocus
                autoComplete="current-password"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg
                           text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                           focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                onKeyDown={e => { if (e.key === 'Enter') void handleGenerate(); }}
              />
            </div>

            {error && (
              <p className="mb-4 text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 py-2 px-4 border border-gray-300 dark:border-gray-600
                           text-gray-700 dark:text-gray-300 text-sm font-medium rounded-lg
                           hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                Not now
              </button>
              <button
                onClick={handleGenerate}
                disabled={loading}
                className="flex-1 py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300
                           text-white text-sm font-medium rounded-lg transition-colors"
              >
                {loading ? 'Generating…' : 'Generate key'}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
              Save your recovery key
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Store this somewhere safe. It <strong>cannot be shown again</strong>.
            </p>

            <div className="bg-gray-100 dark:bg-gray-800 rounded-lg px-4 py-3 font-mono
                            text-sm tracking-widest text-gray-800 dark:text-gray-200
                            text-center select-all mb-3 break-all">
              {recoveryKey}
            </div>

            <div className="flex gap-2 mb-6">
              <button
                onClick={handleDownload}
                className="flex-1 py-2 px-3 border border-gray-300 dark:border-gray-600
                           rounded-lg text-sm text-gray-700 dark:text-gray-300
                           hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                Download .txt
              </button>
              <button
                onClick={handleCopy}
                className="flex-1 py-2 px-3 border border-gray-300 dark:border-gray-600
                           rounded-lg text-sm text-gray-700 dark:text-gray-300
                           hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>

            <label className="flex items-start gap-3 text-sm text-gray-600 dark:text-gray-400
                               mb-5 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600"
                checked={confirmed}
                onChange={e => setConfirmed(e.target.checked)}
              />
              I have saved my recovery key in a safe place
            </label>

            <button
              onClick={onSuccess}
              disabled={!confirmed}
              className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300
                         text-white text-sm font-medium rounded-lg transition-colors"
            >
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}
