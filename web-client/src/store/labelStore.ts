/**
 * labelStore — manages user-created labels (tags with names and colors).
 *
 * ARCHITECTURE:
 * - Individual label records: PK=USER#<userId>, SK=LABEL#<labelId>
 *   Contains: labelId, encryptedName, color, lastUpdatedAt, version
 *
 * Label IDs are short random base64url strings (9 bytes) generated on the client.
 * Names are RSA-encrypted so the server never sees them.
 */

import { create } from 'zustand';
import { encryptBlob, decryptBlob } from '../crypto/BlobCrypto';
import { getLabelList, putLabel, deleteLabel as apiLabelDelete } from '../api/labels';
import { 
  assignLabelToEmail, 
  removeLabelFromEmail, 
  bulkAssignLabelToEmails, 
  bulkRemoveLabelFromEmails,
  removeLabelFromAllEmails
} from '../db/labelOperations';

export interface Label {
  id: string;
  name: string;
  color: string;
}

/**
 * Generate a unique label ID using crypto.getRandomValues.
 * Returns a 9-byte base64url string (12 characters).
 */
export function generateLabelId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function encryptLabelName(name: string, publicKey: CryptoKey): Promise<string> {
  const nameBytes = new TextEncoder().encode(name);
  const encrypted = await encryptBlob(nameBytes, publicKey);
  const bytes = new Uint8Array(encrypted);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function decryptLabelName(encryptedName: string, privateKey: CryptoKey): Promise<string> {
  const blobBytes = Uint8Array.from(atob(encryptedName), c => c.charCodeAt(0));
  const decrypted = await decryptBlob(blobBytes.buffer, privateKey);
  return new TextDecoder().decode(decrypted);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate label name: must be non-empty and contain only valid characters.
 * Valid characters: letters, numbers, spaces, hyphens, underscores.
 * Maximum length: 20 characters.
 * Quotes are not allowed.
 */
function validateLabelName(name: string): void {
  if (!name || name.trim().length === 0) {
    throw new Error('Label name cannot be empty');
  }
  if (name.trim().length > 20) {
    throw new Error('Label name must be 20 characters or less');
  }
  if (/["']/.test(name)) {
    throw new Error('Label name cannot contain quotes');
  }
  if (!/^[a-zA-Z0-9\s\-_]+$/.test(name)) {
    throw new Error('Label name contains invalid characters. Only letters, numbers, spaces, hyphens, and underscores are allowed.');
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Module-level guard: deduplicates concurrent loadLabels calls.
 * React StrictMode double-invokes effects — without this the second call races
 * the first and both see loaded=false before the async fetch completes.
 */
let _loadPromise: Promise<void> | null = null;

interface LabelState {
  labels: Label[];
  loaded: boolean;

  /** Load label list from server (call once after login when keys are available). */
  loadLabels(privateKey: CryptoKey): Promise<void>;

  /** Create a new label with validation. */
  createLabel(name: string, color: string, publicKey: CryptoKey): Promise<void>;

  /** Update an existing label with validation. */
  updateLabel(id: string, name: string, color: string, publicKey: CryptoKey): Promise<void>;

  /** Delete a label and remove it from all emails. */
  deleteLabel(id: string): Promise<void>;

  /** Assign a label to an email (adds to labelIds array with duplicate prevention). */
  assignLabel(emailUlid: string, labelId: string): Promise<void>;

  /** Remove a label from an email (removes from labelIds array). */
  removeLabel(emailUlid: string, labelId: string): Promise<void>;

  /** Assign a label to multiple emails (bulk operation). */
  bulkAssignLabel(emailUlids: string[], labelId: string): Promise<void>;

  /** Remove a label from multiple emails (bulk operation). */
  bulkRemoveLabel(emailUlids: string[], labelId: string): Promise<void>;

  /** Reset store (call on sign-out). */
  reset(): void;
}

export const useLabelStore = create<LabelState>((set, get) => ({
  labels: [],
  loaded: false,

  loadLabels: async (privateKey) => {
    if (get().loaded) return;
    // Return the in-flight promise if one is already running (e.g. StrictMode double-invoke)
    if (_loadPromise) return _loadPromise;

    _loadPromise = (async () => {
      try {
        console.log('[labelStore] Loading labels...');
        const { labels: labelRecords } = await getLabelList();
        console.log('[labelStore] Received label records:', labelRecords);
        
        // Decrypt label names
        const decryptedLabels = await Promise.all(
          labelRecords.map(async (record) => {
            try {
              const name = await decryptLabelName(record.encryptedName, privateKey);
              console.log('[labelStore] Decrypted label:', { id: record.labelId, name, color: record.color });
              return {
                id: record.labelId,
                name,
                color: record.color,
              };
            } catch (error) {
              console.error('[labelStore] Failed to decrypt label:', record.labelId, error);
              return {
                id: record.labelId,
                name: record.labelId, // Fallback to ID if decryption fails
                color: record.color,
              };
            }
          })
        );
        
        console.log('[labelStore] Final labels:', decryptedLabels);
        set({ labels: decryptedLabels, loaded: true });
      } catch (error) {
        console.error('[labelStore] Failed to load labels:', error);
        set({ labels: [], loaded: true });
      } finally {
        _loadPromise = null;
      }
    })();

    return _loadPromise;
  },

  createLabel: async (name, color, publicKey) => {
    validateLabelName(name);
    
    const newLabel: Label = {
      id: generateLabelId(),
      name: name.trim(),
      color,
    };

    const encryptedName = await encryptLabelName(newLabel.name, publicKey);
    await putLabel(newLabel.id, encryptedName, color);
    
    set({ labels: [...get().labels, newLabel] });
  },

  updateLabel: async (id, name, color, publicKey) => {
    validateLabelName(name);
    
    const labels = get().labels;
    const labelIndex = labels.findIndex(l => l.id === id);
    
    if (labelIndex === -1) {
      throw new Error('Label not found');
    }

    const updatedLabels = [...labels];
    updatedLabels[labelIndex] = { id, name: name.trim(), color };
    
    const encryptedName = await encryptLabelName(name.trim(), publicKey);
    await putLabel(id, encryptedName, color);
    
    set({ labels: updatedLabels });
  },

  deleteLabel: async (id) => {
    const labels = get().labels;
    const updatedLabels = labels.filter(l => l.id !== id);
    
    if (updatedLabels.length === labels.length) {
      throw new Error('Label not found');
    }

    await apiLabelDelete(id);
    set({ labels: updatedLabels });
    
    // Remove the label from all emails in the database
    await removeLabelFromAllEmails(id);
  },

  assignLabel: async (emailUlid, labelId) => {
    // Verify the label exists
    const labels = get().labels;
    if (!labels.find(l => l.id === labelId)) {
      throw new Error('Label not found');
    }

    // Call database helper to add label to email's labelIds array
    // The helper includes duplicate prevention logic
    await assignLabelToEmail(emailUlid, labelId);
  },

  removeLabel: async (emailUlid, labelId) => {
    // Call database helper to remove label from email's labelIds array
    await removeLabelFromEmail(emailUlid, labelId);
  },

  bulkAssignLabel: async (emailUlids, labelId) => {
    // Verify the label exists
    const labels = get().labels;
    if (!labels.find(l => l.id === labelId)) {
      throw new Error('Label not found');
    }

    // Call database helper for bulk assignment
    // The helper includes duplicate prevention logic
    await bulkAssignLabelToEmails(emailUlids, labelId);
  },

  bulkRemoveLabel: async (emailUlids, labelId) => {
    // Call database helper for bulk removal
    await bulkRemoveLabelFromEmails(emailUlids, labelId);
  },

  reset: () => { _loadPromise = null; set({ labels: [], loaded: false }); },
}));
