/**
 * Remote logger — buffers client-side log entries and flushes them to
 * POST /client-logs in batches.  Errors and warnings are flushed immediately;
 * debug/info entries are batched and flushed every 10 seconds or when the
 * buffer reaches 20 entries.
 */

import { apiClient } from './client';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  context?: unknown;
  ts: string;
}

const BATCH_SIZE = 20;
const FLUSH_INTERVAL_MS = 10_000;

let buffer: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush() {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_INTERVAL_MS);
}

async function flush() {
  if (buffer.length === 0) return;
  const entries = buffer.splice(0);
  try {
    await apiClient.post('/client-logs', { entries });
  } catch {
    // Silently drop — avoid infinite loop of logging log failures
  }
}

function log(level: LogLevel, message: string, context?: unknown) {
  const entry: LogEntry = { level, message, ts: new Date().toISOString() };
  if (context !== undefined) entry.context = context;
  buffer.push(entry);

  if (level === 'error' || level === 'warn' || buffer.length >= BATCH_SIZE) {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    flush();
  } else {
    scheduleFlush();
  }
}

export const remoteLogger = {
  debug: (message: string, context?: unknown) => log('debug', message, context),
  info:  (message: string, context?: unknown) => log('info',  message, context),
  warn:  (message: string, context?: unknown) => log('warn',  message, context),
  error: (message: string, context?: unknown) => log('error', message, context),
};

/** Install a global error handler to capture uncaught errors and unhandled rejections. */
export function installGlobalErrorLogger() {
  window.addEventListener('error', (e) => {
    remoteLogger.error(e.message, {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error instanceof Error ? e.error.stack : undefined,
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    remoteLogger.error(`Unhandled rejection: ${message}`, {
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
