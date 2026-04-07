import { useState, useRef, useEffect } from 'react';
import { useFolderStore } from '../../store/folderStore';
import { useUiStore } from '../../store/uiStore';
import { useQueryClient } from '@tanstack/react-query';
import { putEmailFlags } from '../../api/emails';
import { getDb } from '../../db/Database';

interface Props {
  emailUlid: string;
  /** Compact icon mode for action bar */
  compact?: boolean;
}

/**
 * MessageControls — provides message-specific controls for moving emails.
 * 
 * Supports two modes:
 * - compact: Small icon buttons for action bar (move folder + trash)
 * - full (default): Full-size buttons with labels
 */
export default function MessageControls({ emailUlid, compact = false }: Props) {
  const { folders } = useFolderStore();
  const { selectedFolderId } = useUiStore();
  const queryClient = useQueryClient();
  
  const [currentFolderId, setCurrentFolderId] = useState<string>('INBOX');
  const [currentIsRead, setCurrentIsRead] = useState<number>(0);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Load current folder and read status from database
  useEffect(() => {
    async function loadCurrentState() {
      try {
        const db = await getDb();
        const rows = await db.selectObjects(
          'SELECT folderId, isRead FROM email_metadata WHERE ulid = ?',
          [emailUlid]
        );
        
        if (rows.length > 0) {
          const folderId = rows[0]['folderId'] as string;
          const isRead = (rows[0]['isRead'] as number) || 0;
          setCurrentFolderId(folderId);
          setCurrentIsRead(isRead);
        }
      } catch (err) {
        console.error('Failed to load current state:', err);
      }
    }
    
    loadCurrentState();
  }, [emailUlid]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setError(null);
      }
    };
    
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  // Clear confirmation after 3 seconds
  useEffect(() => {
    if (!confirmation) return;
    
    const timer = setTimeout(() => {
      setConfirmation(null);
    }, 3000);
    
    return () => clearTimeout(timer);
  }, [confirmation]);

  const systemFolders = [
    { id: 'INBOX', name: 'Inbox' },
    { id: 'ARCHIVE', name: 'Archive' },
    { id: 'SPAM', name: 'Spam' },
    { id: 'TRASH', name: 'Trash' },
    { id: 'SENT', name: 'Sent' },
    { id: 'DRAFTS', name: 'Drafts' },
  ];

  const allFolders = [
    ...systemFolders,
    ...folders.map(f => ({ id: f.id, name: f.name })),
  ];

  async function handleMoveToFolder(folderId: string) {
    setLoading(true);
    setError(null);
    setConfirmation(null);
    
    const db = await getDb();
    let previousFolderId: string | null = null;
    
    try {
      // Read current state from database for optimistic locking
      const rows = await db.selectObjects(
        'SELECT folderId, version FROM email_metadata WHERE ulid = ?',
        [emailUlid]
      );
      previousFolderId = rows[0]?.['folderId'] as string || currentFolderId;
      const version = (rows[0]?.['version'] as number) || 1;
      
      // Optimistic update: Update local database immediately
      await db.exec(
        'UPDATE email_metadata SET folderId = ? WHERE ulid = ?',
        { bind: [folderId, emailUlid] }
      );
      
      // Update UI immediately for instant feedback
      setCurrentFolderId(folderId);
      const folderName = allFolders.find(f => f.id === folderId)?.name ?? folderId;
      setConfirmation(`Moving to ${folderName}...`);
      
      // Sync to server in background
      const response = await putEmailFlags(emailUlid, { folderId, version });
      
      // On success, update local lastUpdatedAt and version with server response
      await db.exec(
        'UPDATE email_metadata SET lastUpdatedAt = ?, version = ? WHERE ulid = ?',
        { bind: [response.lastUpdatedAt, response.version, emailUlid] }
      );
      
      setDropdownOpen(false);
      setConfirmation(`Moved to ${folderName}`);
      
      // Invalidate queries to refresh inbox/folder views
      queryClient.invalidateQueries({ queryKey: ['emails', selectedFolderId] });
      queryClient.invalidateQueries({ queryKey: ['emails', folderId] });
      queryClient.invalidateQueries({ queryKey: ['counts'] });
    } catch (err: any) {
      // Rollback: Restore previous folder on error
      if (previousFolderId !== null) {
        await db.exec(
          'UPDATE email_metadata SET folderId = ? WHERE ulid = ?',
          { bind: [previousFolderId, emailUlid] }
        );
        setCurrentFolderId(previousFolderId);
      }
      
      // Check if this is a 409 Conflict error (optimistic lock failure)
      if (err?.response?.status === 409) {
        setError('This email was modified by another device. Refreshing...');
        // Trigger a sync to refetch the latest version
        window.dispatchEvent(new Event('inbox-refresh-requested'));
      } else {
        setError(err instanceof Error ? err.message : 'Failed to move email');
      }
      
      setConfirmation(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleTrash() {
    setLoading(true);
    setError(null);
    setConfirmation(null);
    
    const db = await getDb();
    let previousFolderId: string | null = null;
    
    try {
      // Read current state from database for optimistic locking
      const rows = await db.selectObjects(
        'SELECT folderId, version FROM email_metadata WHERE ulid = ?',
        [emailUlid]
      );
      previousFolderId = rows[0]?.['folderId'] as string || currentFolderId;
      const version = (rows[0]?.['version'] as number) || 1;
      
      // Optimistic update: Update local database immediately
      await db.exec(
        'UPDATE email_metadata SET folderId = ? WHERE ulid = ?',
        { bind: ['TRASH', emailUlid] }
      );
      
      // Update UI immediately for instant feedback
      setCurrentFolderId('TRASH');
      setConfirmation('Moving to Trash...');
      
      // Sync to server in background
      const response = await putEmailFlags(emailUlid, { folderId: 'TRASH', version });
      
      // On success, update local lastUpdatedAt and version with server response
      await db.exec(
        'UPDATE email_metadata SET lastUpdatedAt = ?, version = ? WHERE ulid = ?',
        { bind: [response.lastUpdatedAt, response.version, emailUlid] }
      );
      
      setConfirmation('Moved to Trash');
      
      // Invalidate queries to refresh inbox/folder views
      queryClient.invalidateQueries({ queryKey: ['emails', selectedFolderId] });
      queryClient.invalidateQueries({ queryKey: ['emails', 'TRASH'] });
      queryClient.invalidateQueries({ queryKey: ['counts'] });
    } catch (err: any) {
      // Rollback: Restore previous folder on error
      if (previousFolderId !== null) {
        await db.exec(
          'UPDATE email_metadata SET folderId = ? WHERE ulid = ?',
          { bind: [previousFolderId, emailUlid] }
        );
        setCurrentFolderId(previousFolderId);
      }
      
      // Check if this is a 409 Conflict error (optimistic lock failure)
      if (err?.response?.status === 409) {
        setError('This email was modified by another device. Refreshing...');
        // Trigger a sync to refetch the latest version
        window.dispatchEvent(new Event('inbox-refresh-requested'));
      } else {
        setError(err instanceof Error ? err.message : 'Failed to move to trash');
      }
      
      setConfirmation(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleRead() {
    setLoading(true);
    setError(null);
    setConfirmation(null);
    
    const db = await getDb();
    let previousIsRead: number | null = null;
    
    try {
      // Read current state from database for optimistic locking
      const rows = await db.selectObjects(
        'SELECT isRead, version FROM email_metadata WHERE ulid = ?',
        [emailUlid]
      );
      previousIsRead = (rows[0]?.['isRead'] as number) ?? currentIsRead;
      const version = (rows[0]?.['version'] as number) || 1;
      
      // Toggle read status
      const newIsRead = previousIsRead === 1 ? 0 : 1;
      
      // Optimistic update: Update local database immediately
      await db.exec(
        'UPDATE email_metadata SET isRead = ? WHERE ulid = ?',
        { bind: [newIsRead, emailUlid] }
      );
      
      // Update UI immediately for instant feedback
      setCurrentIsRead(newIsRead);
      setConfirmation(newIsRead === 1 ? 'Marked as read' : 'Marked as unread');
      
      // Sync to server in background
      const response = await putEmailFlags(emailUlid, { read: newIsRead === 1, version });
      
      // On success, update local lastUpdatedAt and version with server response
      await db.exec(
        'UPDATE email_metadata SET lastUpdatedAt = ?, version = ? WHERE ulid = ?',
        { bind: [response.lastUpdatedAt, response.version, emailUlid] }
      );
      
      // Invalidate queries to refresh unread counts
      queryClient.invalidateQueries({ queryKey: ['folderUnreadCounts'] });
      queryClient.invalidateQueries({ queryKey: ['localUnreadCount'] });
    } catch (err: any) {
      // Rollback: Restore previous read status on error
      if (previousIsRead !== null) {
        await db.exec(
          'UPDATE email_metadata SET isRead = ? WHERE ulid = ?',
          { bind: [previousIsRead, emailUlid] }
        );
        setCurrentIsRead(previousIsRead);
      }
      
      // Check if this is a 409 Conflict error (optimistic lock failure)
      if (err?.response?.status === 409) {
        setError('This email was modified by another device. Refreshing...');
        // Trigger a sync to refetch the latest version
        window.dispatchEvent(new Event('inbox-refresh-requested'));
      } else {
        setError(err instanceof Error ? err.message : 'Failed to toggle read status');
      }
      
      setConfirmation(null);
    } finally {
      setLoading(false);
    }
  }

  // Compact mode: small icon buttons for action bar
  if (compact) {
    return (
      <>
        {/* Move to folder icon button */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(o => !o)}
            disabled={loading}
            aria-label="Move to folder"
            title="Move to folder"
            className="flex items-center justify-center w-8 h-8 rounded-lg
                       transition-colors
                       text-gray-600 bg-gray-100 hover:bg-gray-200
                       dark:text-gray-300 dark:bg-gray-800 dark:hover:bg-gray-700
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
            </svg>
          </button>

          {dropdownOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 min-w-[180px] bg-white dark:bg-gray-800
                            border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 overflow-hidden
                            max-h-[300px] overflow-y-auto">
              {error && (
                <div className="px-3 py-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800">
                  {error}
                </div>
              )}

              {systemFolders.map(folder => (
                <button
                  key={folder.id}
                  onClick={() => handleMoveToFolder(folder.id)}
                  disabled={loading || currentFolderId === folder.id}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700
                             disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2
                             text-gray-900 dark:text-gray-100"
                >
                  {currentFolderId === folder.id && (
                    <svg className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                  <span className={currentFolderId === folder.id ? '' : 'ml-6'}>{folder.name}</span>
                </button>
              ))}

              {folders.length > 0 && (
                <>
                  <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
                  {folders.map(folder => (
                    <button
                      key={folder.id}
                      onClick={() => handleMoveToFolder(folder.id)}
                      disabled={loading || currentFolderId === folder.id}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700
                                 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2
                                 text-gray-900 dark:text-gray-100"
                    >
                      {currentFolderId === folder.id && (
                        <svg className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                      <span className={currentFolderId === folder.id ? '' : 'ml-6'}>{folder.name}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {/* Read/Unread toggle icon button */}
        <button
          onClick={handleToggleRead}
          disabled={loading}
          aria-label={currentIsRead === 1 ? 'Mark as unread' : 'Mark as read'}
          title={currentIsRead === 1 ? 'Mark as unread' : 'Mark as read'}
          className="flex items-center justify-center w-8 h-8 rounded-lg
                     transition-colors
                     text-gray-600 bg-gray-100 hover:bg-gray-200
                     dark:text-gray-300 dark:bg-gray-800 dark:hover:bg-gray-700
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {currentIsRead === 1 ? (
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          ) : (
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </button>

        {/* Trash icon button */}
        {currentFolderId !== 'TRASH' && (
          <button
            onClick={handleTrash}
            disabled={loading}
            aria-label="Move to trash"
            title="Move to trash"
            className="flex items-center justify-center w-8 h-8 rounded-lg
                       transition-colors
                       text-red-600 bg-red-50 hover:bg-red-100
                       dark:text-red-400 dark:bg-red-900/20 dark:hover:bg-red-900/30
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            </svg>
          </button>
        )}

        {/* Confirmation toast (compact) */}
        {confirmation && (
          <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg shadow-lg
                          bg-green-50 text-green-700 border border-green-200
                          dark:bg-green-900/90 dark:text-green-100 dark:border-green-700">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {confirmation}
          </div>
        )}
      </>
    );
  }

  // Full mode: full-size buttons with labels
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {confirmation && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg
                        bg-green-50 text-green-700 border border-green-200
                        dark:bg-green-900/20 dark:text-green-400 dark:border-green-800">
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          {confirmation}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg
                        bg-red-50 text-red-700 border border-red-200
                        dark:bg-red-900/20 dark:text-red-400 dark:border-red-800">
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {error}
        </div>
      )}

      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setDropdownOpen(o => !o)}
          disabled={loading}
          aria-label="Move to folder"
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                     transition-colors border
                     text-gray-600 bg-gray-50 border-gray-300 hover:bg-gray-100
                     dark:text-gray-300 dark:bg-gray-800 dark:border-gray-600 dark:hover:bg-gray-700
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </svg>
          Move to folder
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {dropdownOpen && (
          <div className="absolute left-0 top-full mt-1 z-50 min-w-[180px] bg-white dark:bg-gray-800
                          border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 overflow-hidden
                          max-h-[300px] overflow-y-auto">
            {systemFolders.map(folder => (
              <button
                key={folder.id}
                onClick={() => handleMoveToFolder(folder.id)}
                disabled={loading || currentFolderId === folder.id}
                className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700
                           disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2
                           text-gray-900 dark:text-gray-100"
              >
                {currentFolderId === folder.id && (
                  <svg className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
                <span className={currentFolderId === folder.id ? '' : 'ml-6'}>{folder.name}</span>
              </button>
            ))}

            {folders.length > 0 && (
              <>
                <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
                {folders.map(folder => (
                  <button
                    key={folder.id}
                    onClick={() => handleMoveToFolder(folder.id)}
                    disabled={loading || currentFolderId === folder.id}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700
                               disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2
                               text-gray-900 dark:text-gray-100"
                  >
                    {currentFolderId === folder.id && (
                      <svg className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                    <span className={currentFolderId === folder.id ? '' : 'ml-6'}>{folder.name}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      <button
        onClick={handleToggleRead}
        disabled={loading}
        aria-label={currentIsRead === 1 ? 'Mark as unread' : 'Mark as read'}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                   transition-colors border
                   text-gray-600 bg-gray-50 border-gray-300 hover:bg-gray-100
                   dark:text-gray-300 dark:bg-gray-800 dark:border-gray-600 dark:hover:bg-gray-700
                   disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {currentIsRead === 1 ? (
          <>
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
            Mark as unread
          </>
        ) : (
          <>
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            Mark as read
          </>
        )}
      </button>

      {currentFolderId !== 'TRASH' && (
        <button
          onClick={handleTrash}
          disabled={loading}
          aria-label="Move to trash"
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                     transition-colors border
                     text-red-600 bg-red-50 border-red-300 hover:bg-red-100
                     dark:text-red-400 dark:bg-red-900/20 dark:border-red-800 dark:hover:bg-red-900/30
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
          </svg>
          Trash
        </button>
      )}
    </div>
  );
}
