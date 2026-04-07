/**
 * labelParser.ts — Parse filters from search queries.
 * 
 * Syntax:
 * - labels:name1,name2,"name with spaces"
 * - isUnread:true or isUnread:false
 * - folders:INBOX,SENT,"Custom Folder"
 * 
 * Examples:
 * - "labels:work,urgent" → filters for emails with "work" OR "urgent" labels
 * - "isUnread:true some text" → filters for unread emails AND searches for "some text"
 * - "folders:INBOX,SENT" → filters for emails in INBOX OR SENT folders
 * - "labels:work isUnread:true folders:INBOX" → combines all filters
 */

import type { Label } from '../store/labelStore';

export interface ParsedSearch {
  /** Label names to filter by (OR logic - email must have at least one) */
  labelNames: string[];
  /** Folder names to filter by (OR logic - email must be in at least one) */
  folderNames: string[];
  /** Unread filter (true = unread only, false = read only, undefined = all) */
  isUnread?: boolean;
  /** Remaining query text for keyword/semantic search */
  queryText: string;
}

/**
 * Parse a search query to extract label, folder, and unread filters, plus remaining text.
 * 
 * @param query - The full search query string
 * @returns Parsed filters and remaining query text
 */
export function parseSearchQuery(query: string): ParsedSearch {
  const labelNames: string[] = [];
  const folderNames: string[] = [];
  let isUnread: boolean | undefined = undefined;
  let queryText = query;

  // Match labels: followed by comma-separated names (with optional quotes)
  const labelRegex = /labels:((?:[^,\s"]+|"[^"]*")+(?:,(?:[^,\s"]+|"[^"]*")+)*)/gi;
  const labelMatches = query.matchAll(labelRegex);

  for (const match of labelMatches) {
    const labelPart = match[1];
    const names = parseCommaSeparatedNames(labelPart);
    labelNames.push(...names);
    queryText = queryText.replace(match[0], '').trim();
  }

  // Match folders: followed by comma-separated names (with optional quotes)
  const folderRegex = /folders:((?:[^,\s"]+|"[^"]*")+(?:,(?:[^,\s"]+|"[^"]*")+)*)/gi;
  const folderMatches = query.matchAll(folderRegex);

  for (const match of folderMatches) {
    const folderPart = match[1];
    const names = parseCommaSeparatedNames(folderPart);
    folderNames.push(...names);
    queryText = queryText.replace(match[0], '').trim();
  }

  // Match isUnread:true or isUnread:false
  const unreadRegex = /isUnread:(true|false)/gi;
  const unreadMatch = query.match(unreadRegex);
  
  if (unreadMatch) {
    const value = unreadMatch[0].split(':')[1].toLowerCase();
    isUnread = value === 'true';
    queryText = queryText.replace(unreadMatch[0], '').trim();
  }

  return {
    labelNames: [...new Set(labelNames)], // Deduplicate
    folderNames: [...new Set(folderNames)], // Deduplicate
    isUnread,
    queryText: queryText.trim(),
  };
}

/**
 * Parse comma-separated names, handling quoted names with spaces.
 * Supports both single and double quotes.
 * 
 * Examples:
 * - "work,urgent" → ["work", "urgent"]
 * - '"bug fix",feature' → ["bug fix", "feature"]
 * - 'work,"high priority",bug' → ["work", "high priority", "bug"]
 * - "work,'high priority',bug" → ["work", "high priority", "bug"]
 */
function parseCommaSeparatedNames(part: string): string[] {
  const names: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar: string | null = null;
  
  for (let i = 0; i < part.length; i++) {
    const char = part[i];
    
    if ((char === '"' || char === "'") && !inQuotes) {
      // Start of quoted string
      inQuotes = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuotes) {
      // End of quoted string
      inQuotes = false;
      quoteChar = null;
    } else if (char === ',' && !inQuotes) {
      // Comma outside quotes - separator
      if (current.trim()) {
        names.push(current.trim());
      }
      current = '';
    } else {
      current += char;
    }
  }
  
  // Add the last name
  if (current.trim()) {
    names.push(current.trim());
  }
  
  return names;
}

/**
 * Resolve label names to label IDs using the label store.
 * 
 * @param labelNames - Array of label names to resolve
 * @param labels - All available labels from the label store
 * @returns Array of label IDs (empty array if no matches)
 */
export function resolveLabelIds(labelNames: string[], labels: Label[]): string[] {
  const labelMap = new Map(labels.map(l => [l.name.toLowerCase(), l.id]));
  const labelIds: string[] = [];
  
  for (const name of labelNames) {
    const id = labelMap.get(name.toLowerCase());
    if (id) {
      labelIds.push(id);
    }
  }
  
  return labelIds;
}

/**
 * Filter email ULIDs by label IDs (OR logic - email must have at least one matching label).
 * 
 * @param ulids - Array of email ULIDs to filter
 * @param labelIds - Array of label IDs to filter by
 * @param emailLabels - Map of email ULID to array of label IDs
 * @returns Filtered array of ULIDs
 */
export function filterByLabels(
  ulids: string[],
  labelIds: string[],
  emailLabels: Map<string, string[]>,
): string[] {
  if (labelIds.length === 0) {
    return ulids; // No label filter
  }
  
  return ulids.filter(ulid => {
    const emailLabelIds = emailLabels.get(ulid) ?? [];
    // OR logic: email must have at least one of the specified labels
    return labelIds.some(labelId => emailLabelIds.includes(labelId));
  });
}

/**
 * Filter email ULIDs by folder names (OR logic - email must be in at least one folder).
 * 
 * @param ulids - Array of email ULIDs to filter
 * @param folderNames - Array of folder names to filter by (case-insensitive)
 * @param emailFolders - Map of email ULID to folder ID
 * @returns Filtered array of ULIDs
 */
export function filterByFolders(
  ulids: string[],
  folderNames: string[],
  emailFolders: Map<string, string>,
): string[] {
  if (folderNames.length === 0) {
    return ulids; // No folder filter
  }
  
  const normalizedFolders = folderNames.map(f => f.toUpperCase());
  
  return ulids.filter(ulid => {
    const folderId = emailFolders.get(ulid);
    if (!folderId) return false;
    // OR logic: email must be in at least one of the specified folders
    return normalizedFolders.includes(folderId.toUpperCase());
  });
}

/**
 * Filter email ULIDs by read/unread status.
 * 
 * @param ulids - Array of email ULIDs to filter
 * @param isUnread - true for unread only, false for read only, undefined for all
 * @param emailReadStatus - Map of email ULID to read status (true = read, false = unread)
 * @returns Filtered array of ULIDs
 */
export function filterByReadStatus(
  ulids: string[],
  isUnread: boolean | undefined,
  emailReadStatus: Map<string, boolean>,
): string[] {
  if (isUnread === undefined) {
    return ulids; // No read status filter
  }
  
  return ulids.filter(ulid => {
    const isRead = emailReadStatus.get(ulid) ?? false;
    // isUnread:true means we want unread emails (isRead = false)
    // isUnread:false means we want read emails (isRead = true)
    return isUnread ? !isRead : isRead;
  });
}
