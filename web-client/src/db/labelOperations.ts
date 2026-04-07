/**
 * labelOperations — database helper functions for label assignments.
 *
 * These functions handle SQL UPDATE operations on the email_metadata.labelIds
 * column, which stores label IDs as a JSON array. Operations include:
 * - Adding labels to emails with duplicate prevention
 * - Removing labels from emails
 * - Bulk operations for multiple emails
 */

import { getDb } from './Database';

/**
 * Assign a label to an email by adding the labelId to the email's labelIds array.
 * Includes duplicate prevention — if the label is already assigned, this is a no-op.
 */
export async function assignLabelToEmail(emailUlid: string, labelId: string): Promise<void> {
  const db = await getDb();
  
  // Read current labelIds
  const row = await db.selectObjects(
    'SELECT labelIds FROM email_metadata WHERE ulid = ?',
    [emailUlid]
  );
  
  if (row.length === 0) {
    throw new Error(`Email not found: ${emailUlid}`);
  }
  
  // Parse the JSON array
  const labelIdsJson = row[0]['labelIds'] as string;
  const labelIds: string[] = JSON.parse(labelIdsJson);
  
  // Check for duplicate
  if (labelIds.includes(labelId)) {
    return; // Already assigned, no-op
  }
  
  // Add the new label ID
  labelIds.push(labelId);
  
  // Update the database
  await db.exec(
    'UPDATE email_metadata SET labelIds = ? WHERE ulid = ?',
    { bind: [JSON.stringify(labelIds), emailUlid] }
  );
}

/**
 * Remove a label from an email by removing the labelId from the email's labelIds array.
 */
export async function removeLabelFromEmail(emailUlid: string, labelId: string): Promise<void> {
  const db = await getDb();
  
  // Read current labelIds
  const row = await db.selectObjects(
    'SELECT labelIds FROM email_metadata WHERE ulid = ?',
    [emailUlid]
  );
  
  if (row.length === 0) {
    throw new Error(`Email not found: ${emailUlid}`);
  }
  
  // Parse the JSON array
  const labelIdsJson = row[0]['labelIds'] as string;
  const labelIds: string[] = JSON.parse(labelIdsJson);
  
  // Remove the label ID
  const updatedLabelIds = labelIds.filter(id => id !== labelId);
  
  // Update the database
  await db.exec(
    'UPDATE email_metadata SET labelIds = ? WHERE ulid = ?',
    { bind: [JSON.stringify(updatedLabelIds), emailUlid] }
  );
}

/**
 * Assign a label to multiple emails in bulk.
 * Uses a transaction for efficiency and atomicity.
 * Includes duplicate prevention for each email.
 */
export async function bulkAssignLabelToEmails(emailUlids: string[], labelId: string): Promise<void> {
  const db = await getDb();
  await db.withTransaction(async () => {
    for (const emailUlid of emailUlids) {
      const row = await db.selectObjects(
        'SELECT labelIds FROM email_metadata WHERE ulid = ?',
        [emailUlid]
      );
      if (row.length === 0) continue;
      const labelIds: string[] = JSON.parse(row[0]['labelIds'] as string);
      if (labelIds.includes(labelId)) continue;
      labelIds.push(labelId);
      await db.exec(
        'UPDATE email_metadata SET labelIds = ? WHERE ulid = ?',
        { bind: [JSON.stringify(labelIds), emailUlid] }
      );
    }
  });
}

/**
 * Remove a label from multiple emails in bulk.
 * Uses a transaction for efficiency and atomicity.
 */
export async function bulkRemoveLabelFromEmails(emailUlids: string[], labelId: string): Promise<void> {
  const db = await getDb();
  await db.withTransaction(async () => {
    for (const emailUlid of emailUlids) {
      const row = await db.selectObjects(
        'SELECT labelIds FROM email_metadata WHERE ulid = ?',
        [emailUlid]
      );
      if (row.length === 0) continue;
      const labelIds: string[] = JSON.parse(row[0]['labelIds'] as string);
      const updatedLabelIds = labelIds.filter(id => id !== labelId);
      await db.exec(
        'UPDATE email_metadata SET labelIds = ? WHERE ulid = ?',
        { bind: [JSON.stringify(updatedLabelIds), emailUlid] }
      );
    }
  });
}

/**
 * Remove a label ID from all emails in the database.
 * Used when a label is deleted to clean up all assignments.
 */
export async function removeLabelFromAllEmails(labelId: string): Promise<void> {
  const db = await getDb();
  const rows = await db.selectObjects(
    'SELECT ulid, labelIds FROM email_metadata WHERE labelIds != ?',
    ['[]']
  );
  await db.withTransaction(async () => {
    for (const row of rows) {
      const emailUlid = row['ulid'] as string;
      const labelIds: string[] = JSON.parse(row['labelIds'] as string);
      if (!labelIds.includes(labelId)) continue;
      const updatedLabelIds = labelIds.filter(id => id !== labelId);
      await db.exec(
        'UPDATE email_metadata SET labelIds = ? WHERE ulid = ?',
        { bind: [JSON.stringify(updatedLabelIds), emailUlid] }
      );
    }
  });
}
