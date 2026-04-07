import { useEffect, useRef, useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAuthStore } from '../../store/authStore';
import { useUiStore } from '../../store/uiStore';
import { useIndexStore } from '../../store/indexStore';
import { useFolderStore, RESERVED_FOLDER_IDS } from '../../store/folderStore';
import { SyncManager } from '../../sync/SyncManager';
import { getDb } from '../../db/Database';
import { keywordSearch, phraseSearch, semanticSearch } from '../../search/searcher';
import { parseSearchQuery, resolveLabelIds, filterByLabels, filterByFolders, filterByReadStatus } from '../../search/labelParser';
import { getEmbedderClient } from '../../search/EmbedderClient';
import { deleteEmail, restoreEmail, bulkUpdateEmails } from '../../api/emails';
import { useLabelStore } from '../../store/labelStore';
import { bulkAssignLabelToEmails, bulkRemoveLabelFromEmails } from '../../db/labelOperations';
import { remoteLogger } from '../../api/logger';
import ThreadRow from './ThreadRow';
import FilterModal, { type EmailFilter } from './FilterModal';
import { prepareEmailsForDisplay, getUlidsFromItem, type EmailOrThread } from '../../utils/threadUtils';

/** System folder display labels. */
const SYSTEM_FOLDER_LABELS: Record<string, string> = {
  INBOX: 'Inbox', SENT: 'Sent', DRAFTS: 'Drafts', ARCHIVE: 'Archive', SPAM: 'Spam', TRASH: 'Trash',
};

/** Folders from which emails cannot be moved to another folder. */
const NO_MOVE_FOLDERS = new Set(['DRAFTS', 'SENT', 'TRASH']);

interface LocalEmail {
  ulid: string;
  threadId: string;
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  preview: string | null;
  receivedAt: string;
  isRead: number;
  labelIds: string;
  s3AttachmentsKey: string | null;
  hasAttachments: number;
}

export default function InboxPane() {
  const { privateKey, publicKey } = useAuthStore();
  const { selectedFolderId, selectFolder, openMobileSidebar, threadViewEnabled } = useUiStore();
  const { enabled: indexEnabled, modelReady } = useIndexStore();
  const { folders, deleteFolder } = useFolderStore();
  const { labels } = useLabelStore();

  const [syncing, setSyncing] = useState(false);
  const [movingSpamToTrash, setMovingSpamToTrash] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<LocalEmail[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selectedUlids, setSelectedUlids] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [moveDropdownOpen, setMoveDropdownOpen] = useState(false);
  const [labelDropdownOpen, setLabelDropdownOpen] = useState(false);
  const moveDropdownRef = useRef<HTMLDivElement>(null);
  const labelDropdownRef = useRef<HTMLDivElement>(null);
  
  // Filter modal state - per folder
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  const [folderFilters, setFolderFilters] = useState<Record<string, EmailFilter>>({});
  // Ulids matching body FTS conditions (keyed by lowercase search term)
  const [bodyMatchUlids, setBodyMatchUlids] = useState<Map<string, Set<string>>>(new Map());

  // Get current folder's filter
  const emailFilter = folderFilters[selectedFolderId] || { operator: 'AND', groups: [] };
  
  const totalFilterConditions = emailFilter.groups.reduce((sum, g) => sum + g.conditions.length, 0);
  
  // Load filters from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('folderFilters');
      if (saved) {
        setFolderFilters(JSON.parse(saved));
      }
    } catch (err) {
      console.error('Failed to load folder filters:', err);
    }
  }, []);
  
  // Run FTS for any body 'contains' conditions whenever the filter changes
  useEffect(() => {
    const bodyTerms: string[] = [];
    for (const group of emailFilter.groups) {
      for (const condition of group.conditions) {
        if (condition.field === 'body' && condition.operator === 'contains' && typeof condition.value === 'string' && condition.value) {
          bodyTerms.push(condition.value.toLowerCase());
        }
      }
    }

    if (bodyTerms.length === 0) {
      setBodyMatchUlids(new Map());
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const db = await getDb();
        const result = new Map<string, Set<string>>();
        for (const term of bodyTerms) {
          const ftsQuery = `body_text : "${term.replace(/"/g, '""')}"`;
          const rows = await db.selectObjects(
            `SELECT m.ulid FROM email_fts
             JOIN email_metadata m ON m.email_id = email_fts.rowid
             WHERE email_fts MATCH ?`,
            [ftsQuery],
          ) as Array<{ ulid: string }>;
          result.set(term, new Set(rows.map(r => r.ulid)));
        }
        if (!cancelled) setBodyMatchUlids(result);
      } catch {
        // FTS unavailable — leave bodyMatchUlids empty (body conditions won't match)
      }
    })();

    return () => { cancelled = true; };
  }, [emailFilter]);

  // Save current folder's filter
  const setEmailFilter = useCallback((filter: EmailFilter) => {
    setFolderFilters(prev => {
      const updated = { ...prev, [selectedFolderId]: filter };
      // Save to localStorage
      try {
        localStorage.setItem('folderFilters', JSON.stringify(updated));
      } catch (err) {
        console.error('Failed to save folder filters:', err);
      }
      return updated;
    });
  }, [selectedFolderId]);

  // Delete-folder confirmation
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletingFolder, setDeletingFolder] = useState(false);

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryClient = useQueryClient();
  const parentRef = useRef<HTMLDivElement>(null);

  // Custom folder info for current view
  const currentCustomFolder = folders.find(f => f.id === selectedFolderId);
  const isCustomFolder = !RESERVED_FOLDER_IDS.has(selectedFolderId);
  const folderLabel = selectedFolderId === 'ALL'
    ? 'All'
    : SYSTEM_FOLDER_LABELS[selectedFolderId]
    ?? currentCustomFolder?.name
    ?? selectedFolderId;
  const isTrash = selectedFolderId === 'TRASH';
  const isSpam = selectedFolderId === 'SPAM';
  const canMoveEmails = !NO_MOVE_FOLDERS.has(selectedFolderId);

  function doSync() {
    if (!privateKey) return;
    const mgr = SyncManager.getInstance(privateKey);
    setSyncing(true);
    setSyncError('');
    const t0 = performance.now();
    mgr.syncNewOnly()
      .then(() => {
        console.log('[InboxPane] syncNewOnly done in', Math.round(performance.now() - t0), 'ms — invalidating query');
        setSyncing(false);
        window.dispatchEvent(new Event('search-refresh-requested'));
        void queryClient.invalidateQueries({ queryKey: ['emails', selectedFolderId] })
          .then(() => console.log('[InboxPane] query invalidated +', Math.round(performance.now() - t0), 'ms total'));
      })
      .catch(err => {
        setSyncing(false);
        setSyncError(err instanceof Error ? err.message : 'Sync failed');
      });
  }

  useEffect(() => {
    setSearchQuery('');
    setSearchResults(null);
    setSelectedUlids(new Set());
    setConfirmingDelete(false);
    setMoveDropdownOpen(false);
    setLabelDropdownOpen(false);
    if (!privateKey) return;
    doSync();
  }, [selectedFolderId, privateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handleRefreshRequest = () => { doSync(); };
    window.addEventListener('inbox-refresh-requested', handleRefreshRequest);
    return () => { window.removeEventListener('inbox-refresh-requested', handleRefreshRequest); };
  }, [privateKey, selectedFolderId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close move dropdown on outside click
  useEffect(() => {
    if (!moveDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (moveDropdownRef.current && !moveDropdownRef.current.contains(e.target as Node)) {
        setMoveDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [moveDropdownOpen]);

  // Close label dropdown on outside click
  useEffect(() => {
    if (!labelDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (labelDropdownRef.current && !labelDropdownRef.current.contains(e.target as Node)) {
        setLabelDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [labelDropdownOpen]);

  const { data: allEmails = [] } = useQuery<LocalEmail[]>({
    queryKey: ['emails', selectedFolderId],
    queryFn: async () => {
      const db = await getDb();
      if (selectedFolderId === 'ALL') {
        return await db.selectObjects(
          `SELECT ulid, threadId, subject, fromName, fromAddress, preview, receivedAt, isRead, labelIds, s3AttachmentsKey, hasAttachments
           FROM email_metadata WHERE folderId NOT IN ('TRASH','SPAM','DRAFTS') ORDER BY receivedMs DESC`,
          [],
        ) as unknown as LocalEmail[];
      }
      return await db.selectObjects(
        `SELECT ulid, threadId, subject, fromName, fromAddress, preview, receivedAt, isRead, labelIds, s3AttachmentsKey, hasAttachments
         FROM email_metadata WHERE folderId = ? ORDER BY receivedMs DESC`,
        [selectedFolderId],
      ) as unknown as LocalEmail[];
    },
    refetchInterval: 2000,
  });

const runSearch = useCallback(async (q: string) => {
  const trimmed = q.trim();
  if (!trimmed) { setSearchResults(null); setSearching(false); return; }

  setSearching(true);
  try {
    const db = await getDb();
    const { labelNames, folderNames, isUnread, queryText } = parseSearchQuery(trimmed);
    console.log(`${JSON.stringify(parseSearchQuery(trimmed))}`);
    const labelIds = resolveLabelIds(labelNames, labels);

    // ── Step 1: Build candidate set from metadata filters ──────────────────
    let candidateSet: Set<string> | null = null;
    const hasFilters = labelIds.length > 0 || folderNames.length > 0 || isUnread !== undefined;

    if (hasFilters) {
      const isAllView = selectedFolderId === 'ALL';
      const rows = await db.selectObjects(
        isAllView
          ? `SELECT ulid, labelIds, folderId, isRead FROM email_metadata WHERE folderId NOT IN ('TRASH','SPAM','DRAFTS') ORDER BY receivedMs DESC LIMIT 10000`
          : folderNames.length > 0
            ? `SELECT ulid, labelIds, folderId, isRead FROM email_metadata ORDER BY receivedMs DESC LIMIT 10000`
            : `SELECT ulid, labelIds, folderId, isRead FROM email_metadata WHERE folderId = ? ORDER BY receivedMs DESC LIMIT 10000`,
        isAllView || folderNames.length > 0 ? [] : [selectedFolderId],
      );

      const emailLabels  = new Map<string, string[]>();
      const emailFolders = new Map<string, string>();
      const emailRead    = new Map<string, boolean>();

      for (const row of rows) {
        const ulid = row['ulid'] as string;
        emailLabels.set(ulid, JSON.parse(row['labelIds'] as string));
        emailFolders.set(ulid, row['folderId'] as string);
        emailRead.set(ulid, (row['isRead'] as number) === 1);
      }

      let candidates = rows.map(r => r['ulid'] as string);
      if (labelIds.length > 0)      candidates = filterByLabels(candidates, labelIds, emailLabels);
      if (folderNames.length > 0)   candidates = filterByFolders(candidates, folderNames, emailFolders);
      if (isUnread !== undefined)    candidates = filterByReadStatus(candidates, isUnread, emailRead);

      if (candidates.length === 0) { setSearchResults([]); return; }
      candidateSet = new Set(candidates);
    }

    // ── Step 2: Text search ─────────────────────────────────────────────────
    if (!queryText) {
      // Filters only — return candidates ordered by recency
      const ordered = Array.from(candidateSet ?? []);
      if (ordered.length === 0) { setSearchResults([]); return; }
      const placeholders = ordered.map(() => '?').join(',');
      const rows = await db.selectObjects(
        `SELECT ulid, threadId, subject, fromName, fromAddress, preview, receivedAt, isRead, labelIds
         FROM email_metadata WHERE ulid IN (${placeholders}) ORDER BY receivedMs DESC`,
        ordered,
      ) as unknown as LocalEmail[];
      setSearchResults(rows);
      return;
    }

    const now = Date.now();
const decayMs = 5 * 365 * 24 * 60 * 60 * 1000;
function recencyScore(receivedMs: number): number {
  return Math.max(0, 1 - (now - receivedMs) / decayMs);
}

    // ── Step 3: Keyword and phrase search ───────────────────────────────────
    type ScoredHit = { ulid: string; phraseScore: number; keywordScore: number; semanticScore: number; finalScore: number };
    const hitMap = new Map<string, ScoredHit>();

    const searchFolderId = selectedFolderId === 'ALL' ? undefined : selectedFolderId;

    // Phrase search (exact phrase)
    const rawPhrase = await phraseSearch(queryText, searchFolderId);
    const phraseHits = candidateSet
      ? rawPhrase.filter(h => candidateSet!.has(h.ulid))
      : rawPhrase;

    if (phraseHits.length > 0) {
      // Normalise BM25 (negative, lower = better) → [0, 1] where 1 = best match
      const scores = phraseHits.map(h => h.score);
      const minS = Math.min(...scores);
      const maxS = Math.max(...scores);
      
      const range = maxS - minS || 1;
      console.log('[search] phrase scores:', phraseHits.slice(0, 5).map(h => h.score));
      console.log('[search] phrase minS:', minS, 'maxS:', maxS, 'range:', range);
      
      for (const hit of phraseHits) {
        const normRelevance = (maxS - hit.score) / range; // flip: most negative → 1.0
        hitMap.set(hit.ulid, {
          ulid: hit.ulid,
          phraseScore: normRelevance,
          keywordScore: 0,
          semanticScore: 0,
          finalScore: 0, // computed after merging semantic
        });
      }
    }

    // Keyword search (any word matches)
    const rawKeyword = await keywordSearch(queryText, searchFolderId);
    const keywordHits = candidateSet
      ? rawKeyword.filter(h => candidateSet!.has(h.ulid))
      : rawKeyword;

    if (keywordHits.length > 0) {
      // Normalise BM25 (negative, lower = better) → [0, 1] where 1 = best match
      const scores = keywordHits.map(h => h.score);
      const minS = Math.min(...scores);
      const maxS = Math.max(...scores);
      
      const range = maxS - minS || 1;
      console.log('[search] keyword scores:', keywordHits.slice(0, 5).map(h => h.score));
      console.log('[search] keyword minS:', minS, 'maxS:', maxS, 'range:', range);
      
      for (const hit of keywordHits) {
        const normRelevance = (maxS - hit.score) / range; // flip: most negative → 1.0
        const existing = hitMap.get(hit.ulid);
        if (existing) {
          existing.keywordScore = normRelevance;
        } else {
          hitMap.set(hit.ulid, {
            ulid: hit.ulid,
            phraseScore: 0,
            keywordScore: normRelevance,
            semanticScore: 0,
            finalScore: 0,
          });
        }
      }
    }

    // ── Step 4: Semantic search ─────────────────────────────────────────────
    if (indexEnabled && modelReady) {
      try {
        const client = getEmbedderClient();
        const [queryVec] = await client.embed([queryText]);
        if (queryVec) {
          let semanticHits = await semanticSearch(queryVec, searchFolderId, 30);
          if (candidateSet) semanticHits = semanticHits.filter(h => candidateSet!.has(h.ulid));

          if (semanticHits.length > 0) {
            // Normalise L2 distance → [0, 1] where 1 = most similar
            const dists = semanticHits.map(h => h.score);
            const minD = Math.min(...dists);
            const maxD = Math.max(...dists);
            const range = maxD - minD || 1;

            for (const hit of semanticHits) {
              const normSimilarity = (maxD - hit.score) / range; // flip: smallest dist → 1.0
              const existing = hitMap.get(hit.ulid);
              if (existing) {
                existing.semanticScore = normSimilarity;
              } else {
                hitMap.set(hit.ulid, {
                  ulid: hit.ulid,
                  phraseScore: 0,
                  keywordScore: 0,
                  semanticScore: normSimilarity,
                  finalScore: 0,
                });
              }
            }
          }
        }
      } catch (err) {
        remoteLogger.warn('InboxPane: semantic search failed', { error: String(err) });
      }
    }

    // ── Step 5: Merge scores ────────────────────────────────────────────────
    // Weights: phrase 30%, keyword 10%, semantic 20%, recency 40%
    // If semantic is disabled: phrase 40%, keyword 15%, recency 45%
    // ── Step 5: Fetch receivedMs + compute final scores ─────────────────────
const allUlids = Array.from(hitMap.keys());
const metaRows = await db.selectObjects(
  `SELECT ulid, receivedMs FROM email_metadata 
   WHERE ulid IN (${allUlids.map(() => '?').join(',')})`,
  allUlids,
);

const receivedMsMap = new Map(
  metaRows.map(r => [r['ulid'] as string, r['receivedMs'] as number])
);

const W_PHRASE   = indexEnabled && modelReady ? 0.30 : 0.40;
const W_KEYWORD  = indexEnabled && modelReady ? 0.10 : 0.15;
const W_SEMANTIC = indexEnabled && modelReady ? 0.20 : 0.00;
const W_RECENCY  = indexEnabled && modelReady ? 0.40 : 0.45;

for (const hit of hitMap.values()) {
  const ms = receivedMsMap.get(hit.ulid);
  if (ms === undefined) {
    // ulid in FTS but not metadata — orphaned index entry, skip
    hitMap.delete(hit.ulid);
    continue;
  }
  const recency = recencyScore(ms);
  hit.finalScore = W_PHRASE   * hit.phraseScore
                 + W_KEYWORD  * hit.keywordScore
                 + W_SEMANTIC * hit.semanticScore
                 + W_RECENCY  * recency;
}

    // Sort descending by finalScore (higher = better)
    const orderedUlids = Array.from(hitMap.values())
      .sort((a, b) => b.finalScore - a.finalScore)
      .map(h => h.ulid)
    if (orderedUlids.length === 0) { setSearchResults([]); return; }

    // ── Step 6: Fetch display rows ──────────────────────────────────────────
    const placeholders = orderedUlids.map(() => '?').join(',');
    const rows = await db.selectObjects(
      `SELECT ulid, threadId, subject, fromName, fromAddress, preview, receivedAt, isRead, labelIds
       FROM email_metadata WHERE ulid IN (${placeholders})`,
      orderedUlids,
    ) as unknown as LocalEmail[];

    // Preserve score order (IN clause doesn't guarantee order)
    const indexMap = new Map(orderedUlids.map((id, i) => [id, i]));
    rows.sort((a, b) => (indexMap.get(a.ulid) ?? 999) - (indexMap.get(b.ulid) ?? 999));

    setSearchResults(rows);
  } catch (err) {
    console.error('Search error:', err);
    setSearchResults(null);
  } finally {
    setSearching(false);
  }
}, [selectedFolderId, indexEnabled, modelReady, labels]);

  // Listen for search refresh events (triggered when marking emails as read)
  useEffect(() => {
    const handleSearchRefresh = () => { 
      if (searchQuery.trim()) {
        void runSearch(searchQuery);
      }
    };
    window.addEventListener('search-refresh-requested', handleSearchRefresh);
    return () => { 
      window.removeEventListener('search-refresh-requested', handleSearchRefresh);
    };
  }, [searchQuery, runSearch]);

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!searchQuery.trim()) { setSearchResults(null); setSearching(false); return; }
    setSearching(true);
    searchTimerRef.current = setTimeout(() => { void runSearch(searchQuery); }, 300);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [searchQuery, runSearch]);

  const isSearchActive = searchQuery.trim().length > 0;
  
  // Apply filters to emails
  const applyFilters = useCallback((emails: LocalEmail[]): LocalEmail[] => {
    if (emailFilter.groups.length === 0) return emails;
    
    return emails.filter(email => {
      // Parse email labels once
      const emailLabelIds: string[] = JSON.parse(email.labelIds || '[]');
      
      // Helper to match string with wildcard support
      const matchString = (text: string, pattern: string, operator: string): boolean => {
        const textLower = text.toLowerCase();
        const patternLower = pattern.toLowerCase();
        
        // Check if pattern has wildcards
        if (patternLower.includes('*')) {
          // Convert wildcard pattern to regex
          const regexPattern = patternLower
            .split('*')
            .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*');
          
          const regex = new RegExp(`^${regexPattern}$`, 'i');
          return regex.test(textLower);
        }
        
        // No wildcards - use operator
        switch (operator) {
          case 'equals': return textLower === patternLower;
          case 'startsWith': return textLower.startsWith(patternLower);
          case 'endsWith': return textLower.endsWith(patternLower);
          case 'contains': return textLower.includes(patternLower);
          default: return false;
        }
      };
      
      // Evaluate each group
      const groupResults = emailFilter.groups.map(group => {
        // Evaluate each condition in the group
        const conditionResults = group.conditions.map(condition => {
          const value = String(condition.value);
          
          switch (condition.field) {
            case 'subject': {
              const subject = email.subject || '';
              return matchString(subject, value, condition.operator);
            }
            
            case 'body': {
              if (condition.operator === 'startsWith') {
                // Preview is the start of the body — valid for startsWith
                return (email.preview || '').toLowerCase().startsWith(value.toLowerCase());
              }
              // 'contains' — matched via FTS (see bodyMatchUlids effect above)
              const term = value.toLowerCase();
              return (bodyMatchUlids.get(term) ?? new Set()).has(email.ulid);
            }
            
            case 'from': {
              const from = (email.fromName || '') + ' ' + (email.fromAddress || '');
              return matchString(from, value, condition.operator);
            }
            
            case 'to':
            case 'cc':
              // These would require fetching full email metadata - skip for now
              return true;
            
            case 'date': {
              const emailDate = new Date(email.receivedAt);
              const compareDate = new Date(value);
              
              switch (condition.operator) {
                case 'before': return emailDate < compareDate;
                case 'after': return emailDate > compareDate;
                case 'between': {
                  if (Array.isArray(condition.value) && condition.value.length === 2) {
                    const startDate = new Date(condition.value[0]);
                    const endDate = new Date(condition.value[1]);
                    return emailDate >= startDate && emailDate <= endDate;
                  }
                  return false;
                }
                default: return false;
              }
            }
            
            case 'hasAttachment': {
              // Use the hasAttachments column (1 = has attachments, 0 = no attachments)
              const hasAttachments = email.hasAttachments === 1;
              
              switch (condition.operator) {
                case 'hasAttachment': return hasAttachments;
                case 'notHasAttachment': return !hasAttachments;
                default: return true;
              }
            }
            
            case 'label': {
              const labelId = value;
              const hasLabel = emailLabelIds.includes(labelId);

              switch (condition.operator) {
                case 'hasLabel': return hasLabel;
                case 'notHasLabel': return !hasLabel;
                default: return false;
              }
            }

            case 'readStatus': {
              const isRead = email.isRead === 1;
              switch (condition.operator) {
                case 'isRead': return isRead;
                case 'isUnread': return !isRead;
                default: return true;
              }
            }

            default:
              return true;
          }
        });
        
        // Combine conditions within group using group operator
        return group.operator === 'AND'
          ? conditionResults.every(r => r)
          : conditionResults.some(r => r);
      });
      
      // Combine groups using root operator
      return emailFilter.operator === 'AND'
        ? groupResults.every(r => r)
        : groupResults.some(r => r);
    });
  }, [emailFilter, bodyMatchUlids]);
  
  const visibleEmails = applyFilters(searchResults ?? allEmails);
  
  // Apply thread grouping if enabled
  const displayItems: EmailOrThread[] = prepareEmailsForDisplay(visibleEmails, threadViewEnabled);
  
  const selectionActive = selectedUlids.size > 0;
  
  // Check if all visible items are selected (considering threads)
  const allVisibleSelected = displayItems.length > 0 && displayItems.every(item => {
    const ulids = getUlidsFromItem(item);
    return ulids.every(ulid => selectedUlids.has(ulid));
  });

  // Virtualizer for efficient rendering of large lists
  const rowVirtualizer = useVirtualizer({
    count: displayItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80, // Approximate height of ThreadRow
    overscan: 5, // Render 5 extra items above/below viewport
  });

  function toggleSelect(item: EmailOrThread) {
    const ulids = getUlidsFromItem(item);
    setSelectedUlids(prev => {
      const next = new Set(prev);
      const allSelected = ulids.every(ulid => next.has(ulid));
      
      if (allSelected) {
        // Deselect all
        ulids.forEach(ulid => next.delete(ulid));
      } else {
        // Select all
        ulids.forEach(ulid => next.add(ulid));
      }
      
      return next;
    });
  }

  function toggleSelectAll() {
    if (allVisibleSelected) {
      setSelectedUlids(new Set());
    } else {
      const allUlids = new Set<string>();
      displayItems.forEach(item => {
        getUlidsFromItem(item).forEach(ulid => allUlids.add(ulid));
      });
      setSelectedUlids(allUlids);
    }
  }

  async function handleTrashSelected() {
    const ulids = Array.from(selectedUlids);
    if (!ulids.length) return;
    setBulkLoading(true);
    
    const db = await getDb();
    const previousStates = new Map<string, { folderId: string; version: number }>();
    
    try {
      // Read current state for each email for optimistic locking
      const placeholders = ulids.map(() => '?').join(',');
      const rows = await db.selectObjects(
        `SELECT ulid, folderId, version FROM email_metadata WHERE ulid IN (${placeholders})`,
        ulids
      );
      
      // Store previous states for rollback
      for (const row of rows) {
        previousStates.set(
          row['ulid'] as string,
          {
            folderId: row['folderId'] as string,
            version: (row['version'] as number) || 1
          }
        );
      }
      
      // Optimistic update: Update local database immediately
      for (const ulid of ulids) {
        await db.exec('UPDATE email_metadata SET folderId = ? WHERE ulid = ?', { bind: ['TRASH', ulid] });
      }
      
      // Sync to server using bulk update
      const updates = ulids.map(ulid => ({
        ulid,
        folderId: 'TRASH',
        version: previousStates.get(ulid)?.version || 1,
      }));
      
      const response = await bulkUpdateEmails(updates);
      
      // Update local database with server responses
      for (const result of response.results) {
        if (result.success) {
          await db.exec(
            'UPDATE email_metadata SET lastUpdatedAt = ?, version = ? WHERE ulid = ?',
            { bind: [result.lastUpdatedAt, result.version, result.ulid] }
          );
        } else {
          // Rollback failed update
          const prevState = previousStates.get(result.ulid);
          if (prevState) {
            await db.exec(
              'UPDATE email_metadata SET folderId = ? WHERE ulid = ?',
              { bind: [prevState.folderId, result.ulid] }
            );
          }
        }
      }
      
      setSelectedUlids(new Set());
      void queryClient.invalidateQueries({ queryKey: ['emails', selectedFolderId] });
      void queryClient.invalidateQueries({ queryKey: ['emails', 'TRASH'] });
      void queryClient.invalidateQueries({ queryKey: ['counts'] });
    } catch (err) {
      // Rollback: Restore previous folder states on error
      for (const [ulid, state] of previousStates) {
        await db.exec(
          'UPDATE email_metadata SET folderId = ? WHERE ulid = ?',
          { bind: [state.folderId, ulid] }
        );
      }
      
      console.error('Failed to trash emails:', err);
    } finally {
      setBulkLoading(false);
    }
  }

  async function handleRestoreSelected() {
    const ulids = Array.from(selectedUlids);
    if (!ulids.length) return;
    setBulkLoading(true);
    try {
      await Promise.all(ulids.map(ulid => restoreEmail(ulid)));
      const db = await getDb();
      for (const ulid of ulids) {
        await db.exec('DELETE FROM email_metadata WHERE ulid = ?', { bind: [ulid] });
      }
      setSelectedUlids(new Set());
      void queryClient.invalidateQueries({ queryKey: ['emails', 'TRASH'] });
      void queryClient.invalidateQueries({ queryKey: ['counts'] });
    } catch (err) {
      console.error('Failed to restore emails:', err);
    } finally {
      setBulkLoading(false);
    }
  }

  async function handleMoveSelected(targetFolderId: string) {
    const ulids = Array.from(selectedUlids);
    if (!ulids.length) return;
    setMoveDropdownOpen(false);
    setBulkLoading(true);
    
    const db = await getDb();
    const previousStates = new Map<string, { folderId: string; version: number }>();
    
    try {
      // Read current state for each email for optimistic locking
      const placeholders = ulids.map(() => '?').join(',');
      const rows = await db.selectObjects(
        `SELECT ulid, folderId, version FROM email_metadata WHERE ulid IN (${placeholders})`,
        ulids
      );
      
      // Store previous states for rollback
      for (const row of rows) {
        previousStates.set(
          row['ulid'] as string,
          {
            folderId: row['folderId'] as string,
            version: (row['version'] as number) || 1
          }
        );
      }
      
      // Optimistic update: Update local database immediately
      for (const ulid of ulids) {
        await db.exec('UPDATE email_metadata SET folderId = ? WHERE ulid = ?', { bind: [targetFolderId, ulid] });
      }
      
      // Sync to server using bulk update
      const updates = ulids.map(ulid => ({
        ulid,
        folderId: targetFolderId,
        version: previousStates.get(ulid)?.version || 1,
      }));
      
      const response = await bulkUpdateEmails(updates);
      
      // Update local database with server responses
      for (const result of response.results) {
        if (result.success) {
          await db.exec(
            'UPDATE email_metadata SET lastUpdatedAt = ?, version = ? WHERE ulid = ?',
            { bind: [result.lastUpdatedAt, result.version, result.ulid] }
          );
        } else {
          // Rollback failed update
          const prevState = previousStates.get(result.ulid);
          if (prevState) {
            await db.exec(
              'UPDATE email_metadata SET folderId = ? WHERE ulid = ?',
              { bind: [prevState.folderId, result.ulid] }
            );
          }
        }
      }
      
      setSelectedUlids(new Set());
      void queryClient.invalidateQueries({ queryKey: ['emails', selectedFolderId] });
      void queryClient.invalidateQueries({ queryKey: ['emails', targetFolderId] });
    } catch (err: any) {
      // Rollback: Restore previous folder states on error
      for (const [ulid, state] of previousStates) {
        await db.exec(
          'UPDATE email_metadata SET folderId = ? WHERE ulid = ?',
          { bind: [state.folderId, ulid] }
        );
      }
      
      console.error('Failed to move emails:', err);
      // Check if any of the errors are 409 Conflict errors
      if (err?.response?.status === 409) {
        // Trigger a sync to refetch the latest versions
        window.dispatchEvent(new Event('inbox-refresh-requested'));
      }
    } finally {
      setBulkLoading(false);
    }
  }

  async function handleBulkToggleRead() {
    const ulids = Array.from(selectedUlids);
    if (!ulids.length) return;
    setBulkLoading(true);
    
    const db = await getDb();
    const previousStates = new Map<string, { isRead: number; version: number }>();
    
    try {
      // Read current state for each email
      const placeholders = ulids.map(() => '?').join(',');
      const rows = await db.selectObjects(
        `SELECT ulid, isRead, version FROM email_metadata WHERE ulid IN (${placeholders})`,
        ulids
      );
      
      // Store previous states for rollback
      for (const row of rows) {
        previousStates.set(
          row['ulid'] as string,
          {
            isRead: (row['isRead'] as number) || 0,
            version: (row['version'] as number) || 1
          }
        );
      }
      
      // Determine if majority are read or unread
      const readCount = rows.filter(row => row['isRead'] === 1).length;
      const shouldMarkAsRead = readCount < ulids.length / 2;
      const newIsRead = shouldMarkAsRead ? 1 : 0;
      
      // Optimistic update: Update local database immediately
      for (const ulid of ulids) {
        await db.exec('UPDATE email_metadata SET isRead = ? WHERE ulid = ?', { bind: [newIsRead, ulid] });
      }
      
      // Sync to server using bulk update
      const updates = ulids.map(ulid => ({
        ulid,
        read: newIsRead === 1,
        version: previousStates.get(ulid)?.version || 1,
      }));
      
      const response = await bulkUpdateEmails(updates);
      
      // Update local database with server responses
      for (const result of response.results) {
        if (result.success) {
          await db.exec(
            'UPDATE email_metadata SET lastUpdatedAt = ?, version = ? WHERE ulid = ?',
            { bind: [result.lastUpdatedAt, result.version, result.ulid] }
          );
        } else {
          // Rollback failed update
          const prevState = previousStates.get(result.ulid);
          if (prevState) {
            await db.exec(
              'UPDATE email_metadata SET isRead = ? WHERE ulid = ?',
              { bind: [prevState.isRead, result.ulid] }
            );
          }
        }
      }
      
      setSelectedUlids(new Set());
      void queryClient.invalidateQueries({ queryKey: ['emails', selectedFolderId] });
      void queryClient.invalidateQueries({ queryKey: ['folderUnreadCounts'] });
      void queryClient.invalidateQueries({ queryKey: ['localUnreadCount'] });
    } catch (err) {
      // Rollback: Restore previous isRead states on error
      for (const [ulid, state] of previousStates) {
        await db.exec(
          'UPDATE email_metadata SET isRead = ? WHERE ulid = ?',
          { bind: [state.isRead, ulid] }
        );
      }
      
      console.error('Failed to toggle read status:', err);
    } finally {
      setBulkLoading(false);
    }
  }

  async function handleBulkToggleLabel(labelId: string) {
    const ulids = Array.from(selectedUlids);
    if (!ulids.length) return;
    setLabelDropdownOpen(false);
    setBulkLoading(true);
    
    try {
      const db = await getDb();
      
      // Check if all selected emails have this label
      const placeholders = ulids.map(() => '?').join(',');
      const rows = await db.selectObjects(
        `SELECT ulid, labelIds FROM email_metadata WHERE ulid IN (${placeholders})`,
        ulids
      ) as Array<{ ulid: string; labelIds: string }>;
      
      const emailsWithLabel = rows.filter(row => {
        const labelIds = JSON.parse(row.labelIds) as string[];
        return labelIds.includes(labelId);
      });
      
      // If all have the label, remove it; otherwise add it
      const shouldRemove = emailsWithLabel.length === ulids.length;
      
      if (shouldRemove) {
        // Remove label from all selected emails
        await bulkRemoveLabelFromEmails(ulids, labelId);
      } else {
        // Add label to all selected emails
        await bulkAssignLabelToEmails(ulids, labelId);
      }
      
      // Refresh the current view
      void queryClient.invalidateQueries({ queryKey: ['emails', selectedFolderId] });
    } catch (err) {
      console.error('Failed to toggle label:', err);
    } finally {
      setBulkLoading(false);
    }
  }

  async function handleMoveSpamToTrash() {
    setMovingSpamToTrash(true);
    try {
      const db = await getDb();
      const rows = await db.selectObjects('SELECT ulid FROM email_metadata WHERE folderId = ?', ['SPAM']);
      const ulids = rows.map(r => r['ulid'] as string);
      if (ulids.length > 0) {
        await Promise.all(ulids.map(ulid => deleteEmail(ulid)));
        for (const ulid of ulids) {
          await db.exec('UPDATE email_metadata SET folderId = ? WHERE ulid = ?', { bind: ['TRASH', ulid] });
        }
        void queryClient.invalidateQueries({ queryKey: ['emails', 'SPAM'] });
        void queryClient.invalidateQueries({ queryKey: ['emails', 'TRASH'] });
      }
    } catch (err) {
      console.error('Failed to move spam to trash:', err);
    } finally {
      setMovingSpamToTrash(false);
    }
  }

  async function handleDeleteFolder() {
    if (!publicKey || !currentCustomFolder) return;
    setDeletingFolder(true);
    try {
      // Move all emails in this folder to trash
      const db = await getDb();
      const rows = await db.selectObjects(
        'SELECT ulid FROM email_metadata WHERE folderId = ?',
        [selectedFolderId],
      );
      const ulids = rows.map(r => r['ulid'] as string);
      if (ulids.length > 0) {
        await Promise.all(ulids.map(ulid => deleteEmail(ulid)));
        for (const ulid of ulids) {
          await db.exec('UPDATE email_metadata SET folderId = ? WHERE ulid = ?', { bind: ['TRASH', ulid] });
        }
      }
      // Remove folder from encrypted list and save
      await deleteFolder(selectedFolderId);
      // Navigate to inbox
      selectFolder('INBOX');
      void queryClient.invalidateQueries({ queryKey: ['emails', 'TRASH'] });
      void queryClient.invalidateQueries({ queryKey: ['counts'] });
    } catch (err) {
      console.error('Failed to delete folder:', err);
    } finally {
      setDeletingFolder(false);
      setConfirmingDelete(false);
    }
  }

  // Targets available for "Move to" (excludes current folder and system restricted ones)
  const moveFolderTargets = [
    ...(selectedFolderId !== 'INBOX'   ? [{ id: 'INBOX',   label: 'Inbox'   }] : []),
    ...(selectedFolderId !== 'ARCHIVE' ? [{ id: 'ARCHIVE', label: 'Archive' }] : []),
    ...folders.filter(f => f.id !== selectedFolderId).map(f => ({ id: f.id, label: f.name })),
  ];

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-950">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 min-h-[52px]">
        {selectionActive ? (
          /* Selection action bar */
          <div className="flex items-center gap-2 w-full">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleSelectAll}
              className="w-4 h-4 rounded border-gray-300 accent-blue-600 cursor-pointer shrink-0"
              title={allVisibleSelected ? 'Deselect all' : 'Select all'}
            />
            <span className="text-sm text-gray-600 dark:text-gray-300 flex-1 min-w-0">
              {selectedUlids.size} selected
            </span>

            {isTrash ? (
              <button
                onClick={() => void handleRestoreSelected()}
                disabled={bulkLoading}
                title="Restore to original folder"
                className="flex items-center gap-1 px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50
                           hover:bg-blue-100 disabled:opacity-40 rounded-lg transition-colors
                           dark:text-blue-400 dark:bg-blue-900/20 dark:hover:bg-blue-900/40"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
                </svg>
                Restore
              </button>
            ) : (
              <>
                {/* Label management */}
                <div className="relative" ref={labelDropdownRef}>
                  <button
                    onClick={() => setLabelDropdownOpen(o => !o)}
                    disabled={bulkLoading}
                    title="Manage labels"
                    className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100
                               hover:bg-gray-200 disabled:opacity-40 rounded-lg transition-colors
                               dark:text-gray-300 dark:bg-gray-800 dark:hover:bg-gray-700"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                      strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
                      <line x1="7" y1="7" x2="7.01" y2="7" />
                    </svg>
                  </button>
                  {labelDropdownOpen && (
                    <div className="absolute left-0 top-full mt-1 z-50 min-w-[180px] bg-white dark:bg-gray-800
                                    border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 overflow-hidden max-h-64 overflow-y-auto">
                      {labels.length === 0 ? (
                        <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                          No labels available
                        </div>
                      ) : (
                        labels.map(label => (
                          <button
                            key={label.id}
                            onClick={() => void handleBulkToggleLabel(label.id)}
                            className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100
                                       dark:text-gray-200 dark:hover:bg-gray-700 transition-colors flex items-center gap-2"
                          >
                            <span
                              className="w-3 h-3 rounded-full shrink-0"
                              style={{ backgroundColor: label.color }}
                            />
                            <span className="truncate">{label.name}</span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>

                {/* Mark as read/unread toggle */}
                <button
                  onClick={() => void handleBulkToggleRead()}
                  disabled={bulkLoading}
                  title="Mark as read/unread"
                  className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100
                             hover:bg-gray-200 disabled:opacity-40 rounded-lg transition-colors
                             dark:text-gray-300 dark:bg-gray-800 dark:hover:bg-gray-700"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>

                {/* Move to folder dropdown — not shown in DRAFTS/SENT/TRASH */}
                {canMoveEmails && moveFolderTargets.length > 0 && (
                  <div className="relative" ref={moveDropdownRef}>
                    <button
                      onClick={() => setMoveDropdownOpen(o => !o)}
                      disabled={bulkLoading}
                      title="Move to folder"
                      className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100
                                 hover:bg-gray-200 disabled:opacity-40 rounded-lg transition-colors
                                 dark:text-gray-300 dark:bg-gray-800 dark:hover:bg-gray-700"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                        strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                      </svg>
                    </button>
                    {moveDropdownOpen && (
                      <div className="absolute left-0 top-full mt-1 z-50 min-w-[140px] bg-white dark:bg-gray-800
                                      border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 overflow-hidden">
                        {moveFolderTargets.map(target => (
                          <button
                            key={target.id}
                            onClick={() => void handleMoveSelected(target.id)}
                            className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100
                                       dark:text-gray-200 dark:hover:bg-gray-700 transition-colors truncate"
                          >
                            {target.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Trash */}
                <button
                  onClick={() => void handleTrashSelected()}
                  disabled={bulkLoading}
                  title="Move to Trash"
                  className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-600 bg-red-50
                             hover:bg-red-100 disabled:opacity-40 rounded-lg transition-colors
                             dark:text-red-400 dark:bg-red-900/20 dark:hover:bg-red-900/40"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" />
                    <path d="M10 11v6M14 11v6M9 6V4h6v2" />
                  </svg>
                </button>
              </>
            )}

            <button
              onClick={() => setSelectedUlids(new Set())}
              className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors
                         dark:text-gray-500 dark:hover:text-gray-300 dark:hover:bg-gray-800"
              title="Clear selection"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        ) : (
          /* Normal header */
          <>
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <button
                onClick={openMobileSidebar}
                aria-label="Open menu"
                className="md:hidden p-1.5 -ml-1 shrink-0 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors
                           dark:text-gray-500 dark:hover:text-gray-300 dark:hover:bg-gray-800"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
              <h2 className="font-semibold text-gray-900 dark:text-gray-100 truncate">{folderLabel}</h2>

              {/* Delete custom folder button */}
              {isCustomFolder && !confirmingDelete && (
                <button
                  onClick={() => setConfirmingDelete(true)}
                  title="Delete folder"
                  className="shrink-0 p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors
                             dark:text-gray-500 dark:hover:text-red-400 dark:hover:bg-red-900/20"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" />
                    <path d="M10 11v6M14 11v6M9 6V4h6v2" />
                  </svg>
                </button>
              )}
            </div>

            <button
              onClick={() => { if (!syncing) doSync(); }}
              disabled={syncing}
              title="Refresh"
              className="shrink-0 p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors
                         disabled:opacity-40 disabled:cursor-not-allowed dark:text-gray-500 dark:hover:text-gray-300 dark:hover:bg-gray-800"
              aria-label="Refresh"
            >
              <svg className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 019-9 9.75 9.75 0 016.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 01-9 9 9.75 9.75 0 01-6.74-2.74L3 16" />
                <path d="M8 16H3v5" />
              </svg>
            </button>
          </>
        )}
      </div>

      {/* Delete folder confirmation banner */}
      {confirmingDelete && (
        <div className="px-4 py-2.5 bg-red-50 border-b border-red-100 dark:bg-red-900/20 dark:border-red-800 flex items-center gap-3">
          <p className="text-xs text-red-700 dark:text-red-300 flex-1 min-w-0">
            Delete <strong>{currentCustomFolder?.name}</strong>? All emails will be moved to Trash.
          </p>
          <button
            onClick={() => void handleDeleteFolder()}
            disabled={deletingFolder}
            className="shrink-0 px-3 py-1 text-xs font-medium bg-red-600 text-white rounded-lg
                       hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            {deletingFolder ? 'Deleting…' : 'Delete'}
          </button>
          <button
            onClick={() => setConfirmingDelete(false)}
            disabled={deletingFolder}
            className="shrink-0 px-3 py-1 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg
                       hover:bg-gray-200 disabled:opacity-50 transition-colors
                       dark:text-gray-300 dark:bg-gray-800 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
        </div>
      )}

      {syncError && (
        <p className="px-4 py-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400">{syncError}</p>
      )}

      {/* Trash folder banner */}
      {isTrash && (
        <div className="px-4 py-2 text-xs text-amber-700 bg-amber-50 border-b border-amber-100
                        dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800">
          Items in Trash are permanently deleted after 30 days.
        </div>
      )}

      {/* Spam folder banner */}
      {isSpam && (
        <div className="flex items-center justify-between px-4 py-2 text-xs text-orange-700 bg-orange-50 border-b border-orange-100
                        dark:bg-orange-900/20 dark:text-orange-400 dark:border-orange-800">
          <span>Messages marked as spam.</span>
          <button
            onClick={() => void handleMoveSpamToTrash()}
            disabled={movingSpamToTrash}
            title="Move all spam to trash"
            className="flex items-center gap-1 ml-4 px-2 py-1 rounded-md font-medium
                       text-orange-700 hover:bg-orange-100 disabled:opacity-40 transition-colors
                       dark:text-orange-400 dark:hover:bg-orange-900/40"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
            </svg>
            {movingSpamToTrash ? 'Moving…' : 'Move all to trash'}
          </button>
        </div>
      )}

      {/* Search */}
      <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700">
        <div className="relative flex items-center gap-2">
          <div className="relative flex-1">
            {searching ? (
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-blue-500 animate-spin"
                viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none"
                viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            )}
            <input
              type="search"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={indexEnabled && modelReady ? 'Search messages (AI + keyword)…' : 'Search messages…'}
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-gray-100 rounded-lg border border-transparent
                         focus:outline-none focus:border-blue-300 focus:bg-white transition-colors
                         dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500 dark:focus:bg-gray-900 dark:focus:border-blue-500"
            />
          </div>
          
          {/* Filter button */}
          <button
            onClick={() => setFilterModalOpen(true)}
            title="Filter emails"
            className={`shrink-0 p-1.5 rounded-lg transition-colors relative ${
              totalFilterConditions > 0
                ? 'text-blue-600 bg-blue-50 hover:bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30 dark:hover:bg-blue-900/50'
                : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:text-gray-500 dark:hover:text-gray-300 dark:hover:bg-gray-800'
            }`}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
            </svg>
            {totalFilterConditions > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 text-[10px] font-bold rounded-full bg-blue-600 text-white flex items-center justify-center">
                {totalFilterConditions}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Filter Modal */}
      <FilterModal
        isOpen={filterModalOpen}
        onClose={() => setFilterModalOpen(false)}
        filter={emailFilter}
        onFilterChange={setEmailFilter}
        sourceFolderId={selectedFolderId}
      />

      {/* Email list */}
      <div 
        ref={parentRef}
        className="flex-1 overflow-y-auto"
      >
        {visibleEmails.length === 0 && !syncing && !searching ? (
          <p className="px-4 py-8 text-sm text-gray-400 text-center dark:text-gray-500">
            {isSearchActive ? 'No results' : 'No messages'}
          </p>
        ) : (
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const item = displayItems[virtualRow.index];
              const ulids = getUlidsFromItem(item);
              const isChecked = ulids.every(ulid => selectedUlids.has(ulid));
              const key = item.isThread ? item.threadId : item.ulid;
              
              return (
                <div
                  key={key}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div className="border-b border-gray-100 dark:border-gray-800">
                    <ThreadRow
                      item={item}
                      isChecked={isChecked}
                      selectionActive={selectionActive}
                      onToggleSelect={() => toggleSelect(item)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
