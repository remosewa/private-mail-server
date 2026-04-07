/**
 * Filter Evaluator — evaluates email filters and determines actions to apply.
 * 
 * Used during sync to automatically apply filter actions to incoming emails.
 */

import type { EmailMeta } from '../api/emails';
import type { FilterCondition, FilterGroup, EmailFilter, SavedFilter, FilterActions } from '../api/filters';
import type { EmailHeaderBlob } from '../types';

interface EmailWithHeader extends EmailMeta {
  header: EmailHeaderBlob;
}

/**
 * Evaluate a single condition against an email.
 */
function evaluateCondition(condition: FilterCondition, email: EmailWithHeader, bodyMatchUlids?: Map<string, Set<string>>): boolean {
  const { field, operator, value } = condition;

  // Get the field value from the email
  let fieldValue: string | string[] | boolean | Date | null = null;

  switch (field) {
    case 'subject':
      fieldValue = email.header.subject || '';
      break;
    case 'body':
      if (operator === 'startsWith') {
        // Preview is the start of the body — valid for startsWith
        return (email.header.preview || '').toLowerCase().startsWith(String(value).toLowerCase());
      }
      // 'contains' uses FTS MATCH pre-queries run by the caller.
      // bodyMatchUlids is populated by the caller; if absent, body conditions are skipped.
      if (operator !== 'contains') return false;
      return (bodyMatchUlids?.get(String(value).toLowerCase()) ?? new Set()).has(email.ulid);
    case 'from':
      fieldValue = email.header.fromAddress || '';
      break;
    case 'to':
      fieldValue = (email.header.to || []).join(' ');
      break;
    case 'cc':
      fieldValue = (email.header.cc || []).join(' ');
      break;
    case 'date':
      fieldValue = new Date(email.receivedAt);
      break;
    case 'hasAttachment':
      // Check if attachments key exists (simplified check)
      fieldValue = !!email.s3AttachmentsKey;
      break;
    case 'label':
      fieldValue = email.labelIds;
      break;
    case 'readStatus':
      fieldValue = email.read;
      break;
  }

  // Evaluate operator
  switch (operator) {
    case 'equals':
      if (field === 'hasAttachment') {
        return fieldValue === (value === 'true');
      }
      return String(fieldValue).toLowerCase() === String(value).toLowerCase();

    case 'startsWith':
      if (value === '*') return true; // Wildcard matches everything
      return String(fieldValue).toLowerCase().startsWith(String(value).toLowerCase());

    case 'endsWith':
      if (value === '*') return true; // Wildcard matches everything
      return String(fieldValue).toLowerCase().endsWith(String(value).toLowerCase());

    case 'contains':
      if (value === '*') return true; // Wildcard matches everything
      return String(fieldValue).toLowerCase().includes(String(value).toLowerCase());

    case 'before':
      if (fieldValue instanceof Date && typeof value === 'string') {
        return fieldValue < new Date(value);
      }
      return false;

    case 'after':
      if (fieldValue instanceof Date && typeof value === 'string') {
        return fieldValue > new Date(value);
      }
      return false;

    case 'between':
      if (fieldValue instanceof Date && Array.isArray(value) && value.length === 2) {
        const start = new Date(value[0]);
        const end = new Date(value[1]);
        return fieldValue >= start && fieldValue <= end;
      }
      return false;

    case 'hasLabel':
      if (Array.isArray(fieldValue) && typeof value === 'string') {
        return fieldValue.includes(value);
      }
      return false;

    case 'notHasLabel':
      if (Array.isArray(fieldValue) && typeof value === 'string') {
        return !fieldValue.includes(value);
      }
      return false;

    case 'isRead':
      return fieldValue === true;

    case 'isUnread':
      return fieldValue === false;

    default:
      return false;
  }
}

/**
 * Evaluate a filter group against an email.
 */
function evaluateGroup(group: FilterGroup, email: EmailWithHeader, bodyMatchUlids?: Map<string, Set<string>>): boolean {
  if (group.conditions.length === 0) return false;

  if (group.operator === 'AND') {
    return group.conditions.every(condition => evaluateCondition(condition, email, bodyMatchUlids));
  } else {
    return group.conditions.some(condition => evaluateCondition(condition, email, bodyMatchUlids));
  }
}

/**
 * Extract unique lowercase body 'contains' search terms from a single filter.
 * Used by the caller to pre-query email_fts before evaluation.
 */
export function getBodySearchTerms(filter: EmailFilter): string[] {
  const terms = new Set<string>();
  for (const g of filter.groups) {
    for (const c of g.conditions) {
      if (c.field === 'body' && c.operator === 'contains' && typeof c.value === 'string' && c.value) {
        terms.add(c.value.toLowerCase());
      }
    }
  }
  return [...terms];
}

/**
 * Extract unique body search terms across all active saved filters.
 */
export function getBodySearchTermsForFilters(filters: SavedFilter[]): string[] {
  const terms = new Set<string>();
  for (const f of filters) {
    for (const t of getBodySearchTerms(f.filter)) terms.add(t);
  }
  return [...terms];
}

/**
 * Evaluate a complete filter against an email.
 */
export function evaluateFilter(filter: EmailFilter, email: EmailWithHeader, bodyMatchUlids?: Map<string, Set<string>>): boolean {
  if (filter.groups.length === 0) return false;

  if (filter.operator === 'AND') {
    return filter.groups.every(group => evaluateGroup(group, email, bodyMatchUlids));
  } else {
    return filter.groups.some(group => evaluateGroup(group, email, bodyMatchUlids));
  }
}

/**
 * Apply filter actions to an email and return the resulting state.
 * Does not modify the email object, returns new folderId, labelIds, and read status.
 */
function applyFilterActions(
  actions: FilterActions,
  currentFolderId: string,
  currentLabelIds: string[],
  currentRead: boolean
): { folderId: string; labelIds: string[]; read: boolean } {
  let folderId = currentFolderId;
  let labelIds = [...currentLabelIds];
  let read = currentRead;

  // Apply folder action
  if (actions.folder) {
    folderId = actions.folder;
  }

  // Apply label actions
  if (actions.labels) {
    const { mode, labelIds: actionLabelIds } = actions.labels;

    switch (mode) {
      case 'add':
        // Add labels that aren't already present
        for (const labelId of actionLabelIds) {
          if (!labelIds.includes(labelId)) {
            labelIds.push(labelId);
          }
        }
        break;

      case 'remove':
        // Remove specified labels
        labelIds = labelIds.filter(id => !actionLabelIds.includes(id));
        break;

      case 'set':
        // Replace all labels
        labelIds = [...actionLabelIds];
        break;
    }
  }

  // Apply read/unread action
  if (actions.markAsRead !== undefined) {
    read = actions.markAsRead;
  }

  return { folderId, labelIds, read };
}

/**
 * Evaluate all enabled filters against an email and determine the final state.
 * 
 * Filters are sorted by name and applied in reverse order (last filter wins).
 * Only filters with mode='always' and enabled=true are evaluated.
 * 
 * Returns null if no changes needed, or { folderId, labelIds, read } if changes should be applied.
 */
export function evaluateFiltersForEmail(
  filters: SavedFilter[],
  email: EmailWithHeader,
  bodyMatchUlids?: Map<string, Set<string>>,
): { folderId: string; labelIds: string[]; read?: boolean } | null {
  // Filter to only enabled "always" filters
  const enabledFilters = filters.filter(
    f => f.actions?.mode === 'always' && f.actions
  );

  if (enabledFilters.length === 0) {
    return null;
  }

  // Sort by name and reverse (last filter wins)
  const sortedFilters = [...enabledFilters].sort((a, b) => a.name.localeCompare(b.name)).reverse();

  let folderId = email.folderId;
  let labelIds = [...email.labelIds];
  let read = email.read;
  let hasChanges = false;

  // Apply each matching filter's actions
  for (const filter of sortedFilters) {
    if (evaluateFilter(filter.filter, email, bodyMatchUlids)) {
      const result = applyFilterActions(filter.actions!, folderId, labelIds, read);
      
      // Check if anything changed
      if (result.folderId !== folderId || 
          JSON.stringify(result.labelIds.sort()) !== JSON.stringify(labelIds.sort()) ||
          result.read !== read) {
        hasChanges = true;
      }
      
      folderId = result.folderId;
      labelIds = result.labelIds;
      read = result.read;
    }
  }

  // Only return changes if something actually changed
  if (!hasChanges) {
    return null;
  }

  // Check if final state differs from original
  const readChanged = read !== email.read;
  const folderChanged = folderId !== email.folderId;
  const labelsChanged = JSON.stringify(labelIds.sort()) !== JSON.stringify(email.labelIds.sort());
  
  if (!readChanged && !folderChanged && !labelsChanged) {
    return null;
  }

  return { folderId, labelIds, read };
}
