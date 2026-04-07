import { create } from 'zustand';

export interface SyncProgress {
  syncing: boolean;
  synced: number;
  total: number;
}

interface SyncState extends SyncProgress {
  setProgress(progress: Partial<SyncProgress>): void;
  reset(): void;
}

export const useSyncStore = create<SyncState>(set => ({
  syncing: false,
  synced: 0,
  total: 0,

  setProgress: (progress) => set(state => ({ ...state, ...progress })),

  reset: () => set({ syncing: false, synced: 0, total: 0 }),
}));
