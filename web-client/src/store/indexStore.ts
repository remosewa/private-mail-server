import { create } from 'zustand';

const STORAGE_KEY = 'chase-email-search-index-enabled';

export interface IndexProgress {
  total: number;
  indexed: number;
  running: boolean;
  modelReady: boolean;
}

interface IndexState extends IndexProgress {
  enabled: boolean;

  setEnabled(enabled: boolean): void;
  setProgress(patch: Partial<IndexProgress>): void;
  reset(): void;
}

export const useIndexStore = create<IndexState>(set => ({
  enabled: localStorage.getItem(STORAGE_KEY) === 'true',
  total: 0,
  indexed: 0,
  running: false,
  modelReady: false,

  setEnabled: (enabled) => {
    localStorage.setItem(STORAGE_KEY, String(enabled));
    set({ enabled });
  },

  setProgress: (patch) => set(state => ({ ...state, ...patch })),

  reset: () => set({ total: 0, indexed: 0, running: false }),
}));
