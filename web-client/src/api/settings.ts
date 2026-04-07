/**
 * Settings API client
 */

import { apiClient } from './client';

export interface SettingsResponse {
  settingsBlob: string | null;
  lastUpdatedAt: string | null;
  version: number;
}

export interface PutSettingsRequest {
  settingsBlob: string;
}

export interface PutSettingsResponse {
  lastUpdatedAt: string;
  version: number;
}

/**
 * Get user settings (encrypted blob)
 */
export async function getSettings(): Promise<SettingsResponse> {
  const response = await apiClient.get('/settings');
  return response.data as SettingsResponse;
}

/**
 * Update user settings (encrypted blob)
 */
export async function putSettings(request: PutSettingsRequest): Promise<PutSettingsResponse> {
  const response = await apiClient.put('/settings', request);
  return response.data as PutSettingsResponse;
}
