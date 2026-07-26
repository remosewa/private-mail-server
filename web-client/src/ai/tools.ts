/**
 * Ask AI tool executors — run entirely on-device against the local SQLite
 * mailbox (decrypted metadata + FTS index) and the E2E-decrypted bodies.
 *
 * The model (via lambda/ai-handler) decides which tools to call; the browser
 * executes them here and returns JSON results. Only what these tools return
 * ever leaves the device (sent to Bedrock as tool_result content).
 */

import { getDb } from '../db/Database';
import { anyWordSearch, keywordSearch, phraseSearch, semanticSearch } from '../search/searcher';
import { getEmbedderClient } from '../search/EmbedderClient';
import { fetchEmailText } from '../search/emailText';
import { useFolderStore } from '../store/folderStore';
import { getEmailAttachments, getAttachmentBlob, getEmailBody } from '../api/emails';
import { decryptBlob, decryptAttachment, unwrapEmailKey } from '../crypto/BlobCrypto';
import type { AttachmentMeta } from '../types';

const SYSTEM_FOLDERS = ['INBOX', 'SENT', 'DRAFTS', 'ARCHIVE', 'SPAM', 'TRASH'];

interface EmailSummary {
  id: string;
  subject: string;
  from: string;
  date: string;
  folderId: string;
  isRead: boolean;
  hasAttachments: boolean;
  snippet: string;
}

function rowToSummary(row: Record<string, unknown>): EmailSummary {
  const fromName = (row['fromName'] as string | null) ?? '';
  const fromAddress = (row['fromAddress'] as string | null) ?? '';
  return {
    id: row['ulid'] as string,
    subject: (row['subject'] as string | null) ?? '(no subject)',
    from: fromName && fromAddress ? `${fromName} <${fromAddress}>` : (fromAddress || fromName || '(unknown)'),
    date: row['receivedAt'] as string,
    folderId: row['folderId'] as string,
    isRead: !!(row['isRead'] as number),
    hasAttachments: !!(row['hasAttachments'] as number),
    snippet: ((row['preview'] as string | null) ?? '').slice(0, 200),
  };
}

const SUMMARY_COLS = 'ulid, subject, fromName, fromAddress, receivedAt, folderId, isRead, hasAttachments, preview';

async function summariesByUlids(ulids: string[]): Promise<EmailSummary[]> {
  if (ulids.length === 0) return [];
  const db = await getDb();
  const placeholders = ulids.map(() => '?').join(',');
  const rows = await db.selectObjects(
    `SELECT ${SUMMARY_COLS} FROM email_metadata WHERE ulid IN (${placeholders})`,
    ulids,
  );
  const byUlid = new Map(rows.map(r => [r['ulid'] as string, rowToSummary(r)]));
  return ulids.map(u => byUlid.get(u)).filter((s): s is EmailSummary => !!s);
}

/** Best-effort query embedding — skips semantic search if the model isn't ready quickly. */
async function tryEmbedQuery(query: string, timeoutMs = 4000): Promise<Float32Array | null> {
  try {
    const client = getEmbedderClient();
    const ready = await Promise.race([
      client.onModelReady().then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), timeoutMs)),
    ]);
    if (!ready) return null;
    const [vec] = await client.embed([query]);
    return vec ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// search_emails
// ---------------------------------------------------------------------------

interface SearchInput {
  query: string;
  mode?: 'keyword' | 'semantic' | 'both';
  folderId?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

// Final ranking blends match quality with recency: mailbox questions are
// usually about what's current, so a fresh partial match should outrank a
// years-old literal one. Base score by tier, minus a small per-rank decay,
// plus a recency boost with a ~4-month half-life.
const TIER_BASE: Record<string, number> = {
  exactPhrase: 1.0,
  allWords: 0.85,
  semantic: 0.72,
  anyWord: 0.5,
  metadataScan: 0.45,
};
const RECENCY_WEIGHT = 0.5;
const RECENCY_HALF_LIFE_DAYS = 120;

function hitScore(tier: string, rank: number, receivedMs: number, now: number): number {
  const ageDays = Math.max(0, (now - receivedMs) / 86_400_000);
  const recency = RECENCY_WEIGHT * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  return (TIER_BASE[tier] ?? 0.4) - rank * 0.008 + recency;
}

async function searchEmails(input: SearchInput): Promise<string> {
  const { query, folderId } = input;
  if (!query?.trim()) throw new Error('query is required');
  const mode = input.mode ?? 'both';
  const limit = Math.min(Math.max(input.limit ?? 15, 1), 50);

  const now = Date.now();
  const fromMs = input.dateFrom ? Date.parse(input.dateFrom) : NaN;
  const toMs = input.dateTo ? Date.parse(input.dateTo) + 86_400_000 : NaN; // inclusive end date

  // Best score per email across all tiers
  const best = new Map<string, number>();
  const collect = (tier: string, hits: { ulid: string; receivedMs: number }[]) => {
    hits.forEach((h, rank) => {
      if (!Number.isNaN(fromMs) && h.receivedMs < fromMs) return;
      if (!Number.isNaN(toMs) && h.receivedMs >= toMs) return;
      const score = hitScore(tier, rank, h.receivedMs, now);
      if ((best.get(h.ulid) ?? -1) < score) best.set(h.ulid, score);
    });
  };

  // Per-tier hit counts, returned to the model so a zero-result search is
  // explainable (and an identical retry is obviously pointless).
  const tiers: Record<string, number | string> = {};

  if (mode !== 'semantic') {
    // Precision first: exact phrase, then all-words (FTS5 AND semantics)
    try {
      const hits = await phraseSearch(query, folderId, limit);
      tiers['exactPhrase'] = hits.length;
      collect('exactPhrase', hits);
    } catch { tiers['exactPhrase'] = 'error'; }
    try {
      const hits = await keywordSearch(query, folderId, limit * 3);
      tiers['allWords'] = hits.length;
      collect('allWords', hits);
    } catch { tiers['allWords'] = 'error'; }
  }
  if (mode !== 'keyword') {
    const vec = await tryEmbedQuery(query);
    if (vec) {
      try {
        const hits = await semanticSearch(vec, folderId, limit);
        tiers['semantic'] = hits.length;
        collect('semantic', hits);
      } catch (err) {
        console.error('[ask-ai] semantic search failed:', err);
        tiers['semantic'] = 'error';
      }
    } else {
      tiers['semantic'] = 'unavailable on this device right now';
    }
  }
  if (mode !== 'semantic') {
    // Recall: any-word (OR) matches, BM25-ranked — natural multi-word
    // queries rarely have every word in one email
    const hits = await anyWordSearch(query, folderId, limit * 3);
    tiers['anyWord'] = hits.length;
    collect('anyWord', hits);

    // Metadata scan: LIKE over sender/subject/preview. Always runs — unlike
    // FTS body_text (which only exists after the background indexer processes
    // an email), these columns cover every synced email unconditionally.
    const db = await getDb();
    const words = [...new Set(query.toLowerCase().split(/\s+/).map(w => w.trim()).filter(w => w.length >= 3))].slice(0, 6);
    if (words.length > 0) {
      const clauses = words.map(() =>
        '(LOWER(subject) LIKE ? OR LOWER(fromName) LIKE ? OR LOWER(fromAddress) LIKE ? OR LOWER(preview) LIKE ?)');
      const bind: unknown[] = [];
      for (const w of words) {
        const pat = `%${w}%`;
        bind.push(pat, pat, pat, pat);
      }
      const whereFolder = folderId ? 'AND folderId = ?' : '';
      if (folderId) bind.push(folderId);
      const rows = await db.selectObjects(
        `SELECT ulid, receivedMs, subject, fromName, fromAddress, preview
         FROM email_metadata WHERE (${clauses.join(' OR ')}) ${whereFolder}
         ORDER BY receivedMs DESC LIMIT ?`,
        [...bind, limit * 4],
      );
      tiers['metadataScan'] = rows.length;
      // Boost multi-word matches so one incidental word doesn't rank with a
      // genuinely relevant email
      for (const [rank, r] of rows.entries()) {
        const haystack = `${r['subject']} ${r['fromName']} ${r['fromAddress']} ${r['preview']}`.toLowerCase();
        const matched = words.filter(w => haystack.includes(w)).length;
        if (!Number.isNaN(fromMs) && (r['receivedMs'] as number) < fromMs) continue;
        if (!Number.isNaN(toMs) && (r['receivedMs'] as number) >= toMs) continue;
        const ulid = r['ulid'] as string;
        const score = hitScore('metadataScan', rank, r['receivedMs'] as number, now) + 0.12 * (matched - 1);
        if ((best.get(ulid) ?? -1) < score) best.set(ulid, score);
      }
    }
  }

  // Index coverage — body-text and semantic search only see emails the
  // background indexer has processed; report so the model (and debugging
  // humans) know when text search is flying partially blind.
  const db2 = await getDb();
  const totalEmails = (await db2.selectValue('SELECT COUNT(*) FROM email_metadata')) as number;
  const bodyIndexed = (await db2.selectValue(
    "SELECT COUNT(*) FROM email_fts WHERE body_text IS NOT NULL AND body_text != ''",
  )) as number;
  const coverageLow = totalEmails > 0 && bodyIndexed / totalEmails < 0.8;

  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]).map(([ulid]) => ulid);
  const results = await summariesByUlids(ranked.slice(0, limit));
  return JSON.stringify({
    results,
    resultCount: results.length,
    tierHits: tiers,
    ranking: 'Results are ordered by match quality blended with recency (newer emails rank higher).',
    indexCoverage: `${bodyIndexed} of ${totalEmails} emails have their body text indexed${coverageLow ? ' — body/semantic search is PARTIALLY BLIND on this device; subject/sender/preview are always covered. Prefer list_emails with sender/date filters when a specific email is expected but not found.' : '.'}`,
    ...(results.length === 0
      ? { note: 'No matches in any tier. Retrying this exact query will return the same result — change the terms, try semantic mode, or use list_emails with filters instead.' }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// list_emails
// ---------------------------------------------------------------------------

interface ListInput {
  folderId?: string;
  fromContains?: string;
  toContains?: string;
  subjectContains?: string;
  unreadOnly?: boolean;
  hasAttachments?: boolean;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}

async function listEmails(input: ListInput): Promise<string> {
  const db = await getDb();
  const where: string[] = [];
  const bind: unknown[] = [];

  if (input.folderId) { where.push('folderId = ?'); bind.push(input.folderId); }
  if (input.fromContains) {
    where.push('(LOWER(fromName) LIKE ? OR LOWER(fromAddress) LIKE ?)');
    const pat = `%${input.fromContains.toLowerCase()}%`;
    bind.push(pat, pat);
  }
  if (input.toContains) {
    where.push('(LOWER(toAddresses) LIKE ? OR LOWER(ccAddresses) LIKE ?)');
    const pat = `%${input.toContains.toLowerCase()}%`;
    bind.push(pat, pat);
  }
  if (input.subjectContains) {
    where.push('LOWER(subject) LIKE ?');
    bind.push(`%${input.subjectContains.toLowerCase()}%`);
  }
  if (input.unreadOnly) where.push('isRead = 0');
  if (input.hasAttachments !== undefined) where.push(`hasAttachments = ${input.hasAttachments ? 1 : 0}`);
  if (input.dateFrom) {
    const ms = Date.parse(input.dateFrom);
    if (!Number.isNaN(ms)) { where.push('receivedMs >= ?'); bind.push(ms); }
  }
  if (input.dateTo) {
    const ms = Date.parse(input.dateTo);
    // inclusive end date — add a day
    if (!Number.isNaN(ms)) { where.push('receivedMs < ?'); bind.push(ms + 24 * 60 * 60 * 1000); }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const offset = Math.max(input.offset ?? 0, 0);

  const totalCount = (await db.selectValue(
    `SELECT COUNT(*) FROM email_metadata ${whereSql}`, bind,
  )) as number;
  const rows = await db.selectObjects(
    `SELECT ${SUMMARY_COLS} FROM email_metadata ${whereSql} ORDER BY receivedMs DESC LIMIT ? OFFSET ?`,
    [...bind, limit, offset],
  );

  return JSON.stringify({ totalCount, offset, results: rows.map(rowToSummary) });
}

// ---------------------------------------------------------------------------
// read_email
// ---------------------------------------------------------------------------

const MAX_BODY_CHARS = 12_000;

/**
 * Fetch + decrypt the authoritative attachment manifest for an email.
 * Returns null when no files are actually stored (pre-attachment-storage
 * emails list filenames in their header but have nothing downloadable).
 */
async function fetchAttachmentMeta(
  id: string,
  privateKey: CryptoKey,
  wrappedEmailKey: string | null,
): Promise<AttachmentMeta[] | null> {
  try {
    const metaBuf = await getEmailAttachments(id);
    const metaBytes = await decryptDual(metaBuf, privateKey, wrappedEmailKey);
    const metas = JSON.parse(new TextDecoder().decode(metaBytes)) as AttachmentMeta[];
    return metas.length > 0 ? metas : null;
  } catch {
    return null;
  }
}

async function readEmail(input: { id?: string }, privateKey: CryptoKey): Promise<string> {
  const id = input.id;
  if (!id || !/^[0-9A-Za-z]{1,64}$/.test(id)) throw new Error('A valid email id is required');

  const db = await getDb();
  const rows = await db.selectObjects(
    `SELECT ulid, subject, fromName, fromAddress, toAddresses, ccAddresses, receivedAt,
            folderId, isRead, hasAttachments, attachmentFilenames, wrappedEmailKey, preview
     FROM email_metadata WHERE ulid = ?`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error(`No email found with id ${id}`);

  const wrappedKey = (row['wrappedEmailKey'] as string | null) ?? null;
  let body = '';
  try {
    body = await fetchEmailText(id, privateKey, wrappedKey);
  } catch (err) {
    console.log('[ask-ai] read_email', id, 'text blob unavailable:', (err as Error).message);
  }
  console.log('[ask-ai] read_email', id, 'text blob length:', body.length);

  // HTML-only emails have an empty — or near-empty stub — plain-text blob.
  // For anything suspiciously short, also extract text from the HTML body
  // blob (what the mail view renders) and keep whichever source is richer.
  let bodyNote: string | undefined;
  if (body.trim().length < 200) {
    try {
      const bodyBuf = await getEmailBody(id);
      const bodyBytes = await decryptDual(bodyBuf, privateKey, wrappedKey);
      const blob = JSON.parse(new TextDecoder().decode(bodyBytes)) as { textBody?: string; htmlBody?: string };
      console.log('[ask-ai] read_email', id, 'body blob: textBody', blob.textBody?.length ?? 0,
        'htmlBody', blob.htmlBody?.length ?? 0);
      const candidates = [
        body,
        (blob.textBody ?? '').trim(),
        htmlToText(blob.htmlBody ?? ''),
      ];
      const best = candidates.reduce((a, b) => (b.trim().length > a.trim().length ? b : a));
      if (best !== body) {
        body = best;
        bodyNote = 'Text extracted from the HTML version of this email.';
      }
      console.log('[ask-ai] read_email', id, 'best body length:', body.trim().length);
    } catch (err) {
      console.error('[ask-ai] read_email', id, 'body blob fallback failed:', err);
    }
  }
  if (!body.trim()) {
    // Last resort: the inbox preview snippet (first ~200 chars, generated at ingest)
    const preview = ((row['preview'] as string | null) ?? '').trim();
    if (preview) {
      body = preview;
      bodyNote = 'Full body text could not be extracted; this is only the inbox preview snippet (~200 chars).';
    } else {
      body = '';
      bodyNote = 'This email has no extractable body text.';
    }
  }

  const truncated = body.length > MAX_BODY_CHARS;
  if (truncated) body = body.slice(0, MAX_BODY_CHARS);

  const parseJsonList = (v: unknown): string[] => {
    try { return JSON.parse((v as string) || '[]'); } catch { return []; }
  };

  // Attachments: report the authoritative stored manifest, not the header
  // filename list — pre-attachment-storage emails advertise filenames that
  // have no downloadable files behind them.
  const headerFilenames = parseJsonList(row['attachmentFilenames']);
  let attachments: unknown[] = [];
  let attachmentsNote: string | undefined;
  if (headerFilenames.length > 0 || (row['hasAttachments'] as number)) {
    const wrappedEmailKey = (row['wrappedEmailKey'] as string | null) ?? null;
    const metas = await fetchAttachmentMeta(id, privateKey, wrappedEmailKey);
    if (metas) {
      attachments = metas.map(m => ({
        filename: m.filename,
        contentType: m.contentType,
        sizeBytes: m.size,
        readable: true,
      }));
    } else {
      attachments = headerFilenames;
      attachmentsNote =
        'Attachment files are NOT stored for this email — read_attachment will fail on it. If the content matters, look for another email in the thread that carries the same attachment.';
    }
  }

  return JSON.stringify({
    id,
    subject: (row['subject'] as string | null) ?? '(no subject)',
    from: `${(row['fromName'] as string | null) ?? ''} <${(row['fromAddress'] as string | null) ?? ''}>`.trim(),
    to: parseJsonList(row['toAddresses']),
    cc: parseJsonList(row['ccAddresses']),
    date: row['receivedAt'],
    folderId: row['folderId'],
    isRead: !!(row['isRead'] as number),
    attachments,
    ...(attachmentsNote ? { attachmentsNote } : {}),
    body,
    ...(bodyNote ? { bodyNote } : {}),
    ...(truncated ? { note: `Body truncated to ${MAX_BODY_CHARS} characters.` } : {}),
  });
}

// ---------------------------------------------------------------------------
// read_attachment
// ---------------------------------------------------------------------------

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENT_CHARS = 15_000;
const MAX_PDF_PAGES = 30;

/** Dual-decrypt (per-email AES key for drafts/sent, RSA-hybrid for inbound). */
async function decryptDual(
  encrypted: ArrayBuffer,
  privateKey: CryptoKey,
  wrappedEmailKey: string | null,
): Promise<ArrayBuffer> {
  if (wrappedEmailKey) {
    const emailKey = await unwrapEmailKey(wrappedEmailKey, privateKey);
    return decryptAttachment(encrypted, emailKey);
  }
  const bytes = await decryptBlob(new Uint8Array(encrypted), privateKey);
  return bytes.buffer as ArrayBuffer;
}

async function extractPdfText(buf: ArrayBuffer): Promise<{ text: string; pages: number; pagesRead: number }> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pagesRead = Math.min(doc.numPages, MAX_PDF_PAGES);
  let text = '';
  for (let p = 1; p <= pagesRead; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map(item => ('str' in item ? item.str : '')).join(' ') + '\n';
    if (text.length > MAX_ATTACHMENT_CHARS * 2) break; // enough — will be truncated anyway
  }
  return { text, pages: doc.numPages, pagesRead };
}

function htmlToText(html: string): string {
  // textContent alone mashes block elements together and leaks <style> CSS —
  // inject newlines at block boundaries and drop non-content elements first.
  const withBreaks = html.replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table)[^>]*>/gi, '$&\n');
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html');
  doc.querySelectorAll('style,script,head,title').forEach(el => el.remove());
  const text = doc.body?.textContent ?? '';
  return text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function readAttachment(
  input: { id?: string; filename?: string },
  privateKey: CryptoKey,
): Promise<string> {
  const { id, filename } = input;
  if (!id || !/^[0-9A-Za-z]{1,64}$/.test(id)) throw new Error('A valid email id is required');
  if (!filename) throw new Error('filename is required');

  const db = await getDb();
  const rows = await db.selectObjects(
    'SELECT wrappedEmailKey, hasAttachments FROM email_metadata WHERE ulid = ?', [id],
  );
  const row = rows[0];
  if (!row) throw new Error(`No email found with id ${id}`);
  const wrappedEmailKey = (row['wrappedEmailKey'] as string | null) ?? null;

  // Attachment metadata lives in an encrypted S3 blob (filenames + ULID-keyed ids)
  const attachments = await fetchAttachmentMeta(id, privateKey, wrappedEmailKey);
  if (!attachments) {
    throw new Error('This email has no downloadable attachments. (Emails received before attachment storage was added may list filenames in their header but have no stored files — try another email in the thread.)');
  }

  // Filename matching, most to least strict: exact → substring → token
  // overlap (tolerates version suffixes and control-char artifacts in stored
  // names) → single-attachment fallback.
  const normalizeTokens = (s: string): string[] =>
    s.toLowerCase().replace(/\.[a-z0-9]+$/, '').split(/[^a-z0-9]+/).filter(t => t.length > 0);

  const wanted = filename.toLowerCase();
  let att = attachments.find(a => a.filename.toLowerCase() === wanted)
    ?? attachments.find(a => a.filename.toLowerCase().includes(wanted));
  let matchNote: string | undefined;
  if (!att) {
    const wantedTokens = normalizeTokens(filename);
    let best: { candidate: AttachmentMeta; score: number } | null = null;
    for (const a of attachments) {
      const tokens = new Set(normalizeTokens(a.filename));
      const matched = wantedTokens.filter(t => tokens.has(t)).length;
      const score = wantedTokens.length ? matched / wantedTokens.length : 0;
      if (!best || score > best.score) best = { candidate: a, score };
    }
    if (best && best.score >= 0.6) {
      att = best.candidate;
      matchNote = `Requested "${filename}"; matched attachment "${att.filename}".`;
    }
  }
  if (!att && attachments.length === 1) {
    att = attachments[0];
    matchNote = `Requested "${filename}"; this email's only attachment is "${att.filename}".`;
  }
  if (!att) {
    throw new Error(`No attachment named "${filename}". Available: ${attachments.map(a => a.filename).join(', ')}`);
  }
  if (att.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment is too large to read (${Math.round(att.size / 1024 / 1024)} MB)`);
  }

  const encrypted = await getAttachmentBlob(id, att.attachmentId);
  const plain = await decryptDual(encrypted, privateKey, wrappedEmailKey);

  const type = (att.contentType || '').toLowerCase();
  const ext = att.filename.toLowerCase().split('.').pop() ?? '';
  let text: string;
  let note: string | undefined;

  if (type.includes('pdf') || ext === 'pdf') {
    const pdf = await extractPdfText(plain);
    text = pdf.text;
    if (pdf.pagesRead < pdf.pages) note = `Read ${pdf.pagesRead} of ${pdf.pages} pages.`;
    if (!text.trim()) note = 'This PDF contains no extractable text (likely scanned images).';
  } else if (type.startsWith('text/html') || ext === 'html' || ext === 'htm') {
    text = htmlToText(new TextDecoder().decode(plain));
  } else if (
    type.startsWith('text/') || type.includes('json') || type.includes('xml') || type.includes('csv')
    || ['txt', 'md', 'csv', 'json', 'xml', 'log', 'ics'].includes(ext)
  ) {
    text = new TextDecoder().decode(plain);
  } else {
    throw new Error(`Cannot extract text from "${att.filename}" (${att.contentType || 'unknown type'}). Only PDF, HTML, and plain-text attachments are readable.`);
  }

  const truncated = text.length > MAX_ATTACHMENT_CHARS;
  if (truncated) text = text.slice(0, MAX_ATTACHMENT_CHARS);

  const notes = [matchNote, note].filter(Boolean).join(' ');
  return JSON.stringify({
    emailId: id,
    filename: att.filename,
    contentType: att.contentType,
    sizeBytes: att.size,
    text,
    ...(notes ? { note: notes } : {}),
    ...(truncated ? { truncatedTo: MAX_ATTACHMENT_CHARS } : {}),
  });
}

// ---------------------------------------------------------------------------
// list_folders
// ---------------------------------------------------------------------------

async function listFolders(): Promise<string> {
  const db = await getDb();
  const rows = await db.selectObjects(
    'SELECT folderId, COUNT(*) as cnt FROM email_metadata WHERE isRead = 0 GROUP BY folderId',
  ) as { folderId: string; cnt: number }[];
  const unread = new Map(rows.map(r => [r.folderId, r.cnt]));

  const custom = useFolderStore.getState().folders;
  const folders = [
    ...SYSTEM_FOLDERS.map(id => ({ id, name: id.charAt(0) + id.slice(1).toLowerCase(), type: 'system', unreadCount: unread.get(id) ?? 0 })),
    ...custom.map(f => ({ id: f.id, name: f.name, type: 'custom', unreadCount: unread.get(f.id) ?? 0 })),
  ];
  return JSON.stringify({ folders });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function executeAiTool(
  name: string,
  input: unknown,
  privateKey: CryptoKey,
): Promise<string> {
  switch (name) {
    case 'search_emails':   return searchEmails(input as SearchInput);
    case 'list_emails':     return listEmails(input as ListInput);
    case 'read_email':      return readEmail(input as { id?: string }, privateKey);
    case 'read_attachment': return readAttachment(input as { id?: string; filename?: string }, privateKey);
    case 'list_folders':    return listFolders();
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

/** Short human-readable description of a tool call, for the activity chips in the chat UI. */
export function describeToolCall(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'search_emails': return `Searching: "${i['query'] ?? ''}"`;
    case 'list_emails': {
      const parts: string[] = [];
      if (i['folderId']) parts.push(String(i['folderId']));
      if (i['fromContains']) parts.push(`from ${i['fromContains']}`);
      if (i['subjectContains']) parts.push(`subject "${i['subjectContains']}"`);
      if (i['unreadOnly']) parts.push('unread');
      if (i['dateFrom'] || i['dateTo']) parts.push(`${i['dateFrom'] ?? '…'} – ${i['dateTo'] ?? 'now'}`);
      return `Listing emails${parts.length ? ` (${parts.join(', ')})` : ''}`;
    }
    case 'read_email':      return 'Reading an email';
    case 'read_attachment': return `Reading attachment: ${(i['filename'] as string) ?? ''}`;
    case 'list_folders':    return 'Checking folders';
    default: return name;
  }
}
