/**
 * Folder API client
 */

import { apiClient } from './client';

interface FolderRecord {
  folderId: string;
  encryptedName: string;
  lastUpdatedAt: string;
  version: number;
}

/**
 * Get all folder records and ordering
 */
export async function getFolderList(): Promise<{
  folders: FolderRecord[];
  ordering: string[];
}> {
  const res = await apiClient.get<{
    folders: FolderRecord[];
    ordering: string[];
  }>('/folders/list');
  return res.data;
}

/**
 * Create or update a folder record
 */
export async function putFolder(folderId: string, encryptedName: string): Promise<void> {
  await apiClient.put(`/folders/${folderId}`, { encryptedName });
}

/**
 * Delete a folder record
 */
export async function deleteFolder(folderId: string): Promise<void> {
  await apiClient.delete(`/folders/${folderId}`);
}

/**
 * Update folder ordering (debounced on client)
 */
export async function putFolderOrdering(folderIds: string[]): Promise<void> {
  await apiClient.put('/folders/ordering', { folderIds });
}
