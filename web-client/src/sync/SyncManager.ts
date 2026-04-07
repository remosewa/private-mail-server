/**
 * SyncManager — delta sync from the Chase Email API into the local SQLite DB.
 *
 * Strategy:
 *   1. Query the local DB for the most recent ULID in the given folder.
 *   2. Page through GET /emails until we encounter a ULID already in the DB
 *      (or exhaust all pages).
 *   3. For each new email:
 *      a. Fetch the s3HeaderKey presigned URL, download the blob, decrypt it.
 *      b. Upsert the decrypted header fields + raw S3 keys into email_metadata.
 *      c. Insert into email_fts for full-text search.
 *      d. Upsert sender + recipients into the contacts table.
 */

import { getDb } from '../db/Database';
import { getUpdates, getUpdatesBefore, type EmailMeta, bulkUpdateEmails, type BulkUpdateRequest, type Label } from '../api/emails';
import { decryptBlob, decryptAttachment, unwrapEmailKey, decodeJson } from '../crypto/BlobCrypto';
import { useSyncStore } from '../store/syncStore';
import type { EmailHeaderBlob } from '../types';
import { subtractSeconds, getEpochUTC } from './timestampUtils';
import { listFilters, type SavedFilter } from '../api/filters';
import { evaluateFiltersForEmail, getBodySearchTermsForFilters } from './filterEvaluator';
import { remoteLogger } from '../api/logger';

export class SyncManager {
  private static instance: SyncManager | null = null;
  private privateKey: CryptoKey;
  private static syncing = false;
  private filters: SavedFilter[] = [];
  private filtersLastFetched = 0;
  private static FILTER_TTL_MS = 5 * 60 * 1000; // 5 minutes
  // undefined = not yet loaded from DB; null = DB was empty; string = last known value
  private cachedLatestTimestamp: string | null | undefined = undefined;

  private constructor(privateKey: CryptoKey) {
    this.privateKey = privateKey;
  }

  /**
   * Get or create the singleton instance.
   * Must be called with a privateKey on first access.
   */
  static getInstance(privateKey?: CryptoKey): SyncManager {
    if (!SyncManager.instance) {
      if (!privateKey) {
        throw new Error('SyncManager: privateKey required for first getInstance() call');
      }
      SyncManager.instance = new SyncManager(privateKey);
    } else if (privateKey) {
      // Update the private key if provided (e.g., after re-login)
      SyncManager.instance.privateKey = privateKey;
    }
    return SyncManager.instance;
  }

  /**
   * Reset the singleton instance (e.g., on logout).
   */
  static reset(): void {
    SyncManager.instance = null;
  }

  /**
   * Force a sync starting from the given date, filling in any emails that
   * may have been missed. Does not delete any local data.
   */
  async syncFrom(fromDate: Date): Promise<void> {
    if (SyncManager.syncing) {
      console.warn('[SyncManager] Sync already in progress');
      return;
    }
    SyncManager.syncing = true;
    try {
      const db = await getDb();
      const existingCount = ((await db.selectValue('SELECT COUNT(*) FROM email_metadata')) as number) ?? 0;
      useSyncStore.getState().setProgress({ syncing: true, synced: existingCount, total: existingCount });
      // Roll cursor back and skip the early-exit optimisation so we page through
      // everything in the window even if some emails are already present locally.
      // Clear localStorage cursor so syncHead uses our rolled-back date, not the stored one.
      localStorage.removeItem('sync_cursor');
      this.cachedLatestTimestamp = fromDate.toISOString();
      await this.syncHead(true);
      // Reset so next regular sync re-reads from the newly written sync_cursor.
      this.cachedLatestTimestamp = undefined;
    } finally {
      SyncManager.syncing = false;
      useSyncStore.getState().setProgress({ syncing: false });
    }
  }

  /**
   * Fire a cheap DB query to wake the OPFS worker so subsequent sync operations don't pay cold-start latency.
   */
  async warmup(): Promise<void> {
    try {
      const db = await getDb();
      await db.selectValue('SELECT 1');
    } catch {
      // ignore
    }
  }

  /**
   * Refresh filters with TTL caching (Fix 5)
   */
  private async refreshFilters(): Promise<void> {
    if (Date.now() - this.filtersLastFetched < SyncManager.FILTER_TTL_MS) return;
    try {
      const res = await listFilters();
      this.filters = res.filters;
      this.filtersLastFetched = Date.now();
      //console.log('[SyncManager] Refreshed filters', { count: this.filters.length });
    } catch (error) {
      console.error('[SyncManager] Failed to refresh filters, keeping stale filters:', error);
      remoteLogger.error('SyncManager: failed to refresh filters', { error: String(error) });
    }
  }

  /**
   * Sync only new emails (head sync). Used for refresh button and new email notifications.
   * This can run concurrently with full sync since it only does head sync.
   */
  async syncNewOnly(): Promise<number> {
    // If a full sync is already running it will have included a head sync — skip to avoid OPFS lock contention.
    if (SyncManager.syncing) {
      //console.log('[SyncManager] Full sync in progress, skipping syncNewOnly');
      return 0;
    }
    try {
      const db = await getDb();

      // Count how many emails we already have
      const existingCount = ((await db.selectValue(
        'SELECT COUNT(*) FROM email_metadata',
      )) as number) ?? 0;

      useSyncStore.getState().setProgress({ syncing: true, synced: existingCount, total: existingCount });

      // Use timestamp-based head sync
      const synced = await this.syncHead();

      return synced;
    } catch (error) {
      throw error;
    } finally {
      if (!SyncManager.syncing) {
        useSyncStore.getState().setProgress({ syncing: false });
      }
    }
  }

  /**
   * Head sync: Get newest emails and recent updates.
   * Queries for all changes (new emails, label modifications, folder moves, etc.) since last sync.
   * Implements the 30-second propagation delay buffer.
   * 
   * Uses lastUpdatedAt > max(local) - 30s to get the most recent changes.
   */
  /**
     * Head sync: Get newest emails and recent updates.
     * Queries for all changes (new emails, label modifications, folder moves, etc.) since last sync.
     * Implements the 30-second propagation delay buffer.
     * 
     * Uses lastUpdatedAt > max(local) - 30s to get the most recent changes.
     */
  async syncHead(skipEarlyExit = false): Promise<number> {
    const db = await getDb();
    // console.log('[SyncManager] syncHead: getDb', Math.round(performance.now() - t0), 'ms');

    // Refresh filters with TTL caching (Fix 5)
    await this.refreshFilters();
    //console.log('[SyncManager] syncHead: refreshFilters done', Math.round(performance.now() - t0), 'ms');

    // Get the most recent lastUpdatedAt — prefer syncCursor (survives refresh) over in-memory cache
    const storedCursor = localStorage.getItem('sync_cursor');
    const usingSyncCursor = storedCursor !== null;
    let latestTimestamp: string | null;
    if (usingSyncCursor) {
      latestTimestamp = storedCursor;
      this.cachedLatestTimestamp = storedCursor;
    } else if (this.cachedLatestTimestamp === undefined) {
      latestTimestamp = await db.selectValue(
        'SELECT MAX(lastUpdatedAt) FROM email_metadata'
      ) as string | null;
      this.cachedLatestTimestamp = latestTimestamp;
      // console.log('[SyncManager] syncHead: got latestTimestamp (DB)', Math.round(performance.now() - t0), 'ms');
    } else {
      latestTimestamp = this.cachedLatestTimestamp;
    }

    // Subtract 30 seconds for propagation delay, or use epoch if no records
    const sinceTimestamp = latestTimestamp
      ? subtractSeconds(latestTimestamp, 30)
      : getEpochUTC();  // Epoch for first sync

    // console.log('[SyncManager] Starting timestamp-based sync', { latestTimestamp, sinceTimestamp });

    // Fix 6: Get initial count once, then increment (avoid repeated COUNT(*))
    let runningCount = ((await db.selectValue(
      'SELECT COUNT(*) FROM email_metadata',
    )) as number) ?? 0;
    // console.log('[SyncManager] syncHead: got count', Math.round(performance.now() - t0), 'ms');

    let synced = 0;
    let nextToken: string | undefined;
    // Track max timestamp seen across all pages — only commit after loop completes (prevents gap on refresh)
    let newMaxTimestamp: string | null = usingSyncCursor ? storedCursor : (this.cachedLatestTimestamp ?? null);

    do {
      const response = await getUpdates(sinceTimestamp, nextToken);
      // console.log('[SyncManager] syncHead: API call done', Math.round(performance.now() - tApi), 'ms', '| total', Math.round(performance.now() - t0), 'ms', { emails: response.emails.length });
      // console.log('[SyncManager] Sync page received', {
      //   emails: response.emails.length,
      //   labels: response.labels.length,
      //   migrations: response.migrations.length,
      //   nextToken: response.nextToken,
      // });

      // Check for clock skew on first page
      if (synced === 0) {
        this.detectClockSkew(response.serverTime);
      }

      // Check if ALL emails in this page are already in our DB with the same version
      // If so, we can skip pagination even if there's a nextToken (migration scenario)
      let allEmailsAlreadyPresent = false;
      if (response.emails.length > 0) {
        const ulids = response.emails.map(e => e.ulid);
        const placeholders = ulids.map(() => '?').join(',');
        const localEmails = await db.selectObjects(
          `SELECT ulid, version FROM email_metadata WHERE ulid IN (${placeholders})`,
          ulids
        ) as Array<{ ulid: string; version: number }>;
        //console.log('[SyncManager] syncHead: version check done', Math.round(performance.now() - t0), 'ms');

        const localVersionMap = new Map(localEmails.map(e => [e.ulid, e.version]));

        // Check if every email in the response is already present with same or newer version
        allEmailsAlreadyPresent = response.emails.every(email => {
          const localVersion = localVersionMap.get(email.ulid);
          return localVersion !== undefined && localVersion >= (email.version ?? 1);
        });

        // Fix 1: Break BEFORE expensive processing
        if (allEmailsAlreadyPresent && !skipEarlyExit) {
          // console.log('[SyncManager] All emails in page already present with current versions, stopping pagination');
          break;
        }
      }

      // Process emails with filter evaluation
      const processed = await this.processEmailBatch(db, response.emails);
      //console.log('[SyncManager] syncHead: processEmailBatch done', Math.round(performance.now() - tBatch), 'ms', '| total', Math.round(performance.now() - t0), 'ms');
      synced += processed;
      runningCount += processed;

      // Track max timestamp across all pages — only commit after loop completes
      for (const email of response.emails) {
        if (email.lastUpdatedAt && (!newMaxTimestamp || email.lastUpdatedAt > newMaxTimestamp)) {
          newMaxTimestamp = email.lastUpdatedAt;
        }
      }

      // Update progress after each batch
      useSyncStore.getState().setProgress({
        synced: runningCount,
        total: runningCount,
      });

      // Upsert labels
      for (const label of response.labels) {
        await this.upsertLabel(db, label);
      }

      // Update migration status
      for (const migration of response.migrations) {
        await this.upsertMigrationStatus(db, migration);
      }

      nextToken = response.nextToken ?? undefined;
    } while (nextToken);

    // Commit the max timestamp seen — safe to advance cursor now that all pages completed
    if (newMaxTimestamp) {
      this.cachedLatestTimestamp = newMaxTimestamp;
      localStorage.setItem('sync_cursor', newMaxTimestamp);
    }

    // Final count update using running count
    useSyncStore.getState().setProgress({
      synced: runningCount,
      total: runningCount,
    });

    //console.log('[SyncManager] Timestamp-based sync complete', { synced, finalCount: runningCount });
    return synced;
  }

  /**
   * Tail sync: Backfill older emails.
   * Queries for emails with lastUpdatedAt < min(local) to fill gaps from interrupted downloads.
   * 
   * Uses lastUpdatedAt < min(local) and pages backward until no more emails are found.
   */
  /**
     * Tail sync: Backfill older emails.
     * Queries for emails with lastUpdatedAt < min(local) to fill gaps from interrupted downloads.
     * 
     * Uses lastUpdatedAt < min(local) and pages backward until no more emails are found.
     */
  async syncTail(): Promise<number> {
    const db = await getDb();

    //console.log('[SyncManager] Starting tail sync (backfill older emails)');

    // Get the oldest lastUpdatedAt from local DB (excluding NULL values)
    const oldestTimestamp = await db.selectValue(
      'SELECT MIN(lastUpdatedAt) FROM email_metadata WHERE lastUpdatedAt IS NOT NULL'
    ) as string | null;

    // If no records, nothing to backfill
    if (!oldestTimestamp) {
      //console.log('[SyncManager] No emails in DB, skipping tail sync');
      return 0;
    }

    // console.log('[SyncManager] Starting tail sync (backfill)', { oldestTimestamp });

    // Fix 2: Get initial count once, then increment
    let runningCount = ((await db.selectValue(
      'SELECT COUNT(*) FROM email_metadata',
    )) as number) ?? 0;

    let synced = 0;
    let nextToken: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const response = await getUpdatesBefore(oldestTimestamp, nextToken);
      // console.log('[SyncManager] Tail sync page received', { 
      //   emails: response.emails.length,
      //   labels: response.labels.length,
      //   migrations: response.migrations.length,
      //   nextToken: response.nextToken,
      // });

      // If no emails returned, we've reached the beginning
      if (response.emails.length === 0) {
        hasMore = false;
        break;
      }

      // Process emails with filter evaluation
      const processed = await this.processEmailBatch(db, response.emails);
      synced += processed;
      runningCount += processed;

      // Update progress every 25 emails using running count
      if (synced % 25 === 0) {
        useSyncStore.getState().setProgress({
          synced: runningCount,
          total: runningCount,
        });
      }

      // Upsert labels
      for (const label of response.labels) {
        await this.upsertLabel(db, label);
      }

      // Update migration status
      for (const migration of response.migrations) {
        await this.upsertMigrationStatus(db, migration);
      }

      nextToken = response.nextToken ?? undefined;

      // If no more pages, we're done
      if (!nextToken) {
        hasMore = false;
      }
    }

    // Final count update using running count
    useSyncStore.getState().setProgress({
      synced: runningCount,
      total: runningCount,
    });

    //console.log('[SyncManager] Tail sync complete', { synced, finalCount: runningCount });
    return synced;
  }

  /**
   * Upsert a label into the local database.
   */
  private async upsertLabel(
        db: Awaited<ReturnType<typeof getDb>>,
        label: Label
      ): Promise<void> {
        try {
          await db.exec(
            `INSERT INTO labels (labelId, name, color, lastUpdatedAt)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(labelId) DO UPDATE SET
               name = excluded.name,
               color = excluded.color,
               lastUpdatedAt = excluded.lastUpdatedAt`,
            { bind: [label.labelId, label.encryptedName, label.color, label.lastUpdatedAt] }
          );
        } catch (err) {
          console.warn('[SyncManager] Failed to upsert label:', err);
          remoteLogger.warn('SyncManager: failed to upsert label', { labelId: label.labelId, error: String(err) });
        }
      }

  /**
   * Upsert migration status into the local database.
   */
  private async upsertMigrationStatus(
    db: Awaited<ReturnType<typeof getDb>>,
    migration: { userId: string; migrationId: string; status: string; progress: number; totalEmails: number; lastUpdatedAt: string }
  ): Promise<void> {
    // Note: migration_status table may not exist yet, so we'll handle gracefully
    try {
      await db.exec(
        `INSERT INTO migration_status (userId, migrationId, status, progress, totalEmails, lastUpdatedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(migrationId) DO UPDATE SET
           status = excluded.status,
           progress = excluded.progress,
           totalEmails = excluded.totalEmails,
           lastUpdatedAt = excluded.lastUpdatedAt`,
        { bind: [migration.userId, migration.migrationId, migration.status, migration.progress, migration.totalEmails, migration.lastUpdatedAt] }
      );
    } catch (err) {
      // Migration status table might not exist yet - that's okay
      console.warn('[SyncManager] Failed to upsert migration status (table may not exist):', err);
      remoteLogger.warn('SyncManager: failed to upsert migration status', { error: String(err) });
    }
  }

  /**
   * Detect clock skew between client and server.
   * Logs a warning and shows user notification if skew > 60 seconds.
   * @param serverTime - Server's current UTC timestamp from sync response
   */
  private detectClockSkew(serverTime: string): void {
    try {
      const serverDate = new Date(serverTime);
      const clientDate = new Date();

      // Calculate absolute difference in milliseconds
      const skewMs = Math.abs(serverDate.getTime() - clientDate.getTime());
      const skewSeconds = Math.floor(skewMs / 1000);

      console.log('[SyncManager] Clock skew check', {
        serverTime,
        clientTime: clientDate.toISOString(),
        skewSeconds
      });

      // Warn if skew > 60 seconds
      if (skewSeconds > 60) {
        console.warn(`[SyncManager] Large clock skew detected: ${skewSeconds} seconds`);

        // Show user notification
        const minutes = Math.floor(skewSeconds / 60);
        const message = minutes > 0
          ? `Your device clock may be off by ${minutes} minute${minutes > 1 ? 's' : ''}. Please check your system time settings.`
          : `Your device clock may be off by ${skewSeconds} seconds. Please check your system time settings.`;

        // Use browser notification API if available
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('Clock Sync Warning', { body: message });
        } else {
          // Fallback to console warning
          console.warn(message);
        }
      }
    } catch (error) {
      console.error('[SyncManager] Failed to detect clock skew:', error);
      remoteLogger.error('SyncManager: failed to detect clock skew', { error: String(error) });
    }
  }


  /**
   * Process a batch of emails: decrypt headers, evaluate filters, apply updates, and save to DB.
   * This is the core processing logic used by both head and tail sync.
   */
  private async processEmailBatch(
    db: Awaited<ReturnType<typeof getDb>>,
    emails: EmailMeta[],
  ): Promise<number> {
    if (emails.length === 0) return 0;

    const t0 = performance.now();

    // Decrypt headers for all emails in parallel
    const headers = await Promise.all(emails.map(email => this.decryptHeader(email)));
    const t1 = performance.now();

    const emailsWithHeaders = emails.map((meta, i) => ({ meta, header: headers[i]! }));

    // For body conditions, query email_fts using MATCH — one query per unique search
    // term. This uses the contentless FTS index (no S3 fetch needed).
    // Only 'contains' is supported since FTS keyword matching is what we have.
    const bodyMatchUlids = new Map<string, Set<string>>();
    const bodyTerms = getBodySearchTermsForFilters(this.filters);
    for (const term of bodyTerms) {
      try {
        // Escape any FTS special characters and wrap in quotes for phrase match.
        const ftsQuery = `body_text : "${term.replace(/"/g, '""')}"`;
        const rows = await db.selectObjects(
          `SELECT m.ulid FROM email_fts
           JOIN email_metadata m ON m.email_id = email_fts.rowid
           WHERE email_fts MATCH ?`,
          [ftsQuery],
        ) as Array<{ ulid: string }>;
        bodyMatchUlids.set(term, new Set(rows.map(r => r.ulid)));
      } catch { /* FTS query failure is non-fatal — body condition won't match */ }
    }

    // Evaluate filters and collect updates
    const filterUpdates: BulkUpdateRequest[] = [];

    for (const { meta, header } of emailsWithHeaders) {
      const emailWithHeader = { ...meta, header };
      const filterResult = evaluateFiltersForEmail(this.filters, emailWithHeader, bodyMatchUlids);

      if (filterResult) {
        // Filter wants to change this email
        const update: BulkUpdateRequest = {
          ulid: meta.ulid,
          folderId: filterResult.folderId,
          labelIds: filterResult.labelIds,
          version: meta.version ?? 1,
        };

        // Include read status if it changed
        if (filterResult.read !== undefined) {
          update.read = filterResult.read;
        }

        filterUpdates.push(update);
      }
    }

    const t2 = performance.now();

    // Send bulk update if we have any filter changes
    if (filterUpdates.length > 0) {
      console.log('[SyncManager] Applying filters to emails', { count: filterUpdates.length });
      try {
        const updateResponse = await bulkUpdateEmails(filterUpdates);

        // Update the email metadata with successful updates
        for (const result of updateResponse.results) {
          if (result.success) {
            const emailIndex = emailsWithHeaders.findIndex(e => e.meta.ulid === result.ulid);
            if (emailIndex !== -1) {
              const update = filterUpdates.find(u => u.ulid === result.ulid);
              if (update) {
                // Update the meta with new values from filter
                emailsWithHeaders[emailIndex].meta.folderId = update.folderId!;
                emailsWithHeaders[emailIndex].meta.labelIds = update.labelIds!;
                emailsWithHeaders[emailIndex].meta.version = result.version!;
                emailsWithHeaders[emailIndex].meta.lastUpdatedAt = result.lastUpdatedAt!;
                if (update.read !== undefined) {
                  emailsWithHeaders[emailIndex].meta.read = update.read;
                }
              }
            }
          } else {
            console.warn('[SyncManager] Filter update failed for email', {
              ulid: result.ulid,
              error: result.error
            });
          }
        }
      } catch (error) {
        console.error('[SyncManager] Bulk update failed, continuing with original email states:', error);
        remoteLogger.error('SyncManager: bulk filter update failed', { error: String(error) });
      }
    }

    const t3 = performance.now();

    // Wrap metadata + contacts in one transaction (no FTS — keeps the transaction fast)
    await db.withTransaction(async () => {
      await Promise.all(emailsWithHeaders.map(({ meta, header }) =>
        this.syncOneWithHeader(db, meta, header)
      ));
      await this.upsertContactsBatch(db, emailsWithHeaders.map(e => e.header));
    });

    // Update FTS after the transaction — preserve existing body_text set by the indexer.
    void Promise.resolve().then(async () => {
      const ulids = emailsWithHeaders.map(e => e.meta.ulid);
      const placeholders = ulids.map(() => '?').join(',');

      // Join email_metadata for email_id and email_fts for existing body_text in one query
      const metaRows = await db.selectObjects(
        `SELECT m.email_id, m.ulid, COALESCE(f.body_text, '') as body_text
         FROM email_metadata m
         LEFT JOIN email_fts f ON f.rowid = m.email_id
         WHERE m.ulid IN (${placeholders})`,
        ulids,
      ) as Array<{ email_id: number; ulid: string; body_text: string }>;

      const headerMap = new Map(emailsWithHeaders.map(e => [e.meta.ulid, e.header]));

      await db.withTransaction(async () => {
        const rowids = metaRows.map(r => r.email_id);
        if (rowids.length > 0) {
          const delPh = rowids.map(() => '?').join(',');
          await db.exec(`DELETE FROM email_fts WHERE rowid IN (${delPh})`, { bind: rowids });
        }
        for (const { email_id, ulid, body_text } of metaRows) {
          const header = headerMap.get(ulid)!;
          await db.exec(
            `INSERT INTO email_fts(rowid, subject, fromName, fromAddress, preview, body_text) VALUES (?,?,?,?,?,?)`,
            { bind: [email_id, header.subject ?? '', header.fromName ?? '', header.fromAddress ?? '', header.preview ?? '', body_text] },
          );
        }
      });
    });

    const t4 = performance.now();

    console.log('[SyncManager] Batch processing timing', {
      emails: emails.length,
      decrypt: Math.round(t1 - t0),
      filters: Math.round(t2 - t1),
      bulkUpdate: Math.round(t3 - t2),
      dbWrite: Math.round(t4 - t3),
      total: Math.round(t4 - t0),
    });

    return emails.length;
  }

  /**
   * Decrypt header blob from email metadata.
   * Returns empty header if decryption fails.
   */
  private async decryptHeader(meta: EmailMeta): Promise<EmailHeaderBlob> {
    let header: EmailHeaderBlob = {
      subject: '', fromName: '', fromAddress: '', preview: '',
      to: [], date: meta.receivedAt,
    };

    try {
      if (meta.headerBlob) {
        const bytes = Uint8Array.from(atob(meta.headerBlob), c => c.charCodeAt(0));
        if (meta.wrappedEmailKey) {
          // Draft/sent: unwrap the per-email AES key, then decrypt the blob
          const emailKey = await unwrapEmailKey(meta.wrappedEmailKey, this.privateKey);
          const plaintext = new Uint8Array(await decryptAttachment(bytes.buffer, emailKey));
          header = decodeJson<EmailHeaderBlob>(plaintext);
        } else {
          // Inbound: RSA-hybrid format
          header = decodeJson<EmailHeaderBlob>(await decryptBlob(bytes.buffer, this.privateKey));
        }

        // Debug logging
        if (header.listUnsubscribe) {
          console.log('[SyncManager] Decrypted header with List-Unsubscribe:', {
            ulid: meta.ulid,
            listUnsubscribe: header.listUnsubscribe,
            listUnsubscribePost: header.listUnsubscribePost,
          });
        }
      }
    } catch (err) {
      remoteLogger.warn('SyncManager: failed to decrypt email header', { ulid: meta.ulid, error: String(err) });
    }

    return header;
  }

  /**
   * Save email with already-decrypted header to database.
   */
  private async syncOneWithHeader(
    db: Awaited<ReturnType<typeof getDb>>,
    meta: EmailMeta,
    header: EmailHeaderBlob,
  ): Promise<void> {
    const receivedMs = new Date(meta.receivedAt).getTime();

    // Debug logging for List-Unsubscribe
    if (header.listUnsubscribe) {
      console.log('[SyncManager] Storing email with List-Unsubscribe:', {
        ulid: meta.ulid,
        listUnsubscribe: header.listUnsubscribe,
        listUnsubscribePost: header.listUnsubscribePost,
      });
    }

    // Fix 1: Remove redundant SELECT - the upsert WHERE clause handles this
    await db.exec(
      `INSERT INTO email_metadata
           (ulid, threadId, folderId, labelIds, receivedAt, receivedMs, isRead,
            s3BodyKey, s3TextKey, s3EmbeddingKey, s3AttachmentsKey,
            subject, fromName, fromAddress, preview, toAddresses, ccAddresses, bccAddresses,
            wrappedEmailKey, listUnsubscribe, listUnsubscribePost, lastUpdatedAt, version, messageId, hasAttachments)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(ulid) DO UPDATE SET
           folderId=excluded.folderId, labelIds=excluded.labelIds,
           isRead=excluded.isRead, wrappedEmailKey=excluded.wrappedEmailKey,
           s3EmbeddingKey=COALESCE(excluded.s3EmbeddingKey, email_metadata.s3EmbeddingKey),
           lastUpdatedAt=excluded.lastUpdatedAt, version=excluded.version, messageId=excluded.messageId, hasAttachments=excluded.hasAttachments
         WHERE excluded.lastUpdatedAt > email_metadata.lastUpdatedAt`,
      {
        bind: [
          meta.ulid, meta.threadId, meta.folderId,
          JSON.stringify(meta.labelIds), meta.receivedAt, receivedMs,
          meta.read ? 1 : 0,
          meta.s3BodyKey, meta.s3TextKey,
          meta.s3EmbeddingKey, meta.s3AttachmentsKey,
          header.subject, header.fromName, header.fromAddress,
          header.preview, JSON.stringify(header.to),
          JSON.stringify(header.cc ?? []),
          JSON.stringify(header.bcc ?? []),
          meta.wrappedEmailKey ?? null,
          header.listUnsubscribe ?? null,
          header.listUnsubscribePost ?? null,
          meta.lastUpdatedAt ?? meta.receivedAt,
          meta.version ?? 1,
          meta.messageId ?? null,
          meta.hasAttachments ?? 0,
        ],
      },
    );

    // Contact upserts moved to batch method
  }

  /**
   * Batch contact upserts (Fix 4)
   * Deduplicate across entire batch and write in one pass
   */
  private async upsertContactsBatch(
    db: Awaited<ReturnType<typeof getDb>>,
    headers: EmailHeaderBlob[],
  ): Promise<void> {
    // Deduplicate across batch first
    const seen = new Map<string, { address: string; name: string; date: string }>();

    for (const header of headers) {
      const candidates = [
        { address: header.fromAddress?.toLowerCase(), name: header.fromName ?? '', date: header.date },
        ...[...(header.to ?? []), ...(header.cc ?? [])].map(a => ({
          address: a.toLowerCase().trim(),
          name: '',
          date: header.date
        }))
      ];

      for (const c of candidates) {
        if (c.address && !seen.has(c.address)) {
          seen.set(c.address, { address: c.address, name: c.name, date: c.date });
        }
      }
    }

    // One INSERT per unique address (already inside outer transaction)
    for (const { address, name, date } of seen.values()) {
      await db.exec(
        `INSERT INTO contacts(address, name, frequency, lastSeen) VALUES(?,?,1,?)
         ON CONFLICT(address) DO UPDATE SET
           frequency=frequency+1, lastSeen=excluded.lastSeen,
           name=CASE WHEN excluded.name!='' THEN excluded.name ELSE name END`,
        { bind: [address, name, date] }
      );
    }
  }

  async sync(): Promise<number> {
    // Prevent concurrent syncs
    if (SyncManager.syncing) {
      console.log('[SyncManager] Sync already in progress, skipping');
      return 0;
    }

    SyncManager.syncing = true;

    try {
      const db = await getDb();

      // Count how many emails we already have
      const existingCount = ((await db.selectValue(
        'SELECT COUNT(*) FROM email_metadata',
      )) as number) ?? 0;

      useSyncStore.getState().setProgress({ syncing: true, synced: existingCount, total: existingCount });

      let synced = 0;

      // 1. Head sync: Get newest emails and updates
      synced += await this.syncHead();

      // 2. Tail sync: Backfill older emails (only if we have some emails already)
      if (existingCount > 0 || synced > 0) {
        synced += await this.syncTail();
      }

      return synced;
    } finally {
      SyncManager.syncing = false;
      useSyncStore.getState().setProgress({ syncing: false });
    }
  }
}

// ---------------------------------------------------------------------------
// Contact upsert — exported so the send flow can call it too
// ---------------------------------------------------------------------------

export async function upsertContacts(
  db: Awaited<ReturnType<typeof getDb>>,
  header: Pick<EmailHeaderBlob, 'fromName' | 'fromAddress' | 'to' | 'cc' | 'date'>,
): Promise<void> {
  const entries: Array<{ address: string; name: string }> = [];

  if (header.fromAddress) {
    entries.push({ address: header.fromAddress.toLowerCase(), name: header.fromName });
  }
  for (const addr of [...(header.to ?? []), ...(header.cc ?? [])]) {
    const a = addr.toLowerCase().trim();
    if (a) entries.push({ address: a, name: '' });
  }

  for (const { address, name } of entries) {
    if (!address) continue;
    await db.exec(
      `INSERT INTO contacts(address, name, frequency, lastSeen)
         VALUES(?, ?, 1, ?)
       ON CONFLICT(address) DO UPDATE SET
         frequency = frequency + 1,
         lastSeen  = excluded.lastSeen,
         name      = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END`,
      { bind: [address, name, header.date] },
    );
  }
}
