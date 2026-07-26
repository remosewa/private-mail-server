/**
 * ai-handler Lambda — streaming "Ask AI" proxy to Claude Sonnet 4.6 on Amazon Bedrock.
 *
 * Invoked via a Lambda Function URL with InvokeMode: RESPONSE_STREAM (API
 * Gateway HTTP APIs buffer responses and cap integrations at 30s, so the AI
 * endpoint bypasses the API and streams directly). Auth is a Cognito access
 * token in the Authorization header, verified in-function with aws-jwt-verify
 * (Function URLs have no JWT authorizer).
 *
 * The browser owns the conversation and executes every tool locally against
 * the user's decrypted on-device mailbox (emails are E2E encrypted; the server
 * never holds plaintext at rest). This Lambda only holds the system prompt +
 * tool definitions and forwards the conversation to Bedrock for inference —
 * plaintext transits here solely as tool results the client chose to send.
 * Nothing is logged or stored.
 *
 * Response: newline-delimited JSON events —
 *   {"type":"delta","text":"..."}                       incremental answer text
 *   {"type":"final","content":[...],"stopReason":"..."} the complete assistant message
 *   {"type":"error","error":"..."}                      terminal failure
 *
 * Client loop: send messages → stream deltas for display → on "final", if
 * stopReason is tool_use, execute ALL tool_use blocks locally (in parallel),
 * append ONE user message containing every tool_result, and call again.
 */

import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

// Classic bedrock-runtime surface with the `us.` cross-region inference
// profile. (The newer Mantle Messages-API surface — the only place Sonnet 5
// is served — 403s for this account until AWS support re-syncs the Anthropic
// entitlement; to move to Sonnet 5 later, switch the client back to
// AnthropicBedrockMantle and set BEDROCK_MODEL_ID=anthropic.claude-sonnet-5.)
// Both knobs are env-overridable so routing changes are config redeploys.
const MODEL = process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-6';
// Haiku 4.5 predates adaptive thinking — sending `thinking: {type:"adaptive"}`
// to it returns a 400. Enable it only on models that support it (Sonnet/Opus 4.6+).
const ADAPTIVE_THINKING = !/haiku/i.test(MODEL);
const MAX_MESSAGES = 120;
const MAX_BODY_BYTES = 900_000;

const anthropic = new AnthropicBedrock({
  awsRegion: process.env.BEDROCK_REGION ?? process.env.AWS_REGION,
});

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  tokenUse: 'access',
  clientId: process.env.USER_POOL_CLIENT_ID!,
});

const SYSTEM_PROMPT = `You are the built-in assistant of Chase Email, a private end-to-end-encrypted personal email service. You help the user find, understand, and summarize their own email.

All tools run on the user's device against their decrypted mailbox; results you receive are the user's own private data, returned to them alone.

Guidelines:
- Ground every claim in tool results. If you haven't found something, say so — never invent emails, senders, or dates.
- Be proactive with tools: search before answering, and issue multiple tool calls in parallel when they are independent (e.g. several searches with different phrasings, or reading several emails at once).
- Keyword search matches exact words; semantic search finds conceptually related emails. Tool results are deterministic — NEVER repeat a search with identical arguments. When a search comes up empty, check its tierHits and indexCoverage, then vary the terms (fewer, more distinctive words) or switch mode.
- After TWO searches fail to find something the user says exists, STOP rephrasing and switch strategies: list_emails filtered by the likely sender (company/airline/person name) and a date range is far more reliable than keyword guessing — senders are metadata and always searchable, while body text is only searchable for emails the device has indexed.
- When you mention a specific email, embed a link to it using exactly this markdown form: [Subject line](email:EMAIL_ID) — where EMAIL_ID is the "id" field from tool results. The app renders these as clickable links that open the email. Link every specific email you reference.
- Dates in tool results are ISO 8601. Present dates in a friendly form (e.g. "March 3, 2026").
- Answer concisely. Formatting support is limited to simple markdown: **bold**, *italic*, \`inline code\`, bullet lists (-), numbered lists, and short headings. Do NOT use tables, nested lists, code fences, or images — they will not render.
- System folder IDs: INBOX, SENT, DRAFTS, ARCHIVE, SPAM, TRASH. Custom folders have opaque IDs — call list_folders to map names to IDs before filtering by a custom folder.`;

const TOOLS = [
  {
    name: 'search_emails',
    description:
      "Full-text and semantic search over the user's entire mailbox (subjects, senders, and message bodies). Returns matching emails with id, subject, from, date, folderId, isRead, and a snippet. Ranking blends match quality (exact phrase > all words > semantic > any word) with recency — newer emails rank higher. Use mode 'keyword' for exact words/names/order numbers, 'semantic' for conceptual queries ('that dinner reservation'), or 'both' (default). Short queries with distinctive words work best. For questions about upcoming or recent events (flights, reservations, deliveries), constrain with dateFrom — and remember the sender is often the strongest signal (e.g. search or list_emails by the airline/company name). Issue several searches in parallel when trying different phrasings.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        mode: { type: 'string', enum: ['keyword', 'semantic', 'both'], description: "Search mode. Default 'both'." },
        folderId: { type: 'string', description: 'Restrict to one folder ID. Omit to search everywhere.' },
        dateFrom: { type: 'string', description: 'Only emails received on/after this ISO date, e.g. 2026-05-01.' },
        dateTo: { type: 'string', description: 'Only emails received on/before this ISO date.' },
        limit: { type: 'integer', description: 'Max results, 1-50. Default 15.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_emails',
    description:
      'Structured listing of emails by filters (no text query). Sorted newest first. Returns the same email summaries as search_emails plus the total match count. Use for questions like "latest email from X", "unread this week", "emails with attachments in folder Y".',
    input_schema: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: 'Folder ID to list. Omit for all folders.' },
        fromContains: { type: 'string', description: 'Substring match on sender name or address (case-insensitive).' },
        toContains: { type: 'string', description: 'Substring match on recipient addresses.' },
        subjectContains: { type: 'string', description: 'Substring match on subject.' },
        unreadOnly: { type: 'boolean' },
        hasAttachments: { type: 'boolean' },
        dateFrom: { type: 'string', description: 'ISO date (inclusive), e.g. 2026-06-01.' },
        dateTo: { type: 'string', description: 'ISO date (inclusive).' },
        limit: { type: 'integer', description: 'Max results, 1-100. Default 25.' },
        offset: { type: 'integer', description: 'Pagination offset. Default 0.' },
      },
    },
  },
  {
    name: 'read_email',
    description:
      'Read the full decrypted plain-text body of one email by its id, plus its headers (subject, from, to, cc, date, folder, attachment filenames). Read several emails in parallel when comparing or summarizing them. Long bodies are truncated. To read the contents of an attachment listed in the result, use read_attachment.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The email id (from search_emails / list_emails results).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'read_attachment',
    description:
      "Read the text content of an email attachment (decrypted on the user's device). Supports PDF, HTML, and plain-text formats (txt/csv/json/xml/md); images and office documents are not readable. Use this when the answer likely lives in an attachment — quotes, invoices, receipts, itineraries, statements. Get the filename from read_email's attachments list first.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The email id the attachment belongs to.' },
        filename: { type: 'string', description: "The attachment's filename (exact or partial match, from read_email)." },
      },
      required: ['id', 'filename'],
    },
  },
  {
    name: 'list_folders',
    description: "List the user's folders: system folders and custom folders with their IDs, names, and unread counts.",
    input_schema: { type: 'object', properties: {} },
  },
];

function emit(stream: awslambda.ResponseStream, event: Record<string, unknown>): void {
  stream.write(JSON.stringify(event) + '\n');
}

async function verifyAuth(authHeader: string | undefined): Promise<boolean> {
  if (!authHeader?.startsWith('Bearer ')) return false;
  try {
    await verifier.verify(authHeader.slice(7));
    return true;
  } catch {
    return false;
  }
}

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  // Preflight is handled by the Function URL's CORS config; anything else
  // reaching here should be a POST with a JSON body.
  const authorized = await verifyAuth(
    event.headers?.['authorization'] ?? event.headers?.['Authorization'],
  );

  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: authorized ? 200 : 401,
    headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' },
  });

  if (!authorized) {
    emit(stream, { type: 'error', error: 'Unauthorized' });
    stream.end();
    return;
  }

  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '');
    if (rawBody.length > MAX_BODY_BYTES) {
      emit(stream, { type: 'error', error: 'Conversation too large — start a new chat' });
      stream.end();
      return;
    }

    const { messages } = JSON.parse(rawBody || '{}') as { messages?: unknown[] };
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
      emit(stream, { type: 'error', error: 'Invalid messages' });
      stream.end();
      return;
    }
    for (const m of messages) {
      const role = (m as { role?: string }).role;
      if (role !== 'user' && role !== 'assistant') {
        emit(stream, { type: 'error', error: 'Invalid message role' });
        stream.end();
        return;
      }
    }

    // The current date grounds relative queries ("last week", "yesterday").
    const system = `${SYSTEM_PROMPT}\n\nToday's date is ${new Date().toISOString().slice(0, 10)}.`;

    const modelStream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 4096,
      ...(ADAPTIVE_THINKING ? { thinking: { type: 'adaptive' as const } } : {}),
      system,
      tools: TOOLS as never,
      messages: messages as never,
    });

    modelStream.on('text', (delta: string) => {
      emit(stream, { type: 'delta', text: delta });
    });

    const finalMessage = await modelStream.finalMessage();
    emit(stream, {
      type: 'final',
      content: finalMessage.content,
      stopReason: finalMessage.stop_reason,
      usage: {
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
      },
    });
  } catch (err) {
    console.error('[ai-handler] Request failed:', (err as Error).message);
    const status = (err as { status?: number }).status;
    emit(stream, {
      type: 'error',
      error: status === 429
        ? 'The assistant is busy — try again in a moment'
        : 'The assistant is unavailable right now',
    });
  } finally {
    stream.end();
  }
});
