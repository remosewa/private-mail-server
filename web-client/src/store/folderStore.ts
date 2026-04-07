/**
 * folderStore — manages custom (user-created) folders.
 *
 * ARCHITECTURE:
 * - Individual folder records: PK=USER#<userId>, SK=FOLDER#<folderId>
 *   Contains: folderId, encryptedName, lastUpdatedAt, version
 * - Folder ordering record: PK=USER#<userId>, SK=FOLDER_ORDER#
 *   Contains: folderIds (array), lastUpdatedAt, version
 *
 * Folder IDs are short random base64url strings generated on the client.
 * Names are RSA-encrypted so the server never sees them.
 * Ordering updates are debounced to 1 second to avoid spamming the API.
 */

import { create } from 'zustand';
import { encryptBlob, decryptBlob } from '../crypto/BlobCrypto';
import { getFolderList, putFolder, deleteFolder as apiFolderDelete, putFolderOrdering } from '../api/folders';

export interface CustomFolder {
  id: string;
  name: string;
  sortOrder: number;
}

/** Reserved folder IDs and names — users may not create folders with these names. */
export const RESERVED_FOLDER_IDS = new Set(['ALL', 'INBOX', 'SENT', 'DRAFTS', 'ARCHIVE', 'SPAM', 'TRASH']);
const RESERVED_NAMES = new Set(['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash']);

/** Returns a validation error string, or null if the name is valid. */
export function validateFolderName(name: string, existingFolders: CustomFolder[], skipId?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Folder name is required';
  if (trimmed.length > 64) return 'Folder name must be 64 characters or less';
  if (RESERVED_NAMES.has(trimmed.toLowerCase())) return `"${trimmed}" is a reserved name`;
  
  const duplicate = existingFolders.find(
    f => f.id !== skipId && f.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (duplicate) return 'A folder with this name already exists';
  
  return null;
}

function generateFolderId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function encryptFolderName(name: string, publicKey: CryptoKey): Promise<string> {
  const nameBytes = new TextEncoder().encode(name);
  const encrypted = await encryptBlob(nameBytes, publicKey);
  const bytes = new Uint8Array(encrypted);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function decryptFolderName(encryptedName: string, privateKey: CryptoKey): Promise<string> {
  const blobBytes = Uint8Array.from(atob(encryptedName), c => c.charCodeAt(0));
  const decrypted = await decryptBlob(blobBytes.buffer, privateKey);
  return new TextDecoder().decode(decrypted);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let _loadPromise: Promise<void> | null = null;
let _orderingDebounceTimer: number | null = null;
const ORDERING_DEBOUNCE_MS = 1000; // 1 second

interface FolderState {
  folders: CustomFolder[];
  loaded: boolean;

  /** Load folder list from server (call once after login when keys are available). */
  loadFolders(privateKey: CryptoKey): Promise<void>;

  /** Create a new folder. Returns a validation/save error, or null on success. */
  createFolder(name: string, publicKey: CryptoKey): Promise<string | null>;

  /** Rename a folder. Returns a validation/save error, or null on success. */
  renameFolder(id: string, newName: string, publicKey: CryptoKey): Promise<string | null>;

  /** Delete a folder (caller is responsible for moving its emails first). */
  deleteFolder(id: string): Promise<void>;

  /** Move folder one position up in sort order (debounced). */
  moveFolderUp(id: string): void;

  /** Move folder one position down in sort order (debounced). */
  moveFolderDown(id: string): void;

  /** Flush pending folder ordering changes immediately. */
  flushFolderOrdering(): Promise<void>;

  /** Reset store (call on sign-out). */
  reset(): void;
}

export const useFolderStore = create<FolderState>((set, get) => ({
  folders: [],
  loaded: false,

  loadFolders: async (privateKey) => {
    if (get().loaded) return;
    if (_loadPromise) return _loadPromise;

    _loadPromise = (async () => {
      try {
        console.log('[folderStore] Loading folders...');
        const { folders: folderRecords, ordering } = await getFolderList();
        console.log('[folderStore] Received folder records:', folderRecords);
        
        // Decrypt folder names
        const decryptedFolders = await Promise.all(
          folderRecords.map(async (record) => {
            try {
              const name = await decryptFolderName(record.encryptedName, privateKey);
              console.log('[folderStore] Decrypted folder:', { id: record.folderId, name });
              return {
                id: record.folderId,
                name,
                sortOrder: 0, // Will be set based on ordering
              };
            } catch (error) {
              console.error('[folderStore] Failed to decrypt folder:', record.folderId, error);
              return {
                id: record.folderId,
                name: record.folderId, // Fallback to ID if decryption fails
                sortOrder: 0,
              };
            }
          })
        );
        
        // Apply ordering
        const folderMap = new Map(decryptedFolders.map(f => [f.id, f]));
        const orderedFolders: CustomFolder[] = [];
        
        // First, add folders that are in the ordering array
        ordering.forEach((id, index) => {
          const folder = folderMap.get(id);
          if (folder) {
            folder.sortOrder = index;
            orderedFolders.push(folder);
            folderMap.delete(id); // Remove from map so we don't add it again
          }
        });
        
        // Then, add any remaining folders that weren't in the ordering array
        // (e.g., newly migrated folders that haven't been ordered yet)
        const remainingFolders = Array.from(folderMap.values());
        remainingFolders.forEach((folder, index) => {
          folder.sortOrder = ordering.length + index;
          orderedFolders.push(folder);
        });
        
        console.log('[folderStore] Final folders:', orderedFolders);
        set({ folders: orderedFolders, loaded: true });
      } catch (error) {
        console.error('[folderStore] Failed to load folders:', error);
        set({ folders: [], loaded: true });
      } finally {
        _loadPromise = null;
      }
    })();

    return _loadPromise;
  },

  createFolder: async (name, publicKey) => {
    const { folders } = get();
    const err = validateFolderName(name, folders);
    if (err) return err;

    const maxSortOrder = folders.reduce((max, f) => Math.max(max, f.sortOrder), -1);
    const newFolder: CustomFolder = {
      id: generateFolderId(),
      name: name.trim(),
      sortOrder: maxSortOrder + 1,
    };

    try {
      const encryptedName = await encryptFolderName(newFolder.name, publicKey);
      await putFolder(newFolder.id, encryptedName);
      
      // Update ordering
      const newFolders = [...folders, newFolder];
      set({ folders: newFolders });
      await putFolderOrdering(newFolders.map(f => f.id));
      
      return null;
    } catch (error) {
      console.error('Failed to create folder:', error);
      return 'Failed to save. Try again.';
    }
  },

  renameFolder: async (id, newName, publicKey) => {
    const { folders } = get();
    const err = validateFolderName(newName, folders, id);
    if (err) return err;

    const oldFolders = folders;
    const newFolders = folders.map(f => 
      f.id === id ? { ...f, name: newName.trim() } : f
    );
    
    set({ folders: newFolders });

    try {
      const encryptedName = await encryptFolderName(newName.trim(), publicKey);
      await putFolder(id, encryptedName);
      return null;
    } catch (error) {
      console.error('Failed to rename folder:', error);
      set({ folders: oldFolders }); // rollback
      return 'Failed to save. Try again.';
    }
  },

  deleteFolder: async (id) => {
    const { folders } = get();
    const newFolders = folders.filter(f => f.id !== id);
    set({ folders: newFolders });
    
    try {
      await apiFolderDelete(id);
      await putFolderOrdering(newFolders.map(f => f.id));
    } catch (error) {
      console.error('Failed to delete folder:', error);
      // Don't rollback - folder is already removed from UI
    }
  },

  moveFolderUp: (id) => {
    const { folders } = get();
    const sorted = [...folders].sort((a, b) => a.sortOrder - b.sortOrder);
    const idx = sorted.findIndex(f => f.id === id);
    if (idx <= 0) return;

    const above = sorted[idx - 1]!;
    const current = sorted[idx]!;
    
    // Swap the sort orders
    const newFolders = folders.map(f => {
      if (f.id === current.id) return { ...f, sortOrder: above.sortOrder - 0.5 };
      return f;
    });
    
    // Renumber all folders to have sequential sort orders
    const renumbered = newFolders
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((f, i) => ({ ...f, sortOrder: i }));
    
    // Update UI immediately
    set({ folders: renumbered });
    
    // Debounce the API call
    if (_orderingDebounceTimer !== null) {
      clearTimeout(_orderingDebounceTimer);
    }
    _orderingDebounceTimer = window.setTimeout(() => {
      get().flushFolderOrdering();
    }, ORDERING_DEBOUNCE_MS);
  },

  moveFolderDown: (id) => {
    const { folders } = get();
    const sorted = [...folders].sort((a, b) => a.sortOrder - b.sortOrder);
    const idx = sorted.findIndex(f => f.id === id);
    if (idx < 0 || idx >= sorted.length - 1) return;

    const below = sorted[idx + 1]!;
    const current = sorted[idx]!;
    
    // Swap the sort orders
    const newFolders = folders.map(f => {
      if (f.id === current.id) return { ...f, sortOrder: below.sortOrder + 0.5 };
      return f;
    });
    
    // Renumber all folders to have sequential sort orders
    const renumbered = newFolders
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((f, i) => ({ ...f, sortOrder: i }));
    
    // Update UI immediately
    set({ folders: renumbered });
    
    // Debounce the API call
    if (_orderingDebounceTimer !== null) {
      clearTimeout(_orderingDebounceTimer);
    }
    _orderingDebounceTimer = window.setTimeout(() => {
      get().flushFolderOrdering();
    }, ORDERING_DEBOUNCE_MS);
  },

  flushFolderOrdering: async () => {
    if (_orderingDebounceTimer !== null) {
      clearTimeout(_orderingDebounceTimer);
      _orderingDebounceTimer = null;
    }
    
    const { folders } = get();
    const sorted = [...folders].sort((a, b) => a.sortOrder - b.sortOrder);
    const folderIds = sorted.map(f => f.id);
    
    try {
      await putFolderOrdering(folderIds);
    } catch (error) {
      console.error('Failed to save folder ordering:', error);
      // Don't rollback - user can try again or it will sync on next load
    }
  },

  reset: () => { 
    if (_orderingDebounceTimer !== null) {
      clearTimeout(_orderingDebounceTimer);
      _orderingDebounceTimer = null;
    }
    _loadPromise = null; 
    set({ folders: [], loaded: false }); 
  },
}));
