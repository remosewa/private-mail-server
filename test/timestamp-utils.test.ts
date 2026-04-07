/**
 * Unit tests for timestamp manipulation utilities.
 * Tests edge cases like epoch, invalid timestamps, and UTC format validation.
 */

import {
  getCurrentUTC,
  subtractSeconds,
  isValidUTCTimestamp,
  getEpochUTC,
} from '../web-client/src/sync/timestampUtils';

describe('timestampUtils', () => {
  describe('getCurrentUTC', () => {
    it('should return a valid ISO-8601 UTC timestamp', () => {
      const timestamp = getCurrentUTC();
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('should return current time within 1 second tolerance', () => {
      const before = Date.now();
      const timestamp = getCurrentUTC();
      const after = Date.now();
      
      const timestampMs = new Date(timestamp).getTime();
      expect(timestampMs).toBeGreaterThanOrEqual(before);
      expect(timestampMs).toBeLessThanOrEqual(after);
    });
  });

  describe('subtractSeconds', () => {
    it('should subtract 30 seconds from a timestamp', () => {
      const timestamp = '2024-01-15T10:30:45.000Z';
      const result = subtractSeconds(timestamp, 30);
      expect(result).toBe('2024-01-15T10:30:15.000Z');
    });

    it('should handle subtracting seconds across minute boundary', () => {
      const timestamp = '2024-01-15T10:30:15.000Z';
      const result = subtractSeconds(timestamp, 30);
      expect(result).toBe('2024-01-15T10:29:45.000Z');
    });

    it('should handle subtracting seconds across hour boundary', () => {
      const timestamp = '2024-01-15T10:00:15.000Z';
      const result = subtractSeconds(timestamp, 30);
      expect(result).toBe('2024-01-15T09:59:45.000Z');
    });

    it('should handle subtracting seconds across day boundary', () => {
      const timestamp = '2024-01-15T00:00:15.000Z';
      const result = subtractSeconds(timestamp, 30);
      expect(result).toBe('2024-01-14T23:59:45.000Z');
    });

    it('should handle epoch timestamp', () => {
      const timestamp = '1970-01-01T00:00:00.000Z';
      const result = subtractSeconds(timestamp, 30);
      expect(result).toBe('1969-12-31T23:59:30.000Z');
    });

    it('should handle zero seconds subtraction', () => {
      const timestamp = '2024-01-15T10:30:45.000Z';
      const result = subtractSeconds(timestamp, 0);
      expect(result).toBe(timestamp);
    });

    it('should throw error for invalid timestamp', () => {
      expect(() => subtractSeconds('invalid', 30)).toThrow('Invalid ISO-8601 timestamp');
    });

    it('should throw error for negative seconds', () => {
      const timestamp = '2024-01-15T10:30:45.000Z';
      expect(() => subtractSeconds(timestamp, -30)).toThrow('Seconds must be non-negative');
    });

    it('should preserve milliseconds', () => {
      const timestamp = '2024-01-15T10:30:45.123Z';
      const result = subtractSeconds(timestamp, 30);
      expect(result).toBe('2024-01-15T10:30:15.123Z');
    });
  });

  describe('isValidUTCTimestamp', () => {
    it('should return true for valid UTC timestamp with Z', () => {
      expect(isValidUTCTimestamp('2024-01-15T10:30:45.000Z')).toBe(true);
    });

    it('should return true for valid UTC timestamp with +00:00', () => {
      expect(isValidUTCTimestamp('2024-01-15T10:30:45.000+00:00')).toBe(true);
    });

    it('should return true for epoch', () => {
      expect(isValidUTCTimestamp('1970-01-01T00:00:00.000Z')).toBe(true);
    });

    it('should return false for invalid timestamp', () => {
      expect(isValidUTCTimestamp('invalid')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidUTCTimestamp('')).toBe(false);
    });

    it('should return false for non-UTC timestamp (no Z or +00:00)', () => {
      expect(isValidUTCTimestamp('2024-01-15T10:30:45.000')).toBe(false);
    });

    it('should return false for timestamp with non-UTC offset', () => {
      expect(isValidUTCTimestamp('2024-01-15T10:30:45.000+05:00')).toBe(false);
    });
  });

  describe('getEpochUTC', () => {
    it('should return Unix epoch in ISO-8601 UTC format', () => {
      const epoch = getEpochUTC();
      expect(epoch).toBe('1970-01-01T00:00:00.000Z');
    });

    it('should return a valid UTC timestamp', () => {
      const epoch = getEpochUTC();
      expect(isValidUTCTimestamp(epoch)).toBe(true);
    });

    it('should return timestamp with zero milliseconds', () => {
      const epoch = getEpochUTC();
      const date = new Date(epoch);
      expect(date.getTime()).toBe(0);
    });
  });

  describe('edge cases and integration', () => {
    it('should handle propagation delay calculation (30 seconds)', () => {
      const latestTimestamp = '2024-01-15T10:30:45.000Z';
      const sinceTimestamp = subtractSeconds(latestTimestamp, 30);
      expect(sinceTimestamp).toBe('2024-01-15T10:30:15.000Z');
      expect(isValidUTCTimestamp(sinceTimestamp)).toBe(true);
    });

    it('should handle first sync with epoch', () => {
      const epoch = getEpochUTC();
      const sinceTimestamp = subtractSeconds(epoch, 30);
      expect(isValidUTCTimestamp(sinceTimestamp)).toBe(true);
      expect(new Date(sinceTimestamp).getTime()).toBeLessThan(0);
    });

    it('should handle large second values', () => {
      const timestamp = '2024-01-15T10:30:45.000Z';
      const result = subtractSeconds(timestamp, 86400); // 1 day
      expect(result).toBe('2024-01-14T10:30:45.000Z');
    });

    it('should handle very old timestamps', () => {
      const timestamp = '1900-01-01T00:00:00.000Z';
      const result = subtractSeconds(timestamp, 30);
      expect(result).toBe('1899-12-31T23:59:30.000Z');
      expect(isValidUTCTimestamp(result)).toBe(true);
    });

    it('should handle future timestamps', () => {
      const timestamp = '2099-12-31T23:59:45.000Z';
      const result = subtractSeconds(timestamp, 30);
      expect(result).toBe('2099-12-31T23:59:15.000Z');
      expect(isValidUTCTimestamp(result)).toBe(true);
    });
  });
});
