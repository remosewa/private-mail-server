/**
 * Ask AI API — streaming chat with Claude via the ai-handler Lambda.
 *
 * The stream endpoint is a Lambda Function URL (discovered once via
 * GET /ai/config on the main API) that emits newline-delimited JSON:
 *   {"type":"delta","text":"..."}                       incremental answer text
 *   {"type":"final","content":[...],"stopReason":"..."} complete assistant message
 *   {"type":"error","error":"..."}                      terminal failure
 */

import { apiClient } from './client';
import { useAuthStore } from '../store/authStore';

/** Anthropic-format content block (text | tool_use | thinking | ...). */
export interface AiContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  [key: string]: unknown;
}

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string | AiContentBlock[];
}

export interface AiFinal {
  content: AiContentBlock[];
  stopReason: string;
}

let cachedStreamUrl: string | null = null;

async function getStreamUrl(): Promise<string> {
  if (cachedStreamUrl) return cachedStreamUrl;
  const { data } = await apiClient.get<{ streamUrl: string }>('/ai/config');
  cachedStreamUrl = data.streamUrl;
  return cachedStreamUrl;
}

/**
 * Send the conversation and stream the assistant's reply.
 * Resolves with the final assistant message once the stream ends.
 */
export async function streamAiMessage(
  messages: AiMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<AiFinal> {
  const url = await getStreamUrl();
  const token = useAuthStore.getState().accessToken;
  if (!token) throw new Error('Not signed in');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Assistant request failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final: AiFinal | null = null;

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let event: { type: string; text?: string; content?: AiContentBlock[]; stopReason?: string; error?: string };
    try {
      event = JSON.parse(line);
    } catch {
      return; // partial/garbled line — ignore
    }
    if (event.type === 'delta' && event.text) onDelta(event.text);
    else if (event.type === 'final') final = { content: event.content ?? [], stopReason: event.stopReason ?? 'end_turn' };
    else if (event.type === 'error') throw new Error(event.error ?? 'Assistant error');
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      handleLine(line);
    }
  }
  handleLine(buffer);

  if (!final) throw new Error('Assistant stream ended unexpectedly');
  return final;
}
