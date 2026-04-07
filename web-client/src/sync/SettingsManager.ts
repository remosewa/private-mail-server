/**
 * SettingsManager - handles loading and saving encrypted user settings
 */

import { getSettings, putSettings } from '../api/settings';
import { encryptBlob, decryptBlob } from '../crypto/BlobCrypto';
import { useSettingsStore, type UserSettings } from '../store/settingsStore';

/**
 * Load settings from server and decrypt
 */
export async function loadSettings(privateKey: CryptoKey): Promise<UserSettings> {
  const response = await getSettings();
  
  if (!response.settingsBlob) {
    // No settings yet - return defaults
    const defaultSettings: UserSettings = {
      displayName: '',
    };
    useSettingsStore.getState().setSettings(defaultSettings);
    return defaultSettings;
  }
  
  // Decrypt settings blob
  const encryptedBlob = Uint8Array.from(atob(response.settingsBlob), c => c.charCodeAt(0));
  const decrypted = await decryptBlob(encryptedBlob.buffer as ArrayBuffer, privateKey);
  const settings = JSON.parse(new TextDecoder().decode(decrypted)) as UserSettings;
  
  useSettingsStore.getState().setSettings(settings);
  return settings;
}

/**
 * Save settings to server (encrypted)
 */
export async function saveSettings(
  settings: UserSettings,
  publicKey: CryptoKey,
): Promise<void> {
  // Encrypt settings
  const plaintext = new TextEncoder().encode(JSON.stringify(settings));
  const encrypted = await encryptBlob(plaintext, publicKey);
  const settingsBlob = btoa(String.fromCharCode(...new Uint8Array(encrypted)));
  
  // Save to server
  await putSettings({ settingsBlob });
  
  // Update local store
  useSettingsStore.getState().setSettings(settings);
}
