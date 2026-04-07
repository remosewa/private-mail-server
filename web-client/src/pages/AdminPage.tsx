import { useEffect, useState, useCallback } from 'react';
import { useUiStore } from '../store/uiStore';
import {
  adminListUsers, adminListInvites, adminCreateInvite, adminInvalidateInvite,
  type AdminUser, type AdminInvite,
} from '../api/admin';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inviteStatus(inv: AdminInvite): { label: string; color: string } {
  if (inv.invalidatedAt) return { label: 'Invalidated', color: 'text-red-600 dark:text-red-400' };
  if (inv.usedAt)        return { label: 'Used',        color: 'text-green-600 dark:text-green-400' };
  if (inv.expiresAt && Date.now() / 1000 > inv.expiresAt)
                         return { label: 'Expired',     color: 'text-gray-400' };
  return                        { label: 'Active',      color: 'text-blue-600 dark:text-blue-400' };
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function fmtEpoch(epoch: number | undefined): string {
  if (!epoch) return '—';
  return new Date(epoch * 1000).toLocaleString();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AdminPage() {
  const { setActivePage } = useUiStore();

  const [tab, setTab]             = useState<'users' | 'invites'>('invites');
  const [users, setUsers]         = useState<AdminUser[]>([]);
  const [invites, setInvites]     = useState<AdminInvite[]>([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');

  // Create invite form
  const [creating, setCreating]   = useState(false);
  const [expiryDays, setExpiryDays] = useState(30);
  const [note, setNote]           = useState('');
  const [createError, setCreateError] = useState('');
  const [newCode, setNewCode]     = useState('');
  const [copied, setCopied]       = useState(false);

  const loadUsers = useCallback(async () => {
    setLoading(true); setError('');
    try { setUsers(await adminListUsers()); }
    catch { setError('Failed to load users.'); }
    finally { setLoading(false); }
  }, []);

  const loadInvites = useCallback(async () => {
    setLoading(true); setError('');
    try { setInvites(await adminListInvites()); }
    catch { setError('Failed to load invites.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (tab === 'users')   void loadUsers();
    if (tab === 'invites') void loadInvites();
  }, [tab, loadUsers, loadInvites]);

  async function handleCreateInvite() {
    setCreating(true); setCreateError(''); setNewCode('');
    try {
      const { inviteCode } = await adminCreateInvite({ expiresInDays: expiryDays, note: note.trim() || undefined });
      setNewCode(inviteCode);
      setNote('');
      await loadInvites();
    } catch {
      setCreateError('Failed to create invite.');
    } finally {
      setCreating(false);
    }
  }

  async function handleInvalidate(inviteCode: string) {
    if (!confirm('Invalidate this invite code?')) return;
    try {
      await adminInvalidateInvite(inviteCode);
      await loadInvites();
    } catch {
      setError('Failed to invalidate invite.');
    }
  }

  function copyCode(code: string) {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <button
          onClick={() => setActivePage('settings')}
          className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          aria-label="Back"
        >
          ←
        </button>
        <h1 className="text-lg font-semibold">Admin Panel</h1>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-6">
        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-gray-200 dark:border-gray-700">
          {(['invites', 'users'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                tab === t
                  ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* ── Invites tab ── */}
        {tab === 'invites' && (
          <div className="space-y-6">
            {/* Create invite */}
            <div className="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
              <h2 className="text-sm font-semibold mb-3">Create Invite Code</h2>
              <div className="flex flex-wrap gap-3 items-end">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Expires in (days)</label>
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={expiryDays}
                    onChange={e => setExpiryDays(Number(e.target.value))}
                    className="w-24 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700"
                  />
                </div>
                <div className="flex-1 min-w-40">
                  <label className="block text-xs text-gray-500 mb-1">Note (optional)</label>
                  <input
                    type="text"
                    placeholder="e.g. for Alice"
                    value={note}
                    onChange={e => setNote(e.target.value)}
                    className="w-full px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700"
                  />
                </div>
                <button
                  onClick={() => void handleCreateInvite()}
                  disabled={creating}
                  className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50"
                >
                  {creating ? 'Creating…' : 'Create'}
                </button>
              </div>
              {createError && <p className="mt-2 text-xs text-red-600">{createError}</p>}
              {newCode && (
                <div className="mt-3 flex items-center gap-2">
                  <code className="flex-1 px-3 py-1.5 text-sm rounded-lg bg-gray-100 dark:bg-gray-700 font-mono break-all">
                    {newCode}
                  </code>
                  <button
                    onClick={() => copyCode(newCode)}
                    className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              )}
            </div>

            {/* Invite list */}
            {loading ? (
              <p className="text-sm text-gray-500">Loading…</p>
            ) : invites.length === 0 ? (
              <p className="text-sm text-gray-500">No invite codes.</p>
            ) : (
              <div className="space-y-2">
                {invites.map(inv => {
                  const { label, color } = inviteStatus(inv);
                  const canInvalidate = !inv.usedAt && !inv.invalidatedAt;
                  return (
                    <div
                      key={inv.inviteCode}
                      className="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <code className="text-xs font-mono text-gray-700 dark:text-gray-300 truncate">
                              {inv.inviteCode}
                            </code>
                            <span className={`text-xs font-medium ${color}`}>{label}</span>
                          </div>
                          <div className="text-xs text-gray-500 space-y-0.5">
                            <div>Created {fmtDate(inv.createdAt)} by <span className="font-medium">{inv.createdByEmail}</span></div>
                            {inv.note && <div>Note: {inv.note}</div>}
                            {inv.expiresAt && !inv.usedAt && !inv.invalidatedAt && (
                              <div>Expires {fmtEpoch(inv.expiresAt)}</div>
                            )}
                            {inv.usedAt && (
                              <div>
                                Used {fmtEpoch(inv.usedAt)} by{' '}
                                <span className="font-medium">{inv.assignedUserEmail ?? inv.assignedUserId}</span>
                              </div>
                            )}
                            {inv.invalidatedAt && (
                              <div>Invalidated {fmtDate(inv.invalidatedAt)}</div>
                            )}
                          </div>
                        </div>
                        {canInvalidate && (
                          <button
                            onClick={() => void handleInvalidate(inv.inviteCode)}
                            className="shrink-0 px-3 py-1 text-xs text-red-600 dark:text-red-400 border border-red-300 dark:border-red-700 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20"
                          >
                            Invalidate
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Users tab ── */}
        {tab === 'users' && (
          <div>
            {loading ? (
              <p className="text-sm text-gray-500">Loading…</p>
            ) : users.length === 0 ? (
              <p className="text-sm text-gray-500">No users.</p>
            ) : (
              <div className="space-y-2">
                {users.map(u => (
                  <div
                    key={u.userId}
                    className="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex items-center justify-between"
                  >
                    <div>
                      <div className="text-sm font-medium flex items-center gap-2">
                        {u.username}
                        {u.isAdmin && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium">
                            admin
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500">{u.email}</div>
                      <div className="text-xs text-gray-400">Joined {fmtDate(u.createdAt)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
