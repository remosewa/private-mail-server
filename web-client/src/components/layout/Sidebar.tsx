import { useEffect, useRef, useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useUiStore } from '../../store/uiStore';
import { useAuthStore } from '../../store/authStore';
import { useFolderStore, validateFolderName } from '../../store/folderStore';
import { useLabelStore } from '../../store/labelStore';
import { useIndexStore } from '../../store/indexStore';
import { useSyncStore } from '../../store/syncStore';
import { useFilterStore } from '../../store/filterStore';
import { cancelFilterExecution } from '../../sync/filterExecutor';
import { deletePrivateKey } from '../../db/KeyStore';
import { SyncManager } from '../../sync/SyncManager';

const SYSTEM_FOLDERS = [
  { id: 'INBOX',   label: 'Inbox'   },
  { id: 'SENT',    label: 'Sent'    },
  { id: 'DRAFTS',  label: 'Drafts'  },
  { id: 'ARCHIVE', label: 'Archive' },
  { id: 'SPAM',    label: 'Spam'    },
  { id: 'TRASH',   label: 'Trash'   },
] as const;

const FOLDERS_COLLAPSE_THRESHOLD = 5;

export default function Sidebar() {
  const { selectedFolderId, selectFolder, openCompose, setActivePage, closeMobileSidebar } = useUiStore();
  const { userId, clearAuth, privateKey, publicKey } = useAuthStore();
  const {
    folders, loaded, loadFolders,
    createFolder, renameFolder, moveFolderUp, moveFolderDown,
  } = useFolderStore();
  const { loaded: labelsLoaded, loadLabels } = useLabelStore();
  const { total, indexed, running } = useIndexStore();
  const { syncing, synced, total: syncTotal } = useSyncStore();
  const filterProgress = useFilterStore(state => state.progress);

  // ── Folder creation state ────────────────────────────────────────────────
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState('');
  const createInputRef = useRef<HTMLInputElement>(null);

  // ── Folder rename state ───────────────────────────────────────────────────
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // ── Collapse state ───────────────────────────────────────────────────────
  const [foldersExpanded, setFoldersExpanded] = useState(false);

  const queryClient = useQueryClient();

  // Load custom folders once keys are available
  useEffect(() => {
    if (privateKey && !loaded) {
      void loadFolders(privateKey);
    }
  }, [privateKey, loaded, loadFolders]);

  // Load labels once keys are available
  useEffect(() => {
    if (privateKey && !labelsLoaded) {
      void loadLabels(privateKey);
    }
  }, [privateKey, labelsLoaded, loadLabels]);

  // Focus creation input when it appears
  useEffect(() => {
    if (creating) {
      setTimeout(() => createInputRef.current?.focus(), 0);
    }
  }, [creating]);

  // Focus rename input when it appears
  useEffect(() => {
    if (renamingId) {
      setTimeout(() => renameInputRef.current?.focus(), 0);
    }
  }, [renamingId]);

  async function handleSignOut() {
    if (userId) {
      await deletePrivateKey(userId).catch(() => {/* best-effort */ });
    }
    useFolderStore.getState().reset();
    SyncManager.reset();
    clearAuth();
  }

  // Get local unread count from database (more accurate for migrated emails)
  const { data: localUnreadCount } = useQuery({
    queryKey: ['localUnreadCount'],
    queryFn: async () => {
      if (!privateKey) return 0;
      const { getDb } = await import('../../db/Database');
      const db = await getDb();
      const count = await db.selectValue(
        "SELECT COUNT(*) FROM email_metadata WHERE folderId = 'INBOX' AND isRead = 0"
      );
      return (count as number) ?? 0;
    },
    enabled: !!privateKey,
  });

  // Unread counts for all non-inbox folders (queried locally)
  const { data: folderUnreadCounts } = useQuery({
    queryKey: ['folderUnreadCounts'],
    queryFn: async () => {
      const { getDb } = await import('../../db/Database');
      const db = await getDb();
      const rows = await db.selectObjects(
        "SELECT folderId, COUNT(*) as cnt FROM email_metadata WHERE isRead = 0 AND folderId != 'INBOX' GROUP BY folderId"
      ) as { folderId: string; cnt: number }[];
      const map: Record<string, number> = {};
      for (const row of rows) map[row.folderId] = row.cnt;
      return map;
    },
    enabled: !!privateKey,
    refetchInterval: 5000,
  });

  // Get migration folders (no longer needed - all folders come from folder store)
  const migrationFolders: { id: string; name: string; sortOrder: number }[] = [];

  // Merge custom folders and migration folders
  // For migration folders, use custom name from folders store if it exists
  const allFolders = [
    ...folders,
    ...migrationFolders.filter(mf => !folders.find(f => f.id === mf.id))
  ];

  useEffect(() => {
    const handler = () => {
      void queryClient.invalidateQueries({ queryKey: ['localUnreadCount'] });
      void queryClient.invalidateQueries({ queryKey: ['folderUnreadCounts'] });
    };
    window.addEventListener('inbox-refresh-requested', handler);
    return () => window.removeEventListener('inbox-refresh-requested', handler);
  }, [queryClient]);

  // Use local count (more accurate for migrated data)
  const unreadInbox = localUnreadCount ?? 0;

  // ── Create folder ────────────────────────────────────────────────────────

  function startCreating() {
    setCreating(true);
    setNewName('');
    setCreateError('');
  }

  function cancelCreating() {
    setCreating(false);
    setNewName('');
    setCreateError('');
  }

  async function submitCreate() {
    if (!publicKey) return;
    const trimmed = newName.trim();
    const validationErr = validateFolderName(trimmed, folders);
    if (validationErr) { setCreateError(validationErr); return; }

    const err = await createFolder(trimmed, publicKey);
    if (err) { setCreateError(err); return; }
    setCreating(false);
    setNewName('');
    setCreateError('');
  }

  // ── Rename folder ────────────────────────────────────────────────────────

  function startRenaming(id: string, currentName: string) {
    setRenamingId(id);
    setRenameValue(currentName);
    setRenameError('');
  }

  function cancelRenaming() {
    setRenamingId(null);
    setRenameValue('');
    setRenameError('');
  }

  const submitRename = useCallback(async (id: string) => {
    if (!publicKey) return;
    const err = await renameFolder(id, renameValue, publicKey);
    if (err) { setRenameError(err); return; }
    setRenamingId(null);
    setRenameValue('');
    setRenameError('');
  }, [publicKey, renameFolder, renameValue]);

  // ── Sorted & sliced custom folders ──────────────────────────────────────
  const sortedFolders = [...allFolders].sort((a, b) => a.sortOrder - b.sortOrder);
  const visibleFolders = foldersExpanded
    ? sortedFolders
    : sortedFolders.slice(0, FOLDERS_COLLAPSE_THRESHOLD);
  const hiddenCount = sortedFolders.length - FOLDERS_COLLAPSE_THRESHOLD;

  return (
    <aside className="w-56 shrink-0 flex flex-col border-r border-gray-200 bg-gray-50 h-full dark:border-gray-700 dark:bg-gray-900">
      <div className="p-4 flex items-center gap-2">
        <button
          onClick={() => openCompose()}
          className="flex-1 py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white text-sm
                     font-medium rounded-lg transition-colors"
        >
          Compose
        </button>
        {/* Close button — only shown on mobile */}
        <button
          onClick={closeMobileSidebar}
          aria-label="Close menu"
          className="md:hidden p-2 text-gray-500 hover:bg-gray-200 hover:text-gray-700 rounded-lg transition-colors
                     dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <nav className="flex-1 px-2 space-y-0.5 overflow-y-auto">
        {/* All mail — cross-folder view */}
        <button
          onClick={() => selectFolder('ALL')}
          className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center justify-between ${selectedFolderId === 'ALL'
            ? 'bg-blue-100 text-blue-700 font-medium dark:bg-blue-900/40 dark:text-blue-200'
            : 'text-gray-700 hover:bg-gray-200 dark:text-gray-200 dark:hover:bg-gray-800'
            }`}
        >
          <span>All</span>
          {(() => {
            const allUnread = Object.values(folderUnreadCounts ?? {}).reduce((s, n) => s + n, 0) + (localUnreadCount ?? 0);
            return allUnread > 0 ? (
              <span className="ml-auto text-xs font-semibold bg-blue-600 text-white rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center">
                {allUnread > 99 ? '99+' : allUnread}
              </span>
            ) : null;
          })()}
        </button>

        {/* INBOX row with [+] button */}
        <div className="flex items-center group/inbox">
          <button
            onClick={() => selectFolder('INBOX')}
            className={`flex-1 min-w-0 text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center justify-between ${selectedFolderId === 'INBOX'
              ? 'bg-blue-100 text-blue-700 font-medium dark:bg-blue-900/40 dark:text-blue-200'
              : 'text-gray-700 hover:bg-gray-200 dark:text-gray-200 dark:hover:bg-gray-800'
              }`}
          >
            <span>Inbox</span>
            {unreadInbox > 0 && (
              <span className="ml-auto text-xs font-semibold bg-blue-600 text-white rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center">
                {unreadInbox > 99 ? '99+' : unreadInbox}
              </span>
            )}
          </button>
          {/* Add folder button */}
          <button
            onClick={startCreating}
            title="New folder"
            className="shrink-0 p-1.5 ml-0.5 text-gray-400 hover:text-blue-600 hover:bg-gray-200
                       rounded-lg transition-colors opacity-0 group-hover/inbox:opacity-100
                       dark:text-gray-500 dark:hover:text-blue-400 dark:hover:bg-gray-800"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>

        {/* Custom folder list (indented) - includes migration folders */}
        {(sortedFolders.length > 0 || creating) && (
          <div className="pl-3 space-y-0.5">
            {visibleFolders.map((folder, idx) => (
              <div key={folder.id} className="group/folder flex items-center gap-0.5">
                {renamingId === folder.id ? (
                  /* Inline rename input */
                  <div className="flex-1 min-w-0 flex flex-col gap-1 py-1 pr-1">
                    <div className="flex items-center gap-1">
                      <input
                        ref={renameInputRef}
                        value={renameValue}
                        onChange={e => { setRenameValue(e.target.value); setRenameError(''); }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') void submitRename(folder.id);
                          if (e.key === 'Escape') cancelRenaming();
                        }}
                        className="flex-1 min-w-0 px-2 py-1 text-xs rounded border border-blue-400 bg-white
                                   dark:bg-gray-800 dark:border-blue-600 dark:text-gray-100 outline-none"
                        maxLength={64}
                      />
                      <button
                        onClick={() => void submitRename(folder.id)}
                        className="shrink-0 p-1 text-blue-600 hover:text-blue-700 dark:text-blue-400"
                        title="Save"
                      >
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </button>
                      <button
                        onClick={cancelRenaming}
                        className="shrink-0 p-1 text-gray-400 hover:text-gray-600 dark:text-gray-500"
                        title="Cancel"
                      >
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                    {renameError && <p className="text-xs text-red-500 dark:text-red-400 px-1">{renameError}</p>}
                  </div>
                ) : (
                  <>
                    {/* Folder button */}
                    <button
                      onClick={() => selectFolder(folder.id)}
                      className={`flex-1 min-w-0 text-left px-2 py-1.5 rounded-lg text-sm transition-colors flex items-center justify-between gap-1 ${selectedFolderId === folder.id
                        ? 'bg-blue-100 text-blue-700 font-medium dark:bg-blue-900/40 dark:text-blue-200'
                        : 'text-gray-700 hover:bg-gray-200 dark:text-gray-200 dark:hover:bg-gray-800'
                        }`}
                    >
                      <span className="truncate">{folder.name}</span>
                      {(folderUnreadCounts?.[folder.id] ?? 0) > 0 && (
                        <span className="shrink-0 text-xs font-semibold bg-gray-400 text-white rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center dark:bg-gray-600">
                          {(folderUnreadCounts![folder.id] ?? 0) > 99 ? '99+' : folderUnreadCounts![folder.id]}
                        </span>
                      )}
                    </button>

                    {/* Hover controls */}
                    <div className="shrink-0 flex items-center gap-0 opacity-0 group-hover/folder:opacity-100 transition-opacity">
                      {/* Move up */}
                      {idx > 0 && (
                        <button
                          onClick={() => { void moveFolderUp(folder.id); }}
                          title="Move up"
                          className="p-1 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                        >
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="18 15 12 9 6 15" />
                          </svg>
                        </button>
                      )}
                      {/* Move down */}
                      {idx < visibleFolders.length - 1 && (
                        <button
                          onClick={() => { void moveFolderDown(folder.id); }}
                          title="Move down"
                          className="p-1 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                        >
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>
                      )}
                      {/* Rename */}
                      <button
                        onClick={() => startRenaming(folder.id, folder.name)}
                        title="Rename"
                        className="p-1 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                      >
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}

            {/* Show more / fewer toggle */}
            {sortedFolders.length > FOLDERS_COLLAPSE_THRESHOLD && (
              <button
                onClick={() => setFoldersExpanded(e => !e)}
                className="w-full text-left px-2 py-1 text-xs text-gray-400 hover:text-gray-600
                           dark:text-gray-500 dark:hover:text-gray-300 transition-colors"
              >
                {foldersExpanded
                  ? 'Show fewer…'
                  : `${hiddenCount} more…`}
              </button>
            )}

            {/* New folder inline form */}
            {creating && (
              <div className="flex flex-col gap-1 py-1 pr-1">
                <div className="flex items-center gap-1">
                  <input
                    ref={createInputRef}
                    value={newName}
                    onChange={e => { setNewName(e.target.value); setCreateError(''); }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void submitCreate();
                      if (e.key === 'Escape') cancelCreating();
                    }}
                    placeholder="Folder name"
                    className="flex-1 min-w-0 px-2 py-1 text-xs rounded border border-blue-400 bg-white
                               dark:bg-gray-800 dark:border-blue-600 dark:text-gray-100 outline-none placeholder-gray-400"
                    maxLength={64}
                  />
                  <button
                    onClick={() => void submitCreate()}
                    className="shrink-0 p-1 text-blue-600 hover:text-blue-700 dark:text-blue-400"
                    title="Create"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </button>
                  <button
                    onClick={cancelCreating}
                    className="shrink-0 p-1 text-gray-400 hover:text-gray-600 dark:text-gray-500"
                    title="Cancel"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
                {createError && <p className="text-xs text-red-500 dark:text-red-400 px-1">{createError}</p>}
              </div>
            )}
          </div>
        )}

        {/* Remaining system folders */}
        {SYSTEM_FOLDERS.filter(f => f.id !== 'INBOX').map(({ id, label }) => (
          <button
            key={id}
            onClick={() => selectFolder(id)}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center justify-between ${selectedFolderId === id
              ? 'bg-blue-100 text-blue-700 font-medium dark:bg-blue-900/40 dark:text-blue-200'
              : 'text-gray-700 hover:bg-gray-200 dark:text-gray-200 dark:hover:bg-gray-800'
              }`}
          >
            <span>{label}</span>
            {(folderUnreadCounts?.[id] ?? 0) > 0 && (
              <span className="ml-auto text-xs font-semibold bg-gray-400 text-white rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center dark:bg-gray-600">
                {(folderUnreadCounts![id] ?? 0) > 99 ? '99+' : folderUnreadCounts![id]}
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* Sign out */}
      <div className="p-2 border-t border-gray-200 dark:border-gray-700">
        {/* Sync progress bar */}
        {syncing && synced > 0 && (
          <div className="mb-2 px-2 py-2 bg-green-50 dark:bg-green-900/20 rounded-lg">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-gray-600 dark:text-gray-300">Syncing emails</span>
              <span className="text-xs font-medium text-gray-700 dark:text-gray-200">
                {syncTotal > 0 ? `${synced}` : synced}
              </span>
            </div>
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5 overflow-hidden">
              {syncTotal > 0 ? (
                <div
                  className="bg-green-600 dark:bg-green-500 h-full transition-all duration-300 ease-out"
                  style={{ width: `${Math.min(100, (synced) * 100)}%` }}
                />
              ) : (
                <div className="bg-green-600 dark:bg-green-500 h-full animate-pulse" />
              )}
            </div>
          </div>
        )}

        {/* Indexing progress bar */}
        {running && total > 0 && (
          <div className="mb-2 px-2 py-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-gray-600 dark:text-gray-300">Indexing emails</span>
              <span className="text-xs font-medium text-gray-700 dark:text-gray-200">
                {indexed} / {total}
              </span>
            </div>
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-blue-600 dark:bg-blue-500 h-full transition-all duration-300 ease-out"
                style={{ width: `${Math.min(100, (indexed / total) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Filter progress bar */}
        {filterProgress && filterProgress.running && (
          <div className="mb-2 px-2 py-2 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-gray-600 dark:text-gray-300 truncate flex-1">
                Applying filter: {filterProgress.filterName}
              </span>
              <button
                onClick={() => {
                  cancelFilterExecution();
                  useFilterStore.getState().setProgress(null);
                }}
                className="ml-2 p-0.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                title="Cancel filter execution"
              >
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-gray-700 dark:text-gray-200">
                {filterProgress.processed} / {filterProgress.total}
              </span>
            </div>
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-purple-600 dark:bg-purple-500 h-full transition-all duration-300 ease-out"
                style={{ width: `${Math.min(100, (filterProgress.processed / filterProgress.total) * 100)}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={() => setActivePage('settings')}
            aria-label="Open settings"
            className="p-2 text-gray-500 hover:bg-gray-200 hover:text-gray-700 rounded-lg transition-colors dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09A1.65 1.65 0 0015 4.6a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9c.23.5.36 1.05.36 1.62s-.13 1.12-.36 1.62z" />
            </svg>
          </button>

          <button
            onClick={() => { void handleSignOut(); }}
            className="flex-1 flex items-center gap-2 px-3 py-2 text-sm text-gray-500 hover:bg-gray-200 hover:text-gray-700 rounded-lg transition-colors dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
          >
            <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
