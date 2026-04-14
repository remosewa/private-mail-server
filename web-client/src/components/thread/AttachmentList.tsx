import { useState } from 'react';
import type { AttachmentMeta } from '../../types';
import { getAttachmentBlob } from '../../api/emails';
import { decryptBlob, decryptAttachment, unwrapEmailKey } from '../../crypto/BlobCrypto';

function formatBytes(n: number): string {
  if (n < 1024)        return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  attachments: AttachmentMeta[];
  emailUlid: string;
  privateKey: CryptoKey;
  /** Present for draft/sent emails; absent for inbound (RSA-hybrid). */
  wrappedEmailKey?: string | null;
}

const COLLAPSE_THRESHOLD = 3;

export default function AttachmentList({ attachments, emailUlid, privateKey, wrappedEmailKey }: Props) {
  const [downloading, setDownloading] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(attachments.length <= COLLAPSE_THRESHOLD);

  if (!attachments.length) return null;

  async function download(attachment: AttachmentMeta) {
    const id = attachment.attachmentId;
    setDownloading(id);
    setErrors(prev => { const n = { ...prev }; delete n[id]; return n; });
    try {
      const encryptedBuffer = await getAttachmentBlob(emailUlid, id);
      let plaintext: ArrayBuffer;
      if (wrappedEmailKey) {
        const emailKey = await unwrapEmailKey(wrappedEmailKey, privateKey);
        plaintext = await decryptAttachment(encryptedBuffer, emailKey);
      } else {
        plaintext = (await decryptBlob(encryptedBuffer, privateKey)).buffer;
      }
      const blob = new Blob([plaintext], { type: attachment.contentType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = attachment.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      const msg = err instanceof Error && err.message.includes('404')
        ? 'Not available (email predates download support)'
        : 'Download failed';
      setErrors(prev => ({ ...prev, [id]: msg }));
    } finally {
      setDownloading(null);
    }
  }

  const canCollapse = attachments.length > COLLAPSE_THRESHOLD;

  return (
    <div className="border-t border-gray-200 px-4 py-3">
      <button
        onClick={() => canCollapse && setExpanded(v => !v)}
        className={`flex items-center gap-1.5 w-full text-left mb-2 group
                    ${canCollapse ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          Attachments ({attachments.length})
        </p>
        {canCollapse && (
          <span className="text-gray-400 text-xs group-hover:text-gray-600 transition-colors ml-auto">
            {expanded ? '▲ collapse' : '▼ show all'}
          </span>
        )}
      </button>

      {expanded && (
        <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto pr-1">
          {attachments.map((a) => (
            <div key={a.attachmentId} className="flex flex-col">
              <button
                onClick={() => void download(a)}
                disabled={downloading !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 hover:bg-gray-200
                           disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm
                           transition-colors text-left"
              >
                <span className="text-gray-600">{a.filename}</span>
                <span className="text-gray-400 text-xs">{formatBytes(a.size)}</span>
                {downloading === a.attachmentId ? (
                  <span className="text-gray-400 text-xs">…</span>
                ) : (
                  <span className="text-gray-400 text-xs">↓</span>
                )}
              </button>
              {errors[a.attachmentId] && (
                <span className="text-xs text-red-500 px-1 mt-0.5">{errors[a.attachmentId]}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {!expanded && (
        <div className="flex flex-wrap gap-2">
          {attachments.slice(0, COLLAPSE_THRESHOLD).map((a) => (
            <div key={a.attachmentId} className="flex flex-col">
              <button
                onClick={() => void download(a)}
                disabled={downloading !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 hover:bg-gray-200
                           disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm
                           transition-colors text-left"
              >
                <span className="text-gray-600">{a.filename}</span>
                <span className="text-gray-400 text-xs">{formatBytes(a.size)}</span>
                {downloading === a.attachmentId ? (
                  <span className="text-gray-400 text-xs">…</span>
                ) : (
                  <span className="text-gray-400 text-xs">↓</span>
                )}
              </button>
              {errors[a.attachmentId] && (
                <span className="text-xs text-red-500 px-1 mt-0.5">{errors[a.attachmentId]}</span>
              )}
            </div>
          ))}
          <button
            onClick={() => setExpanded(true)}
            className="flex items-center px-3 py-1.5 bg-gray-50 hover:bg-gray-100
                       border border-dashed border-gray-300 rounded-lg text-xs text-gray-500
                       hover:text-gray-700 transition-colors"
          >
            +{attachments.length - COLLAPSE_THRESHOLD} more
          </button>
        </div>
      )}
    </div>
  );
}
