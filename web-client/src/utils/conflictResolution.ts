/**
 * Conflict resolution utilities for handling optimistic locking conflicts.
 * 
 * When a 409 Conflict error occurs (another device modified the email),
 * this module provides utilities to:
 * 1. Detect the conflict
 * 2. Refetch the latest version from server
 * 3. Update local database
 * 4. Notify the user
 */

import { getDb } from '../db/Database';
import type { EmailMeta } from '../api/emails';

export interface ConflictError {
  statusCode: number;
  error: string;
  message: string;
  currentVersion?: number;
}

/**
 * Check if an error is a 409 Conflict error from optimistic locking.
 */
export function isConflictError(error: any): error is ConflictError {
  return (
    error?.response?.status === 409 ||
    error?.statusCode === 409 ||
    error?.error === 'CONFLICT'
  );
}

/**
 * Handle a conflict error by refetching the latest version and updating local database.
 * 
 * @param emailUlid - The ULID of the email that had a conflict
 * @param onRefetch - Callback to refetch the latest email from server
 * @returns The updated email metadata with latest version
 */
export async function handleConflict(
  emailUlid: string,
  onRefetch: () => Promise<EmailMeta>
): Promise<EmailMeta> {
  // Refetch latest version from server
  const latestEmail = await onRefetch();
  
  // Update local database with latest version
  const db = await getDb();
  await db.exec(
    `UPDATE email_metadata 
     SET folderId = ?, labelIds = ?, isRead = ?, lastUpdatedAt = ?, version = ?
     WHERE ulid = ?`,
    {
      bind: [
        latestEmail.folderId,
        JSON.stringify(latestEmail.labelIds),
        latestEmail.read ? 1 : 0,
        latestEmail.lastUpdatedAt,
        latestEmail.version,
        emailUlid,
      ],
    }
  );
  
  return latestEmail;
}

/**
 * User-friendly conflict error message.
 */
export const CONFLICT_MESSAGE = 'This email was modified by another device. Please try again.';
