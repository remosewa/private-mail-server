/**
 * searcher.ts — FTS5 keyword search and sqlite-vec ANN semantic search.
 *
 * email_fts is a contentless FTS5 table (content='') keyed by email_metadata.email_id.
 * Join via email_fts.rowid = email_metadata.email_id to resolve ulid and other fields.
 */

import { getDb } from '../db/Database';

// ---------------------------------------------------------------------------
// Keyword search (FTS5)
// ---------------------------------------------------------------------------

async function ftsSearch(
  ftsQuery: string,
  folderId?: string,
  limit = 5000,
): Promise<{ ulid: string; score: number; receivedMs: number }[]> {
  const db = await getDb();

  // email_fts is contentless — join via rowid = email_metadata.email_id
  let sql: string;
  let bind: unknown[];

  if (folderId) {
    sql = `
      SELECT m.ulid, bm25(email_fts) AS score, m.receivedMs
      FROM email_fts
      INNER JOIN email_metadata m ON m.email_id = email_fts.rowid
      WHERE email_fts MATCH ?
        AND m.folderId = ?
      ORDER BY bm25(email_fts)
      LIMIT ?
    `;
    bind = [ftsQuery, folderId, limit];
  } else {
    sql = `
      SELECT m.ulid, bm25(email_fts) AS score, m.receivedMs
      FROM email_fts
      INNER JOIN email_metadata m ON m.email_id = email_fts.rowid
      WHERE email_fts MATCH ?
      ORDER BY bm25(email_fts)
      LIMIT ?
    `;
    bind = [ftsQuery, limit];
  }

  const rows = await db.selectObjects(sql, bind);
  return rows.map(r => ({
    ulid: r['ulid'] as string,
    score: r['score'] as number,
    receivedMs: r['receivedMs'] as number,
  }));
}

export async function phraseSearch(
  query: string,
  folderId?: string,
  limit = 5000,
): Promise<{ ulid: string; score: number; receivedMs: number }[]> {
  const ftsQuery = `"${query.replace(/"/g, '""')}"`;
  console.log('[phraseSearch] query:', ftsQuery, '| folderId:', folderId);
  try {
    const rows = await ftsSearch(ftsQuery, folderId, limit);
    console.log('[phraseSearch] rows returned:', rows.length);
    return rows;
  } catch (err) {
    console.error('[phraseSearch] FTS5 query failed:', err, 'ftsQuery:', ftsQuery);
    throw err;
  }
}

export async function keywordSearch(
  query: string,
  folderId?: string,
  limit = 5000,
): Promise<{ ulid: string; score: number; receivedMs: number }[]> {
  const words = query.trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return [];
  const ftsQuery = query.replace(/"/g, '""');
  console.log('[keywordSearch] query:', ftsQuery, '| folderId:', folderId);
  try {
    const rows = await ftsSearch(ftsQuery, folderId, limit);
    console.log('[keywordSearch] rows returned:', rows.length);
    return rows;
  } catch (err) {
    console.error('[keywordSearch] FTS5 query failed:', err, 'ftsQuery:', ftsQuery);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Semantic search — SQL ANN via sqlite-vec vec0 virtual table
// ---------------------------------------------------------------------------

export async function semanticSearch(
  queryEmb: Float32Array,
  folderId?: string,
  limit = 20,
): Promise<{ ulid: string; score: number; receivedMs: number }[]> {
  const db = await getDb();

  const queryBytes = new Uint8Array(queryEmb.buffer, queryEmb.byteOffset, queryEmb.byteLength);
  const candidates = Math.max(200, limit * 20);

  const rows = await db.selectObjects(
    `SELECT v.ulid, v.distance, m.receivedMs
     FROM email_vecs v
     INNER JOIN email_metadata m ON m.ulid = v.ulid
     WHERE v.embedding MATCH ?
     ORDER BY v.distance
     LIMIT ?`,
    [queryBytes, candidates],
  );

  let filtered = rows;
  if (folderId) {
    const folderRows = await db.selectObjects(
      'SELECT ulid FROM email_metadata WHERE folderId = ?',
      [folderId],
    );
    const folderSet = new Set(folderRows.map(r => r['ulid'] as string));
    filtered = rows.filter(r => folderSet.has(r['ulid'] as string));
  }

  const best = new Map<string, { score: number; receivedMs: number }>();
  for (const row of filtered) {
    const ulid = row['ulid'] as string;
    const dist = row['distance'] as number;
    const receivedMs = row['receivedMs'] as number;
    const current = best.get(ulid);
    if (!current || current.score > dist) best.set(ulid, { score: dist, receivedMs });
  }

  return Array.from(best.entries())
    .map(([ulid, { score, receivedMs }]) => ({ ulid, score, receivedMs }))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit);
}
