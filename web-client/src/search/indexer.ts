/**
 * indexer.ts — background email indexing.
 *
 * Processes all emails where indexed_at IS NULL in groups of up to BATCH_SIZE:
 *   1. Ensure FTS5 body_text is populated (per email, download text blob if needed).
 *   2. Group emails by s3EmbeddingKey. For each unique batch key, download the
 *      encrypted batch blob once, decrypt, and cache — then store every email's
 *      embedding from that batch without re-downloading. This means the progress
 *      counter jumps by the full group size, not one by one.
 *   3. Emails with no s3EmbeddingKey (or whose ulid isn't in the cached batch)
 *      are chunked, embedded, and queued for upload. Every BATCH_SIZE freshly
 *      computed embeddings are packed into one gzip+RSA-encrypted blob and
 *      uploaded to S3 in a single request.
 */

import { getDb } from '../db/Database';
import { getEmailEmbedding, uploadEmbeddingsBatch } from '../api/emails';
import { decryptBlob, decodeJson, encryptBlob } from '../crypto/BlobCrypto';
import { chunkText } from './chunker';
import { getEmbedderClient } from './EmbedderClient';
import { batchFetchEmailText } from './emailText';
import { remoteLogger } from '../api/logger';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIMS = 384;
const BATCH_SIZE = 100;

export interface IndexingProgress {
  total: number;
  indexed: number;
  running: boolean;
  modelReady: boolean;
}

export interface StartIndexingOpts {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  signal?: AbortSignal;
  onProgress: (p: IndexingProgress) => void;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const tid = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(tid); resolve(); }, { once: true });
  });
}

interface PendingEmbed {
  ulid: string;
  nChunks: number;
  embBytes: Uint8Array;
}

interface CachedEmbed {
  nChunks: number;
  embBytes: Uint8Array;
}

interface BatchJson {
  version: 1;
  model: string;
  embeddings: Array<{ ulid: string; n_chunks: number; emb_data: string }>;
}

type FtsRow = { ulid: string; row: Record<string, unknown>; bodyText: string };

interface PreparedBatch {
  rows: Record<string, unknown>[];
  textMap: Map<string, string>;
  ftsStateMap: Map<string, string>;
  /** FTS rows to write — deferred to the main loop so DB writes don't contend with embedding writes. */
  pendingFtsRows: FtsRow[];
  ftsWritten: number;
  ftsSkipped: number;
}

/**
 * Query the next BATCH_SIZE unindexed emails (excluding currently-processing ones),
 * fetch + decrypt their text blobs, and write FTS rows.
 * Called once upfront and then again concurrently with each embed pass.
 */
async function prepareBatch(
  db: Awaited<ReturnType<typeof getDb>>,
  privateKey: CryptoKey,
  excludeUlids: string[],
  signal?: AbortSignal,
): Promise<PreparedBatch | null> {
  if (signal?.aborted) return null;

  let rows: Record<string, unknown>[];
  if (excludeUlids.length > 0) {
    const excPh = excludeUlids.map(() => '?').join(',');
    rows = await db.selectObjects(
      `SELECT ulid, s3TextKey, s3EmbeddingKey, subject, fromName, fromAddress, preview, wrappedEmailKey
       FROM email_metadata
       WHERE indexed_at IS NULL AND ulid NOT IN (${excPh})
       ORDER BY receivedMs DESC LIMIT ?`,
      [...excludeUlids, BATCH_SIZE],
    );
  } else {
    rows = await db.selectObjects(
      `SELECT ulid, s3TextKey, s3EmbeddingKey, subject, fromName, fromAddress, preview, wrappedEmailKey
       FROM email_metadata
       WHERE indexed_at IS NULL
       ORDER BY receivedMs DESC LIMIT ?`,
      [BATCH_SIZE],
    );
  }

  if (rows.length === 0) return null;

  console.log(`[indexer] Processing batch of ${rows.length} emails`, {
    withEmbeddingKey: rows.filter((r: Record<string, unknown>) => r['s3EmbeddingKey']).length,
    withoutEmbeddingKey: rows.filter((r: Record<string, unknown>) => !r['s3EmbeddingKey']).length,
    withTextKey: rows.filter((r: Record<string, unknown>) => r['s3TextKey']).length,
  });

  const rowsNeedingText = rows.filter((r: Record<string, unknown>) => r['s3TextKey']);
  const ftsStateMap = new Map<string, string>();

  // Check FTS status for ALL rows, not just rowsNeedingText.
  {
    const allUlids = rows.map((r: Record<string, unknown>) => r['ulid'] as string);
    const allPh = allUlids.map(() => '?').join(',');
    // Join via email_id (rowid alias) since email_fts is contentless — can't SELECT body_text from it directly.
    // Instead read body_text from email_fts by rowid join.
    const existingFtsRows = await db.selectObjects(
      `SELECT m.ulid, f.body_text
       FROM email_metadata m
       JOIN email_fts f ON f.rowid = m.email_id
       WHERE m.ulid IN (${allPh})`,
      allUlids,
    ) as Array<{ ulid: string; body_text: string }>;
    for (const r of existingFtsRows) ftsStateMap.set(r.ulid, r.body_text ?? '');
  }

  const ulidsNeedingText = rowsNeedingText
    .map((r: Record<string, unknown>) => r['ulid'] as string)
    .filter((ulid: string) => !ftsStateMap.get(ulid));

  const textMap = new Map<string, string>();
  if (ulidsNeedingText.length > 0) {
    const tFetch = performance.now();
    console.log(`[indexer] Batch fetching ${ulidsNeedingText.length} text blobs`);
    try {
      const entries = ulidsNeedingText.map(ulid => {
        const row = rows.find((r: Record<string, unknown>) => r['ulid'] === ulid);
        return { ulid, wrappedEmailKey: row?.['wrappedEmailKey'] as string | null };
      });
      const fetched = await batchFetchEmailText(entries, privateKey);
      fetched.forEach((text, ulid) => textMap.set(ulid, text));
      console.log(`[indexer] Successfully decrypted ${textMap.size} text blobs in ${Math.round(performance.now() - tFetch)}ms`);
    } catch (err) {
      console.error('[indexer] Batch fetch failed:', err);
    }
  }

  // Build FTS rows but don't write them yet — caller writes them after the embed
  // so network-only prep doesn't contend with the embedding DB writes.
  const pendingFtsRows: FtsRow[] = [];
  let ftsWritten = 0, ftsSkipped = 0;
  for (const row of rows) {
    if (signal?.aborted) break;
    const ulid = row['ulid'] as string;
    const existing = ftsStateMap.get(ulid);
    const hasText = existing !== undefined && existing !== '';
    const bodyText = hasText ? existing : (textMap.get(ulid) ?? '');
    if (existing === undefined || (!hasText && bodyText)) {
      pendingFtsRows.push({ ulid, row, bodyText });
      ftsWritten++;
    } else {
      ftsSkipped++;
    }
  }

  return { rows, textMap, ftsStateMap, pendingFtsRows, ftsWritten, ftsSkipped };
}

export async function startIndexing(opts: StartIndexingOpts): Promise<void> {
  const { privateKey, publicKey, signal, onProgress } = opts;
  const client = getEmbedderClient();

  // s3EmbeddingKey → (ulid → CachedEmbed). Each unique batch file is downloaded
  // at most once per indexing run, then reused for all emails that share its key.
  const batchCache = new Map<string, Map<string, CachedEmbed>>();

  while (!signal?.aborted) {
    const db = await getDb();

    const total = ((await db.selectValue(
      'SELECT COUNT(*) FROM email_metadata WHERE indexed_at IS NULL',
    )) as number) ?? 0;

    const alreadyIndexed = ((await db.selectValue(
      'SELECT COUNT(*) FROM email_metadata WHERE indexed_at IS NOT NULL',
    )) as number) ?? 0;

    if (total === 0) {
      if (!client.modelReady) {
        client.embed(['']).then(() => {
          onProgress({ total: alreadyIndexed, indexed: alreadyIndexed, running: false, modelReady: true });
        }).catch(() => {});
      }
      onProgress({ total: alreadyIndexed, indexed: alreadyIndexed, running: false, modelReady: client.modelReady });
      await delay(30_000, signal);
      continue;
    }

    onProgress({ total: total + alreadyIndexed, indexed: alreadyIndexed, running: true, modelReady: client.modelReady });
    let indexed = 0;
    const pendingUploads: PendingEmbed[] = [];

    // Fetch the first batch, then pipeline: while embedding batch N, pre-fetch batch N+1.
    let prepared = await prepareBatch(db, privateKey, [], signal);

    while (!signal?.aborted && prepared !== null) {
      const { rows, textMap, ftsStateMap, pendingFtsRows, ftsWritten, ftsSkipped } = prepared;
      const currentUlids = rows.map(r => r['ulid'] as string);

      // Step 2: Group by s3EmbeddingKey so each batch file is fetched once.
      const byBatchKey = new Map<string, typeof rows>();
      const noBatchKey: typeof rows = [];
      for (const row of rows) {
        const key = (row['s3EmbeddingKey'] as string | null) ?? null;
        if (key) {
          const g = byBatchKey.get(key) ?? [];
          g.push(row);
          byBatchKey.set(key, g);
        } else {
          noBatchKey.push(row);
        }
      }

      // Step 3: Process emails that have an existing S3 batch.
      // Write FTS rows first (text was fetched in prepareBatch for all emails including byBatchKey)
      if (pendingFtsRows.length > 0) await batchWriteFtsRows(db, pendingFtsRows);
      console.log(`[indexer] FTS: written=${ftsWritten} skipped=${ftsSkipped} textMapSize=${textMap.size}`);

      // Start prefetching next batch NOW — overlaps with the S3 embedding fetches + DB writes below.
      // For byBatchKey-only batches the noBatchKey branch below is skipped, so we need pipelining here too.
      const byBatchKeyNextPromise = byBatchKey.size > 0 && noBatchKey.length === 0
        ? prepareBatch(db, privateKey, currentUlids, signal)
        : null;

      const uncachedKeys = [...byBatchKey.keys()].filter(k => !batchCache.has(k));
      if (uncachedKeys.length > 0) {
        await Promise.all(uncachedKeys.map(async batchKey => {
          const group = byBatchKey.get(batchKey)!;
          const firstUlid = group[0]!['ulid'] as string;
          try {
            const encBytes = await getEmailEmbedding(firstUlid);
            const plainBytes = await decryptBlob(encBytes, privateKey);
            const batchData = decodeJson<BatchJson>(plainBytes);
            const entries = new Map<string, CachedEmbed>();
            if (batchData.version === 1 && batchData.model === MODEL) {
              for (const e of batchData.embeddings) {
                entries.set(e.ulid, {
                  nChunks: e.n_chunks,
                  embBytes: Uint8Array.from(atob(e.emb_data), c => c.charCodeAt(0)),
                });
              }
            }
            batchCache.set(batchKey, entries);
          } catch {
            batchCache.set(batchKey, new Map());
          }
        }));
      }

      // Collect all entries to store using batch operations (3 round-trips instead of O(n*chunks))
      type EmbEntryBK = { ulid: string; nChunks: number; embBytes: Uint8Array };
      const allToStore: EmbEntryBK[] = [];
      const allToMarkIndexed: string[] = [];
      const allToComputeFresh: typeof rows = [];

      for (const [batchKey, group] of byBatchKey) {
        if (signal?.aborted) break;
        const cached = batchCache.get(batchKey)!;
        const groupUlids = group.map(r => r['ulid'] as string);
        const groupPlaceholders = groupUlids.map(() => '?').join(',');
        const alreadyStored = await db.selectObjects(
          `SELECT ulid FROM email_embeddings WHERE ulid IN (${groupPlaceholders}) AND model = ?`,
          [...groupUlids, MODEL],
        ) as Array<{ ulid: string }>;
        const alreadyStoredSet = new Set(alreadyStored.map(r => r.ulid));

        for (const row of group) {
          if (signal?.aborted) break;
          const ulid = row['ulid'] as string;
          const entry = cached.get(ulid);
          if (entry) {
            if (!alreadyStoredSet.has(ulid)) allToStore.push({ ulid, nChunks: entry.nChunks, embBytes: entry.embBytes });
            allToMarkIndexed.push(ulid);
          } else {
            allToComputeFresh.push(row);
          }
        }
        indexed += group.length;
      }

      // Batch-write all embeddings in 3 round-trips (vs O(n*chunks) with storeEmbeddingsNoTx loop)
      await batchStoreEmbeddings(db, allToStore);
      if (allToMarkIndexed.length > 0) await batchMarkIndexed(db, allToMarkIndexed);

      for (const row of allToComputeFresh) {
        if (signal?.aborted) break;
        const ulid = row['ulid'] as string;
        const embed = await computeEmbedding(db, ulid, client).catch(() => null);
        if (embed) pendingUploads.push({ ulid, ...embed });
        else await db.exec("UPDATE email_metadata SET indexed_at = 'error' WHERE ulid = ?", { bind: [ulid] });
      }

      if (byBatchKey.size > 0) {
        onProgress({ total: total + alreadyIndexed, indexed: alreadyIndexed + indexed, running: true, modelReady: client.modelReady });
      }

      // If we pre-fetched the next batch above (byBatchKey-only path), use it now.
      if (byBatchKeyNextPromise) {
        prepared = await byBatchKeyNextPromise;
        continue;
      }

      // Step 4: Compute fresh embeddings for emails with no S3 batch.
      if (noBatchKey.length > 0 && !signal?.aborted) {
        const noBatchUlids = noBatchKey.map(r => r['ulid'] as string);
        const nbPlaceholders = noBatchUlids.map(() => '?').join(',');
        const alreadyStored = await db.selectObjects(
          `SELECT ulid FROM email_embeddings WHERE ulid IN (${nbPlaceholders}) AND model = ?`,
          [...noBatchUlids, MODEL],
        ) as Array<{ ulid: string }>;
        const alreadyStoredSet = new Set(alreadyStored.map(r => r.ulid));

        type ChunkEntry = { ulid: string; chunks: string[]; offset: number };
        const chunkEntries: ChunkEntry[] = [];
        let totalChunks = 0;
        for (const ulid of noBatchUlids) {
          if (alreadyStoredSet.has(ulid)) continue;
          const bodyText = textMap.get(ulid) ?? ftsStateMap.get(ulid) ?? '';
          const chunks = chunkText(bodyText);
          if (chunks.length === 0) continue;
          chunkEntries.push({ ulid, chunks, offset: totalChunks });
          totalChunks += chunks.length;
        }

        // KEY OPTIMIZATION: start pre-fetching next batch while embed runs.
        // The embed takes ~15-20s; fetch+decrypt+FTS takes ~4s — completely hidden.
        const nextBatchPromise = prepareBatch(db, privateKey, currentUlids, signal);

        let allVecs: Float32Array[] = [];
        let embedFailed = false;
        if (totalChunks > 0) {
          const t0 = performance.now();
          try {
            allVecs = await client.embed(chunkEntries.flatMap(e => e.chunks));
            console.log(`[indexer] Embedded ${totalChunks} chunks across ${chunkEntries.length} emails in ${Math.round(performance.now() - t0)}ms`);
          } catch (err) {
            console.error('[indexer] Batch embed failed:', err);
            embedFailed = true;
            await nextBatchPromise.catch(() => {});
            await delay(5000, signal);
            break;
          }
        } else {
          // Nothing to embed — still need to kick off the next batch fetch
          // (already started above); nothing else to do here.
        }

        // Write FTS for this batch now — embed is done so no contention with
        // the next batch's network prep, and it runs sequentially before the
        // embedding DB write so all writes are serialized cleanly.
        console.log(`[indexer] Embedding complete, writing DB...`);

        const processedUlids = new Set<string>();
        const newlyIndexed: string[] = [];
        const tDb = performance.now();
        type EmbEntry = { ulid: string; nChunks: number; embBytes: Uint8Array };
        const toStore: EmbEntry[] = [];
        for (const { ulid, chunks, offset } of chunkEntries) {
          if (signal?.aborted) break;
          if (embedFailed) { processedUlids.add(ulid); continue; }
          try {
            const flat = new Float32Array(chunks.length * DIMS);
            for (let i = 0; i < chunks.length; i++) flat.set(allVecs[offset + i]!, i * DIMS);
            toStore.push({ ulid, nChunks: chunks.length, embBytes: new Uint8Array(flat.buffer) });
            newlyIndexed.push(ulid);
            pendingUploads.push({ ulid, nChunks: chunks.length, embBytes: toStore[toStore.length - 1]!.embBytes });
          } catch (err) {
            remoteLogger.warn('[indexer] Failed to pack embedding for ulid', { ulid, error: String(err) });
          }
          processedUlids.add(ulid);
        }

        if (embedFailed) {
          const errUlids = chunkEntries.map(e => e.ulid).filter(u => !processedUlids.has(u));
          if (errUlids.length > 0) {
            const ph = errUlids.map(() => '?').join(',');
            await db.exec(`UPDATE email_metadata SET indexed_at = 'error' WHERE ulid IN (${ph})`, { bind: errUlids });
          }
        }

        await batchStoreEmbeddings(db, toStore);
        const errorUlids = [...processedUlids].filter(u => !newlyIndexed.includes(u));
        if (errorUlids.length > 0) {
          const ph = errorUlids.map(() => '?').join(',');
          await db.exec(`UPDATE email_metadata SET indexed_at = 'error' WHERE ulid IN (${ph})`, { bind: errorUlids });
        }
        await batchMarkIndexed(db, newlyIndexed);
        await batchMarkIndexed(db, noBatchUlids.filter(u => !processedUlids.has(u)));
        console.log(`[indexer] DB write took ${Math.round(performance.now() - tDb)}ms for ${chunkEntries.length} emails`);

        indexed += noBatchKey.length;
        onProgress({ total: total + alreadyIndexed, indexed: alreadyIndexed + indexed, running: true, modelReady: client.modelReady });

        if (pendingUploads.length >= BATCH_SIZE) {
          await flushPendingUploads(pendingUploads.splice(0, BATCH_SIZE), publicKey).catch(err =>
            remoteLogger.warn('[indexer] Failed to flush embedding uploads', { error: String(err) }),
          );
        }

        // Use the pre-fetched next batch (likely already ready since embed took ~15-20s).
        prepared = await nextBatchPromise;
        continue;
      }

      // No noBatchKey emails — fetch next batch normally.
      prepared = await prepareBatch(db, privateKey, currentUlids, signal);
    }

    if (pendingUploads.length > 0) {
      await flushPendingUploads(pendingUploads.splice(0), publicKey).catch(err =>
        remoteLogger.warn('[indexer] Failed to flush final embedding uploads', { error: String(err) }),
      );
    }

    onProgress({ total: total + alreadyIndexed, indexed: alreadyIndexed + indexed, running: false, modelReady: client.modelReady });
  }
}

// ---------------------------------------------------------------------------
// Batch upload
// ---------------------------------------------------------------------------

async function flushPendingUploads(batch: PendingEmbed[], publicKey: CryptoKey): Promise<void> {
  if (batch.length === 0) return;

  const batchJson: BatchJson = {
    version: 1,
    model: MODEL,
    embeddings: batch.map(({ ulid, nChunks, embBytes }) => ({
      ulid,
      n_chunks: nChunks,
      emb_data: btoa(String.fromCharCode(...embBytes)),
    })),
  };

  const plaintext = new TextEncoder().encode(JSON.stringify(batchJson));
  const encryptedBlob = await encryptBlob(plaintext, publicKey);
  const s3EmbeddingKey = await uploadEmbeddingsBatch(batch.map(e => e.ulid), encryptedBlob);

  // Update local DB so the indexer doesn't re-process these on next run
  if (s3EmbeddingKey) {
    const db = await getDb();
    const ulids = batch.map(e => e.ulid);
    const placeholders = ulids.map(() => '?').join(',');
    await db.exec(
      `UPDATE email_metadata SET s3EmbeddingKey = ? WHERE ulid IN (${placeholders})`,
      { bind: [s3EmbeddingKey, ...ulids] },
    );
  }
}

// ---------------------------------------------------------------------------
// Per-email helpers
// ---------------------------------------------------------------------------



async function batchWriteFtsRows(
  db: Awaited<ReturnType<typeof getDb>>,
  rows: Array<{ ulid: string; row: Record<string, unknown>; bodyText: string }>,
): Promise<void> {
  if (rows.length === 0) return;
  const ulids = rows.map(r => r.ulid);
  const placeholders = ulids.map(() => '?').join(',');

  // Look up email_id (stable rowid alias) for each ulid
  const idRows = await db.selectObjects(
    `SELECT email_id, ulid FROM email_metadata WHERE ulid IN (${placeholders})`,
    ulids,
  ) as Array<{ email_id: number; ulid: string }>;

  // Delete existing FTS rows by rowid, then re-insert
  const rowids = idRows.map(r => r.email_id);
  if (rowids.length > 0) {
    const delPh = rowids.map(() => '?').join(',');
    await db.exec(`DELETE FROM email_fts WHERE rowid IN (${delPh})`, { bind: rowids });
  }

  const valPlaceholders = idRows.map(() => '(?,?,?,?,?,?)').join(',');
  const binds = idRows.flatMap(({ ulid, email_id }) => {
    const r = rows.find(x => x.ulid === ulid)!;
    return [
      email_id,
      (r.row['subject'] as string) ?? '',
      (r.row['fromName'] as string) ?? '',
      (r.row['fromAddress'] as string) ?? '',
      (r.row['preview'] as string) ?? '',
      r.bodyText,
    ];
  });
  await db.exec(
    `INSERT INTO email_fts(rowid, subject, fromName, fromAddress, preview, body_text) VALUES ${valPlaceholders}`,
    { bind: binds },
  );
}

/**
 * Check local DB, chunk, embed, store, and mark indexed.
 * Returns raw embedding data for the caller to queue for batch upload,
 * or null if the email had no text to embed.
 */
async function computeEmbedding(
  db: Awaited<ReturnType<typeof getDb>>,
  ulid: string,
  client: ReturnType<typeof getEmbedderClient>,
): Promise<{ nChunks: number; embBytes: Uint8Array } | null> {
  // Already stored locally?
  const existing = await db.selectObjects(
    'SELECT n_chunks FROM email_embeddings WHERE ulid = ? AND model = ?',
    [ulid, MODEL],
  );
  if (existing.length > 0) {
    await markIndexed(db, ulid);
    return null;
  }

  const ftsRow = await db.selectObjects('SELECT body_text FROM email_fts WHERE ulid = ?', [ulid]);
  const bodyText = (ftsRow[0]?.['body_text'] as string | undefined) ?? '';
  const chunks = chunkText(bodyText);

  if (chunks.length === 0) {
    await markIndexed(db, ulid);
    return null;
  }

  const vecs = await client.embed(chunks);
  const flat = new Float32Array(chunks.length * DIMS);
  for (let i = 0; i < vecs.length; i++) flat.set(vecs[i]!, i * DIMS);
  const embBytes = new Uint8Array(flat.buffer);

  await storeEmbeddings(db, ulid, chunks.length, embBytes);
  await markIndexed(db, ulid);

  return { nChunks: chunks.length, embBytes };
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function storeEmbeddings(
  db: Awaited<ReturnType<typeof getDb>>,
  ulid: string,
  nChunks: number,
  embBytes: Uint8Array,
): Promise<void> {
  const CHUNK_BYTES = DIMS * 4;
  await db.withTransaction(async () => {
    await db.exec(
      `INSERT OR REPLACE INTO email_embeddings(ulid, model, n_chunks, emb_data) VALUES (?, ?, ?, ?)`,
      { bind: [ulid, MODEL, nChunks, embBytes] },
    );
    await db.exec('DELETE FROM email_vecs WHERE ulid = ?', { bind: [ulid] });
    for (let i = 0; i < nChunks; i++) {
      const vec = embBytes.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
      await db.exec(
        'INSERT INTO email_vecs(ulid, chunk_idx, embedding) VALUES (?, ?, ?)',
        { bind: [ulid, i, vec] },
      );
    }
  });
}

async function markIndexed(db: Awaited<ReturnType<typeof getDb>>, ulid: string): Promise<void> {
  await db.exec(
    "UPDATE email_metadata SET indexed_at = datetime('now') WHERE ulid = ?",
    { bind: [ulid] },
  );
}

async function batchMarkIndexed(db: Awaited<ReturnType<typeof getDb>>, ulids: string[]): Promise<void> {
  if (ulids.length === 0) return;
  const placeholders = ulids.map(() => '?').join(',');
  await db.exec(
    `UPDATE email_metadata SET indexed_at = datetime('now') WHERE ulid IN (${placeholders})`,
    { bind: ulids },
  );
}

/** Store a batch of embeddings in 3 round-trips instead of O(n*chunks). */
async function batchStoreEmbeddings(
  db: Awaited<ReturnType<typeof getDb>>,
  entries: Array<{ ulid: string; nChunks: number; embBytes: Uint8Array }>,
): Promise<void> {
  if (entries.length === 0) return;
  const CHUNK_BYTES = DIMS * 4;

  const ulids = entries.map(e => e.ulid);
  const delPh = ulids.map(() => '?').join(',');
  await db.exec(`DELETE FROM email_vecs WHERE ulid IN (${delPh})`, { bind: ulids });

  const embPh = entries.map(() => '(?,?,?,?)').join(',');
  const embBinds = entries.flatMap(({ ulid, nChunks, embBytes }) => [ulid, MODEL, nChunks, embBytes]);
  await db.exec(
    `INSERT OR REPLACE INTO email_embeddings(ulid, model, n_chunks, emb_data) VALUES ${embPh}`,
    { bind: embBinds },
  );

  const vecPh: string[] = [];
  const vecBinds: unknown[] = [];
  for (const { ulid, nChunks, embBytes } of entries) {
    for (let i = 0; i < nChunks; i++) {
      vecPh.push('(?,?,?)');
      vecBinds.push(ulid, i, embBytes.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
    }
  }
  if (vecPh.length > 0) {
    await db.exec(
      `INSERT INTO email_vecs(ulid, chunk_idx, embedding) VALUES ${vecPh.join(',')}`,
      { bind: vecBinds },
    );
  }
}

