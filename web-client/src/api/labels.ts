import { apiClient } from './client';

export interface LabelRecord {
  labelId: string;
  encryptedName: string;
  color: string;
  lastUpdatedAt: string;
  version: number;
}

export async function getLabelList(): Promise<{ labels: LabelRecord[] }> {
  const res = await apiClient.get<{ labels: LabelRecord[] }>('/labels/list');
  return res.data;
}

export async function putLabel(labelId: string, encryptedName: string, color: string): Promise<void> {
  await apiClient.put(`/labels/${labelId}`, { encryptedName, color });
}

export async function deleteLabel(labelId: string): Promise<void> {
  await apiClient.delete(`/labels/${labelId}`);
}
