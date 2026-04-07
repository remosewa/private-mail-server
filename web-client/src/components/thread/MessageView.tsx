import { useState, useEffect, useRef } from 'react';
import type { EmailBodyBlob, EmailAttachmentsBlob } from '../../types';
import AttachmentList from './AttachmentList';
import LabelManager from './LabelManager';
import MessageControls from './MessageControls';
import { useUiStore } from '../../store/uiStore';
import { useAuthStore } from '../../store/authStore';
import { useFolderStore } from '../../store/folderStore';
import { getDb } from '../../db/Database';

interface Props {
  header: {
    subject: string;
    fromName: string;
    fromAddress: string;
    to: string[];
    date: string;
    listUnsubscribe?: string;
    listUnsubscribePost?: string;
    messageId?: string; // Message-ID header for threading
  };
  body: EmailBodyBlob;
  attachments: EmailAttachmentsBlob;
  cidMap: Map<string, string>;
  emailUlid: string;
  privateKey: CryptoKey;
  /** Present for draft/sent emails; absent for inbound (RSA-hybrid). */
  wrappedEmailKey?: string | null;
}

/** Parse a List-Unsubscribe header into its constituent URL / mailto parts. */
function parseUnsubscribeHeader(raw: string): { url: string | null; mailto: string | null } {
  // Header is a comma-separated list of angle-bracket-enclosed URIs, e.g.:
  //   <https://example.com/unsub?id=123>, <mailto:list@example.com>
  let url: string | null = null;
  let mailto: string | null = null;
  for (const part of raw.split(',')) {
    const uri = part.trim().replace(/^<|>$/g, '');
    if (!url && /^https?:\/\//i.test(uri)) url = uri;
    else if (!mailto && /^mailto:/i.test(uri)) mailto = uri;
  }
  return { url, mailto };
}

/** Sanitize HTML: remove only external (http/https) image src values. Preserves blob: and data: URLs. */
function blockExternalImages(html: string): string {
  return html.replace(/(<img[^>]*)\s+src\s*=\s*["']https?:[^"']*["']/gi, '$1 data-blocked-src');
}

/** Replace cid: references with blob URLs from the cidMap. */
function replaceCidImages(html: string, cidMap: Map<string, string>): string {
  return html.replace(/src\s*=\s*["']cid:([^"'>]+)["']/gi, (_match, cid: string) => {
    const c = cid.trim();
    const url = cidMap.get(c)
      ?? cidMap.get(`<${c}>`)
      ?? cidMap.get(c.split('@')[0]!)
      ?? cidMap.get(`<${c.split('@')[0]}>`);
    return url ? `src="${url}"` : 'data-cid-missing';
  });
}

/** Build a blockquote with original email metadata + body for reply/forward. */
function buildQuotedHtml(
  header: Props['header'],
  body: EmailBodyBlob,
  type: 'reply' | 'replyAll' | 'forward',
): string {
  const originalHtml = body.htmlBody
    || `<pre style="font-family:inherit;white-space:pre-wrap">${body.textBody ?? ''}</pre>`;
  const dateStr = new Date(header.date).toLocaleString();

  if (type === 'forward') {
    return [
      '<br><br>',
      '<div style="border-top:1px solid #ccc;margin-top:1em;padding-top:0.5em;color:#555;font-size:0.9em">',
      '<b>---------- Forwarded message ----------</b><br>',
      `<b>From:</b> ${header.fromName} &lt;${header.fromAddress}&gt;<br>`,
      `<b>Date:</b> ${dateStr}<br>`,
      `<b>Subject:</b> ${header.subject}<br>`,
      `<b>To:</b> ${header.to.join(', ')}`,
      '</div>',
      '<br>',
      originalHtml,
    ].join('');
  }

  // reply / replyAll
  return [
    '<br><br>',
    `<blockquote style="border-left:3px solid #ccc;margin:0 0 0 0.5em;padding-left:1em;color:#555">`,
    `<div style="font-size:0.85em;margin-bottom:0.5em">`,
    `On ${dateStr}, ${header.fromName} &lt;${header.fromAddress}&gt; wrote:`,
    '</div>',
    originalHtml,
    '</blockquote>',
  ].join('');
}

export default function MessageView({ header, body, attachments, cidMap, emailUlid, privateKey, wrappedEmailKey }: Props) {
  const [showImages, setShowImages] = useState(false);
  const [unsubStatus, setUnsubStatus] = useState<'idle' | 'sending' | 'done'>('idle');
  const [currentFolderId, setCurrentFolderId] = useState<string>('INBOX');
  const [headerExpanded, setHeaderExpanded] = useState(() => window.innerWidth >= 768);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { openCompose, selectEmail, darkMode } = useUiStore();
  const userEmail = useAuthStore(s => s.userEmail);
  const { folders } = useFolderStore();

  const unsubParsed = header.listUnsubscribe
    ? parseUnsubscribeHeader(header.listUnsubscribe)
    : null;

  // Debug logging
  useEffect(() => {
    console.log('[MessageView] Unsubscribe debug:', {
      hasListUnsubscribe: !!header.listUnsubscribe,
      listUnsubscribe: header.listUnsubscribe,
      listUnsubscribePost: header.listUnsubscribePost,
      unsubParsed,
    });
  }, [header.listUnsubscribe, header.listUnsubscribePost, unsubParsed]);

  // Load current folder from database
  useEffect(() => {
    async function loadCurrentFolder() {
      try {
        const db = await getDb();
        const rows = await db.selectObjects(
          'SELECT folderId FROM email_metadata WHERE ulid = ?',
          [emailUlid]
        );
        
        if (rows.length > 0) {
          const folderId = rows[0]['folderId'] as string;
          setCurrentFolderId(folderId);
        }
      } catch (err) {
        console.error('Failed to load current folder:', err);
      }
    }
    
    loadCurrentFolder();
  }, [emailUlid]);

  // Get folder display name
  const getFolderName = (folderId: string): string => {
    const systemFolders: Record<string, string> = {
      'INBOX': 'Inbox',
      'SENT': 'Sent',
      'DRAFTS': 'Drafts',
      'ARCHIVE': 'Archive',
      'SPAM': 'Spam',
      'TRASH': 'Trash',
    };
    
    if (systemFolders[folderId]) {
      return systemFolders[folderId];
    }
    
    const customFolder = folders.find(f => f.id === folderId);
    return customFolder?.name || folderId;
  };

  async function handleUnsubscribe() {
    if (!unsubParsed || unsubStatus !== 'idle') return;
    setUnsubStatus('sending');
    try {
      const isOneClick =
        !!unsubParsed.url &&
        /list-unsubscribe=one-click/i.test(header.listUnsubscribePost ?? '');

      if (isOneClick && unsubParsed.url) {
        // RFC 8058 one-click: POST with no-cors (simple request — response is opaque
        // but the POST is delivered to the server, which is all we need).
        await fetch(unsubParsed.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'List-Unsubscribe=One-Click',
          mode: 'no-cors',
        });
      } else if (unsubParsed.url) {
        window.open(unsubParsed.url, '_blank', 'noopener,noreferrer');
      } else if (unsubParsed.mailto) {
        window.open(unsubParsed.mailto);
      }
      setUnsubStatus('done');
    } catch {
      setUnsubStatus('idle');
    }
  }

  const rawHtml = body.htmlBody || `<pre style="font-family:sans-serif;white-space:pre-wrap">${body.textBody}</pre>`;
  const cidHtml = cidMap.size > 0 ? replaceCidImages(rawHtml, cidMap) : rawHtml;
  const safeHtml = showImages ? cidHtml : blockExternalImages(cidHtml);

  const hasExternalImages = /src\s*=\s*["']https?:/i.test(rawHtml);

useEffect(() => {
  const frame = iframeRef.current;
  if (!frame) return;

  const onLoad = () => {
    const doc = frame.contentDocument;
    if (!doc) return;

    // Inject a style to counter-invert images/videos so they look natural
    // when the CSS filter is applied to the iframe element in dark mode.
    const style = doc.createElement('style');
    style.id = 'chase-dark-mode';
    style.textContent = `img, video, svg { filter: invert(1) hue-rotate(180deg); }`;
    doc.head.appendChild(style);

    // Resize to content
    frame.style.height = `${doc.documentElement.scrollHeight}px`;

    // Intercept link clicks
    doc.addEventListener('click', (e) => {
      const anchor = (e.target as Element).closest('a');
      if (!anchor) return;

      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;

      // Let mailto: links work natively
      if (href.startsWith('mailto:')) return;

      e.preventDefault();
      window.open(href, '_blank', 'noopener,noreferrer');
    });
  };

  frame.addEventListener('load', onLoad);
  return () => frame.removeEventListener('load', onLoad);
}, [safeHtml]);  // darkMode is applied via CSS filter on the iframe element, not via injection


  function handleReply() {
    openCompose({
      type: 'reply',
      to: header.fromAddress,
      subject: header.subject,
      fromName: header.fromName,
      fromAddress: header.fromAddress,
      date: header.date,
      quotedHtml: buildQuotedHtml(header, body, 'reply'),
      messageId: header.messageId, // Pass Message-ID for threading
    });
  }

  function handleReplyAll() {
    // To = original sender; Cc = all other recipients excluding the current user
    const ccAddresses = header.to
      .filter(a => a !== header.fromAddress && a !== userEmail)
      .join(', ');
    openCompose({
      type: 'replyAll',
      to: header.fromAddress,
      cc: ccAddresses,
      subject: header.subject,
      fromName: header.fromName,
      fromAddress: header.fromAddress,
      date: header.date,
      quotedHtml: buildQuotedHtml(header, body, 'replyAll'),
      messageId: header.messageId, // Pass Message-ID for threading
    });
  }

  function handleForward() {
    openCompose({
      type: 'forward',
      to: '',
      subject: header.subject,
      fromName: header.fromName,
      fromAddress: header.fromAddress,
      date: header.date,
      quotedHtml: buildQuotedHtml(header, body, 'forward'),
    });
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-white dark:bg-gray-950">
      {/* Header */}
      <div className="px-4 py-4 border-b border-gray-200 dark:border-gray-700">
        {/* Back button — mobile only */}
        <button
          onClick={() => selectEmail(null)}
          aria-label="Back to inbox"
          className="md:hidden flex items-center gap-1 mb-3 text-sm text-blue-600 hover:text-blue-700
                     dark:text-blue-400 dark:hover:text-blue-300"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </button>

        <h2 className="text-lg font-semibold text-gray-900 mb-1.5 dark:text-gray-100">{header.subject || '(no subject)'}</h2>

        {/* From line — always visible */}
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-gray-600 dark:text-gray-300 truncate">
            <span className="font-medium">From:</span> {header.fromName} &lt;{header.fromAddress}&gt;
          </p>
          {/* Expand/collapse toggle — mobile only */}
          <button
            onClick={() => setHeaderExpanded(v => !v)}
            aria-label={headerExpanded ? 'Collapse details' : 'Expand details'}
            className="md:hidden shrink-0 flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700
                       dark:text-gray-400 dark:hover:text-gray-200"
          >
            {headerExpanded ? 'Less' : 'More'}
            <svg
              className={`w-3.5 h-3.5 transition-transform ${headerExpanded ? 'rotate-180' : ''}`}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>

        {/* Collapsible section — always visible on md+, toggled on mobile */}
        <div className={`${headerExpanded ? '' : 'hidden md:block'}`}>
          {/* Folder indicator */}
          <div className="mt-2 mb-2">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-md
                             bg-gray-100 text-gray-700 border border-gray-300
                             dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
              </svg>
              {getFolderName(currentFolderId)}
            </span>
          </div>

          <div className="text-sm text-gray-600 space-y-0.5 mb-3 dark:text-gray-300">
            <p><span className="font-medium">To:</span> {header.to.join(', ')}</p>
            <p><span className="font-medium">Date:</span> {new Date(header.date).toLocaleString()}</p>
          </div>

          {/* Label display (assigned labels) */}
          <LabelManager emailUlid={emailUlid} displayOnly />

          {/* Action buttons with controls on the right */}
          <div className="flex items-center gap-2 flex-wrap mt-3">
            <ActionBtn onClick={handleReply} icon={
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 17H5a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v5" />
                <polyline points="17 12 12 17 7 12" />
                <line x1="12" y1="17" x2="12" y2="3" />
              </svg>
            }>Reply</ActionBtn>

            <ActionBtn onClick={handleReplyAll} icon={
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M7 17H3a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v5" />
                <polyline points="13 12 8 17 3 12" />
                <path d="M21 12l-5-5-5 5" />
              </svg>
            }>Reply All</ActionBtn>

            <ActionBtn onClick={handleForward} icon={
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 4 20 9 15 14" />
                <path d="M4 20v-7a4 4 0 014-4h12" />
              </svg>
            }>Forward</ActionBtn>

            {/* Spacer to push controls to the right */}
            <div className="flex-1" />

            {/* Label and message controls as small icons */}
            <LabelManager emailUlid={emailUlid} compact />
            <MessageControls emailUlid={emailUlid} compact />

            {unsubParsed && (
              <button
                onClick={handleUnsubscribe}
                disabled={unsubStatus !== 'idle'}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg
                           transition-colors
                           text-red-600 bg-red-50 hover:bg-red-100
                           disabled:opacity-60 disabled:cursor-not-allowed
                           dark:text-red-400 dark:bg-red-900/20 dark:hover:bg-red-900/30"
              >
                {unsubStatus === 'done' ? 'Unsubscribed' : unsubStatus === 'sending' ? 'Unsubscribing…' : 'Unsubscribe'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* External images banner */}
      {hasExternalImages && !showImages && (
        <div className="flex items-center gap-3 px-4 py-2 bg-amber-50 border-b border-amber-200 text-sm dark:bg-amber-900/20 dark:border-amber-700/50">
          <svg className="w-4 h-4 text-amber-600 shrink-0 dark:text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span className="text-amber-700 dark:text-amber-300">External images are blocked to protect your privacy.</span>
          <button
            onClick={() => setShowImages(true)}
            className="ml-auto text-amber-800 font-medium underline hover:no-underline shrink-0 dark:text-amber-200"
          >
            Load images
          </button>
        </div>
      )}

      {/* Body iframe — dark mode via CSS filter so inline styles are handled too */}
      <iframe
        ref={iframeRef}
        title="Email body"
        srcDoc={safeHtml}
        sandbox="allow-same-origin"
        className="flex-1 w-full border-0 px-1"
        style={{
          minHeight: '200px',
          filter: darkMode ? 'invert(1) hue-rotate(180deg)' : undefined,
        }}
      />

      <AttachmentList attachments={attachments} emailUlid={emailUlid} privateKey={privateKey} wrappedEmailKey={wrappedEmailKey} />
    </div>
  );
}

function ActionBtn({
  onClick, icon, children,
}: {
  onClick: () => void; icon: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600
                 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors font-medium
                 dark:text-gray-300 dark:bg-gray-800 dark:hover:bg-gray-700"
    >
      {icon}
      {children}
    </button>
  );
}
