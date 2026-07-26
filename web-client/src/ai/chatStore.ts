/**
 * Ask AI chat history — persisted in the device-local SQLite database (OPFS,
 * encrypted at rest). Never synced to the server.
 */

import { getDb } from '../db/Database';
import type { AiMessage } from '../api/ai';

export interface ChatSummary {
  chatId: string;
  title: string;
  updatedAt: string;
}

export async function listChats(): Promise<ChatSummary[]> {
  const db = await getDb();
  const rows = await db.selectObjects(
    'SELECT chat_id, title, updatedAt FROM ai_chats ORDER BY updatedAt DESC LIMIT 200',
  );
  return rows.map(r => ({
    chatId: r['chat_id'] as string,
    title: r['title'] as string,
    updatedAt: r['updatedAt'] as string,
  }));
}

export async function loadChat(chatId: string): Promise<AiMessage[] | null> {
  const db = await getDb();
  const raw = await db.selectValue(
    'SELECT messages FROM ai_chats WHERE chat_id = ?', [chatId],
  ) as string | undefined;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AiMessage[];
  } catch {
    return null;
  }
}

export async function saveChat(chatId: string, title: string, messages: AiMessage[]): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.exec(
    `INSERT INTO ai_chats (chat_id, title, createdAt, updatedAt, messages)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       title = excluded.title,
       updatedAt = excluded.updatedAt,
       messages = excluded.messages`,
    { bind: [chatId, title, now, now, JSON.stringify(messages)] },
  );
}

export async function deleteChat(chatId: string): Promise<void> {
  const db = await getDb();
  await db.exec('DELETE FROM ai_chats WHERE chat_id = ?', { bind: [chatId] });
}
