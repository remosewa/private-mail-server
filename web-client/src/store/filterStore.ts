/**
 * Filter execution store - manages "Run Once" filter execution state
 */

import { create } from 'zustand';

interface FilterProgress {
  filterId: string;
  filterName: string;
  processed: number;
  total: number;
  running: boolean;
}

interface FilterStore {
  progress: FilterProgress | null;
  setProgress: (progress: FilterProgress | null) => void;
  cancel: () => void;
}

export const useFilterStore = create<FilterStore>((set) => ({
  progress: null,
  setProgress: (progress) => set({ progress }),
  cancel: () => set({ progress: null }),
}));
