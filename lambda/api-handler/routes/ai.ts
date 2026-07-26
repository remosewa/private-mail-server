/**
 * Ask AI config route.
 *
 * GET /ai/config (JWT) — returns the Lambda Function URL of the streaming AI
 * handler. The AI itself lives in lambda/ai-handler (a separate function with
 * a RESPONSE_STREAM Function URL, since API Gateway HTTP APIs buffer responses
 * and cap integrations at 30s — unusable for streamed model output).
 */

import type { ApiEvent, ApiResult } from '../types';

function json(status: number, body: unknown): ApiResult {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function getUserId(event: ApiEvent): string | undefined {
  return event.requestContext.authorizer?.jwt?.claims?.['sub'] as string | undefined;
}

export async function handleAiConfig(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const streamUrl = process.env.AI_STREAM_URL;
  if (!streamUrl) return json(503, { error: 'AI assistant is not configured' });

  return json(200, { streamUrl });
}
