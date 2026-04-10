import { useUiStore } from '../../store/uiStore';
import { useQueryClient } from '@tanstack/react-query';
import { putEmailFlags } from '../../api/emails';
import { getDb } from '../../db/Database';
import { useLabelStore } from '../../store/labelStore';
import LabelTag from './LabelTag';
import type { DraftContext } from '../../store/uiStore';
import type { EmailOrThread } from '../../utils/threadUtils';
import { isThreadGroup, getDisplayInfo } from '../../utils/threadUtils';

interface Props {
  item: EmailOrThread;
  isChecked: boolean;
  selectionActive: boolean;
  onToggleSelect: () => void;
}

function relativeTime(iso: string): string {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  
  // Show year if more than a year old
  const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  if (date.getTime() < oneYearAgo) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function ThreadRow({ item, isChecked, selectionActive, onToggleSelect }: Props) {
  const { selectedEmailUlid, selectEmail, selectedFolderId, openDraftCompose } = useUiStore();
  const queryClient = useQueryClient();
  const { labels } = useLabelStore();
  
  // Get display info (works for both threads and single messages)
  const displayInfo = getDisplayInfo(item);
  const isThread = isThreadGroup(item);
  const messageCount = displayInfo.messageCount;
  
  const isViewing = selectedEmailUlid === displayInfo.ulid;
  const isUnread = displayInfo.isRead === 0;

  // Parse labelIds JSON array and resolve to Label objects
  const labelIdsArray: string[] = JSON.parse(displayInfo.labelIds || '[]');
  
  // Resolve all labels from store
  const emailLabels = labelIdsArray
    .map(labelId => labels.find(l => l.id === labelId))
    .filter((label): label is NonNullable<typeof label> => label !== undefined);

  async function handleClick() {
    // Drafts: open in compose instead of the read view
    if (selectedFolderId === 'DRAFTS') {
      const db = await getDb();
      const rows = await db.selectObjects(
        'SELECT toAddresses, ccAddresses, bccAddresses, s3BodyKey, wrappedEmailKey FROM email_metadata WHERE ulid = ?',
        [displayInfo.ulid],
      );
      const row = rows[0];
      const ctx: DraftContext = {
        ulid:      displayInfo.ulid,
        subject:   displayInfo.subject ?? '',
        to:        JSON.parse(row?.['toAddresses']  as string || '[]') as string[],
        cc:        JSON.parse(row?.['ccAddresses']  as string || '[]') as string[],
        bcc:       JSON.parse(row?.['bccAddresses'] as string || '[]') as string[],
        s3BodyKey:       row?.['s3BodyKey'] as string | null ?? null,
        wrappedEmailKey: row?.['wrappedEmailKey'] as string | null ?? null,
      };
      openDraftCompose(ctx);
      return;
    }

    selectEmail(displayInfo.ulid);
    if (isUnread) {
      try {
        // Optimistic update: Update database first
        const db = await getDb();
        
        // Read current version for optimistic locking
        const rows = await db.selectObjects(
          'SELECT version FROM email_metadata WHERE ulid = ?',
          [displayInfo.ulid]
        );
        const version = (rows[0]?.['version'] as number) || 1;
        
        await db.exec('UPDATE email_metadata SET isRead = 1 WHERE ulid = ?', { bind: [displayInfo.ulid] });
        
        // Trigger search refresh if we're in search mode
        window.dispatchEvent(new Event('search-refresh-requested'));
        
        // Refetch email list
        void queryClient.refetchQueries({ queryKey: ['emails', selectedFolderId] });
        
        // Update backend in background
        putEmailFlags(displayInfo.ulid, { read: true, version })
          .then(response => {
            // On success, update local lastUpdatedAt and version with server response
            db.exec(
              'UPDATE email_metadata SET lastUpdatedAt = ?, version = ? WHERE ulid = ?',
              { bind: [response.lastUpdatedAt, response.version, displayInfo.ulid] }
            ).catch(err => console.error('Failed to update lastUpdatedAt and version:', err));
          })
          .catch(err => {
            console.error('Failed to sync read status to backend:', err);
            // On error, rollback the read status
            if (err?.response?.status === 409) {
              // Conflict - refetch from server
              window.dispatchEvent(new Event('inbox-refresh-requested'));
            } else {
              // Other error - rollback local change
              db.exec('UPDATE email_metadata SET isRead = 0 WHERE ulid = ?', { bind: [displayInfo.ulid] })
                .catch(rollbackErr => console.error('Failed to rollback read status:', rollbackErr));
            }
          });
        
        // Update counters
        void queryClient.invalidateQueries({ queryKey: ['localUnreadCount'] });
      } catch (error) {
        console.error('Failed to mark email as read:', error);
      }
    }
  }

  return (
    <div className={`group relative flex items-stretch w-full transition-colors
                     ${isChecked || isViewing
                       ? 'bg-blue-50 dark:bg-blue-900/20'
                       : 'hover:bg-gray-50 dark:hover:bg-gray-800/60'}`}>
      {/* Checkbox tap target */}
      <div
        className={`flex items-center justify-center w-10 shrink-0 cursor-pointer
                    transition-opacity
                    ${selectionActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
        onClick={e => { e.stopPropagation(); onToggleSelect(); }}
      >
        <input
          type="checkbox"
          checked={isChecked}
          readOnly
          className="w-4 h-4 rounded border-gray-300 accent-blue-600 cursor-pointer pointer-events-none"
        />
      </div>

      {/* Email content */}
      <button
        onClick={handleClick}
        className="flex-1 min-w-0 text-left py-3 pr-4"
      >
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className={`text-sm truncate ${isUnread
              ? 'font-semibold text-gray-900 dark:text-gray-50'
              : 'text-gray-700 dark:text-gray-300'
              }`}>
              {selectedFolderId === 'DRAFTS'
                ? <span className="text-blue-600 dark:text-blue-400">Draft</span>
                : (displayInfo.fromName || displayInfo.fromAddress || 'Unknown')}
            </span>
            {isThread && messageCount > 1 && (
              <span className="shrink-0 inline-flex items-center justify-center px-1.5 py-0.5 text-xs font-medium rounded-full
                               bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                {messageCount}
              </span>
            )}
          </div>
          <span className="text-xs text-gray-400 shrink-0 dark:text-gray-500">{relativeTime(displayInfo.receivedAt)}</span>
        </div>
        <div className={`flex items-center gap-1.5 mt-0.5 ${isUnread ? 'text-gray-800 dark:text-gray-200' : 'text-gray-600 dark:text-gray-400'}`}>
          <span className="text-sm truncate">{displayInfo.subject || '(no subject)'}</span>
          {displayInfo.attachmentFilenames.length > 0 && (
            <svg className="shrink-0 w-3.5 h-3.5 text-gray-400 dark:text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
          )}
        </div>
        {emailLabels.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {emailLabels.map(label => (
              <LabelTag key={label.id} label={label} />
            ))}
          </div>
        )}
        {displayInfo.preview && (
          <div className="text-xs text-gray-400 truncate mt-0.5 dark:text-gray-500">{displayInfo.preview}</div>
        )}
        {isUnread && (
          <span className="inline-block w-2 h-2 rounded-full bg-blue-500 mt-1" />
        )}
      </button>
    </div>
  );
}
