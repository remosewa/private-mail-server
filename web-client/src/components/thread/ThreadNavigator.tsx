import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useUiStore } from '../../store/uiStore';
import { getDb } from '../../db/Database';

interface ThreadMessage {
  ulid: string;
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  receivedAt: string;
  receivedMs: number;
  isRead: number;
}

interface Props {
  currentUlid: string;
  threadId: string;
  folderId: string;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  
  if (isToday) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  
  const isThisYear = date.getFullYear() === now.getFullYear();
  if (isThisYear) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ThreadNavigator({ currentUlid, threadId, folderId }: Props) {
  const { selectEmail, threadViewEnabled } = useUiStore();
  const [expandedUlids, setExpandedUlids] = useState<Set<string>>(new Set([currentUlid]));

  // Query all messages in this thread (DESC order - newest first)
  const { data: messages = [] } = useQuery<ThreadMessage[]>({
    queryKey: ['thread-messages', threadId, folderId],
    queryFn: async () => {
      const db = await getDb();
      const rows = await db.selectObjects(
        `SELECT ulid, subject, fromName, fromAddress, receivedAt, receivedMs, isRead
         FROM email_metadata
         WHERE threadId = ? AND folderId = ?
         ORDER BY receivedMs DESC`,
        [threadId, folderId]
      );
      return rows as unknown as ThreadMessage[];
    },
    staleTime: 1000, // Refetch after 1 second to pick up new messages quickly
    refetchInterval: 5000, // Poll every 5 seconds when component is mounted
  });

  // Expand current message when it changes
  useEffect(() => {
    setExpandedUlids(new Set([currentUlid]));
  }, [currentUlid]);

  const currentIndex = messages.findIndex(m => m.ulid === currentUlid);
  const hasPrevious = currentIndex < messages.length - 1; // Previous is older (higher index)
  const hasNext = currentIndex > 0; // Next is newer (lower index)

  const navigatePrevious = () => {
    if (hasPrevious) {
      selectEmail(messages[currentIndex + 1].ulid);
    }
  };

  const navigateNext = () => {
    if (hasNext) {
      selectEmail(messages[currentIndex - 1].ulid);
    }
  };

  const toggleExpanded = (ulid: string) => {
    setExpandedUlids(prev => {
      const next = new Set(prev);
      if (next.has(ulid)) {
        next.delete(ulid);
      } else {
        next.add(ulid);
      }
      return next;
    });
  };

  // Keyboard shortcuts - must be called unconditionally
  useEffect(() => {
    // Only set up keyboard shortcuts if thread view is enabled and we have multiple messages
    if (!threadViewEnabled || messages.length <= 1) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if no input is focused
      if (document.activeElement?.tagName === 'INPUT' || 
          document.activeElement?.tagName === 'TEXTAREA') {
        return;
      }

      if (e.key === 'n' && hasNext) {
        e.preventDefault();
        navigateNext();
      } else if (e.key === 'p' && hasPrevious) {
        e.preventDefault();
        navigatePrevious();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [threadViewEnabled, messages.length, currentIndex, hasNext, hasPrevious]); // eslint-disable-line react-hooks/exhaustive-deps

  // Don't render navigator if thread view is disabled or only one message
  if (!threadViewEnabled || messages.length <= 1) {
    return null;
  }

  return (
    <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950">
      {/* Header with navigation */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Thread ({messages.length} messages)
        </span>

        {/* Navigation controls */}
        <div className="flex items-center gap-1">
          <button
            onClick={navigateNext}
            disabled={!hasNext}
            className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed
                       text-gray-600 dark:text-gray-400 transition-colors"
            title="Newer message (n)"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          <span className="text-xs text-gray-500 dark:text-gray-400 px-2">
            {currentIndex + 1} / {messages.length}
          </span>
          <button
            onClick={navigatePrevious}
            disabled={!hasPrevious}
            className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed
                       text-gray-600 dark:text-gray-400 transition-colors"
            title="Older message (p)"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
      </div>

      {/* Accordion list of messages */}
      <div className="divide-y divide-gray-200 dark:divide-gray-700">
        {messages.map((message) => {
          const isCurrent = message.ulid === currentUlid;
          const isExpanded = expandedUlids.has(message.ulid);
          const isUnread = message.isRead === 0;

          return (
            <div
              key={message.ulid}
              className={`transition-colors ${isCurrent ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
            >
              {/* Accordion header */}
              <button
                onClick={() => {
                  if (!isCurrent) {
                    selectEmail(message.ulid);
                  } else {
                    toggleExpanded(message.ulid);
                  }
                }}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {/* Expand/collapse icon */}
                    <svg
                      className={`w-4 h-4 shrink-0 text-gray-400 transition-transform ${
                        isExpanded ? 'rotate-90' : ''
                      }`}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>

                    {/* Unread indicator */}
                    {isUnread && (
                      <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                    )}

                    {/* Sender name */}
                    <span className={`text-sm truncate ${
                      isUnread || isCurrent
                        ? 'font-semibold text-gray-900 dark:text-gray-100'
                        : 'text-gray-700 dark:text-gray-300'
                    }`}>
                      {message.fromName || message.fromAddress || 'Unknown'}
                    </span>

                    {/* Current indicator */}
                    {isCurrent && (
                      <span className="shrink-0 text-xs font-medium text-blue-600 dark:text-blue-400">
                        (viewing)
                      </span>
                    )}
                  </div>

                  {/* Date */}
                  <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
                    {formatDateTime(message.receivedAt)}
                  </span>
                </div>

                {/* Subject preview when collapsed */}
                {!isExpanded && message.subject && (
                  <div className="text-xs text-gray-500 dark:text-gray-400 truncate mt-1 ml-6">
                    {message.subject}
                  </div>
                )}
              </button>

              {/* Expanded content */}
              {isExpanded && message.subject && (
                <div className="px-4 pb-3 ml-6">
                  <div className="text-sm text-gray-700 dark:text-gray-300">
                    <span className="font-medium">Subject:</span> {message.subject}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

