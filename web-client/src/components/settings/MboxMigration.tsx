import { useState, useEffect, useRef } from 'react';
import { useAuthStore } from '../../store/authStore';
import { apiClient } from '../../api/client';
import { useSyncStore } from '../../store/syncStore';

interface MigrationStatus {
  state: 'idle' | 'uploading' | 'extracting' | 'running' | 'completed' | 'failed';
  totalFiles: number;
  processedFiles: number;
  totalMessages: number;
  processedMessages: number;
  errorCount: number;
  currentFile?: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
}

export default function MboxMigration() {
  const { accessToken } = useAuthStore();
  const { syncing } = useSyncStore();
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState('');
  const [migrationName, setMigrationName] = useState('');
  const [showNameInput, setShowNameInput] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollIntervalRef = useRef<number | null>(null);

  const handleForceResync = () => {
    // Trigger a page reload to start a full sync
    window.location.reload();
  };

  // Poll migration status
  useEffect(() => {
    if (!accessToken) return;
    
    const poll = async () => {
      try {
        const res = await apiClient.get<MigrationStatus>('/migration/status');
        setStatus(res.data);
        
        // Stop polling if migration is complete or failed
        if (res.data.state === 'completed' || res.data.state === 'failed') {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
        }
      } catch (err) {
        // 404 means no migration exists
        if ((err as any).response?.status === 404) {
          setStatus(null);
        }
      }
    };

    // Initial poll
    poll();

    // Start polling if migration is active
    if (status && ['uploading', 'extracting', 'running'].includes(status.state)) {
      pollIntervalRef.current = window.setInterval(poll, 5000);
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [accessToken, status?.state]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file size (max 5GB total, but warn about individual mbox file sizes)
    const maxSize = 5 * 1024 * 1024 * 1024;
    if (file.size > maxSize) {
      setError('File size exceeds 5GB limit. For very large archives, split into multiple smaller zip files.');
      return;
    }

    setError('');
    setSelectedFile(file);
    setShowNameInput(true);

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleStartMigration = async () => {
    if (!selectedFile || !migrationName.trim()) return;

    const trimmedName = migrationName.trim();
    
    // Validate migration name
    if (trimmedName.length > 20) {
      setError('Migration name must be 20 characters or less');
      return;
    }
    
    if (!/^[a-zA-Z0-9\s\-_]+$/.test(trimmedName)) {
      setError('Migration name can only contain letters, numbers, spaces, hyphens, and underscores');
      return;
    }

    setError('');
    setUploading(true);
    setUploadProgress(0);
    setShowNameInput(false);

    try {
      // Get presigned URL with migration name
      const urlRes = await apiClient.get<{ uploadUrl: string; migrationId: string }>(
        `/migration/upload-url?name=${encodeURIComponent(trimmedName)}`
      );
      const { uploadUrl } = urlRes.data;

      // Upload file to S3 using XMLHttpRequest for progress tracking
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();

        // Track upload progress
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const percentComplete = Math.round((e.loaded / e.total) * 100);
            setUploadProgress(percentComplete);
          }
        });

        // Handle completion
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed with status ${xhr.status}`));
          }
        });

        // Handle errors
        xhr.addEventListener('error', () => {
          reject(new Error('Upload failed'));
        });

        xhr.addEventListener('abort', () => {
          reject(new Error('Upload cancelled'));
        });

        // Start upload
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Content-Type', 'application/zip');
        xhr.send(selectedFile);
      });

      setUploading(false);
      setSelectedFile(null);
      setMigrationName('');
      
      // Start polling for status
      setStatus({ state: 'uploading', totalFiles: 0, processedFiles: 0, totalMessages: 0, processedMessages: 0, errorCount: 0 });
    } catch (err: any) {
      setError(err.message || 'Upload failed');
      setUploading(false);
      setUploadProgress(0);
      setShowNameInput(true);
    }
  };

  const handleCancelNameInput = () => {
    setShowNameInput(false);
    setSelectedFile(null);
    setMigrationName('');
    setError('');
  };

  const handleCancel = async () => {
    if (!accessToken) return;
    
    try {
      await apiClient.post('/migration/cancel');
      setStatus(null); // Clear status to allow new migration
    } catch (err: any) {
      setError(err.message || 'Failed to cancel migration');
    }
  };

  const handleComplete = async () => {
    if (!accessToken) return;
    
    try {
      await apiClient.post('/migration/complete');
      setStatus(null); // Clear status to allow new migration
    } catch (err: any) {
      setError(err.message || 'Failed to complete migration');
    }
  };

  const isActive = status && ['uploading', 'extracting', 'running'].includes(status.state);
  const progress = status && status.totalMessages > 0 
    ? Math.round((status.processedMessages / status.totalMessages) * 100)
    : 0;
  
  // Check if migration is actually complete (processed + errors = total)
  const isComplete = status && status.totalMessages > 0 && 
    (status.processedMessages + status.errorCount >= status.totalMessages);

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-700 dark:bg-gray-900">
      <h2 className="text-base font-medium">Email Archive Migration</h2>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        Import your email history from mbox archives or .eml files. Upload a zip file containing .mbox files or .eml files exported from your previous email client.
      </p>

      {error && (
        <div className="mt-3 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Upload interface */}
      {(!status || isComplete) && !uploading && !showNameInput && (
        <div className="mt-4">
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            onChange={handleFileSelect}
            className="hidden"
          />
          {(!status || isComplete) && <button
            onClick={() => fileInputRef.current?.click()}
            className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
          >
            Upload Archive
          </button>
          }
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Maximum file size: 5GB. Supports .mbox files and .eml files (batched in groups of 100).
            Files are automatically deleted after processing.
          </p>
        </div>
      )}

      {/* Migration name input */}
      {showNameInput && selectedFile && (
        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor="migration-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Migration Name
            </label>
            <input
              id="migration-name"
              type="text"
              value={migrationName}
              onChange={(e) => setMigrationName(e.target.value)}
              placeholder="e.g., Gmail 2024"
              maxLength={20}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg
                         bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                         focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Give this migration a name (max 20 characters). This will be added as a label to all imported emails.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleStartMigration}
              disabled={!migrationName.trim()}
              className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
            >
              Start Migration
            </button>
            <button
              onClick={handleCancelNameInput}
              className="px-4 py-2 text-sm font-medium bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Upload progress */}
      {uploading && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-700 dark:text-gray-300">Uploading...</span>
            <span className="text-gray-500">{uploadProgress}%</span>
          </div>
          <div className="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700">
            <div
              className="h-2 rounded-full bg-blue-600 transition-all"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* Migration status */}
      {status && !isComplete && (
        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Status: {status.state}
            </span>
            {isActive && (
              <button
                onClick={handleCancel}
                className="text-sm text-red-600 hover:underline dark:text-red-400"
              >
                Cancel
              </button>
            )}
          </div>

          {status.state === 'running' && (
            <>
              <div className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-700 dark:text-gray-300">
                    Processing {status.processedMessages} of {status.totalMessages} messages
                  </span>
                  <span className="text-gray-500">{progress}%</span>
                </div>
                <div className="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700">
                  <div
                    className="h-2 rounded-full bg-blue-600 transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>

              <div className="text-xs text-gray-500 dark:text-gray-400">
                <div>Files: {status.processedFiles} of {status.totalFiles}</div>
                {status.currentFile && <div>Current: {status.currentFile}</div>}
                {status.errorCount > 0 && (
                  <div className="text-amber-600 dark:text-amber-400">
                    Errors: {status.errorCount}
                  </div>
                )}
              </div>
            </>
          )}

          {status.state === 'completed' && (
            <div className="rounded-lg bg-green-50 dark:bg-green-900/20 px-3 py-2 text-sm text-green-700 dark:text-green-300">
              Migration completed! Imported {status.processedMessages} messages
              {status.errorCount > 0 && ` with ${status.errorCount} errors`}.
            </div>
          )}

          {status.state === 'failed' && (
            <div className="space-y-3">
              <div className="rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                Migration failed: {status.errorMessage || 'Unknown error'}
              </div>
              <button
                onClick={handleComplete}
                className="w-full px-4 py-2 text-sm font-medium bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
              >
                Clear & Try Again
              </button>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                This will delete the failed migration record and any uploaded files so you can start a new migration.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Completed migration summary */}
      {isComplete && (
        <div className="mt-4 rounded-lg bg-green-50 dark:bg-green-900/20 px-4 py-3 space-y-3">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-green-600 dark:text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <span className="text-sm font-semibold text-green-700 dark:text-green-300">
              Migration Completed
            </span>
          </div>
          <div className="text-sm text-green-700 dark:text-green-300">
            Successfully imported {status.processedMessages} of {status.totalMessages} messages.
            It may take up to 2 minutes for emails to start showing in your inbox.
            {status.errorCount > 0 && (
              <span className="text-amber-600 dark:text-amber-400">
                {' '}({status.errorCount} errors)
              </span>
            )}
          </div>
          <div className="text-xs text-green-600 dark:text-green-400">
            Files processed: {status.processedFiles} of {status.totalFiles}
          </div>
          <button
            onClick={handleComplete}
            className="w-full px-4 py-2 text-sm font-medium bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors"
          >
            Complete Migration
          </button>
          <p className="text-xs text-green-600 dark:text-green-400">
            Click "Complete Migration" to permanently delete the migration record and free up space.
          </p>
        </div>
      )}

      {/* User guidance */}
      <details className="mt-4 text-xs text-gray-600 dark:text-gray-400">
        <summary className="cursor-pointer font-medium hover:text-gray-900 dark:hover:text-gray-200">
          How to export mbox files from your email provider
        </summary>
        <div className="mt-3 space-y-4">
          {/* Gmail */}
          <div className="border-l-2 border-blue-500 pl-3">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">Gmail</h3>
            <ol className="mt-1 space-y-1 list-decimal list-inside text-gray-700 dark:text-gray-300">
              <li>Go to <a href="https://takeout.google.com" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">Google Takeout</a></li>
              <li>Deselect all, then check <span className="font-medium">Mail</span> only</li>
              <li>Choose export format — mail exports as <code className="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs">.mbox</code> automatically</li>
              <li>Click <span className="font-medium">Next step</span> → <span className="font-medium">Create export</span></li>
              <li>You'll get an email with a download link (can take minutes to hours depending on mailbox size)</li>
            </ol>
          </div>

          {/* Yahoo Mail */}
          <div className="border-l-2 border-purple-500 pl-3">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">Yahoo Mail</h3>
            <p className="mt-1 text-gray-700 dark:text-gray-300">Yahoo doesn't provide a direct mbox export. Use Thunderbird:</p>
            <ol className="mt-1 space-y-1 list-decimal list-inside text-gray-700 dark:text-gray-300">
              <li>Install <a href="https://www.thunderbird.net/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">Thunderbird</a> (free email client)</li>
              <li>Add your Yahoo account via IMAP (Thunderbird will guide you through setup)</li>
              <li>Let Thunderbird sync all your emails (may take a while for large mailboxes)</li>
              <li>Install the <a href="https://addons.thunderbird.net/en-US/thunderbird/addon/importexporttools-ng/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">ImportExportTools NG</a> add-on</li>
              <li>Right-click your Yahoo account folder → <span className="font-medium">ImportExportTools NG → Export folder → mbox format</span></li>
              <li>Zip the exported <code className="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs">.mbox</code> file and upload it here</li>
            </ol>
          </div>

          {/* Apple Mail */}
          <div className="border-l-2 border-gray-500 pl-3">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">Apple Mail (iCloud)</h3>
            <ol className="mt-1 space-y-1 list-decimal list-inside text-gray-700 dark:text-gray-300">
              <li>Open the <span className="font-medium">Mail</span> app on Mac</li>
              <li>Select the mailbox you want → <span className="font-medium">Mailbox → Export Mailbox</span></li>
              <li>Choose a save location — exports as <code className="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs">.mbox</code> directly</li>
            </ol>
          </div>

          {/* Outlook / Hotmail */}
          <div className="border-l-2 border-blue-600 pl-3">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">Outlook / Hotmail</h3>
            <p className="mt-1 text-gray-700 dark:text-gray-300">Outlook doesn't natively export <code className="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs">.mbox</code>. Options:</p>
            <ol className="mt-1 space-y-1 list-decimal list-inside text-gray-700 dark:text-gray-300">
              <li>Use <span className="font-medium">Thunderbird</span> — add your Outlook account via IMAP, let it sync, then right-click the mailbox → <span className="font-medium">Export</span></li>
              <li>Or use <a href="https://www.mailstore.com/en/products/mailstore-home/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">MailStore Home</a> (free), which can export Outlook to <code className="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs">.mbox</code></li>
            </ol>
          </div>

          {/* Thunderbird */}
          <div className="border-l-2 border-orange-500 pl-3">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">Thunderbird (any account)</h3>
            <ol className="mt-1 space-y-1 list-decimal list-inside text-gray-700 dark:text-gray-300">
              <li>Install the <a href="https://addons.thunderbird.net/en-US/thunderbird/addon/importexporttools-ng/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">ImportExportTools NG</a> add-on</li>
              <li>Right-click any folder → <span className="font-medium">ImportExportTools NG → Export folder → mbox format</span></li>
            </ol>
          </div>

          {/* Fastmail */}
          <div className="border-l-2 border-green-500 pl-3">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">Fastmail</h3>
            <ol className="mt-1 space-y-1 list-decimal list-inside text-gray-700 dark:text-gray-300">
              <li>Go to <span className="font-medium">Settings → Privacy &amp; Security → Export Data</span></li>
              <li>Select <span className="font-medium">Email</span> and choose folders</li>
              <li>Downloads as <code className="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs">.mbox</code></li>
            </ol>
          </div>
        </div>
      </details>

      {/* Force Re-sync */}
      <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Force Re-sync</h3>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Re-download all emails from the server, starting from the beginning. 
          Useful after a migration or if you suspect missing emails or want to refresh your local database.
        </p>
        <button
          onClick={handleForceResync}
          disabled={syncing}
          className="mt-2 px-3 py-1.5 text-sm font-medium bg-amber-600 hover:bg-amber-700 disabled:bg-amber-300 text-white rounded-lg transition-colors"
        >
          {syncing ? 'Sync in progress...' : 'Force Re-sync All Emails'}
        </button>
      </div>
    </div>
  );
}
