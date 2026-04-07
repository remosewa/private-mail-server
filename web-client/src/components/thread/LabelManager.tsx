import { useState, useRef, useEffect } from 'react';
import { useLabelStore } from '../../store/labelStore';
import { useAuthStore } from '../../store/authStore';
import { useUiStore } from '../../store/uiStore';
import { useQueryClient } from '@tanstack/react-query';
import { putEmailFlags } from '../../api/emails';
import { getDb } from '../../db/Database';
import LabelTag from '../inbox/LabelTag';

interface DeleteConfirmation {
  labelId: string;
  labelName: string;
}

interface Props {
  emailUlid: string;
  /** Display only assigned labels without controls */
  displayOnly?: boolean;
  /** Compact icon mode for action bar */
  compact?: boolean;
}

/**
 * LabelManager — manages labels for an individual email.
 * 
 * Supports three modes:
 * - displayOnly: Shows assigned labels as tags (no controls)
 * - compact: Small icon button for action bar with dropdown
 * - full (default): Inline label management with add button
 */
export default function LabelManager({ emailUlid, displayOnly = false, compact = false }: Props) {
  const { labels, assignLabel, removeLabel, createLabel, deleteLabel, updateLabel } = useLabelStore();
  const { publicKey } = useAuthStore();
  const { selectedFolderId } = useUiStore();
  const queryClient = useQueryClient();

  const [assignedLabelIds, setAssignedLabelIds] = useState<string[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');
  const [newLabelColor, setNewLabelColor] = useState('#3b82f6');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmation | null>(null);
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [editLabelName, setEditLabelName] = useState('');
  const [editLabelColor, setEditLabelColor] = useState('#3b82f6');
  const [editError, setEditError] = useState<string | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);

  // Load assigned labels from database
  // Reload whenever emailUlid changes or when we're in displayOnly mode and labels might have changed
  useEffect(() => {
    async function loadAssignedLabels() {
      try {
        const db = await getDb();
        const rows = await db.selectObjects(
          'SELECT labelIds FROM email_metadata WHERE ulid = ?',
          [emailUlid]
        );

        if (rows.length > 0) {
          const labelIdsJson = rows[0]['labelIds'] as string;
          const labelIds: string[] = JSON.parse(labelIdsJson);
          setAssignedLabelIds(labelIds);
        }
      } catch (err) {
        console.error('Failed to load assigned labels:', err);
      }
    }

    loadAssignedLabels();

    // In displayOnly mode, poll for changes every second to catch updates from compact mode
    if (displayOnly) {
      const interval = setInterval(loadAssignedLabels, 1000);
      return () => clearInterval(interval);
    }
  }, [emailUlid, labels, displayOnly]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;

    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setCreatingNew(false);
        setError(null);
      }
    };

    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  const assignedLabels = labels.filter(label => assignedLabelIds.includes(label.id));
  const unassignedLabels = labels.filter(label => !assignedLabelIds.includes(label.id));

  async function handleAssignLabel(labelId: string) {
    if (!publicKey) return;

    setLoading(true);
    setError(null);

    let previousLabelIds: string[] = [];

    try {
      // Read current state from database for optimistic locking
      const db = await getDb();
      const rows = await db.selectObjects(
        'SELECT labelIds, version FROM email_metadata WHERE ulid = ?',
        [emailUlid]
      );
      const labelIdsJson = rows[0]?.['labelIds'] as string || '[]';
      previousLabelIds = JSON.parse(labelIdsJson) as string[];
      const version = (rows[0]?.['version'] as number) || 1;

      // Optimistic update: Update local state and database immediately
      const newLabelIds = [...previousLabelIds, labelId];
      setAssignedLabelIds(newLabelIds);
      await assignLabel(emailUlid, labelId);

      // Sync to server in background
      const response = await putEmailFlags(emailUlid, { labelIds: newLabelIds, version });

      // On success, update local lastUpdatedAt and version with server response
      await db.exec(
        'UPDATE email_metadata SET lastUpdatedAt = ?, version = ? WHERE ulid = ?',
        { bind: [response.lastUpdatedAt, response.version, emailUlid] }
      );

      // Invalidate queries to refresh inbox view
      queryClient.invalidateQueries({ queryKey: ['emails', selectedFolderId] });

      setDropdownOpen(false);
    } catch (err: any) {
      // Rollback: Restore previous label state on error
      setAssignedLabelIds(previousLabelIds);
      // Rollback database change
      const db = await getDb();
      await db.exec(
        'UPDATE email_metadata SET labelIds = ? WHERE ulid = ?',
        { bind: [JSON.stringify(previousLabelIds), emailUlid] }
      );

      // Check if this is a 409 Conflict error (optimistic lock failure)
      if (err?.response?.status === 409) {
        setError('This email was modified by another device. Refreshing...');
        // Trigger a sync to refetch the latest version
        window.dispatchEvent(new Event('inbox-refresh-requested'));
      } else {
        setError(err instanceof Error ? err.message : 'Failed to assign label');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleRemoveLabel(labelId: string) {
    if (!publicKey) return;

    setLoading(true);
    setError(null);

    let previousLabelIds: string[] = [];

    try {
      // Read current state from database for optimistic locking
      const db = await getDb();
      const rows = await db.selectObjects(
        'SELECT labelIds, version FROM email_metadata WHERE ulid = ?',
        [emailUlid]
      );
      const labelIdsJson = rows[0]?.['labelIds'] as string || '[]';
      previousLabelIds = JSON.parse(labelIdsJson) as string[];
      const version = (rows[0]?.['version'] as number) || 1;

      // Optimistic update: Update local state and database immediately
      const newLabelIds = previousLabelIds.filter(id => id !== labelId);
      setAssignedLabelIds(newLabelIds);
      await removeLabel(emailUlid, labelId);

      // Sync to server in background
      const response = await putEmailFlags(emailUlid, { labelIds: newLabelIds, version });

      // On success, update local lastUpdatedAt and version with server response
      await db.exec(
        'UPDATE email_metadata SET lastUpdatedAt = ?, version = ? WHERE ulid = ?',
        { bind: [response.lastUpdatedAt, response.version, emailUlid] }
      );

      // Invalidate queries to refresh inbox view
      queryClient.invalidateQueries({ queryKey: ['emails', selectedFolderId] });
    } catch (err: any) {
      // Rollback: Restore previous label state on error
      setAssignedLabelIds(previousLabelIds);
      // Rollback database change
      const db = await getDb();
      await db.exec(
        'UPDATE email_metadata SET labelIds = ? WHERE ulid = ?',
        { bind: [JSON.stringify(previousLabelIds), emailUlid] }
      );

      // Check if this is a 409 Conflict error (optimistic lock failure)
      if (err?.response?.status === 409) {
        setError('This email was modified by another device. Refreshing...');
        // Trigger a sync to refetch the latest version
        window.dispatchEvent(new Event('inbox-refresh-requested'));
      } else {
        setError(err instanceof Error ? err.message : 'Failed to remove label');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateLabel() {
    if (!publicKey || !newLabelName.trim()) return;

    setLoading(true);
    setError(null);

    let previousLabelIds: string[] = [];

    try {
      const labelName = newLabelName.trim();
      await createLabel(labelName, newLabelColor, publicKey);

      const newLabel = useLabelStore.getState().labels.find(l => l.name === labelName);
      if (newLabel) {
        // Read current state from database for optimistic locking
        const db = await getDb();
        const rows = await db.selectObjects(
          'SELECT labelIds, version FROM email_metadata WHERE ulid = ?',
          [emailUlid]
        );
        const labelIdsJson = rows[0]?.['labelIds'] as string || '[]';
        previousLabelIds = JSON.parse(labelIdsJson) as string[];
        const version = (rows[0]?.['version'] as number) || 1;

        // Optimistic update: Update local state and database immediately
        const newLabelIds = [...previousLabelIds, newLabel.id];
        setAssignedLabelIds(newLabelIds);
        await assignLabel(emailUlid, newLabel.id);

        // Sync to server in background
        const response = await putEmailFlags(emailUlid, { labelIds: newLabelIds, version });

        // On success, update local lastUpdatedAt and version with server response
        await db.exec(
          'UPDATE email_metadata SET lastUpdatedAt = ?, version = ? WHERE ulid = ?',
          { bind: [response.lastUpdatedAt, response.version, emailUlid] }
        );

        // Invalidate queries to refresh inbox view
        queryClient.invalidateQueries({ queryKey: ['emails', selectedFolderId] });
      }

      setNewLabelName('');
      setNewLabelColor('#3b82f6');
      setCreatingNew(false);
      setDropdownOpen(false);
    } catch (err: any) {
      // Rollback: Restore previous label state on error
      setAssignedLabelIds(previousLabelIds);
      // Rollback database change
      const db = await getDb();
      await db.exec(
        'UPDATE email_metadata SET labelIds = ? WHERE ulid = ?',
        { bind: [JSON.stringify(previousLabelIds), emailUlid] }
      );

      // Check if this is a 409 Conflict error (optimistic lock failure)
      if (err?.response?.status === 409) {
        setError('This email was modified by another device. Refreshing...');
        // Trigger a sync to refetch the latest version
        window.dispatchEvent(new Event('inbox-refresh-requested'));
      } else {
        setError(err instanceof Error ? err.message : 'Failed to create label');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteLabel(labelId: string) {
    if (!publicKey) return;

    setLoading(true);
    setError(null);

    try {
      // Delete the label (this also removes it from all emails)
      await deleteLabel(labelId);

      // Update local state to remove the label from this email
      setAssignedLabelIds(prev => prev.filter(id => id !== labelId));

      // Invalidate queries to refresh all views
      queryClient.invalidateQueries({ queryKey: ['emails'] });

      setDeleteConfirm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete label');
    } finally {
      setLoading(false);
    }
  }

  function startEditingLabel(labelId: string, currentName: string, currentColor?: string) {
    setEditingLabelId(labelId);
    setEditLabelName(currentName);
    setEditLabelColor(currentColor || '#3b82f6');
    setEditError(null);
  }

  function cancelEditingLabel() {
    setEditingLabelId(null);
    setEditLabelName('');
    setEditLabelColor('#3b82f6');
    setEditError(null);
  }

  async function submitEditLabel(labelId: string) {
    if (!publicKey) return;

    setLoading(true);
    setEditError(null);

    try {
      // Update the label (works for all labels now with individual records)
      await updateLabel(labelId, editLabelName, editLabelColor, publicKey);

      setEditingLabelId(null);
      setEditLabelName('');
      setEditLabelColor('#3b82f6');
      
      // Invalidate queries to refresh views
      queryClient.invalidateQueries({ queryKey: ['emails'] });
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update label');
    } finally {
      setLoading(false);
    }
  }

  // Display-only mode: just show assigned labels
  if (displayOnly) {
    return (
      <>
        <div className="flex items-center gap-2 flex-wrap">
          {assignedLabels.map(label => (
            <div key={label.id} className="group/label flex items-center gap-1">
              {editingLabelId === label.id ? (
                /* Inline edit input */
                <div className="flex items-center gap-1">
                  <input
                    type="color"
                    value={editLabelColor}
                    onChange={(e) => setEditLabelColor(e.target.value)}
                    className="w-6 h-6 rounded cursor-pointer border-0"
                    title="Label color"
                  />
                  <input
                    value={editLabelName}
                    onChange={(e) => { setEditLabelName(e.target.value); setEditError(null); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submitEditLabel(label.id);
                      if (e.key === 'Escape') cancelEditingLabel();
                    }}
                    className="px-2 py-0.5 text-xs rounded border border-blue-400 bg-white
                               dark:bg-gray-800 dark:border-blue-600 dark:text-gray-100 outline-none"
                    maxLength={20}
                    autoFocus
                  />
                  <button
                    onClick={() => void submitEditLabel(label.id)}
                    disabled={loading}
                    className="p-0.5 text-blue-600 hover:text-blue-700 dark:text-blue-400"
                    title="Save"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </button>
                  <button
                    onClick={cancelEditingLabel}
                    className="p-0.5 text-gray-400 hover:text-gray-600 dark:text-gray-500"
                    title="Cancel"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => startEditingLabel(label.id, label.name, label.color)}
                  className="cursor-pointer"
                >
                  <LabelTag label={label} />
                </button>
              )}
            </div>
          ))}
          {assignedLabels.length === 0 && (
            <span className="text-xs text-gray-400 dark:text-gray-500">No labels</span>
          )}
        </div>
        {editError && <p className="text-xs text-red-500 dark:text-red-400 mt-1">{editError}</p>}

        {/* Delete confirmation modal */}
        {deleteConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setDeleteConfirm(null)}>
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-sm mx-4" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">Delete Label?</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                Are you sure you want to delete <strong>{deleteConfirm.labelName}</strong>? This will remove it from all emails.
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setDeleteConfirm(null)}
                  disabled={loading}
                  className="px-4 py-2 text-sm font-medium rounded-lg
                             text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700
                             hover:bg-gray-200 dark:hover:bg-gray-600
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDeleteLabel(deleteConfirm.labelId)}
                  disabled={loading}
                  className="px-4 py-2 text-sm font-medium rounded-lg
                             text-white bg-red-600 hover:bg-red-700
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // Compact mode: small icon button for action bar
  if (compact) {
    return (
      <>
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(o => !o)}
            disabled={loading}
            aria-label="Manage labels"
            title="Manage labels"
            className="flex items-center justify-center w-8 h-8 rounded-lg
                       transition-colors
                       text-gray-600 bg-gray-100 hover:bg-gray-200
                       dark:text-gray-300 dark:bg-gray-800 dark:hover:bg-gray-700
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
              <line x1="7" y1="7" x2="7.01" y2="7" />
            </svg>
          </button>

          {dropdownOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 min-w-[200px] bg-white dark:bg-gray-800
                            border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 overflow-hidden">
              {error && (
                <div className="px-3 py-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800">
                  {error}
                </div>
              )}

              {assignedLabels.length > 0 && (
                <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
                  <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">Assigned</div>
                  <div className="flex flex-wrap gap-1">
                    {assignedLabels.map(label => (
                      <div key={label.id} className="flex items-center gap-1 group">
                        {editingLabelId === label.id ? (
                          /* Inline edit input */
                          <div className="flex items-center gap-1">
                            <input
                              type="color"
                              value={editLabelColor}
                              onChange={(e) => setEditLabelColor(e.target.value)}
                              className="w-6 h-6 rounded cursor-pointer border-0"
                              title="Label color"
                            />
                            <input
                              value={editLabelName}
                              onChange={(e) => { setEditLabelName(e.target.value); setEditError(null); }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void submitEditLabel(label.id);
                                if (e.key === 'Escape') cancelEditingLabel();
                              }}
                              className="px-2 py-0.5 text-xs rounded border border-blue-400 bg-white
                                         dark:bg-gray-800 dark:border-blue-600 dark:text-gray-100 outline-none"
                              maxLength={20}
                              autoFocus
                            />
                            <button
                              onClick={() => void submitEditLabel(label.id)}
                              disabled={loading}
                              className="p-0.5 text-blue-600 hover:text-blue-700 dark:text-blue-400"
                              title="Save"
                            >
                              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            </button>
                            <button
                              onClick={cancelEditingLabel}
                              className="p-0.5 text-gray-400 hover:text-gray-600 dark:text-gray-500"
                              title="Cancel"
                            >
                              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              onClick={() => startEditingLabel(label.id, label.name, label.color)}
                              className="cursor-pointer"
                            >
                              <LabelTag label={label} />
                            </button>
                            <button
                              onClick={() => handleRemoveLabel(label.id)}
                              disabled={loading}
                              aria-label={`Remove ${label.name} label`}
                              className="opacity-0 group-hover:opacity-100 transition-opacity
                                         text-gray-400 hover:text-gray-600 dark:hover:text-gray-300
                                         disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                  {editError && <p className="text-xs text-red-500 dark:text-red-400 mt-1">{editError}</p>}
                </div>
              )}

              {creatingNew ? (
                <div className="px-3 py-2 space-y-2">
                  <input
                    type="text"
                    value={newLabelName}
                    onChange={(e) => setNewLabelName(e.target.value)}
                    placeholder="Label name (max 20 chars)" maxLength={20}
                    autoFocus
                    className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600
                               rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100
                               focus:outline-none focus:ring-2 focus:ring-blue-500"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleCreateLabel();
                      } else if (e.key === 'Escape') {
                        setCreatingNew(false);
                        setNewLabelName('');
                        setError(null);
                      }
                    }}
                  />
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={newLabelColor}
                      onChange={(e) => setNewLabelColor(e.target.value)}
                      className="w-8 h-8 rounded cursor-pointer"
                    />
                    <button
                      onClick={handleCreateLabel}
                      disabled={loading || !newLabelName.trim()}
                      className="flex-1 px-2 py-1 text-xs font-medium rounded
                                 bg-blue-600 text-white hover:bg-blue-700
                                 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Create
                    </button>
                    <button
                      onClick={() => {
                        setCreatingNew(false);
                        setNewLabelName('');
                        setError(null);
                      }}
                      disabled={loading}
                      className="px-2 py-1 text-xs font-medium rounded
                                 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {unassignedLabels.length > 0 ? (
                    unassignedLabels.map(label => (
                      <div
                        key={label.id}
                        className="flex items-center gap-2 px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 group"
                      >
                        <button
                          onClick={() => handleAssignLabel(label.id)}
                          disabled={loading}
                          className="flex-1 flex items-center gap-2 text-left text-sm
                                     disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <span
                            className="w-3 h-3 rounded-full"
                            style={{ backgroundColor: label.color }}
                          />
                          <span className="text-gray-900 dark:text-gray-100">{label.name}</span>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteConfirm({ labelId: label.id, labelName: label.name });
                          }}
                          disabled={loading}
                          aria-label={`Delete ${label.name} label`}
                          title="Delete label"
                          className="opacity-0 group-hover:opacity-100 transition-opacity p-1
                                     text-red-500 hover:text-red-600 dark:hover:text-red-400
                                     disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    ))
                  ) : assignedLabels.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                      No labels yet
                    </div>
                  ) : (
                    <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                      All labels assigned
                    </div>
                  )}

                  <button
                    onClick={() => setCreatingNew(true)}
                    disabled={loading}
                    className="w-full px-3 py-2 text-left text-sm font-medium border-t border-gray-200 dark:border-gray-700
                               text-blue-600 dark:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-700
                               disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Create new label
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Delete confirmation modal */}
        {deleteConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setDeleteConfirm(null)}>
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-sm mx-4" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">Delete Label?</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                Are you sure you want to delete <strong>{deleteConfirm.labelName}</strong>? This will remove it from all emails.
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setDeleteConfirm(null)}
                  disabled={loading}
                  className="px-4 py-2 text-sm font-medium rounded-lg
                             text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700
                             hover:bg-gray-200 dark:hover:bg-gray-600
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDeleteLabel(deleteConfirm.labelId)}
                  disabled={loading}
                  className="px-4 py-2 text-sm font-medium rounded-lg
                             text-white bg-red-600 hover:bg-red-700
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // Full mode: inline label management (original)
  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        {assignedLabels.map(label => (
          <div key={label.id} className="flex items-center gap-1 group">
            {editingLabelId === label.id ? (
              /* Inline edit input */
              <div className="flex items-center gap-1">
                <input
                  type="color"
                  value={editLabelColor}
                  onChange={(e) => setEditLabelColor(e.target.value)}
                  className="w-6 h-6 rounded cursor-pointer border-0"
                  title="Label color"
                />
                <input
                  value={editLabelName}
                  onChange={(e) => { setEditLabelName(e.target.value); setEditError(null); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitEditLabel(label.id);
                    if (e.key === 'Escape') cancelEditingLabel();
                  }}
                  className="px-2 py-0.5 text-xs rounded border border-blue-400 bg-white
                             dark:bg-gray-800 dark:border-blue-600 dark:text-gray-100 outline-none"
                  maxLength={20}
                  autoFocus
                />
                <button
                  onClick={() => void submitEditLabel(label.id)}
                  disabled={loading}
                  className="p-0.5 text-blue-600 hover:text-blue-700 dark:text-blue-400"
                  title="Save"
                >
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </button>
                <button
                  onClick={cancelEditingLabel}
                  className="p-0.5 text-gray-400 hover:text-gray-600 dark:text-gray-500"
                  title="Cancel"
                >
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            ) : (
              <>
                <button
                  onClick={() => startEditingLabel(label.id, label.name, label.color)}
                  className="cursor-pointer"
                >
                  <LabelTag label={label} />
                </button>
                <button
                  onClick={() => handleRemoveLabel(label.id)}
                  disabled={loading}
                  aria-label={`Remove ${label.name} label`}
                  className="opacity-0 group-hover:opacity-100 transition-opacity
                             text-gray-400 hover:text-gray-600 dark:hover:text-gray-300
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </>
            )}
          </div>
        ))}
        {editError && <p className="text-xs text-red-500 dark:text-red-400">{editError}</p>}

        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(o => !o)}
            disabled={loading}
            aria-label="Add label"
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg
                       transition-colors border
                       text-gray-600 bg-gray-50 border-gray-300 hover:bg-gray-100
                       dark:text-gray-300 dark:bg-gray-800 dark:border-gray-600 dark:hover:bg-gray-700
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add Label
          </button>

          {dropdownOpen && (
            <div className="absolute left-0 top-full mt-1 z-50 min-w-[200px] bg-white dark:bg-gray-800
                            border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 overflow-hidden">
              {error && (
                <div className="px-3 py-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800">
                  {error}
                </div>
              )}

              {creatingNew ? (
                <div className="px-3 py-2 space-y-2">
                  <input
                    type="text"
                    value={newLabelName}
                    onChange={(e) => setNewLabelName(e.target.value)}
                    placeholder="Label name (max 20 chars)" maxLength={20}
                    autoFocus
                    className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600
                               rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100
                               focus:outline-none focus:ring-2 focus:ring-blue-500"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleCreateLabel();
                      } else if (e.key === 'Escape') {
                        setCreatingNew(false);
                        setNewLabelName('');
                        setError(null);
                      }
                    }}
                  />
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={newLabelColor}
                      onChange={(e) => setNewLabelColor(e.target.value)}
                      className="w-8 h-8 rounded cursor-pointer"
                    />
                    <button
                      onClick={handleCreateLabel}
                      disabled={loading || !newLabelName.trim()}
                      className="flex-1 px-2 py-1 text-xs font-medium rounded
                                 bg-blue-600 text-white hover:bg-blue-700
                                 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Create
                    </button>
                    <button
                      onClick={() => {
                        setCreatingNew(false);
                        setNewLabelName('');
                        setError(null);
                      }}
                      disabled={loading}
                      className="px-2 py-1 text-xs font-medium rounded
                                 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {unassignedLabels.length > 0 ? (
                    unassignedLabels.map(label => (
                      <div
                        key={label.id}
                        className="flex items-center gap-2 px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 group"
                      >
                        <button
                          onClick={() => handleAssignLabel(label.id)}
                          disabled={loading}
                          className="flex-1 flex items-center gap-2 text-left text-sm
                                     disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <span
                            className="w-3 h-3 rounded-full"
                            style={{ backgroundColor: label.color }}
                          />
                          <span className="text-gray-900 dark:text-gray-100">{label.name}</span>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteConfirm({ labelId: label.id, labelName: label.name });
                          }}
                          disabled={loading}
                          aria-label={`Delete ${label.name} label`}
                          title="Delete label"
                          className="opacity-0 group-hover:opacity-100 transition-opacity p-1
                                     text-red-500 hover:text-red-600 dark:hover:text-red-400
                                     disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                      All labels assigned
                    </div>
                  )}

                  <button
                    onClick={() => setCreatingNew(true)}
                    disabled={loading}
                    className="w-full px-3 py-2 text-left text-sm font-medium border-t border-gray-200 dark:border-gray-700
                               text-blue-600 dark:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-700
                               disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Create new label
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setDeleteConfirm(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-sm mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">Delete Label?</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Are you sure you want to delete <strong>{deleteConfirm.labelName}</strong>? This will remove it from all emails.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteConfirm(null)}
                disabled={loading}
                className="px-4 py-2 text-sm font-medium rounded-lg
                           text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700
                           hover:bg-gray-200 dark:hover:bg-gray-600
                           disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteLabel(deleteConfirm.labelId)}
                disabled={loading}
                className="px-4 py-2 text-sm font-medium rounded-lg
                           text-white bg-red-600 hover:bg-red-700
                           disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
