/**
 * AskAiPanel — chat UI for the on-device AI email assistant.
 *
 * Right-side drawer (full-screen on mobile). The conversation is streamed
 * from Claude on Bedrock (lambda/ai-handler); every tool the model calls is
 * executed locally in this browser against the decrypted mailbox, and only
 * those tool results leave the device. Multiple tool calls in one assistant
 * turn are executed in parallel and returned in a single user message.
 *
 * Assistant answers can cite emails as [Subject](email:ULID) — rendered as
 * clickable links that open the email in the mail view.
 *
 * Chat history is stored only in the device-local SQLite database (ai_chats).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { streamAiMessage, type AiContentBlock, type AiMessage } from '../../api/ai';
import { executeAiTool, describeToolCall } from '../../ai/tools';
import { listChats, loadChat, saveChat, deleteChat, type ChatSummary } from '../../ai/chatStore';
import { useUiStore } from '../../store/uiStore';
import { useAuthStore } from '../../store/authStore';

const MAX_TOOL_ROUNDS = 8;

const newChatId = (): string => crypto.randomUUID();

// ---------------------------------------------------------------------------
// Assistant text rendering — lightweight markdown (the subset Claude emits in
// chat: bold, italic, inline code, bullet/numbered lists, headings) plus
// [label](email:ID) email links and plain web links. Dependency-free.
// ---------------------------------------------------------------------------

// Alternation: **bold** | `code` | [label](email:ID) | [label](https://…) | *italic*
const INLINE_RE =
  /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(email:([0-9A-Za-z]{1,64})\)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*([^*\s][^*]*)\*/g;

function renderInline(text: string, onOpenEmail: (ulid: string) => void, keyPrefix = ''): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(INLINE_RE.source, 'g');
  let i = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const key = `${keyPrefix}${i++}`;
    const [, bold, code, emailLabel, emailId, urlLabel, url, italic] = match;
    if (bold !== undefined) {
      parts.push(<strong key={key} className="font-semibold">{renderInline(bold, onOpenEmail, `${key}b`)}</strong>);
    } else if (code !== undefined) {
      parts.push(
        <code key={key} className="px-1 py-0.5 text-[0.85em] rounded bg-gray-100 dark:bg-gray-800 font-mono">
          {code}
        </code>,
      );
    } else if (emailId !== undefined) {
      parts.push(
        <button
          key={key}
          onClick={() => onOpenEmail(emailId)}
          className="inline text-left text-blue-600 dark:text-blue-400 underline decoration-dotted
                     underline-offset-2 hover:text-blue-700 dark:hover:text-blue-300"
        >
          {emailLabel}
        </button>,
      );
    } else if (url !== undefined) {
      parts.push(
        <a key={key} href={url} target="_blank" rel="noopener noreferrer"
          className="text-blue-600 dark:text-blue-400 underline underline-offset-2 hover:text-blue-700 dark:hover:text-blue-300">
          {urlLabel}
        </a>,
      );
    } else if (italic !== undefined) {
      parts.push(<em key={key}>{renderInline(italic, onOpenEmail, `${key}i`)}</em>);
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

type MdBlock =
  | { type: 'p'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] };

function parseBlocks(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = text.split('\n');
  let para: string[] = [];
  const flushPara = () => {
    const t = para.join('\n').trim();
    if (t) blocks.push({ type: 'p', text: t });
    para = [];
  };

  for (const line of lines) {
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (bullet) {
      flushPara();
      const last = blocks[blocks.length - 1];
      if (last?.type === 'ul') last.items.push(bullet[1]);
      else blocks.push({ type: 'ul', items: [bullet[1]] });
    } else if (numbered) {
      flushPara();
      const last = blocks[blocks.length - 1];
      if (last?.type === 'ol') last.items.push(numbered[1]);
      else blocks.push({ type: 'ol', items: [numbered[1]] });
    } else if (heading) {
      flushPara();
      blocks.push({ type: 'heading', text: heading[1] });
    } else if (!line.trim()) {
      flushPara();
    } else {
      para.push(line);
    }
  }
  flushPara();
  return blocks;
}

function AssistantText({ text, onOpenEmail }: { text: string; onOpenEmail: (ulid: string) => void }) {
  const blocks = parseBlocks(text);
  return (
    <div className="text-sm text-gray-800 dark:text-gray-100 break-words leading-relaxed space-y-2">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'heading':
            return <p key={i} className="font-semibold">{renderInline(block.text, onOpenEmail, `h${i}-`)}</p>;
          case 'ul':
            return (
              <ul key={i} className="list-disc pl-5 space-y-1">
                {block.items.map((item, j) => <li key={j}>{renderInline(item, onOpenEmail, `u${i}-${j}-`)}</li>)}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} className="list-decimal pl-5 space-y-1">
                {block.items.map((item, j) => <li key={j}>{renderInline(item, onOpenEmail, `o${i}-${j}-`)}</li>)}
              </ol>
            );
          default:
            return <p key={i} className="whitespace-pre-wrap">{renderInline(block.text, onOpenEmail, `p${i}-`)}</p>;
        }
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transcript derivation — the display is derived from the stored API messages,
// so saved chats re-render identically to live ones.
// ---------------------------------------------------------------------------

type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tools'; items: string[] };

function deriveTranscript(messages: AiMessage[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ kind: 'user', text: msg.content });
      }
      // tool_result user messages are internal — not displayed
      continue;
    }
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const toolItems: string[] = [];
    for (const block of blocks) {
      if (block.type === 'text' && block.text?.trim()) {
        if (toolItems.length) { out.push({ kind: 'tools', items: [...toolItems] }); toolItems.length = 0; }
        out.push({ kind: 'assistant', text: block.text });
      } else if (block.type === 'tool_use') {
        toolItems.push(describeToolCall(block.name ?? '', block.input));
      }
    }
    if (toolItems.length) out.push({ kind: 'tools', items: toolItems });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chat history row — swipe left on touch screens to reveal delete
// (hover reveals it on desktop; touch has no hover state)
// ---------------------------------------------------------------------------

const SWIPE_REVEAL_PX = 88;

function ChatRow({ chat, onOpen, onDelete }: {
  chat: ChatSummary;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startX = useRef<number | null>(null);
  const startOffset = useRef(0);

  return (
    <div className="relative overflow-hidden rounded-lg">
      {/* Delete action revealed behind the row */}
      <button
        onClick={onDelete}
        aria-label="Delete chat"
        className="absolute inset-y-0 right-0 w-[88px] bg-red-600 text-white flex items-center justify-center"
      >
        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
        </svg>
      </button>

      {/* Sliding layer */}
      <div
        className={`group relative flex items-center gap-1 bg-white dark:bg-gray-900 ${dragging ? '' : 'transition-transform duration-200'}`}
        style={{ transform: `translateX(${offset}px)` }}
        onTouchStart={e => {
          startX.current = e.touches[0].clientX;
          startOffset.current = offset;
          setDragging(true);
        }}
        onTouchMove={e => {
          if (startX.current === null) return;
          const delta = e.touches[0].clientX - startX.current + startOffset.current;
          setOffset(Math.min(0, Math.max(-SWIPE_REVEAL_PX, delta)));
        }}
        onTouchEnd={() => {
          startX.current = null;
          setDragging(false);
          setOffset(o => (o < -SWIPE_REVEAL_PX / 2 ? -SWIPE_REVEAL_PX : 0));
        }}
      >
        <button
          onClick={() => {
            // A tap while the delete action is revealed just closes it
            if (offset !== 0) { setOffset(0); return; }
            onOpen();
          }}
          className="flex-1 min-w-0 text-left px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <p className="text-sm text-gray-800 dark:text-gray-100 truncate">{chat.title}</p>
          <p className="text-xs text-gray-400">{new Date(chat.updatedAt).toLocaleString()}</p>
        </button>
        {/* Desktop hover delete */}
        <button
          onClick={onDelete}
          title="Delete chat"
          aria-label="Delete chat"
          className="shrink-0 p-1.5 text-gray-400 hover:text-red-600 opacity-0 group-hover:opacity-100
                     dark:hover:text-red-400 max-md:hidden"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export default function AskAiPanel() {
  const aiPanel = useUiStore(s => s.aiPanel);
  const closeAiPanel = useUiStore(s => s.closeAiPanel);
  const selectEmail = useUiStore(s => s.selectEmail);
  const privateKey = useAuthStore(s => s.privateKey);

  const [view, setView] = useState<'chat' | 'history'>(aiPanel === 'history' ? 'history' : 'chat');
  const [chatId, setChatId] = useState(() => newChatId());
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [pendingTools, setPendingTools] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [chats, setChats] = useState<ChatSummary[]>([]);

  const messagesRef = useRef<AiMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef('');

  // Reset to the requested view whenever the panel is (re)opened
  useEffect(() => {
    if (aiPanel === 'history') setView('history');
    if (aiPanel === 'new') startNewChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiPanel]);

  useEffect(() => {
    if (view === 'history') void listChats().then(setChats).catch(() => setChats([]));
  }, [view]);

  // Keep scrolled to the bottom as content streams in
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streamingText, pendingTools]);

  // Abort any in-flight request on unmount
  useEffect(() => () => abortRef.current?.abort(), []);

  function startNewChat() {
    abortRef.current?.abort();
    setView('chat');
    setChatId(newChatId());
    messagesRef.current = [];
    setMessages([]);
    setStreamingText('');
    setPendingTools([]);
    setBusy(false);
    setError(null);
    titleRef.current = '';
  }

  async function openChat(id: string) {
    const loaded = await loadChat(id);
    if (!loaded) return;
    abortRef.current?.abort();
    setChatId(id);
    messagesRef.current = loaded;
    setMessages(loaded);
    const firstUser = loaded.find(m => m.role === 'user' && typeof m.content === 'string');
    titleRef.current = typeof firstUser?.content === 'string' ? firstUser.content.slice(0, 80) : 'Chat';
    setStreamingText('');
    setPendingTools([]);
    setBusy(false);
    setError(null);
    setView('chat');
  }

  const openEmail = useCallback((ulid: string) => {
    selectEmail(ulid);
    // On phones the panel covers the whole screen — close it to reveal the email
    if (window.matchMedia('(max-width: 767px)').matches) closeAiPanel();
  }, [selectEmail, closeAiPanel]);

  async function persist() {
    if (messagesRef.current.length === 0) return;
    await saveChat(chatId, titleRef.current || 'Chat', messagesRef.current).catch(() => { /* history is best-effort */ });
  }

  async function runTurn(userText: string) {
    if (!privateKey) { setError('Sign-in keys unavailable — reload and sign in again.'); return; }
    setBusy(true);
    setError(null);

    if (!titleRef.current) titleRef.current = userText.slice(0, 80);
    messagesRef.current = [...messagesRef.current, { role: 'user', content: userText }];
    setMessages(messagesRef.current);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        setStreamingText('');
        const final = await streamAiMessage(
          messagesRef.current,
          delta => setStreamingText(prev => prev + delta),
          controller.signal,
        );

        messagesRef.current = [...messagesRef.current, { role: 'assistant', content: final.content }];
        setMessages(messagesRef.current);
        setStreamingText('');
        await persist();

        const toolUses = final.content.filter(b => b.type === 'tool_use');
        if (final.stopReason !== 'tool_use' || toolUses.length === 0) break;
        if (round === MAX_TOOL_ROUNDS) {
          setError('The assistant hit its research limit for one question — ask a follow-up to continue.');
          break;
        }

        // Execute ALL tool calls in parallel; return every result in ONE user message
        setPendingTools(toolUses.map(t => describeToolCall(t.name ?? '', t.input)));
        const results = await Promise.all(toolUses.map(async (tu): Promise<AiContentBlock> => {
          try {
            const content = await executeAiTool(tu.name ?? '', tu.input, privateKey);
            return { type: 'tool_result', tool_use_id: tu.id, content };
          } catch (err) {
            console.error(`[ask-ai] Tool ${tu.name} failed:`, tu.input, err);
            return { type: 'tool_result', tool_use_id: tu.id, content: (err as Error).message, is_error: true };
          }
        }));
        setPendingTools([]);
        if (controller.signal.aborted) break;

        messagesRef.current = [...messagesRef.current, { role: 'user', content: results }];
        // (not displayed — deriveTranscript skips tool_result messages)
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError((err as Error).message || 'Something went wrong.');
      }
    } finally {
      setPendingTools([]);
      setStreamingText('');
      setBusy(false);
      abortRef.current = null;
      await persist();
    }
  }

  function handleSend() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    void runTurn(text);
  }

  async function handleDeleteChat(id: string) {
    await deleteChat(id).catch(() => { /* best-effort */ });
    setChats(prev => prev.filter(c => c.chatId !== id));
    if (id === chatId) startNewChat();
  }

  const transcript = deriveTranscript(messages);

  return (
    <div className="fixed inset-0 z-50 md:inset-auto md:right-0 md:top-0 md:bottom-0 md:w-[26rem]
                    flex flex-col bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 shadow-2xl">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        {view === 'chat' ? (
          <button
            onClick={() => setView('history')}
            title="Chat history"
            aria-label="Chat history"
            className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-lg dark:text-gray-400 dark:hover:bg-gray-800"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
          </button>
        ) : (
          <span className="p-1.5 text-gray-400">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
          </span>
        )}
        <h2 className="flex-1 text-sm font-semibold text-gray-800 dark:text-gray-100">
          {view === 'history' ? 'AI Chats' : 'Ask AI'}
        </h2>
        <button
          onClick={startNewChat}
          title="New chat"
          aria-label="New chat"
          className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-lg dark:text-gray-400 dark:hover:bg-gray-800"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button
          onClick={closeAiPanel}
          title="Close"
          aria-label="Close Ask AI"
          className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-lg dark:text-gray-400 dark:hover:bg-gray-800"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {view === 'history' ? (
        /* ── Chat history list ─────────────────────────────────────────── */
        <div className="flex-1 overflow-y-auto p-2">
          {chats.length === 0 && (
            <p className="p-4 text-sm text-gray-500 dark:text-gray-400">
              No previous chats. Chats are stored only on this device.
            </p>
          )}
          {chats.map(chat => (
            <ChatRow
              key={chat.chatId}
              chat={chat}
              onOpen={() => void openChat(chat.chatId)}
              onDelete={() => void handleDeleteChat(chat.chatId)}
            />
          ))}
        </div>
      ) : (
        /* ── Active chat ───────────────────────────────────────────────── */
        <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
            {transcript.length === 0 && !busy && (
              <div className="text-sm text-gray-500 dark:text-gray-400 space-y-2 mt-4">
                <p>Ask anything about your email — I can search it, read specific messages, and pull together answers.</p>
                <p className="text-xs">Try: "What did the dentist say about my next appointment?" or "Summarize unread emails from this week."</p>
              </div>
            )}
            {transcript.map((item, i) => {
              if (item.kind === 'user') {
                return (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] px-3 py-2 rounded-2xl rounded-br-sm bg-blue-600 text-white text-sm whitespace-pre-wrap break-words">
                      {item.text}
                    </div>
                  </div>
                );
              }
              if (item.kind === 'tools') {
                return (
                  <div key={i} className="space-y-1">
                    {item.items.map((t, j) => (
                      <div key={j} className="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
                        <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                        <span className="truncate">{t}</span>
                      </div>
                    ))}
                  </div>
                );
              }
              return (
                <div key={i} className="max-w-[95%]">
                  <AssistantText text={item.text} onOpenEmail={openEmail} />
                </div>
              );
            })}

            {/* Live streaming text */}
            {streamingText && (
              <div className="max-w-[95%]">
                <AssistantText text={streamingText} onOpenEmail={openEmail} />
              </div>
            )}
            {/* In-flight tool activity */}
            {pendingTools.map((t, i) => (
              <div key={`p${i}`} className="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
                <svg className="w-3 h-3 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="truncate">{t}</span>
              </div>
            ))}
            {busy && !streamingText && pendingTools.length === 0 && (
              <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Thinking…
              </div>
            )}
            {error && (
              <p className="text-xs text-red-500 dark:text-red-400">{error}</p>
            )}
          </div>

          {/* Input */}
          <div className="shrink-0 border-t border-gray-200 dark:border-gray-700 p-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
                }}
                placeholder="Ask about your email…"
                rows={Math.min(4, Math.max(1, input.split('\n').length))}
                className="flex-1 resize-none px-3 py-2 text-sm rounded-xl border border-gray-300 bg-white
                           focus:border-blue-500 outline-none dark:bg-gray-800 dark:border-gray-600
                           dark:text-gray-100 placeholder-gray-400"
              />
              {busy ? (
                <button
                  onClick={() => abortRef.current?.abort()}
                  title="Stop"
                  aria-label="Stop"
                  className="shrink-0 p-2.5 rounded-xl bg-gray-200 hover:bg-gray-300 text-gray-700
                             dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-200"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!input.trim()}
                  title="Send"
                  aria-label="Send"
                  className="shrink-0 p-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                </button>
              )}
            </div>
            <p className="mt-2 text-[11px] leading-snug text-gray-400 dark:text-gray-500">
              Searches run on this device; retrieved content is sent to AWS Bedrock for the answer. Chats stay on this device.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
