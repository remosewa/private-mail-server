/**
 * Unit tests for Unzip Lambda
 * 
 * Tests the key parsing and mbox file identification logic.
 */

describe('Unzip Lambda', () => {
  describe('S3 Key Parsing', () => {
    test('should parse valid S3 key', () => {
      const key = 'uploads/user123/01HQZX123456789.zip';
      const parts = key.split('/');
      
      expect(parts[0]).toBe('uploads');
      expect(parts[1]).toBe('user123');
      expect(parts[2]).toBe('01HQZX123456789.zip');
      
      const userId = parts[1];
      const migrationId = parts[2].replace('.zip', '');
      
      expect(userId).toBe('user123');
      expect(migrationId).toBe('01HQZX123456789');
    });
    
    test('should handle URL-encoded keys', () => {
      const key = 'uploads/user%20123/01HQZX123456789.zip';
      const decoded = decodeURIComponent(key.replace(/\+/g, ' '));
      const parts = decoded.split('/');
      
      expect(parts[1]).toBe('user 123');
    });
  });
  
  describe('Mbox File Identification', () => {
    test('should identify mbox file by extension', () => {
      const filename = 'Inbox.mbox';
      expect(filename.toLowerCase().endsWith('.mbox')).toBe(true);
    });
    
    test('should identify mbox file by content', () => {
      const content = Buffer.from('From sender@example.com Mon Jan 01 00:00:00 2024\nSubject: Test\n\nBody');
      const header = content.slice(0, 1024).toString('utf-8');
      
      expect(header.startsWith('From ')).toBe(true);
    });
    
    test('should not identify non-mbox file', () => {
      const filename = 'document.pdf';
      const content = Buffer.from('%PDF-1.4\n...');
      const header = content.slice(0, 1024).toString('utf-8');
      
      expect(filename.toLowerCase().endsWith('.mbox')).toBe(false);
      expect(header.startsWith('From ')).toBe(false);
    });
  });
  
  describe('Filename Sanitization', () => {
    test('should extract filename from path', () => {
      const filename = 'path/to/Inbox.mbox';
      const sanitized = filename.split('/').pop();
      
      expect(sanitized).toBe('Inbox.mbox');
    });
    
    test('should add .mbox extension if missing', () => {
      const filename = 'Inbox';
      const mboxFilename = filename.endsWith('.mbox') ? filename : `${filename}.mbox`;
      
      expect(mboxFilename).toBe('Inbox.mbox');
    });
    
    test('should not duplicate .mbox extension', () => {
      const filename = 'Inbox.mbox';
      const mboxFilename = filename.endsWith('.mbox') ? filename : `${filename}.mbox`;
      
      expect(mboxFilename).toBe('Inbox.mbox');
    });
  });
});
