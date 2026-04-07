/**
 * Timestamp manipulation utilities for data synchronization.
 * All functions work with ISO-8601 UTC timestamps.
 */

/**
 * Get the current time in ISO-8601 UTC format.
 * @returns Current UTC timestamp (e.g., "2024-01-15T10:30:45.123Z")
 */
export function getCurrentUTC(): string {
  return new Date().toISOString();
}

/**
 * Subtract seconds from an ISO-8601 UTC timestamp.
 * Handles edge cases like epoch and invalid timestamps.
 * 
 * @param isoTimestamp - ISO-8601 UTC timestamp string
 * @param seconds - Number of seconds to subtract
 * @returns New ISO-8601 UTC timestamp with seconds subtracted
 * @throws Error if timestamp is invalid
 */
export function subtractSeconds(isoTimestamp: string, seconds: number): string {
  const date = new Date(isoTimestamp);
  
  // Handle invalid timestamps
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid ISO-8601 timestamp: ${isoTimestamp}`);
  }
  
  // Handle negative seconds (edge case)
  if (seconds < 0) {
    throw new Error(`Seconds must be non-negative: ${seconds}`);
  }
  
  date.setSeconds(date.getSeconds() - seconds);
  return date.toISOString();
}

/**
 * Validate if a string is a valid ISO-8601 UTC timestamp.
 * @param timestamp - String to validate
 * @returns true if valid ISO-8601 UTC timestamp, false otherwise
 */
export function isValidUTCTimestamp(timestamp: string): boolean {
  if (!timestamp) return false;
  
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return false;
  
  // Verify it's in UTC format (ends with Z or has +00:00 offset)
  return timestamp.endsWith('Z') || timestamp.includes('+00:00');
}

/**
 * Get epoch timestamp (1970-01-01T00:00:00.000Z) for initial sync.
 * @returns ISO-8601 UTC timestamp representing Unix epoch
 */
export function getEpochUTC(): string {
  return new Date(0).toISOString();
}
