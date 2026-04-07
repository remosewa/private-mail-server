/**
 * Client log forwarding — POST /client-logs
 *
 * Accepts a batch of log entries from the web client and writes them to
 * CloudWatch Logs via console.log/error (Lambda stdout is automatically
 * forwarded to CloudWatch).
 *
 * Rate limiting is intentionally left to API Gateway throttling settings.
 * Each entry is logged as a single structured JSON line tagged with the
 * authenticated userId so logs can be filtered per user.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

type ApiEvent = APIGatewayProxyEventV2;
type ApiResult = APIGatewayProxyResultV2;

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface ClientLogEntry {
  level: LogLevel;
  message: string;
  /** Optional structured context (stack traces, component names, etc.) */
  context?: unknown;
  /** Client-side timestamp (ISO 8601) */
  ts?: string;
}

const ALLOWED_LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error']);
const MAX_ENTRIES = 50;
const MAX_MESSAGE_LENGTH = 2000;

function json(status: number, body: unknown): ApiResult {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function getUserId(event: ApiEvent): string | undefined {
  // @ts-expect-error - authorizer is added by API Gateway JWT authorizer at runtime
  return event.requestContext.authorizer?.jwt?.claims?.['sub'] as string | undefined;
}

export async function handleClientLogs(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  let entries: unknown[];
  try {
    const body = JSON.parse(event.body ?? '{}');
    if (!Array.isArray(body.entries)) return json(400, { error: 'entries must be an array' });
    entries = body.entries;
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  if (entries.length > MAX_ENTRIES) return json(400, { error: `Maximum ${MAX_ENTRIES} entries per request` });

  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Partial<ClientLogEntry>;

    const level: LogLevel = ALLOWED_LEVELS.has(entry.level as LogLevel) ? (entry.level as LogLevel) : 'info';
    const message = typeof entry.message === 'string'
      ? entry.message.slice(0, MAX_MESSAGE_LENGTH)
      : String(entry.message ?? '').slice(0, MAX_MESSAGE_LENGTH);

    const line = JSON.stringify({
      source: 'client',
      userId,
      level,
      message,
      ts: entry.ts ?? new Date().toISOString(),
      ...(entry.context !== undefined ? { context: entry.context } : {}),
    });

    if (level === 'error' || level === 'warn') {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  return json(200, { ok: true });
}
