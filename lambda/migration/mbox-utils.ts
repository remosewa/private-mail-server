/**
 * Utility functions for mbox file handling and label mapping
 */

/**
 * Sanitizes a filename by removing special characters and ensuring
 * only alphanumeric characters, hyphens, and underscores remain.
 * 
 * @param filename - The original filename (with or without .mbox extension)
 * @returns Sanitized filename containing only [a-zA-Z0-9_-]
 * 
 * Requirements: 3.4
 */
export function sanitizeFilename(filename: string): string {
  // Remove .mbox extension if present
  let name = filename.replace(/\.mbox$/i, '');
  
  // Replace spaces with underscores
  name = name.replace(/\s+/g, '_');
  
  // Remove all characters except alphanumeric, hyphens, and underscores
  name = name.replace(/[^a-zA-Z0-9_-]/g, '');
  
  // Remove leading/trailing hyphens and underscores
  name = name.replace(/^[-_]+|[-_]+$/g, '');
  
  // If the result is empty, use a default name
  if (name.length === 0) {
    name = 'unknown';
  }
  
  return name;
}

/**
 * Maps an mbox filename to an appropriate email label.
 * Handles common variations and provides default mappings for standard folders.
 * 
 * @param filename - The mbox filename (e.g., "Inbox.mbox", "Sent Messages.mbox")
 * @returns The mapped label name (e.g., "INBOX", "SENT")
 * 
 * Requirements: 3.1
 */
export function mapFileToLabel(filename: string): string {
  // Remove .mbox extension and normalize to lowercase for comparison
  const normalized = filename.replace(/\.mbox$/i, '').toLowerCase().trim();
  
  // Default mappings for common folder names
  const mappings: Record<string, string> = {
    // Inbox variations
    'inbox': 'INBOX',
    'inbox.mbox': 'INBOX',
    
    // Sent variations
    'sent': 'SENT',
    'sent items': 'SENT',
    'sent messages': 'SENT',
    'sent mail': 'SENT',
    
    // Drafts variations
    'drafts': 'DRAFTS',
    'draft': 'DRAFTS',
    
    // Trash variations
    'trash': 'TRASH',
    'deleted': 'TRASH',
    'deleted items': 'TRASH',
    'deleted messages': 'TRASH',
    
    // Spam variations
    'spam': 'SPAM',
    'junk': 'SPAM',
    'junk mail': 'SPAM',
    'junk e-mail': 'SPAM',
    
    // Archive variations
    'archive': 'ARCHIVE',
    'archives': 'ARCHIVE',
    
    // All Mail (Gmail)
    'all mail': 'ALL_MAIL',
    'all': 'ALL_MAIL',
  };
  
  // Check if we have a direct mapping
  if (mappings[normalized]) {
    return mappings[normalized];
  }
  
  // No direct mapping found - sanitize the filename and use it as a custom label
  const sanitized = sanitizeFilename(filename);
  
  // Convert to uppercase for consistency with standard labels
  return sanitized.toUpperCase();
}
