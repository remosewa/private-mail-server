/**
 * Settings store - manages user settings (encrypted)
 */

import { create } from 'zustand';

export interface UserSettings {
  displayName: string; // User's display name for outgoing emails
}

interface SettingsState {
  settings: UserSettings | null;
  loaded: boolean;
  
  setSettings(settings: UserSettings): void;
  getDisplayName(): string;
  clear(): void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  loaded: false,
  
  setSettings: (settings) => set({ settings, loaded: true }),
  
  getDisplayName: () => {
    const { settings } = get();
    return settings?.displayName || '';
  },
  
  clear: () => set({ settings: null, loaded: false }),
}));
