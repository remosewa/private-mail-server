import { useState, useRef, useEffect, useCallback } from 'react';
import RecipientInput, { extractAddress } from './RecipientInput';
import { getDb } from '../../db/Database';
import { upsertContacts } from '../../sync/SyncManager';
import { useEditor, EditorContent } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import TextAlign from '@tiptap/extension-text-align';
import Color from '@tiptap/extension-color';
import { TextStyle } from '@tiptap/extension-text-style';
import FontFamily from '@tiptap/extension-font-family';
import Image from '@tiptap/extension-image';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';
import { useUiStore } from '../../store/uiStore';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import {
  sendEmail, saveDraft, deleteDraft, getEmailBody, getEmailAttachments, getAttachmentBlob,
  getAttachmentUploadUrl, uploadEncryptedAttachment, deleteAttachment,
} from '../../api/emails';
import { remoteLogger } from '../../api/logger';
import {
  decryptBlob, decryptAttachment, unwrapEmailKey, decodeJson,
  generateEmailKey, wrapEmailKey, exportEmailKeyBase64, encryptAttachment,
} from '../../crypto/BlobCrypto';
import { useQueryClient } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 25 MB per-file ceiling (mirrors server-side validation). */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** 50 MB total attachment ceiling. */
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AttachmentEntry {
  id:           string;    // local React key
  file?:        File;      // absent when loaded from a saved draft
  name:         string;
  size:         number;    // original (pre-compression) file size
  type:         string;
  attachmentId: string | null; // server-assigned after upload
  status:       'uploading' | 'ready' | 'failed';
  progress:     number;    // 0–100
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a ULID-compatible ID (48-bit ms timestamp + 80-bit random, base32). */
function generateUlid(): string {
  const CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = Date.now();
  let ts = '';
  for (let i = 9; i >= 0; i--) { ts = CHARS[t % 32]! + ts; t = Math.floor(t / 32); }
  const rand = crypto.getRandomValues(new Uint8Array(10));
  let rnd = '';
  let bits = 0, acc = 0;
  for (const byte of rand) {
    acc = (acc << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; rnd += CHARS[(acc >> bits) & 31]; }
  }
  return ts + rnd;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res((reader.result as string).split(',')[1]!);
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
}

// Custom font-size extension
const FontSize = Extension.create({
  name: 'fontSize',
  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        fontSize: {
          default: null,
          parseHTML: el => (el as HTMLElement).style.fontSize || null,
          renderHTML: attrs => {
            if (!attrs['fontSize']) return {};
            return { style: `font-size: ${attrs['fontSize'] as string}` };
          },
        },
      },
    }];
  },
});

type ComposeMode = 'normal' | 'expanded' | 'minimized';

function splitRecipients(s: string | undefined): string[] {
  if (!s) return [];
  return s.split(',').map(r => r.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Toolbar primitives
// ---------------------------------------------------------------------------

function ToolbarBtn({
  onClick, active, title, children,
}: {
  onClick: () => void; active?: boolean; title: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={e => { e.preventDefault(); onClick(); }}
      title={title}
      className={`p-1 rounded transition-colors select-none ${active ? 'bg-gray-200 text-gray-900' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
        }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="w-px h-4 bg-gray-300 mx-0.5 shrink-0" />;
}

// ---------------------------------------------------------------------------
// Attachment chip
// ---------------------------------------------------------------------------

function AttachmentChip({ att, onRemove }: { att: AttachmentEntry; onRemove: () => void }) {
  const isImage = att.type.startsWith('image/');
  return (
    <div className="flex items-center gap-1.5 pl-2 pr-1 py-1 bg-gray-100 hover:bg-gray-200
                    rounded-lg border border-gray-200 text-xs text-gray-700 max-w-[180px] group">
      {isImage ? (
        <svg className="w-3.5 h-3.5 shrink-0 text-blue-500" viewBox="0 0 24 24" fill="currentColor">
          <path d="M21 19V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      )}
      <span className="truncate">{att.name}</span>
      {att.status === 'uploading' ? (
        <span className="text-blue-400 shrink-0">{att.progress}%</span>
      ) : att.status === 'failed' ? (
        <span className="text-red-400 shrink-0">failed</span>
      ) : (
        <span className="text-gray-400 shrink-0">{formatBytes(att.size)}</span>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 p-0.5 rounded hover:bg-gray-300 text-gray-400 hover:text-gray-700 shrink-0"
        title="Remove attachment"
      >
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Discard dialog
// ---------------------------------------------------------------------------

function DiscardDialog({
  onSave, onDiscard, onCancel,
}: {
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 rounded-t-xl">
      <div className="bg-white rounded-xl shadow-2xl p-5 mx-4 w-full max-w-xs">
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Save this draft?</h3>
        <p className="text-xs text-gray-500 mb-4">Your message will be lost if you don't save it.</p>
        <div className="flex flex-col gap-2">
          <button
            onClick={onSave}
            className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Save draft
          </button>
          <button
            onClick={onDiscard}
            className="w-full px-4 py-2 bg-white hover:bg-gray-50 text-red-600 text-sm font-medium rounded-lg border border-gray-200 transition-colors"
          >
            Discard
          </button>
          <button
            onClick={onCancel}
            className="w-full px-4 py-2 text-gray-500 hover:text-gray-700 text-sm transition-colors"
          >
            Keep editing
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ComposePane() {
  const { replyContext, draftContext, closeCompose } = useUiStore();
  const userEmail = useAuthStore(s => s.userEmail) ?? '';
  const publicKey = useAuthStore(s => s.publicKey);
  const privateKey = useAuthStore(s => s.privateKey);
  const userId = useAuthStore(s => s.userId) ?? '';
  const displayName = useSettingsStore(s => s.getDisplayName());
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<ComposeMode>('normal');
  const [showCc, setShowCc] = useState(!!(replyContext?.cc || draftContext?.cc.length));
  const [showBcc, setShowBcc] = useState(!!(draftContext?.bcc.length));
  const [showEmoji, setShowEmoji] = useState(false);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentEntry[]>([]);
  const [attachError, setAttachError] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  // Stable email ID for this compose session (reuses existing ULID if resuming a draft)
  const composeEmailIdRef = useRef<string>(draftContext?.ulid ?? generateUlid());
  const emailKeyRef = useRef<CryptoKey | null>(null);
  const wrappedEmailKeyRef = useRef<string | null>(draftContext?.wrappedEmailKey ?? null);

  const [to, setTo] = useState<string[]>(() =>
    draftContext ? draftContext.to : splitRecipients(replyContext?.to));
  const [cc, setCc] = useState<string[]>(() =>
    draftContext ? draftContext.cc : splitRecipients(replyContext?.cc));
  const [bcc, setBcc] = useState<string[]>(() =>
    draftContext ? draftContext.bcc : []);
  const [subject, setSubject] = useState(() => {
    if (draftContext) return draftContext.subject;
    if (!replyContext) return '';
    const s = replyContext.subject;
    if (replyContext.type === 'forward') return /^fwd:/i.test(s) ? s : `Fwd: ${s}`;
    return /^re:/i.test(s) ? s : `Re: ${s}`;
  });

  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const colorInputRef = useRef<HTMLInputElement>(null);

  const draftUlidRef = useRef<string | null>(draftContext?.ulid ?? null);
  const isDirtyRef = useRef(false);
  const editorHtmlRef = useRef<string>(replyContext?.quotedHtml ?? '');
  const editorTextRef = useRef<string>('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // ── Per-email key initialization ─────────────────────────────────────────
  // If resuming a draft: unwrap existing key. Otherwise generate a fresh one.
  useEffect(() => {
    if (!publicKey || !privateKey) return;
    void (async () => {
      if (draftContext?.wrappedEmailKey) {
        const key = await unwrapEmailKey(draftContext.wrappedEmailKey, privateKey);
        emailKeyRef.current = key;
        wrappedEmailKeyRef.current = draftContext.wrappedEmailKey;
      } else {
        const key = await generateEmailKey();
        emailKeyRef.current = key;
        wrappedEmailKeyRef.current = await wrapEmailKey(key, publicKey);
      }
    })();
  }, [publicKey, privateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Draft auto-save ───────────────────────────────────────────────────────
  const doSaveDraftRef = useRef<(() => Promise<void>) | undefined>(undefined);

  doSaveDraftRef.current = async () => {
    if (!emailKeyRef.current || !wrappedEmailKeyRef.current) return;
    if (!draftUlidRef.current) draftUlidRef.current = composeEmailIdRef.current;

    setSaveStatus('saving');
    try {
      const html = editorHtmlRef.current;
      const text = editorTextRef.current;
      const now = new Date().toISOString();
      const emailKey = emailKeyRef.current;

      const enc = async (obj: unknown): Promise<string> => {
        const bytes = new TextEncoder().encode(JSON.stringify(obj));
        return arrayBufferToBase64(await encryptAttachment(bytes.buffer as ArrayBuffer, emailKey));
      };

      const attachmentMeta = attachments
        .filter(a => a.status === 'ready' && a.attachmentId)
        .map(a => ({
          filename:     a.name,
          size:         a.size,
          contentType:  a.type,
          attachmentId: a.attachmentId!,
        }));

      // Generate Message-ID for this email (RFC 5322 format)
      const mailDomain = import.meta.env['VITE_MAIL_DOMAIN'] as string;
      const messageId = `<${draftUlidRef.current}@${mailDomain}>`;

      // If replying, construct In-Reply-To from parent's messageId (or use emailUlid as fallback)
      const inReplyTo = replyContext?.messageId
        ? replyContext.messageId.startsWith('<')
          ? replyContext.messageId
          : `<${replyContext.messageId}@${mailDomain}>`
        : undefined;

      console.log('[ComposeModal] Saving draft:', {
        messageId,
        inReplyTo,
        replyContextMessageId: replyContext?.messageId,
        draftUlid: draftUlidRef.current,
      });

      const [headerBlob, bodyBlob, textBlob, attachmentsBlob] = await Promise.all([
        enc({
          subject,
          fromName: displayName || userEmail, // Use display name, fallback to email
          fromAddress: userEmail,
          preview: text.slice(0, 200),
          to: to.map(extractAddress),
          ...(cc.length ? { cc: cc.map(extractAddress) } : {}),
          ...(bcc.length ? { bcc: bcc.map(extractAddress) } : {}),
          date: now,
          messageId, // Include Message-ID for threading
          ...(inReplyTo ? { inReplyTo } : {}), // Include In-Reply-To if replying
        }),
        enc({ textBody: text, htmlBody: html }),
        enc({ text }),
        enc(attachmentMeta),
      ]);

      await saveDraft(draftUlidRef.current, {
        headerBlob, bodyBlob, textBlob, attachmentsBlob,
        wrappedEmailKey: wrappedEmailKeyRef.current!,
        receivedAt: now,
      });

      const db = await getDb();
      const receivedMs = new Date(now).getTime();
      const uid = draftUlidRef.current;
      await db.exec(
        `INSERT INTO email_metadata
           (ulid, threadId, folderId, labelIds, receivedAt, receivedMs, isRead,
            s3BodyKey, s3TextKey, s3EmbeddingKey, s3AttachmentsKey,
            subject, fromName, fromAddress, preview, toAddresses, ccAddresses, bccAddresses,
            wrappedEmailKey)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(ulid) DO UPDATE SET
           subject=excluded.subject, preview=excluded.preview,
           toAddresses=excluded.toAddresses, ccAddresses=excluded.ccAddresses,
           bccAddresses=excluded.bccAddresses,
           receivedAt=excluded.receivedAt, receivedMs=excluded.receivedMs,
           wrappedEmailKey=excluded.wrappedEmailKey`,
        {
          bind: [
            uid, `THREAD#${uid}`, 'DRAFTS', '[]', now, receivedMs, 1,
            `${userId}/bodies/${uid}.enc`, `${userId}/text/${uid}.enc`,
            `${userId}/embeddings/${uid}.enc`, `${userId}/attachments/${uid}.enc`,
            subject, displayName || userEmail, userEmail, text.slice(0, 200),
            JSON.stringify(to.map(extractAddress)),
            JSON.stringify(cc.map(extractAddress)),
            JSON.stringify(bcc.map(extractAddress)),
            wrappedEmailKeyRef.current,
          ],
        },
      );
      void queryClient.invalidateQueries({ queryKey: ['emails', 'DRAFTS'] });

      isDirtyRef.current = false;
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(s => s === 'saved' ? 'idle' : s), 2000);
    } catch (e) {
      console.log('Error while saving draft', e);
      setSaveStatus('error');
    }
  };

  useEffect(() => {
    const id = setInterval(() => {
      if (isDirtyRef.current) void doSaveDraftRef.current?.();
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  // Auto-save on unmount so switching drafts doesn't lose unsaved changes
  useEffect(() => {
    return () => {
      if (isDirtyRef.current && draftUlidRef.current) {
        void doSaveDraftRef.current?.();
      }
    };
  }, []);

  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) { isInitialMount.current = false; return; }
    isDirtyRef.current = true;
  }, [to, cc, bcc, subject]);

  const draftBodyLoadedRef = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TextStyle,
      FontFamily,
      FontSize,
      Color,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Link.configure({ openOnClick: false }),
      Image.configure({ inline: true, allowBase64: true }),
      Placeholder.configure({ placeholder: 'Write your message…' }),
    ],
    content: replyContext?.quotedHtml ?? '',
    editorProps: {
      attributes: { class: 'outline-none px-4 py-3 min-h-[240px]' },
    },
    onUpdate: ({ editor: ed }) => {
      isDirtyRef.current = true;
      editorHtmlRef.current = ed.getHTML();
      editorTextRef.current = ed.getText();
    },
  });

  // Load draft body — dual decrypt depending on whether wrappedEmailKey is present
  useEffect(() => {
    if (!draftContext || !editor || !privateKey || draftBodyLoadedRef.current) return;
    draftBodyLoadedRef.current = true;
    void (async () => {
      try {
        const buf = await getEmailBody(draftContext.ulid);
        let plaintext: Uint8Array;
        if (draftContext.wrappedEmailKey) {
          // Wait for emailKey to be initialized (usually <1ms after mount)
          let attempts = 0;
          while (!emailKeyRef.current && attempts < 100) {
            await new Promise(r => setTimeout(r, 20));
            attempts++;
          }
          if (!emailKeyRef.current) return;
          plaintext = new Uint8Array(await decryptAttachment(buf, emailKeyRef.current));
        } else {
          plaintext = await decryptBlob(buf, privateKey);
        }
        const { htmlBody, textBody } = decodeJson<{ textBody: string; htmlBody: string }>(plaintext);
        editor.commands.setContent(htmlBody);
        editorHtmlRef.current = htmlBody;
        editorTextRef.current = textBody ?? '';
        isDirtyRef.current = false;

        // Load saved attachments metadata
        if (emailKeyRef.current) {
          try {
            const attBuf = await getEmailAttachments(draftContext.ulid);
            const attPlain = new Uint8Array(await decryptAttachment(attBuf, emailKeyRef.current));
            const attMeta = decodeJson<Array<{
              filename: string; size: number; contentType: string; attachmentId: string;
            }>>(attPlain);
            if (attMeta.length > 0) {
              setAttachments(attMeta.map(a => ({
                id:           `draft-${a.attachmentId}`,
                name:         a.filename,
                size:         a.size,
                type:         a.contentType,
                attachmentId: a.attachmentId,
                status:       'ready' as const,
                progress:     100,
              })));
            }
          } catch { /* no attachments or empty */ }
        }
      } catch (err) {
        remoteLogger.warn('ComposeModal: failed to load draft body', { error: String(err) });
      }
    })();
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load attachments from the source email when forwarding
  const forwardAttachmentsLoadedRef = useRef(false);
  useEffect(() => {
    const srcUlid = replyContext?.forwardEmailUlid;
    if (!srcUlid || forwardAttachmentsLoadedRef.current || !privateKey) return;
    forwardAttachmentsLoadedRef.current = true;

    void (async () => {
      // Wait for the compose emailKey to be ready
      let attempts = 0;
      while (!emailKeyRef.current && attempts < 100) {
        await new Promise(r => setTimeout(r, 20));
        attempts++;
      }
      if (!emailKeyRef.current) return;

      try {
        const db = await getDb();
        const rows = await db.selectObjects(
          'SELECT wrappedEmailKey FROM email_metadata WHERE ulid = ?', [srcUlid],
        );
        const srcWrappedKey = (rows[0]?.['wrappedEmailKey'] as string | null) ?? null;
        const srcEmailKey = srcWrappedKey ? await unwrapEmailKey(srcWrappedKey, privateKey) : null;

        const attBuf = await getEmailAttachments(srcUlid);
        const attPlain = srcEmailKey
          ? new Uint8Array(await decryptAttachment(attBuf, srcEmailKey))
          : await decryptBlob(attBuf, privateKey);
        const attMeta = decodeJson<Array<{ filename: string; size: number; contentType: string; attachmentId: string; contentId?: string }>>(attPlain);

        const toForward = attMeta.filter(a => !a.contentId);
        if (toForward.length === 0) return;

        const entries: AttachmentEntry[] = toForward.map(a => ({
          id: `fwd-${a.attachmentId}`,
          name: a.filename,
          size: a.size,
          type: a.contentType,
          attachmentId: null,
          status: 'uploading' as const,
          progress: 0,
        }));
        setAttachments(prev => [...prev, ...entries]);

        for (let i = 0; i < toForward.length; i++) {
          const att = toForward[i]!;
          const entry = entries[i]!;
          try {
            const encBuf = await getAttachmentBlob(srcUlid, att.attachmentId);
            const bytes = srcEmailKey
              ? new Uint8Array(await decryptAttachment(encBuf, srcEmailKey))
              : await decryptBlob(encBuf, privateKey);
            const reEncrypted = await encryptAttachment(bytes.buffer as ArrayBuffer, emailKeyRef.current!);
            const { attachmentId, uploadUrl } = await getAttachmentUploadUrl({
              emailId: composeEmailIdRef.current,
              filename: att.filename,
              contentType: att.contentType,
              size: att.size,
            });
            await uploadEncryptedAttachment(uploadUrl, reEncrypted, (pct) => {
              setAttachments(prev => prev.map(a => a.id === entry.id ? { ...a, progress: pct } : a));
            });
            setAttachments(prev => prev.map(a =>
              a.id === entry.id ? { ...a, attachmentId, status: 'ready', progress: 100 } : a,
            ));
          } catch {
            setAttachments(prev => prev.map(a => a.id === entry.id ? { ...a, status: 'failed' } : a));
          }
        }
        isDirtyRef.current = true;
      } catch { /* failed to load forward attachments — not fatal */ }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function insertLink() {
    const url = window.prompt('Enter URL:');
    if (!url) return;
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    editor?.chain().focus().setLink({ href }).run();
  }

  // ---------------------------------------------------------------------------
  // Attachment helpers
  // ---------------------------------------------------------------------------

  /** Encrypt and upload a single file; update entry status as it progresses. */
  async function uploadFile(file: File, entryId: string) {
    // Wait briefly for email key (usually ready by the time user picks a file)
    let attempts = 0;
    while (!emailKeyRef.current && attempts < 100) {
      await new Promise(r => setTimeout(r, 20));
      attempts++;
    }
    const emailKey = emailKeyRef.current;
    if (!emailKey) {
      setAttachments(prev => prev.map(a => a.id === entryId ? { ...a, status: 'failed' } : a));
      return;
    }

    try {
      const raw = await file.arrayBuffer();
      if (raw.byteLength > MAX_FILE_BYTES) {
        setAttachments(prev => prev.map(a => a.id === entryId ? { ...a, status: 'failed' } : a));
        setAttachError(`${file.name} exceeds the 25 MB per-file limit.`);
        return;
      }

      const encrypted = await encryptAttachment(raw, emailKey);

      const { attachmentId, uploadUrl } = await getAttachmentUploadUrl({
        emailId:     composeEmailIdRef.current,
        filename:    file.name,
        contentType: file.type || 'application/octet-stream',
        size:        file.size,
      });

      await uploadEncryptedAttachment(uploadUrl, encrypted, (pct) => {
        setAttachments(prev => prev.map(a => a.id === entryId ? { ...a, progress: pct } : a));
      });

      setAttachments(prev => prev.map(a =>
        a.id === entryId ? { ...a, attachmentId, status: 'ready', progress: 100 } : a,
      ));
      isDirtyRef.current = true;
    } catch {
      setAttachments(prev => prev.map(a => a.id === entryId ? { ...a, status: 'failed' } : a));
    }
  }

  function addFiles(files: File[]) {
    setAttachError('');
    const currentTotal = attachments.reduce((s, a) => s + a.size, 0);
    const newTotal = files.reduce((s, f) => s + f.size, currentTotal);

    if (newTotal > MAX_TOTAL_BYTES) {
      setAttachError(`Total attachment size exceeds ${formatBytes(MAX_TOTAL_BYTES)} limit.`);
      return;
    }

    const entries: AttachmentEntry[] = files.map(f => ({
      id:           `${Date.now()}-${Math.random()}`,
      file:         f,
      name:         f.name,
      size:         f.size,
      type:         f.type,
      attachmentId: null,
      status:       'uploading',
      progress:     0,
    }));

    setAttachments(prev => [...prev, ...entries]);
    for (let i = 0; i < entries.length; i++) {
      void uploadFile(files[i]!, entries[i]!.id);
    }
  }

  async function insertImageInline(file: File) {
    const b64 = await fileToBase64(file);
    const src = `data:${file.type};base64,${b64}`;
    editor?.chain().focus().setImage({ src, alt: file.name }).run();
    isDirtyRef.current = true;
  }

  function removeAttachment(id: string) {
    const att = attachments.find(a => a.id === id);
    if (att?.attachmentId) {
      void deleteAttachment(composeEmailIdRef.current, att.attachmentId);
    }
    setAttachments(prev => prev.filter(a => a.id !== id));
    setAttachError('');
    isDirtyRef.current = true;
  }

  // ---------------------------------------------------------------------------
  // Drag and drop
  // ---------------------------------------------------------------------------

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragOver(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;

    const images = files.filter(f => f.type.startsWith('image/'));
    const others = files.filter(f => !f.type.startsWith('image/'));

    for (const img of images) {
      await insertImageInline(img);
    }
    if (others.length) addFiles(others);
  }, [attachments, editor]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Close / discard dialog
  // ---------------------------------------------------------------------------

  function hasContent() {
    return (
      to.length > 0 ||
      cc.length > 0 ||
      bcc.length > 0 ||
      subject.trim().length > 0 ||
      (editor?.getText().trim().length ?? 0) > 0 ||
      attachments.length > 0
    );
  }

  function handleCloseClick() {
    if (!hasContent() && !draftUlidRef.current) {
      closeCompose();
      return;
    }
    setShowDiscardDialog(true);
  }

  async function handleSaveDraftAndClose() {
    setShowDiscardDialog(false);
    await doSaveDraftRef.current?.();
    closeCompose();
  }

  async function handleDiscard() {
    setShowDiscardDialog(false);
    // Best-effort delete of uploaded attachment binaries
    for (const att of attachments) {
      if (att.attachmentId) {
        void deleteAttachment(composeEmailIdRef.current, att.attachmentId);
      }
    }
    if (draftUlidRef.current) {
      const uid = draftUlidRef.current;
      draftUlidRef.current = null;
      await deleteDraft(uid).catch(() => { });
      const db = await getDb();
      await db.exec('DELETE FROM email_metadata WHERE ulid = ?', { bind: [uid] }).catch(() => { });
      void queryClient.invalidateQueries({ queryKey: ['emails', 'DRAFTS'] });
    }
    closeCompose();
  }

  // ---------------------------------------------------------------------------
  // Send
  // ---------------------------------------------------------------------------

  async function handleSend() {
    if (!editor || sending) return;
    if (!to.length) { setError('Please enter a recipient.'); return; }
    if (attachments.some(a => a.status === 'uploading')) {
      setError('Please wait for attachments to finish uploading.');
      return;
    }
    if (attachments.some(a => a.status === 'failed')) {
      setError('Some attachments failed to upload. Remove them and try again.');
      return;
    }
    if (!emailKeyRef.current) {
      setError('Encryption key not ready. Please try again.');
      return;
    }

    setSending(true);
    setError('');
    try {
      // 1. Save blobs to S3 only if content changed since last auto-save (or never saved yet)
      if (isDirtyRef.current || !draftUlidRef.current || saveStatus === 'error') {
        await doSaveDraftRef.current?.();
      }
      if (!draftUlidRef.current) draftUlidRef.current = composeEmailIdRef.current;
      const emailId  = draftUlidRef.current!;
      const emailKey = await exportEmailKeyBase64(emailKeyRef.current!);
      const displayName = useSettingsStore.getState().getDisplayName();

      // 2. Ask the server to decrypt, build MIME, and send via SES
      await sendEmail({ emailId, emailKey, displayName });

      // 3. Remove draft entry from local DB
      const db = await getDb();
      await db.exec('DELETE FROM email_metadata WHERE ulid = ?', { bind: [emailId] }).catch(() => { });
      await db.exec('DELETE FROM email_fts WHERE ulid = ?',      { bind: [emailId] }).catch(() => { });
      await upsertContacts(db, {
        fromName: '', fromAddress: userEmail,
        to: to.map(extractAddress), cc: cc.map(extractAddress),
        date: new Date().toISOString(),
      });

      void queryClient.invalidateQueries({ queryKey: ['emails', 'DRAFTS'] });
      void queryClient.invalidateQueries({ queryKey: ['emails', 'SENT'] });
      closeCompose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setSending(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const headerTitle = subject.trim() || 'New Message';

  const sizeClasses =
    mode === 'expanded'
      ? 'inset-0 md:inset-4 md:left-[8vw] md:right-[8vw] md:top-[3vh] md:bottom-[3vh]'
      : mode === 'minimized'
        ? 'bottom-0 inset-x-0 h-11 md:inset-x-auto md:right-6 md:w-[340px]'
        : 'inset-x-0 bottom-0 h-[90vh] md:inset-x-auto md:right-6 md:h-auto md:w-[580px] md:max-h-[min(760px,calc(100vh-2rem))]';

  const totalAttachedBytes = attachments.reduce((s, a) => s + a.size, 0);

  return (
    <div
      className={`fixed ${sizeClasses} z-50 flex flex-col rounded-t-xl
                  shadow-[0_8px_40px_rgba(0,0,0,0.35)] bg-white border border-gray-300
                  border-b-0 overflow-hidden transition-[width,height] duration-150`}
      onDragEnter={mode !== 'minimized' ? handleDragEnter : undefined}
      onDragLeave={mode !== 'minimized' ? handleDragLeave : undefined}
      onDragOver={mode !== 'minimized' ? handleDragOver : undefined}
      onDrop={mode !== 'minimized' ? handleDrop : undefined}
    >
      {/* ── Discard confirmation overlay ── */}
      {showDiscardDialog && (
        <DiscardDialog
          onSave={() => void handleSaveDraftAndClose()}
          onDiscard={() => void handleDiscard()}
          onCancel={() => setShowDiscardDialog(false)}
        />
      )}

      {/* ── Drag-over overlay ── */}
      {isDragOver && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center
                        bg-blue-50/90 border-2 border-dashed border-blue-400 rounded-t-xl pointer-events-none">
          <svg className="w-10 h-10 text-blue-400 mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
          <p className="text-sm font-medium text-blue-600">Drop files here</p>
          <p className="text-xs text-blue-400 mt-0.5">Images will be inserted inline · other files will be attached</p>
        </div>
      )}

      {/* ── Title bar ── */}
      <div
        className="flex items-center justify-between px-3 h-11 bg-gray-800 text-white
                   cursor-default select-none shrink-0"
        onDoubleClick={() => setMode(m => m === 'minimized' ? 'normal' : 'minimized')}
      >
        <div className="flex items-center gap-2 min-w-0 mr-2">
          <span className="text-sm font-medium truncate">{headerTitle}</span>
          {saveStatus === 'saving' && <span className="text-xs text-gray-400 shrink-0">Saving…</span>}
          {saveStatus === 'saved' && <span className="text-xs text-green-400 shrink-0">Saved</span>}
          {saveStatus === 'error' && <span className="text-xs text-red-400 shrink-0">Save failed</span>}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => setMode(m => m === 'minimized' ? 'normal' : 'minimized')}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/20"
            title={mode === 'minimized' ? 'Restore' : 'Minimize'}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>

          <button
            onClick={() => setMode(m => m === 'expanded' ? 'normal' : 'expanded')}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/20"
            title={mode === 'expanded' ? 'Restore' : 'Full screen'}
          >
            {mode === 'expanded' ? (
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            )}
          </button>

          <button
            onClick={handleCloseClick}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/20"
            title="Close"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Body — hidden when minimized ── */}
      {mode !== 'minimized' && (
        <>
          {/* Header fields */}
          <div className="border-b border-gray-200 shrink-0 text-sm">
            <div className="flex items-center border-b border-gray-100 last:border-b-0">
              <div className="flex-1 min-w-0">
                <RecipientInput label="To" recipients={to} onChange={setTo} autoFocus />
              </div>
              <div className="flex gap-2 shrink-0 text-xs text-gray-400 pr-3">
                {!showCc && <button onClick={() => setShowCc(true)} className="hover:text-gray-600">Cc</button>}
                {!showBcc && <button onClick={() => setShowBcc(true)} className="hover:text-gray-600">Bcc</button>}
              </div>
            </div>

            {showCc && (
              <div className="border-t border-gray-100">
                <RecipientInput label="Cc" recipients={cc} onChange={setCc} />
              </div>
            )}

            {showBcc && (
              <div className="border-t border-gray-100">
                <RecipientInput label="Bcc" recipients={bcc} onChange={setBcc} />
              </div>
            )}

            <div className="flex items-center px-3 py-1.5 gap-2 border-t border-gray-100">
              <span className="text-xs font-medium text-gray-400 w-10 shrink-0">Subject</span>
              <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject"
                className="flex-1 py-0.5 focus:outline-none font-medium" />
            </div>
          </div>

          {/* ── Formatting toolbar ── */}
          <div className="flex items-center flex-wrap gap-0.5 px-2 py-1 border-b border-gray-200 bg-gray-50 shrink-0">
            {/* Font family */}
            <select
              title="Font family"
              className="text-xs text-gray-600 bg-transparent border-0 focus:outline-none cursor-pointer
                         hover:bg-gray-100 rounded px-1 py-0.5 max-w-[90px]"
              onChange={e => editor?.chain().focus().setFontFamily(e.target.value).run()}
              value={editor?.getAttributes('textStyle').fontFamily ?? ''}
            >
              <option value="">Font</option>
              <option value="Arial, sans-serif">Arial</option>
              <option value="Georgia, serif">Georgia</option>
              <option value="'Courier New', monospace">Courier New</option>
              <option value="'Times New Roman', serif">Times New Roman</option>
              <option value="Verdana, sans-serif">Verdana</option>
            </select>

            {/* Font size */}
            <select
              title="Font size"
              className="text-xs text-gray-600 bg-transparent border-0 focus:outline-none cursor-pointer
                         hover:bg-gray-100 rounded px-1 py-0.5 w-[52px]"
              onChange={e => {
                if (!e.target.value) return;
                editor?.chain().focus().setMark('textStyle', { fontSize: e.target.value }).run();
              }}
              defaultValue=""
            >
              <option value="">Size</option>
              <option value="10px">10</option>
              <option value="12px">12</option>
              <option value="14px">14</option>
              <option value="16px">16</option>
              <option value="18px">18</option>
              <option value="24px">24</option>
              <option value="36px">36</option>
            </select>

            <Divider />

            {/* Bold / Italic / Underline / Strikethrough */}
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleBold().run()}
              active={editor?.isActive('bold')} title="Bold (Ctrl+B)">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 4h8a4 4 0 010 8H6V4zm0 8h9a4 4 0 010 8H6v-8z" />
              </svg>
            </ToolbarBtn>
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleItalic().run()}
              active={editor?.isActive('italic')} title="Italic (Ctrl+I)">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M10 4h6l-1 2h-5L6 20H4l1-2h4l4-14z" />
              </svg>
            </ToolbarBtn>
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleUnderline().run()}
              active={editor?.isActive('underline')} title="Underline (Ctrl+U)">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 17a6 6 0 006-6V3h-2v8a4 4 0 01-8 0V3H6v8a6 6 0 006 6z" />
                <rect x="4" y="20" width="16" height="2" rx="1" />
              </svg>
            </ToolbarBtn>
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleStrike().run()}
              active={editor?.isActive('strike')} title="Strikethrough">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 4H9a3 3 0 00-2.83 4" />
                <path d="M14 12a4 4 0 010 8H6" />
                <line x1="4" y1="12" x2="20" y2="12" />
              </svg>
            </ToolbarBtn>

            <Divider />

            {/* Text color */}
            <div className="relative">
              <ToolbarBtn onClick={() => colorInputRef.current?.click()} title="Text color">
                <div className="flex flex-col items-center gap-0">
                  <svg className="w-4 h-3.5" viewBox="0 0 24 18" fill="currentColor">
                    <path d="M11 2L2 18h3.5l1.6-4h9.8l1.6 4H22L13 2h-2zm-2.3 9L11 5l2.3 6H8.7z" />
                  </svg>
                  <div className="w-4 h-1 rounded-sm" style={{ backgroundColor: editor?.getAttributes('textStyle').color ?? '#000000' }} />
                </div>
              </ToolbarBtn>
              <input ref={colorInputRef} type="color" className="absolute opacity-0 w-0 h-0 pointer-events-none"
                onChange={e => editor?.chain().focus().setColor(e.target.value).run()} />
            </div>

            <Divider />

            {/* Alignment */}
            <ToolbarBtn onClick={() => editor?.chain().focus().setTextAlign('left').run()}
              active={editor?.isActive({ textAlign: 'left' })} title="Align left">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <rect x="3" y="5" width="18" height="2" rx="1" />
                <rect x="3" y="9" width="12" height="2" rx="1" />
                <rect x="3" y="13" width="18" height="2" rx="1" />
                <rect x="3" y="17" width="12" height="2" rx="1" />
              </svg>
            </ToolbarBtn>
            <ToolbarBtn onClick={() => editor?.chain().focus().setTextAlign('center').run()}
              active={editor?.isActive({ textAlign: 'center' })} title="Align center">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <rect x="3" y="5" width="18" height="2" rx="1" />
                <rect x="6" y="9" width="12" height="2" rx="1" />
                <rect x="3" y="13" width="18" height="2" rx="1" />
                <rect x="6" y="17" width="12" height="2" rx="1" />
              </svg>
            </ToolbarBtn>
            <ToolbarBtn onClick={() => editor?.chain().focus().setTextAlign('right').run()}
              active={editor?.isActive({ textAlign: 'right' })} title="Align right">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <rect x="3" y="5" width="18" height="2" rx="1" />
                <rect x="9" y="9" width="12" height="2" rx="1" />
                <rect x="3" y="13" width="18" height="2" rx="1" />
                <rect x="9" y="17" width="12" height="2" rx="1" />
              </svg>
            </ToolbarBtn>

            <Divider />

            {/* Lists */}
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleBulletList().run()}
              active={editor?.isActive('bulletList')} title="Bullet list">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="4" cy="6" r="1.5" /><circle cx="4" cy="12" r="1.5" /><circle cx="4" cy="18" r="1.5" />
                <path d="M8 5h12v2H8V5zm0 6h12v2H8v-2zm0 6h12v2H8v-2z" />
              </svg>
            </ToolbarBtn>
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleOrderedList().run()}
              active={editor?.isActive('orderedList')} title="Numbered list">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 4h2v4H3V5h1V4zm4 1h13v2H7V5zm0 6h13v2H7v-2zm0 6h13v2H7v-2zM3 14h3v1H4v1h3v1H3v-1h1v-1H3v-1z" />
              </svg>
            </ToolbarBtn>

            {/* Blockquote */}
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleBlockquote().run()}
              active={editor?.isActive('blockquote')} title="Blockquote">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1zm12 0c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z" />
              </svg>
            </ToolbarBtn>

            <Divider />

            {/* Link */}
            <ToolbarBtn onClick={insertLink} active={editor?.isActive('link')} title="Insert link">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
              </svg>
            </ToolbarBtn>

            {/* Emoji */}
            <div className="relative">
              <ToolbarBtn onClick={() => setShowEmoji(v => !v)} active={showEmoji} title="Emoji">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                  <line x1="9" y1="9" x2="9.01" y2="9" />
                  <line x1="15" y1="9" x2="15.01" y2="9" />
                </svg>
              </ToolbarBtn>
              {showEmoji && (
                <div className="absolute bottom-full right-0 mb-1 z-10 shadow-xl rounded-xl overflow-hidden">
                  <Picker
                    data={data}
                    onEmojiSelect={(emoji: { native: string }) => {
                      editor?.chain().focus().insertContent(emoji.native).run();
                      setShowEmoji(false);
                    }}
                    theme="light"
                    previewPosition="none"
                    skinTonePosition="none"
                  />
                </div>
              )}
            </div>

            {/* Attach file */}
            <ToolbarBtn onClick={() => fileInputRef.current?.click()} title="Attach file">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
              </svg>
            </ToolbarBtn>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={e => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) addFiles(files);
                e.target.value = '';
              }}
            />
          </div>

          {/* ── Rich-text body ── */}
          <div
            className="flex-1 overflow-y-auto min-h-0 text-sm cursor-text
                       [&_.tiptap]:outline-none
                       [&_.tiptap_p.is-empty:first-child::before]:content-[attr(data-placeholder)]
                       [&_.tiptap_p.is-empty:first-child::before]:text-gray-400
                       [&_.tiptap_p.is-empty:first-child::before]:float-left
                       [&_.tiptap_p.is-empty:first-child::before]:h-0
                       [&_.tiptap_p.is-empty:first-child::before]:pointer-events-none
                       [&_.tiptap_ul]:list-disc [&_.tiptap_ul]:pl-5 [&_.tiptap_ul]:my-1
                       [&_.tiptap_ol]:list-decimal [&_.tiptap_ol]:pl-5 [&_.tiptap_ol]:my-1
                       [&_.tiptap_blockquote]:border-l-4 [&_.tiptap_blockquote]:border-gray-300
                       [&_.tiptap_blockquote]:pl-3 [&_.tiptap_blockquote]:text-gray-500 [&_.tiptap_blockquote]:my-2
                       [&_.tiptap_a]:text-blue-600 [&_.tiptap_a]:underline
                       [&_.tiptap_p]:my-0.5
                       [&_.tiptap_img]:max-w-full [&_.tiptap_img]:rounded
                       [&_.tiptap_h1]:text-2xl [&_.tiptap_h1]:font-bold [&_.tiptap_h1]:my-2
                       [&_.tiptap_h2]:text-xl [&_.tiptap_h2]:font-bold [&_.tiptap_h2]:my-1.5
                       [&_.tiptap_h3]:text-lg [&_.tiptap_h3]:font-semibold [&_.tiptap_h3]:my-1"
            onClick={() => editor?.commands.focus()}
          >
            <EditorContent editor={editor} />
          </div>

          {/* ── Attachment chips ── */}
          {attachments.length > 0 && (
            <div className="px-3 py-2 border-t border-gray-100 bg-gray-50 shrink-0">
              <div className="flex flex-wrap gap-1.5">
                {attachments.map(att => (
                  <AttachmentChip
                    key={att.id}
                    att={att}
                    onRemove={() => removeAttachment(att.id)}
                  />
                ))}
              </div>
              <p className="text-[10px] text-gray-400 mt-1">
                {formatBytes(totalAttachedBytes)} / {formatBytes(MAX_TOTAL_BYTES)} used
              </p>
            </div>
          )}

          {attachError && (
            <p className="px-3 py-1.5 text-xs text-amber-700 bg-amber-50 border-t border-amber-100 shrink-0">{attachError}</p>
          )}

          {error && (
            <p className="px-3 py-1.5 text-xs text-red-600 bg-red-50 border-t border-red-100 shrink-0">{error}</p>
          )}

          {/* ── Footer ── */}
          <div className="flex items-center justify-between px-3 py-2 border-t border-gray-200 bg-gray-50 shrink-0">
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={sending || attachments.some(a => a.status === 'uploading')}
              className="flex items-center gap-1.5 px-5 py-2 bg-blue-600 hover:bg-blue-700
                         disabled:bg-blue-300 text-white text-sm font-medium rounded-full transition-colors"
            >
              {sending ? 'Sending…' : 'Send'}
              {!sending && (
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M22 2L11 13M22 2L15 22 11 13 2 9l20-7z" />
                </svg>
              )}
            </button>
            <button type="button" onClick={handleCloseClick}
              className="text-xs text-gray-400 hover:text-gray-600">
              Discard
            </button>
          </div>
        </>
      )}
    </div>
  );
}
