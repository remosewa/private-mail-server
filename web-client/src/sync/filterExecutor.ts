/**
 * Filter Executor - runs filters against existing emails in the database
 */

import { getDb } from '../db/Database';
import { bulkUpdateEmails, type BulkUpdateRequest } from '../api/emails';
import { evaluateFilter, getBodySearchTerms } from './filterEvaluator';
import type { EmailFilter } from '../api/filters';
import type { EmailHeaderBlob } from '../types';
import { useFilterStore } from '../store/filterStore';

interface FilterExecutionOptions {
  filterId: string;
  filterName: string;
  filter: EmailFilter;
  sourceFolderId?: string; // Only apply filter to emails in this folder
  folderId?: string;
  labelIds?: string[];
  labelMode?: 'add' | 'remove' | 'set';
  markAsRead?: boolean; // true = mark as read, false = mark as unread, undefined = no change
  onProgress?: (processed: number, total: number) => void;
  onComplete?: (updated: number) => void;
  onError?: (error: Error) => void;
}

let cancelRequested = false;

/**
 * Cancel the currently running filter execution
 */
export function cancelFilterExecution() {
  cancelRequested = true;
}

/**
 * Execute a filter against all emails in the database
 * Processes emails in batches of 100 and sends bulk updates
 */
export async function executeFilter(options: FilterExecutionOptions): Promise<void> {
  const { filterId, filterName, filter, sourceFolderId, folderId, labelIds, labelMode, markAsRead, onProgress, onComplete, onError } = options;
  
  cancelRequested = false;
  
  try {
    const db = await getDb();
    
    // Get emails from database - optionally filtered by source folder
    const query = sourceFolderId
      ? `SELECT ulid, folderId, labelIds, isRead, subject, fromName, fromAddress, preview, 
                toAddresses, ccAddresses, receivedAt, s3AttachmentsKey, version, messageId, hasAttachments, attachmentFilenames
         FROM email_metadata
         WHERE folderId = ?
         ORDER BY receivedMs DESC`
      : `SELECT ulid, folderId, labelIds, isRead, subject, fromName, fromAddress, preview, 
                toAddresses, ccAddresses, receivedAt, s3AttachmentsKey, version, messageId, hasAttachments, attachmentFilenames
         FROM email_metadata
         ORDER BY receivedMs DESC`;
    
    const params = sourceFolderId ? [sourceFolderId] : [];
    
    const emails = await db.selectObjects(query, params) as Array<{
      ulid: string;
      folderId: string;
      labelIds: string;
      isRead: number;
      subject: string;
      fromName: string;
      fromAddress: string;
      preview: string;
      toAddresses: string;
      ccAddresses: string;
      receivedAt: string;
      s3AttachmentsKey: string;
      version: number;
      messageId: string | null;
      hasAttachments: number;
      attachmentFilenames: string | null;
    }>;
    
    const total = emails.length;
    let processed = 0;
    let updated = 0;

    // Pre-query FTS for any body conditions (one MATCH per unique term).
    const bodyMatchUlids = new Map<string, Set<string>>();
    for (const term of getBodySearchTerms(filter)) {
      try {
        const ftsQuery = `body_text : "${term.replace(/"/g, '""')}"`;
        const rows = await db.selectObjects(
          `SELECT m.ulid FROM email_fts
           JOIN email_metadata m ON m.email_id = email_fts.rowid
           WHERE email_fts MATCH ?`,
          [ftsQuery],
        ) as Array<{ ulid: string }>;
        bodyMatchUlids.set(term, new Set(rows.map(r => r.ulid)));
      } catch { /* non-fatal */ }
    }

    // First pass: evaluate all emails to count matches
    const matchedEmails: typeof emails = [];

    for (const email of emails) {
      if (cancelRequested) {
        console.log('[FilterExecutor] Execution cancelled');
        return;
      }
      
      // Parse JSON fields
      const parsedLabelIds = JSON.parse(email.labelIds || '[]') as string[];
      const parsedTo = JSON.parse(email.toAddresses || '[]') as string[];
      const parsedCc = JSON.parse(email.ccAddresses || '[]') as string[];
      
      // Build email object for evaluation
      const emailWithHeader = {
        ulid: email.ulid,
        threadId: email.ulid,
        folderId: email.folderId,
        labelIds: parsedLabelIds,
        read: email.isRead === 1,
        receivedAt: email.receivedAt,
        lastUpdatedAt: email.receivedAt,
        version: email.version,
        headerBlob: null,
        wrappedEmailKey: null,
        s3BodyKey: '',
        s3TextKey: '',
        s3EmbeddingKey: '',
        s3AttachmentsKey: email.s3AttachmentsKey,
        messageId: email.messageId ?? null,
        hasAttachments: email.hasAttachments,
        attachmentFilenames: email.attachmentFilenames ?? null,
        header: {
          subject: email.subject,
          fromName: email.fromName,
          fromAddress: email.fromAddress,
          preview: email.preview,
          to: parsedTo,
          cc: parsedCc,
          date: email.receivedAt,
        } as EmailHeaderBlob,
      };
      
      // Evaluate filter
      if (evaluateFilter(filter, emailWithHeader, bodyMatchUlids)) {
        matchedEmails.push(email);
      }
    }
    
    const totalMatched = matchedEmails.length;
    
    console.log(`[FilterExecutor] Found ${totalMatched} matching emails out of ${total} total`);
    
    // Update initial progress with matched count
    useFilterStore.getState().setProgress({
      filterId,
      filterName,
      processed: 0,
      total: totalMatched,
      running: true,
    });
    
    // If no matches, complete immediately
    if (totalMatched === 0) {
      useFilterStore.getState().setProgress(null);
      if (onComplete) {
        onComplete(0);
      }
      return;
    }
    
    // Process matched emails in batches of 100
    const batchSize = 100;
    const updates: BulkUpdateRequest[] = [];
    
    for (const email of matchedEmails) {
      if (cancelRequested) {
        console.log('[FilterExecutor] Execution cancelled');
        useFilterStore.getState().setProgress(null);
        return;
      }
      
      // Parse JSON fields
      const parsedLabelIds = JSON.parse(email.labelIds || '[]') as string[];
      
      // Calculate new state
      let newFolderId = email.folderId;
      let newLabelIds = [...parsedLabelIds];
      let newRead = email.isRead === 1;
      
      if (folderId) {
        newFolderId = folderId;
      }
      
      if (labelIds && labelMode) {
        switch (labelMode) {
          case 'add':
            for (const labelId of labelIds) {
              if (!newLabelIds.includes(labelId)) {
                newLabelIds.push(labelId);
              }
            }
            break;
          case 'remove':
            newLabelIds = newLabelIds.filter(id => !labelIds.includes(id));
            break;
          case 'set':
            newLabelIds = [...labelIds];
            break;
        }
      }
      
      if (markAsRead !== undefined) {
        newRead = markAsRead;
      }
      
      // Check if anything changed
      const folderChanged = newFolderId !== email.folderId;
      const labelsChanged = JSON.stringify(newLabelIds.sort()) !== JSON.stringify(parsedLabelIds.sort());
      const readChanged = newRead !== (email.isRead === 1);
      
      if (folderChanged || labelsChanged || readChanged) {
        const update: BulkUpdateRequest = {
          ulid: email.ulid,
          folderId: newFolderId,
          labelIds: newLabelIds,
          version: email.version,
        };
        
        if (readChanged) {
          update.read = newRead;
        }
        
        updates.push(update);
      }
      
      processed++;
      
      // Send batch if we have 100 updates or reached the end
      if (updates.length >= batchSize || processed === totalMatched) {
        if (updates.length > 0) {
          try {
            const response = await bulkUpdateEmails(updates);
            
            // Count successful updates
            const successCount = response.results.filter(r => r.success).length;
            updated += successCount;
            
            // Update local database with successful changes
            for (const result of response.results) {
              if (result.success) {
                const update = updates.find(u => u.ulid === result.ulid);
                if (update) {
                  const setParts = ['folderId = ?', 'labelIds = ?', 'version = ?', 'lastUpdatedAt = ?'];
                  const binds: unknown[] = [
                    update.folderId,
                    JSON.stringify(update.labelIds),
                    result.version,
                    result.lastUpdatedAt,
                  ];
                  
                  if (update.read !== undefined) {
                    setParts.push('isRead = ?');
                    binds.push(update.read ? 1 : 0);
                  }
                  
                  binds.push(result.ulid);
                  
                  await db.exec(
                    `UPDATE email_metadata 
                     SET ${setParts.join(', ')}
                     WHERE ulid = ?`,
                    { bind: binds }
                  );
                }
              }
            }
            
            updates.length = 0; // Clear the batch
          } catch (error) {
            console.error('[FilterExecutor] Bulk update failed:', error);
            if (onError) {
              onError(error as Error);
            }
          }
        }
      }
      
      // Update progress
      if (processed % 25 === 0 || processed === totalMatched) {
        useFilterStore.getState().setProgress({
          filterId,
          filterName,
          processed,
          total: totalMatched,
          running: true,
        });
        
        if (onProgress) {
          onProgress(processed, totalMatched);
        }
      }
    }
    
    // Clear progress
    useFilterStore.getState().setProgress(null);
    
    if (onComplete) {
      onComplete(updated);
    }
    
    console.log('[FilterExecutor] Execution complete', { processed, updated });
  } catch (error) {
    console.error('[FilterExecutor] Execution failed:', error);
    useFilterStore.getState().setProgress(null);
    if (onError) {
      onError(error as Error);
    }
  }
}
