/**
 * Filters API — all calls are authenticated (accessToken injected by apiClient interceptor).
 */

import { apiClient } from './client';

export interface FilterCondition {
  field: 'subject' | 'body' | 'from' | 'to' | 'cc' | 'date' | 'hasAttachment' | 'label' | 'readStatus';
  operator: 'equals' | 'startsWith' | 'endsWith' | 'contains' | 'before' | 'after' | 'between' | 'hasLabel' | 'notHasLabel' | 'hasAttachment' | 'notHasAttachment' | 'isRead' | 'isUnread';
  value: string | string[];
}

export interface FilterGroup {
  operator: 'AND' | 'OR';
  conditions: FilterCondition[];
}

export interface EmailFilter {
  operator: 'AND' | 'OR';
  groups: FilterGroup[];
}

export interface FilterActions {
  mode: 'once' | 'always';
  folder?: string;
  labels?: {
    mode: 'add' | 'remove' | 'set';
    labelIds: string[];
  };
  markAsRead?: boolean; // true = mark as read, false = mark as unread, undefined = no change
}

export interface SavedFilter {
  filterId: string;
  name: string;
  filter: EmailFilter;
  actions?: FilterActions;
  version: number;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface ListFiltersResponse {
  filters: SavedFilter[];
}

/**
 * GET /filters
 * List all filters for the authenticated user
 */
export async function listFilters(): Promise<ListFiltersResponse> {
  const res = await apiClient.get<ListFiltersResponse>('/filters');
  return res.data;
}

/**
 * GET /filters/:filterId
 * Get a specific filter
 */
export async function getFilter(filterId: string): Promise<SavedFilter> {
  const res = await apiClient.get<SavedFilter>(`/filters/${filterId}`);
  return res.data;
}

/**
 * PUT /filters/:filterId
 * Create or update a filter with optimistic locking
 */
export async function putFilter(
  filterId: string,
  data: {
    name: string;
    filter: EmailFilter;
    actions?: FilterActions;
    version?: number;
  }
): Promise<{ filterId: string; version: number; lastUpdatedAt: string }> {
  const res = await apiClient.put<{ filterId: string; version: number; lastUpdatedAt: string }>(
    `/filters/${filterId}`,
    data
  );
  return res.data;
}

/**
 * DELETE /filters/:filterId
 * Delete a filter
 */
export async function deleteFilter(filterId: string): Promise<void> {
  await apiClient.delete(`/filters/${filterId}`);
}
