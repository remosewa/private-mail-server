/**
 * Thread grouping utilities for email threading
 */

export interface LocalEmail {
  ulid: string;
  threadId: string;
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  preview: string | null;
  receivedAt: string;
  isRead: number;
  labelIds: string;
  hasAttachments?:      number | null;
  attachmentFilenames?: string | null; // JSON array of original filenames
}

export interface ThreadGroup {
  threadId: string;
  messageCount: number;
  messages: LocalEmail[];
  latestMessage: LocalEmail;
  hasUnread: boolean;
  allLabels: string[];
  attachmentFilenames: string[]; // deduplicated union across all messages in thread
  isThread: true;
}

export interface SingleMessage extends LocalEmail {
  isThread: false;
}

export type EmailOrThread = ThreadGroup | SingleMessage;

/**
 * Group emails by threadId, sorted by most recent message
 * 
 * @param emails Array of emails to group
 * @returns Array of thread groups, sorted by latest message receivedAt DESC
 */
export function groupByThread(emails: LocalEmail[]): ThreadGroup[] {
  // Group emails by threadId
  const threadMap = new Map<string, LocalEmail[]>();
  
  for (const email of emails) {
    const threadId = email.threadId || email.ulid; // Fallback to ulid if no threadId
    const existing = threadMap.get(threadId);
    if (existing) {
      existing.push(email);
    } else {
      threadMap.set(threadId, [email]);
    }
  }
  
  // Convert to ThreadGroup array
  const threads: ThreadGroup[] = [];
  
  for (const [threadId, messages] of threadMap.entries()) {
    // Sort messages within thread by receivedAt ASC (oldest first)
    messages.sort((a, b) => {
      const aTime = new Date(a.receivedAt).getTime();
      const bTime = new Date(b.receivedAt).getTime();
      return aTime - bTime;
    });
    
    // Latest message is the last one after sorting
    const latestMessage = messages[messages.length - 1];
    
    // Check if any message is unread
    const hasUnread = messages.some(m => m.isRead === 0);
    
    // Collect all unique labels from all messages
    const labelSet = new Set<string>();
    for (const message of messages) {
      try {
        const labels = JSON.parse(message.labelIds || '[]') as string[];
        labels.forEach(label => labelSet.add(label));
      } catch {
        // Ignore parse errors
      }
    }
    const allLabels = Array.from(labelSet);
    
    threads.push({
      threadId,
      messageCount: messages.length,
      messages,
      latestMessage,
      hasUnread,
      allLabels,
      attachmentFilenames: mergeThreadFilenames(messages),
      isThread: true,
    });
  }
  
  // Sort threads by latest message receivedAt DESC (most recent first)
  threads.sort((a, b) => {
    const aTime = new Date(a.latestMessage.receivedAt).getTime();
    const bTime = new Date(b.latestMessage.receivedAt).getTime();
    return bTime - aTime;
  });
  
  return threads;
}

/**
 * Convert emails to EmailOrThread format for unified handling
 * 
 * @param emails Array of emails
 * @param enableThreading Whether to group by thread
 * @returns Array of threads or single messages
 */
export function prepareEmailsForDisplay(
  emails: LocalEmail[],
  enableThreading: boolean
): EmailOrThread[] {
  if (enableThreading) {
    return groupByThread(emails);
  }
  
  // Return as single messages
  return emails.map(email => ({
    ...email,
    isThread: false as const,
  }));
}

/**
 * Check if an item is a thread group
 */
export function isThreadGroup(item: EmailOrThread): item is ThreadGroup {
  return item.isThread === true;
}

/**
 * Get all ULIDs from an EmailOrThread item
 */
export function getUlidsFromItem(item: EmailOrThread): string[] {
  if (isThreadGroup(item)) {
    return item.messages.map(m => m.ulid);
  }
  return [item.ulid];
}

/**
 * Get display info for an EmailOrThread item
 */
function parseFilenames(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as string[];
  } catch (e) {
    console.warn('[threadUtils] Failed to parse attachmentFilenames JSON:', json, e);
    return [];
  }
}

/**
 * Collect all attachment filenames from messages in chronological order.
 * Filenames that appear more than once across the thread are suffixed with
 * (1), (2), … in time order so the latest occurrence has the highest number.
 */
function mergeThreadFilenames(messages: LocalEmail[]): string[] {
  // messages are already sorted oldest-first by groupByThread
  const allFilenames: string[] = messages.flatMap(m => parseFilenames(m.attachmentFilenames));

  // Count total occurrences of each filename
  const counts = new Map<string, number>();
  for (const f of allFilenames) counts.set(f, (counts.get(f) ?? 0) + 1);

  // Assign running index only to filenames that appear more than once
  const seen = new Map<string, number>();
  return allFilenames.map(f => {
    if ((counts.get(f) ?? 0) <= 1) return f;
    const n = (seen.get(f) ?? 0) + 1;
    seen.set(f, n);
    return `${f} (${n})`;
  });
}

export function getDisplayInfo(item: EmailOrThread) {
  if (isThreadGroup(item)) {
    return {
      ulid: item.latestMessage.ulid,
      threadId: item.threadId,
      subject: item.latestMessage.subject,
      fromName: item.latestMessage.fromName,
      fromAddress: item.latestMessage.fromAddress,
      preview: item.latestMessage.preview,
      receivedAt: item.latestMessage.receivedAt,
      isRead: item.hasUnread ? 0 : 1,
      labelIds: JSON.stringify(item.allLabels),
      messageCount: item.messageCount,
      attachmentFilenames: item.attachmentFilenames,
    };
  }

  return {
    ulid: item.ulid,
    threadId: item.threadId,
    subject: item.subject,
    fromName: item.fromName,
    fromAddress: item.fromAddress,
    preview: item.preview,
    receivedAt: item.receivedAt,
    isRead: item.isRead,
    labelIds: item.labelIds,
    messageCount: 1,
    attachmentFilenames: parseFilenames(item.attachmentFilenames),
  };
}
