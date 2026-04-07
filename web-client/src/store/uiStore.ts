import { create } from 'zustand';

export interface ReplyContext {
  type: 'reply' | 'replyAll' | 'forward';
  to: string;
  cc?: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  date: string;
  quotedHtml?: string;
  messageId?: string; // Message-ID of the email being replied to (for threading)
}

/** Passed to ComposeModal when the user opens an existing draft for editing. */
export interface DraftContext {
  ulid:    string;
  subject: string;
  to:      string[];
  cc:      string[];
  bcc:     string[];
  /** S3 key for the encrypted body blob — fetched async by ComposeModal. */
  s3BodyKey: string | null;
  /** RSA-OAEP wrapped per-email AES key — unwrapped by ComposeModal to recover emailKey. */
  wrappedEmailKey: string | null;
}

interface UiState {
  selectedFolderId: string;
  selectedEmailUlid: string | null;
  composeOpen: boolean;
  replyContext:  ReplyContext | null;
  draftContext:  DraftContext | null;
  activePage: 'mail' | 'settings' | 'admin';
  darkMode: boolean;
  threadViewEnabled: boolean;
  mobileSidebarOpen: boolean;

  selectFolder(folderId: string): void;
  selectEmail(ulid: string | null): void;
  openCompose(replyContext?: ReplyContext): void;
  openDraftCompose(ctx: DraftContext): void;
  closeCompose(): void;
  setActivePage(page: 'mail' | 'settings' | 'admin'): void;
  setDarkMode(enabled: boolean): void;
  toggleDarkMode(): void;
  setThreadViewEnabled(enabled: boolean): void;
  openMobileSidebar(): void;
  closeMobileSidebar(): void;
}

const DARK_MODE_STORAGE_KEY = 'chase-email-dark-mode';
const THREAD_VIEW_STORAGE_KEY = 'chase-email-thread-view';

function readInitialDarkMode(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(DARK_MODE_STORAGE_KEY) === 'true';
}

function persistDarkMode(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(DARK_MODE_STORAGE_KEY, String(enabled));
}

function readInitialThreadView(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(THREAD_VIEW_STORAGE_KEY) === 'true';
}

function persistThreadView(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(THREAD_VIEW_STORAGE_KEY, String(enabled));
}

export const useUiStore = create<UiState>(set => ({
  selectedFolderId: 'INBOX',
  selectedEmailUlid: null,
  composeOpen: false,
  replyContext: null,
  draftContext: null,
  activePage: 'mail',
  darkMode: readInitialDarkMode(),
  threadViewEnabled: readInitialThreadView(),
  mobileSidebarOpen: false,

  selectFolder: (folderId) =>
    set({ selectedFolderId: folderId, selectedEmailUlid: null, mobileSidebarOpen: false }),

  selectEmail: (ulid) =>
    set({ selectedEmailUlid: ulid }),

  openCompose: (replyContext = undefined) =>
    set({ composeOpen: true, replyContext: replyContext ?? null, draftContext: null }),

  openDraftCompose: (ctx) =>
    set({ composeOpen: true, draftContext: ctx, replyContext: null }),

  closeCompose: () =>
    set({ composeOpen: false, replyContext: null, draftContext: null }),

  setActivePage: (page) =>
    set({ activePage: page }),

  setDarkMode: (enabled) => {
    persistDarkMode(enabled);
    set({ darkMode: enabled });
  },

  toggleDarkMode: () =>
    set((state) => {
      const next = !state.darkMode;
      persistDarkMode(next);
      return { darkMode: next };
    }),

  setThreadViewEnabled: (enabled) => {
    persistThreadView(enabled);
    set({ threadViewEnabled: enabled });
  },

  openMobileSidebar: () => set({ mobileSidebarOpen: true }),
  closeMobileSidebar: () => set({ mobileSidebarOpen: false }),
}));
