import { create } from 'zustand';

interface DbState {
  /** True when another tab has taken the OPFS lock and this tab's DB is offline. */
  disconnected: boolean;
  setDisconnected(v: boolean): void;
}

export const useDbStore = create<DbState>(set => ({
  disconnected: false,
  setDisconnected: (v) => set({ disconnected: v }),
}));
