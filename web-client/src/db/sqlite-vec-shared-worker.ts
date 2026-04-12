/**
 * sqlite-vec-shared-worker.ts — Pure message router.
 *
 * One SharedWorker instance shared across all tabs. It does NOT touch SQLite
 * or OPFS at all — SharedWorkers lack SharedArrayBuffer which is required by
 * the OPFS SAH-pool VFS.
 *
 * Instead, each tab spawns its own dedicated worker (sqlite-vec-dedicated-worker.ts).
 * The dedicated worker that wins the Web Lock named "chase-email-sqlite-leader"
 * becomes the leader and opens the OPFS database. All other tabs route their
 * SQL queries here; this router forwards them to the leader's dedicated worker
 * and sends replies back to the originating tab.
 *
 * Message protocol (Tab → SharedWorker)
 * --------------------------------------
 *   { type: 'i-am-leader' }                    — leader tab's dedicated worker is ready
 *   { type: 'leader-closed' }                  — leader tab is closing
 *   { type: 'register' }                        — non-leader tab registering
 *   { type: 'request-sync' }
 *   { type: 'request-sync-from', fromDate }
 *   { type: 'sync-result', synced }
 *   { type: 'index-result' }
 *   { id, sql, bind?, rowMode?, returnValue? }  — SQL query to forward to leader
 *
 * Message protocol (SharedWorker → Tab)
 *   { type: 'do-sync' }
 *   { type: 'do-sync-from', fromDate }
 *   { type: 'do-index' }
 *   { type: 'sync-done', synced }
 *   { id, result }  /  { id, error }            — SQL reply forwarded from leader
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const sharedSelf = self as any;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const ports = new Set<MessagePort>();

/** The port belonging to the leader tab. SQL queries are forwarded here. */
let leaderPort: MessagePort | null = null;

/** Queries queued while no leader is available. */
const pendingQueue: Array<{ fromPort: MessagePort; msg: unknown }> = [];

// Sync / index coordinator state
let syncInProgress = false;
let indexInProgress = false;
let primaryPort: MessagePort | null = null;
const SYNC_INTERVAL_MS = 30_000;
let syncTimer: ReturnType<typeof setInterval> | null = null;
/** Set to true when a sync was requested while one was already in progress — fires immediately after. */
let syncPending = false;

// Leader heartbeat — detects tabs that crash/close without sending 'leader-closed'
/** The tab port belonging to the current leader (distinct from leaderPort which is a MessageChannel port). */
let leaderTabPort: MessagePort | null = null;
let leaderHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
const HEARTBEAT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetHeartbeatTimer() {
  if (leaderHeartbeatTimer) clearTimeout(leaderHeartbeatTimer);
  leaderHeartbeatTimer = setTimeout(() => {
    console.warn('[shared-worker] Leader heartbeat timed out — assuming leader tab closed unexpectedly');
    leaderPort = null;
    leaderTabPort = null;
    leaderHeartbeatTimer = null;
  }, HEARTBEAT_TIMEOUT_MS);
}

function clearHeartbeatTimer() {
  if (leaderHeartbeatTimer) { clearTimeout(leaderHeartbeatTimer); leaderHeartbeatTimer = null; }
}

function broadcastAll(msg: unknown) {
  for (const p of ports) {
    try { p.postMessage(msg); } catch { /* port closed */ }
  }
}

function electPrimary(excludePort?: MessagePort) {
  primaryPort = null;
  for (const p of ports) {
    if (p !== excludePort) { primaryPort = p; break; }
  }
  if (primaryPort && !syncTimer) {
    syncTimer = setInterval(triggerSync, SYNC_INTERVAL_MS);
  }
  if (!primaryPort && syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

function triggerSync(fromDate?: string) {
  if (!primaryPort) return;
  if (syncInProgress) {
    syncPending = true;
    return;
  }
  syncInProgress = true;
  primaryPort.postMessage(fromDate ? { type: 'do-sync-from', fromDate } : { type: 'do-sync' });
}

function triggerIndex() {
  if (indexInProgress || !primaryPort) return;
  indexInProgress = true;
  primaryPort.postMessage({ type: 'do-index' });
}

/** Forward a SQL query to the leader, tagging it with a replyPort so the
 *  leader's dedicated worker can send the result directly back here, and we
 *  relay it to the originating tab. */
function forwardToLeader(fromPort: MessagePort, msg: unknown) {
  if (!leaderPort) {
    pendingQueue.push({ fromPort, msg });
    return;
  }

  // Create a MessageChannel so the leader can reply directly to us
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = (ev) => {
    try { fromPort.postMessage(ev.data); } catch { /* tab closed */ }
    port1.close();
  };

  leaderPort.postMessage({ ...(msg as object), replyPort: port2 }, [port2]);
}

function drainPendingQueue() {
  for (const { fromPort, msg } of pendingQueue.splice(0)) {
    forwardToLeader(fromPort, msg);
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

function handleMessage(port: MessagePort, ev: MessageEvent) {
  const data = ev.data as Record<string, unknown>;

  // ── Leader registration ──────────────────────────────────────────────────

  if (data.type === 'i-am-leader') {
    leaderPort = data.leaderPort as MessagePort;
    leaderPort.start();
    leaderTabPort = port;
    resetHeartbeatTimer();
    drainPendingQueue();
    // Notify all non-leader tabs that a leader is now available so they can unblock their ready promise
    for (const p of ports) {
      if (p !== port) {
        try { p.postMessage({ type: 'leader-available' }); } catch { /* port closed */ }
      }
    }
    return;
  }

  if (data.type === 'leader-closed') {
    leaderPort = null;
    leaderTabPort = null;
    clearHeartbeatTimer();
    return;
  }

  if (data.type === 'heartbeat') {
    if (port === leaderTabPort) resetHeartbeatTimer();
    return;
  }

  // ── Sync / index coordinator ─────────────────────────────────────────────

  if (data.type === 'register') {
    if (!primaryPort) electPrimary();
    triggerSync();
    // If a leader is already available, tell this tab immediately so it can unblock
    if (leaderPort) {
      try { port.postMessage({ type: 'leader-available' }); } catch { /* port closed */ }
    }
    return;
  }

  if (data.type === 'request-sync') {
    triggerSync();
    return;
  }

  if (data.type === 'request-sync-from') {
    triggerSync(data.fromDate as string);
    return;
  }

  if (data.type === 'sync-result') {
    syncInProgress = false;
    broadcastAll({ type: 'sync-done', synced: data.synced });
    if (syncPending) {
      syncPending = false;
      triggerSync();
    } else {
      triggerIndex();
    }
    return;
  }

  if (data.type === 'index-result') {
    indexInProgress = false;
    return;
  }

  // ── SQL query — forward to leader ────────────────────────────────────────

  if ('id' in data) {
    // If this port IS the leader, it handles its own queries directly
    // (Database.ts sends directly to the dedicated worker, not here)
    forwardToLeader(port, data);
    return;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

sharedSelf.onconnect = (e: MessageEvent) => {
  const port: MessagePort = e.ports[0];
  ports.add(port);

  electPrimary();

  port.onmessage = (ev) => handleMessage(port, ev);

  port.addEventListener('close', () => {
    ports.delete(port);
    if (leaderTabPort === port) {
      leaderPort = null;
      leaderTabPort = null;
      clearHeartbeatTimer();
    }
    if (primaryPort === port) electPrimary(port);
  });

  port.start();
};
