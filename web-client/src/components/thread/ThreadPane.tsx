import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useUiStore } from '../../store/uiStore';
import { useAuthStore } from '../../store/authStore';
import { getEmailBody, getEmailAttachments, getAttachmentBlob } from '../../api/emails';
import { decryptBlob, decryptAttachment, unwrapEmailKey, decodeJson } from '../../crypto/BlobCrypto';
import { getDb } from '../../db/Database';
import type { EmailBodyBlob, EmailAttachmentsBlob } from '../../types';
import MessageView from './MessageView';
import ThreadNavigator from './ThreadNavigator';

export default function ThreadPane() {
  const { selectedEmailUlid, selectedFolderId } = useUiStore();
  const { privateKey } = useAuthStore();

  // Get threadId from local DB for navigator (fast, no decryption needed)
  const { data: threadData } = useQuery({
    queryKey: ['email-thread-id', selectedEmailUlid],
    enabled: !!selectedEmailUlid,
    queryFn: async () => {
      const db = await getDb();
      const rows = await db.selectObjects(
        'SELECT threadId FROM email_metadata WHERE ulid = ?',
        [selectedEmailUlid],
      );
      return {
        threadId: (rows[0]?.['threadId'] as string) ?? selectedEmailUlid,
      };
    },
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ['email-body', selectedEmailUlid],
    enabled: !!selectedEmailUlid && !!privateKey,
    queryFn: async () => {
      if (!selectedEmailUlid || !privateKey) throw new Error('Not ready');

      // Load header fields + wrappedEmailKey from local DB (header already decrypted during sync)
      const db = await getDb();
      const rows = await db.selectObjects(
        'SELECT threadId, subject, fromName, fromAddress, preview, toAddresses, receivedAt, wrappedEmailKey, listUnsubscribe, listUnsubscribePost, messageId FROM email_metadata WHERE ulid = ?',
        [selectedEmailUlid],
      );
      const row = rows[0];
      const threadId = (row?.['threadId'] as string) ?? selectedEmailUlid;
      const wrappedEmailKey = (row?.['wrappedEmailKey'] as string | null) ?? null;
      const header = {
        subject: (row?.['subject'] as string) ?? '',
        fromName: (row?.['fromName'] as string) ?? '',
        fromAddress: (row?.['fromAddress'] as string) ?? '',
        to: JSON.parse((row?.['toAddresses'] as string) ?? '[]') as string[],
        date: (row?.['receivedAt'] as string) ?? '',
        listUnsubscribe: (row?.['listUnsubscribe'] as string | null) ?? undefined,
        listUnsubscribePost: (row?.['listUnsubscribePost'] as string | null) ?? undefined,
        messageId: (row?.['messageId'] as string | null) ?? undefined,
      };

      console.log('[ThreadPane] Loaded header from DB:', {
        ulid: selectedEmailUlid,
        hasListUnsubscribe: !!row?.['listUnsubscribe'],
        listUnsubscribe: row?.['listUnsubscribe'],
        listUnsubscribePost: row?.['listUnsubscribePost'],
      });

      // Parallelize: unwrap the per-email key (RSA), body fetch, and attachments fetch
      // all at the same time — previously these ran sequentially (300-600ms wasted).
      const [emailKey, bodyBlob, attBlobResult] = await Promise.all([
        wrappedEmailKey ? unwrapEmailKey(wrappedEmailKey, privateKey) : Promise.resolve(null),
        getEmailBody(selectedEmailUlid),
        getEmailAttachments(selectedEmailUlid).catch(() => null),
      ]);

      async function decryptEmailBlob(buf: ArrayBuffer): Promise<Uint8Array> {
        if (emailKey) {
          return new Uint8Array(await decryptAttachment(buf, emailKey));
        }
        return decryptBlob(buf, privateKey!);
      }

      const body = decodeJson<EmailBodyBlob>(await decryptEmailBlob(bodyBlob));

      let attachments: EmailAttachmentsBlob = [];
      if (attBlobResult) {
        try {
          attachments = decodeJson<EmailAttachmentsBlob>(await decryptEmailBlob(attBlobResult));
        } catch {
          // No attachments blob or empty — not an error
        }
      }

      // Build CID map for inline images: contentId → blob URL
      const cidEntries = await Promise.all(
        attachments
          .filter(a => !!a.contentId)
          .map(async (a) => {
            try {
              const encBuf = await getAttachmentBlob(selectedEmailUlid, a.attachmentId);
              const bytes = await decryptEmailBlob(encBuf);
              const blobUrl = URL.createObjectURL(new Blob([bytes.slice()], { type: a.contentType }));
              const raw = a.contentId!.replace(/^<|>$/g, '');
              return [raw, blobUrl] as [string, string];
            } catch {
              return null;
            }
          }),
      );

      const cidMap = new Map<string, string>(
        cidEntries.filter((e): e is [string, string] => e !== null),
      );

      return { header, body, attachments, cidMap, wrappedEmailKey, threadId };
    },
  });

  // Revoke CID blob URLs when switching away from an email
  useEffect(() => {
    return () => {
      if (data?.cidMap) {
        for (const url of data.cidMap.values()) {
          URL.revokeObjectURL(url);
        }
      }
    };
  }, [data?.cidMap]);

  if (!selectedEmailUlid) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-400 bg-white dark:bg-gray-950 dark:text-gray-500">
        Select a message to read
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-950">
      {/* Thread Navigator - always visible */}
      {threadData && (
        <ThreadNavigator
          currentUlid={selectedEmailUlid}
          threadId={threadData.threadId}
          folderId={selectedFolderId}
        />
      )}

      {/* Message Content Area - shows loading/error states */}
      <div className="flex-1 overflow-auto">
        {isLoading && (
          <div className="flex items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500">
            Decrypting…
          </div>
        )}

        {error && !isLoading && (
          <div className="flex items-center justify-center h-full text-sm text-red-500">
            {error instanceof Error ? error.message : 'Failed to decrypt message'}
          </div>
        )}

        {data && !isLoading && !error && (
          <MessageView
            header={data.header}
            body={data.body}
            attachments={data.attachments}
            cidMap={data.cidMap}
            emailUlid={selectedEmailUlid}
            privateKey={privateKey!}
            wrappedEmailKey={data.wrappedEmailKey}
          />
        )}
      </div>
    </div>
  );
}
