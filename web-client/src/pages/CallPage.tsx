/**
 * CallPage — public video-call page at /call/{callId} (Amazon Chime SDK).
 *
 * Works with or without a logged-in session: the host opens this page with a
 * one-time host token in the URL fragment (#ht=...), which is moved into
 * sessionStorage and stripped from the URL; anyone else with the link joins
 * as a guest. Chime is an SFU, so everyone sees and hears everyone.
 *
 * Layout fills the visual viewport (h-dvh): tiles stretch to the available
 * space instead of forcing 16:9, so portrait phones get stacked full-width
 * tiles rather than letterboxed landscape strips.
 */

import { useEffect, useRef, useState } from 'react';
import { useChimeCall, parseExternalUserId, type CallTile } from '../hooks/useChimeCall';
import { useSettingsStore } from '../store/settingsStore';
import { useAuthStore } from '../store/authStore';

function readHostToken(callId: string): string | null {
  const storageKey = `call-host-token-${callId}`;
  const match = window.location.hash.match(/#ht=([0-9A-Za-z_-]+)/);
  if (match) {
    sessionStorage.setItem(storageKey, match[1]);
    // Strip the token from the URL so it isn't shared via copy/paste or history
    history.replaceState(null, '', window.location.pathname);
  }
  return sessionStorage.getItem(storageKey);
}

function tileLabel(tile: CallTile): string {
  if (tile.isLocal && !tile.isContent) return 'You';
  const { name } = parseExternalUserId(tile.externalUserId);
  if (tile.isContent) return tile.isLocal ? 'Your screen' : `${name}'s screen`;
  return name;
}

/**
 * Chat message text with clickable links. Rendered as plain text through
 * React (everything is escaped — no HTML is ever interpreted); only http(s)
 * and www. URLs are upgraded to anchors.
 */
const CHAT_URL_RE = /\b(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+\.[^\s<>"']{2,})/g;

function ChatText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(CHAT_URL_RE.source, 'g');
  while ((match = re.exec(text)) !== null) {
    // Trailing punctuation is almost never part of the URL
    let url = match[0];
    const trimmed = url.replace(/[.,!?;:)\]]+$/, '');
    const trailing = url.slice(trimmed.length);
    url = trimmed;

    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const href = url.startsWith('www.') ? `https://${url}` : url;
    parts.push(
      <a
        key={`${match.index}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 break-all hover:opacity-80"
      >
        {url}
      </a>,
    );
    if (trailing) parts.push(trailing);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts}</>;
}

/** Lobby self-view fed by a plain getUserMedia stream. */
function PreviewTile({ stream }: { stream: MediaStream | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current && videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);
  return (
    <div className="relative bg-gray-800 rounded-xl overflow-hidden aspect-video">
      <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover scale-x-[-1]" />
      <span className="absolute bottom-2 left-2 px-2 py-0.5 text-xs text-white bg-black/50 rounded">You</span>
    </div>
  );
}

/** In-call tile bound to a Chime video tile ID. Sized by its container. */
function ChimeTile({ tile, label, speaking, bind, onClick, className = '', clickTitle, onExpand, fill = false }: {
  tile: CallTile;
  label: string;
  speaking: boolean;
  bind: (tileId: number, el: HTMLVideoElement | null) => void;
  onClick?: () => void;
  className?: string;
  clickTitle?: string;
  /** When set, renders an always-visible "expand to full screen" button. */
  onExpand?: () => void;
  /** In the full-screen viewer we want the video to fill (object-contain) and no rounding. */
  fill?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    bind(tile.tileId, videoRef.current);
    return () => bind(tile.tileId, null);
  }, [tile.tileId, bind]);

  return (
    <div
      onClick={onClick}
      title={onClick ? clickTitle : undefined}
      className={`relative bg-gray-800 overflow-hidden min-h-0 transition-shadow ${fill ? '' : 'rounded-xl'} ${
        speaking ? 'ring-2 ring-green-500' : ''
      } ${onClick ? 'cursor-pointer' : ''} ${className}`}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={tile.isLocal}
        className={`absolute inset-0 w-full h-full ${tile.isContent || fill ? 'object-contain bg-black' : 'object-cover'} ${
          tile.isLocal && !tile.isContent ? 'scale-x-[-1]' : ''
        }`}
      />
      <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 text-[11px] text-white bg-black/50 rounded pointer-events-none">
        {label}
      </span>
      {onExpand && (
        <button
          onClick={e => { e.stopPropagation(); onExpand(); }}
          title="Expand to full screen"
          aria-label={`Expand ${label} to full screen`}
          className="absolute top-1.5 right-1.5 z-10 p-1.5 rounded-lg bg-black/55 hover:bg-black/75
                     text-white transition-colors"
        >
          <ExpandIcon />
        </button>
      )}
    </div>
  );
}

/** Full-screen viewer for a single tile with pinch/button zoom + drag-to-pan. */
function MaximizedViewer({ tile, label, bind, onClose }: {
  tile: CallTile;
  label: string;
  bind: (tileId: number, el: HTMLVideoElement | null) => void;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const MIN = 1, MAX = 5;
  const clamp = (z: number) => Math.min(MAX, Math.max(MIN, z));
  function zoomBy(delta: number) {
    setZoom(z => {
      const nz = clamp(Math.round((z + delta) * 100) / 100);
      if (nz === 1) setPan({ x: 0, y: 0 });
      return nz;
    });
  }
  function reset() { setZoom(1); setPan({ x: 0, y: 0 }); }

  function onPointerDown(e: React.PointerEvent) {
    if (zoom <= 1) return;
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    setPan({ x: dragRef.current.px + (e.clientX - dragRef.current.x), y: dragRef.current.py + (e.clientY - dragRef.current.y) });
  }
  function onPointerUp() { dragRef.current = null; setDragging(false); }

  // Esc closes; +/- zoom for keyboard users
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === '+' || e.key === '=') zoomBy(0.5);
      else if (e.key === '-' || e.key === '_') zoomBy(-0.5);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <div
        className="flex-1 min-h-0 overflow-hidden touch-none"
        style={{ cursor: zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'default' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onWheel={e => zoomBy(e.deltaY < 0 ? 0.3 : -0.3)}
      >
        <div
          className="w-full h-full"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
            transition: dragging ? 'none' : 'transform 0.15s ease-out',
          }}
        >
          <ChimeTile tile={tile} label={label} speaking={false} bind={bind} fill className="h-full w-full" />
        </div>
      </div>

      {/* Zoom + close controls — large targets for accessibility */}
      <div className="shrink-0 flex items-center justify-center gap-3 p-4 pb-6 bg-black">
        <button
          onClick={() => zoomBy(-0.5)}
          disabled={zoom <= MIN}
          title="Zoom out"
          aria-label="Zoom out"
          className="p-4 rounded-full bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-xl leading-none"
        >
          <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button
          onClick={reset}
          title="Reset zoom"
          className="px-4 py-3 rounded-full bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium tabular-nums min-w-[4.5rem]"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          onClick={() => zoomBy(0.5)}
          disabled={zoom >= MAX}
          title="Zoom in"
          aria-label="Zoom in"
          className="p-4 rounded-full bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white"
        >
          <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button
          onClick={onClose}
          className="ml-2 px-5 py-3 rounded-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold"
        >
          Done
        </button>
      </div>
    </div>
  );
}

/** Live mic input level, 0..1. */
function MicLevelBar({ level, muted }: { level: number; muted: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <MicIcon on={!muted} className="w-3.5 h-3.5 shrink-0 text-gray-400" />
      <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full transition-[width] duration-100 ${muted ? 'bg-gray-500' : 'bg-green-500'}`}
          style={{ width: `${Math.min(100, Math.round(level * 100))}%` }}
        />
      </div>
    </div>
  );
}

function DeviceSelects({ mics, cams, selectedMicId, selectedCamId, onMic, onCam, blur }: {
  mics: MediaDeviceInfo[];
  cams: MediaDeviceInfo[];
  selectedMicId: string;
  selectedCamId: string;
  onMic: (id: string) => void;
  onCam: (id: string) => void;
  /** Background blur toggle — omitted/hidden when the device can't run it. */
  blur?: { supported: boolean | null; enabled: boolean; onChange: (enabled: boolean) => void; note?: string };
}) {
  return (
    <>
      {mics.length > 0 && (
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          Microphone
          <select
            value={selectedMicId}
            onChange={e => onMic(e.target.value)}
            className="px-2 py-1.5 text-sm rounded-lg bg-gray-700 text-gray-100 outline-none focus:ring-1 focus:ring-blue-500"
          >
            {mics.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>
            ))}
          </select>
        </label>
      )}
      {cams.length > 0 && (
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          Camera
          <select
            value={selectedCamId}
            onChange={e => onCam(e.target.value)}
            className="px-2 py-1.5 text-sm rounded-lg bg-gray-700 text-gray-100 outline-none focus:ring-1 focus:ring-blue-500"
          >
            {cams.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>
            ))}
          </select>
        </label>
      )}
      {blur?.supported && cams.length > 0 && (
        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={blur.enabled}
            onChange={e => blur.onChange(e.target.checked)}
            className="accent-blue-600"
          />
          Blur my background{blur.note ? ` ${blur.note}` : ''}
        </label>
      )}
    </>
  );
}

function ControlButton({ onClick, active, danger, title, children }: {
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`p-3 rounded-full transition-colors ${
        danger
          ? 'bg-red-600 hover:bg-red-700 text-white'
          : active === false
            ? 'bg-red-500/90 hover:bg-red-600 text-white'
            : 'bg-gray-700 hover:bg-gray-600 text-white'
      }`}
    >
      {children}
    </button>
  );
}

export default function CallPage({ callId }: { callId: string }) {
  const [hostToken] = useState(() => readHostToken(callId));
  const {
    status, error, tiles, participantCount, localPreview,
    micOn, camOn, sharingScreen, hasCamera, hasMic,
    mics, cams, selectedMicId, selectedCamId, selectMic, selectCam,
    micLevel, speakingIds,
    chatMessages, sendChat,
    blurSupported, blurEnabled, setBlur,
    participants, isHost, transferHostTo,
    audioElRef,
    initLocalMedia, join, hangUp,
    toggleMic, toggleCam, startScreenShare, stopScreenShare,
    bindVideoTile,
  } = useChimeCall(callId, hostToken);
  const [linkCopied, setLinkCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Layout: null = auto (screen share, else solo remote, else grid);
  // a tileId = user pinned that tile big; 'grid' = user forced equal grid.
  const [focusedTileId, setFocusedTileId] = useState<number | 'grid' | null>(null);
  const [selfHidden, setSelfHidden] = useState(false);
  const [stripCollapsed, setStripCollapsed] = useState(false);
  // A tile the user expanded to the full-screen zoom viewer.
  const [maximizedTileId, setMaximizedTileId] = useState<number | null>(null);
  // Attendee whose camera holds the big stage in auto mode (the active speaker).
  const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null);
  const activeSpeakerRef = useRef<string | null>(null);
  const pendingSpeakerRef = useRef<string | null>(null);
  const speakerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Drop a pin when its tile leaves the call
  useEffect(() => {
    if (typeof focusedTileId === 'number' && !tiles.some(t => t.tileId === focusedTileId)) {
      setFocusedTileId(null);
    }
  }, [tiles, focusedTileId]);

  // Close the full-screen viewer if its tile leaves the call
  useEffect(() => {
    if (maximizedTileId !== null && !tiles.some(t => t.tileId === maximizedTileId)) {
      setMaximizedTileId(null);
    }
  }, [tiles, maximizedTileId]);

  // Track the active speaker for the auto stage. The person on the big stage is
  // whoever is talking now or spoke last (excluding you). A challenger must talk
  // for ~1s of continuous speech before taking over, so brief crosstalk doesn't
  // strobe the layout; while the current speaker is still talking, they keep the
  // stage even if someone else also speaks.
  useEffect(() => {
    const remoteSpeakers = tiles
      .filter(t => !t.isLocal && !t.isContent && speakingIds.has(t.attendeeId))
      .map(t => t.attendeeId);
    const current = activeSpeakerRef.current;

    const cancelPending = () => {
      if (speakerTimerRef.current) { clearTimeout(speakerTimerRef.current); speakerTimerRef.current = null; }
      pendingSpeakerRef.current = null;
    };

    // Current stage speaker is still talking → keep them (also handles the
    // "two talking at once → stick with whoever was there" rule).
    if (current && remoteSpeakers.includes(current)) { cancelPending(); return; }

    // Nobody else is talking → leave the last speaker on the stage.
    if (remoteSpeakers.length === 0) { cancelPending(); return; }

    // Stage speaker is silent and someone else is talking — promote the
    // challenger, but only after the dwell timer confirms continuous speech.
    const candidate = pendingSpeakerRef.current && remoteSpeakers.includes(pendingSpeakerRef.current)
      ? pendingSpeakerRef.current
      : remoteSpeakers[0];

    if (pendingSpeakerRef.current !== candidate) {
      if (speakerTimerRef.current) clearTimeout(speakerTimerRef.current);
      pendingSpeakerRef.current = candidate;
      speakerTimerRef.current = setTimeout(() => {
        activeSpeakerRef.current = candidate;
        setActiveSpeakerId(candidate);
        pendingSpeakerRef.current = null;
        speakerTimerRef.current = null;
      }, 1000);
    }
  }, [speakingIds, tiles]);

  useEffect(() => () => {
    if (speakerTimerRef.current) clearTimeout(speakerTimerRef.current);
  }, []);

  // ── Display name (asked in the lobby; host prefills from email settings) ──
  const settingsName = useSettingsStore(s => s.settings?.displayName ?? '');
  const userEmail = useAuthStore(s => s.userEmail);
  const [name, setName] = useState(() => sessionStorage.getItem(`call-name-${callId}`) ?? '');
  useEffect(() => {
    // Prefill for the logged-in host once settings load (guests type theirs)
    if (!name && hostToken) {
      const fallback = settingsName || (userEmail ? userEmail.split('@')[0] : '');
      if (fallback) setName(fallback);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsName, userEmail, hostToken]);

  // ── Chat panel ────────────────────────────────────────────────────────────
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [seenChatCount, setSeenChatCount] = useState(0);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (chatOpen) {
      setSeenChatCount(chatMessages.length);
      chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight });
    }
  }, [chatOpen, chatMessages]);
  const unreadChat = chatMessages.length - seenChatCount;

  function handleSendChat() {
    const text = chatInput.trim();
    if (!text) return;
    sendChat(text);
    setChatInput('');
  }

  const canShareScreen = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  const callLink = `${window.location.origin}/call/${callId}`;

  // ── Host leave flow (leave vs end-for-everyone vs hand over) ─────────────
  const [leaveModalOpen, setLeaveModalOpen] = useState(false);
  const [newHostId, setNewHostId] = useState('');
  const otherParticipants = participants.filter(p => !p.isSelf);

  function handleHangUpClick() {
    if (isHost && otherParticipants.length > 0) {
      setNewHostId('');
      setLeaveModalOpen(true);
    } else {
      // Guests just leave; a host alone in the call ends it outright
      void hangUp(isHost);
    }
  }

  async function leaveWithoutEnding() {
    setLeaveModalOpen(false);
    if (newHostId) {
      transferHostTo(newHostId);
      // Give the data message a beat to fan out before tearing down
      await new Promise(r => setTimeout(r, 300));
    }
    void hangUp(false);
  }

  // Warm up the camera for the lobby preview
  useEffect(() => {
    if (status === 'idle') void initLocalMedia();
  }, [status, initLocalMedia]);

  function copyLink() {
    void navigator.clipboard.writeText(callLink).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    });
  }

  // Chime plays all remote audio through this element (kept mounted in every state)
  const audioSink = <audio ref={audioElRef} className="hidden" />;

  // ── Ended / error screens ────────────────────────────────────────────────
  if (status === 'ended' || status === 'error') {
    return (
      <div className="min-h-dvh bg-gray-950 flex flex-col items-center justify-center gap-4 p-6">
        {audioSink}
        <h1 className="text-xl font-medium text-white">
          {status === 'ended' ? 'Call ended' : 'Unable to join call'}
        </h1>
        {error && <p className="text-sm text-gray-400 text-center max-w-sm">{error}</p>}
        {status === 'ended' && (
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Rejoin
          </button>
        )}
      </div>
    );
  }

  // ── Lobby ────────────────────────────────────────────────────────────────
  if (status === 'idle' || status === 'connecting') {
    return (
      <div className="min-h-dvh bg-gray-950 flex items-center justify-center p-4 sm:p-6">
        {audioSink}
        <div className="w-full max-w-md flex flex-col gap-4">
          <h1 className="text-xl font-medium text-white text-center">
            {isHost ? 'Start your call' : 'Join call'}
          </h1>
          <PreviewTile stream={localPreview} />
          {hasMic && <MicLevelBar level={micLevel} muted={!micOn} />}
          {!hasCamera && (
            <p className="text-xs text-gray-400 text-center">
              No camera detected — you can still join with {hasMic ? 'audio only' : 'viewing only'}.
            </p>
          )}
          <div className="flex items-center justify-center gap-3">
            <ControlButton onClick={toggleMic} active={micOn} title={micOn ? 'Mute microphone' : 'Unmute microphone'}>
              <MicIcon on={micOn} />
            </ControlButton>
            <ControlButton onClick={toggleCam} active={camOn} title={camOn ? 'Turn camera off' : 'Turn camera on'}>
              <CamIcon on={camOn} />
            </ControlButton>
          </div>
          <DeviceSelects
            mics={mics} cams={cams}
            selectedMicId={selectedMicId} selectedCamId={selectedCamId}
            onMic={id => void selectMic(id)} onCam={id => void selectCam(id)}
            blur={{ supported: blurSupported, enabled: blurEnabled, onChange: e => void setBlur(e), note: '(applies when you join)' }}
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="call-name" className="text-sm font-medium text-white">
              Enter your name to join
            </label>
            <input
              id="call-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus={!name}
              placeholder="Your name (shown to others)"
              maxLength={40}
              className={`w-full px-3 py-2.5 text-sm rounded-lg border bg-gray-800 text-gray-100
                          placeholder-gray-500 outline-none transition-colors focus:border-blue-500
                          ${name.trim() ? 'border-gray-700' : 'border-blue-500 ring-1 ring-blue-500/40'}`}
            />
          </div>
          <button
            onClick={() => {
              const trimmed = name.trim();
              sessionStorage.setItem(`call-name-${callId}`, trimmed);
              void join(trimmed);
            }}
            disabled={status === 'connecting' || !name.trim()}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed
                       text-white font-medium rounded-lg transition-colors"
          >
            {status === 'connecting'
              ? 'Connecting…'
              : !name.trim()
                ? 'Enter your name to join'
                : isHost ? 'Start call' : 'Join call'}
          </button>
          {isHost && (
            <button
              onClick={copyLink}
              className="w-full py-2 text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              {linkCopied ? 'Link copied!' : 'Copy invite link'}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── In call ──────────────────────────────────────────────────────────────
  // Stage + filmstrip layout. The self view lives in a small corner PiP (or
  // hidden), never in the grid. Auto mode puts a screen share — or the only
  // other participant — on the big stage; clicking a thumbnail pins it big,
  // clicking the stage drops to an equal grid.
  const localCam = tiles.find(t => t.isLocal && !t.isContent) ?? null;
  const others = tiles.filter(t => t !== localCam); // remote cameras + all screen shares
  const remoteContent = others.find(t => t.isContent) ?? null;

  let stageTile: CallTile | null = null;
  if (typeof focusedTileId === 'number') {
    stageTile = tiles.find(t => t.tileId === focusedTileId) ?? null;
  } else if (focusedTileId !== 'grid') {
    // Auto: a screen share always wins the stage. Otherwise the stage shows the
    // active speaker (or the lone remote), with everyone else in the filmstrip.
    // Alone in the call, your own camera takes the stage (no PiP needed then).
    if (remoteContent) {
      stageTile = remoteContent;
    } else {
      const remoteCams = others.filter(t => !t.isContent);
      stageTile =
        remoteCams.length === 0 ? localCam
        : remoteCams.length === 1 ? remoteCams[0]
        : remoteCams.find(t => t.attendeeId === activeSpeakerId) ?? remoteCams[0];
    }
  }
  const stripTiles = others.filter(t => t !== stageTile);
  const gridTiles = others.length > 0 ? others : (localCam ? [localCam] : []);
  const n = gridTiles.filter(t => !t.isContent).length;
  const gridCols =
    n <= 1 ? 'grid-cols-1'
    : n === 2 ? 'grid-cols-1 sm:grid-cols-2'
    : n <= 4 ? 'grid-cols-2'
    : 'grid-cols-2 sm:grid-cols-3';

  const tileFor = (tile: CallTile, opts: { onClick?: () => void; className?: string; clickTitle?: string }) => (
    <ChimeTile
      key={tile.tileId}
      tile={tile}
      label={tileLabel(tile)}
      speaking={!tile.isContent && speakingIds.has(tile.attendeeId)}
      bind={bindVideoTile}
      onExpand={() => setMaximizedTileId(tile.tileId)}
      {...opts}
    />
  );

  const maximizedTile = maximizedTileId !== null ? tiles.find(t => t.tileId === maximizedTileId) ?? null : null;

  return (
    <div className="h-dvh bg-gray-950 flex flex-col relative overflow-hidden">
      {audioSink}
      <div className="flex-1 min-h-0 flex flex-col gap-1.5 p-2 sm:p-4 w-full max-w-7xl mx-auto">
        {/* While a tile is maximized, the full-screen viewer owns its video
            binding — don't also mount it here, or Chime rebinds to one element
            and the other goes blank. */}
        {maximizedTile ? null : tiles.length === 0 ? (
          <div className="flex-1 flex items-center justify-center bg-gray-900 rounded-xl">
            <p className="text-sm text-gray-500">
              {camOn ? 'Starting video…' : 'Camera is off'}
            </p>
          </div>
        ) : stageTile ? (
          <>
            {/* Stage */}
            <div className="flex-1 min-h-0">
              {tileFor(stageTile, {
                className: 'h-full w-full',
                onClick: others.length > 1 ? () => setFocusedTileId('grid') : undefined,
                clickTitle: 'Switch to grid view',
              })}
            </div>
            {/* Filmstrip collapse toggle — collapsing gives the stage everything */}
            {stripTiles.length > 0 && (
              <button
                onClick={() => setStripCollapsed(v => !v)}
                title={stripCollapsed ? 'Show thumbnails' : 'Hide thumbnails'}
                aria-label={stripCollapsed ? 'Show thumbnails' : 'Hide thumbnails'}
                className="shrink-0 self-center p-0.5 text-gray-500 hover:text-gray-300"
              >
                <svg className={`w-5 h-5 transition-transform ${stripCollapsed ? 'rotate-180' : ''}`}
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            )}
            {/* Filmstrip */}
            {stripTiles.length > 0 && !stripCollapsed && (
              <div className="shrink-0 flex gap-2 overflow-x-auto">
                {stripTiles.map(t => tileFor(t, {
                  className: 'h-20 sm:h-28 aspect-video shrink-0',
                  onClick: () => setFocusedTileId(t.tileId),
                  clickTitle: 'Pin this video',
                }))}
              </div>
            )}
          </>
        ) : (
          /* Equal grid (no stage) */
          <div className={`flex-1 min-h-0 grid auto-rows-fr ${gridCols} gap-2 sm:gap-3`}>
            {gridTiles.map(t => tileFor(t, {
              className: `h-full w-full ${t.isContent ? 'col-span-full' : ''}`,
              onClick: () => setFocusedTileId(t.tileId),
              clickTitle: 'Make this video big',
            }))}
          </div>
        )}
      </div>

      {/* Full-screen zoom viewer */}
      {maximizedTile && (
        <MaximizedViewer
          tile={maximizedTile}
          label={tileLabel(maximizedTile)}
          bind={bindVideoTile}
          onClose={() => setMaximizedTileId(null)}
        />
      )}

      {/* Self-view PiP — hidden while your own camera is on the stage or a tile is maximized */}
      {!maximizedTile && localCam && stageTile !== localCam && !selfHidden && (
        <div className="absolute bottom-20 right-2 sm:bottom-24 sm:right-4 z-20 w-28 sm:w-44 aspect-video
                        rounded-lg overflow-hidden shadow-xl ring-1 ring-white/20 group/self">
          {tileFor(localCam, {
            className: 'h-full w-full',
            onClick: () => setFocusedTileId(localCam.tileId),
            clickTitle: 'Make your video big',
          })}
          <button
            onClick={e => { e.stopPropagation(); setSelfHidden(true); }}
            title="Hide self view"
            aria-label="Hide self view"
            className="absolute top-1 left-1 p-1 rounded-full bg-black/60 text-white
                       opacity-0 group-hover/self:opacity-100 max-md:opacity-100 transition-opacity"
          >
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}
      {!maximizedTile && localCam && stageTile !== localCam && selfHidden && (
        <button
          onClick={() => setSelfHidden(false)}
          className="absolute bottom-20 right-2 sm:bottom-24 sm:right-4 z-20 px-2.5 py-1.5 text-xs
                     bg-gray-800/90 hover:bg-gray-700 text-gray-300 rounded-lg shadow-lg"
        >
          Show self view
        </button>
      )}

      {status === 'waiting' && (
        <p className="text-center text-sm text-gray-400 pb-1">
          {isHost ? 'Waiting for others to join — share the invite link.' : 'Waiting for others…'}
        </p>
      )}
      {status === 'connected' && participantCount > 1 && (
        <p className="text-center text-xs text-gray-500 pb-1">
          {participantCount} in call
        </p>
      )}

      {/* Host leave options */}
      {leaveModalOpen && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setLeaveModalOpen(false)}>
          <div className="w-full max-w-sm bg-gray-800 rounded-xl p-5 shadow-2xl flex flex-col gap-4"
            onClick={e => e.stopPropagation()}>
            <h2 className="text-base font-semibold text-white">Leave the call?</h2>
            <p className="text-sm text-gray-400">
              You can end the call for everyone, or leave and let the others keep talking.
            </p>
            <label className="flex flex-col gap-1 text-xs text-gray-400">
              Hand the host role to someone (optional)
              <select
                value={newHostId}
                onChange={e => setNewHostId(e.target.value)}
                className="px-2 py-1.5 text-sm rounded-lg bg-gray-700 text-gray-100 outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">No one — just leave</option>
                {otherParticipants.map(p => (
                  <option key={p.attendeeId} value={p.attendeeId}>{p.name}</option>
                ))}
              </select>
            </label>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => void leaveWithoutEnding()}
                className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {newHostId ? 'Make them host & leave' : 'Leave — others continue'}
              </button>
              <button
                onClick={() => { setLeaveModalOpen(false); void hangUp(true); }}
                className="w-full py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                End call for everyone
              </button>
              <button
                onClick={() => setLeaveModalOpen(false)}
                className="w-full py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* In-call chat — ephemeral, lives only for the duration of the call */}
      {chatOpen && (
        <div className="absolute inset-y-0 right-0 z-30 w-full sm:w-80 flex flex-col
                        bg-gray-900/95 backdrop-blur border-l border-gray-700">
          <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-gray-700">
            <h2 className="text-sm font-semibold text-white">Chat</h2>
            <button
              onClick={() => setChatOpen(false)}
              aria-label="Close chat"
              className="p-1.5 text-gray-400 hover:text-gray-200"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-3 space-y-2">
            {chatMessages.length === 0 && (
              <p className="text-xs text-gray-500 text-center mt-4">
                No messages yet. Chat is only visible during the call and isn't saved.
              </p>
            )}
            {chatMessages.map(m => (
              <div key={m.id} className={`flex flex-col ${m.self ? 'items-end' : 'items-start'}`}>
                <span className="text-[10px] text-gray-500 px-1">
                  {m.self ? 'You' : m.senderName} · {new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </span>
                <div className={`max-w-[85%] px-3 py-1.5 rounded-2xl text-sm whitespace-pre-wrap break-words ${
                  m.self ? 'bg-blue-600 text-white rounded-br-sm' : 'bg-gray-700 text-gray-100 rounded-bl-sm'
                }`}>
                  <ChatText text={m.text} />
                </div>
              </div>
            ))}
          </div>
          <div className="shrink-0 flex items-end gap-2 p-3 border-t border-gray-700">
            <textarea
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendChat(); }
              }}
              placeholder="Message everyone…"
              rows={Math.min(3, Math.max(1, chatInput.split('\n').length))}
              maxLength={1500}
              className="flex-1 resize-none px-3 py-2 text-sm rounded-xl border border-gray-700 bg-gray-800
                         text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500"
            />
            <button
              onClick={handleSendChat}
              disabled={!chatInput.trim()}
              title="Send"
              aria-label="Send message"
              className="shrink-0 p-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Device settings popover */}
      {showSettings && (
        <div className="absolute bottom-20 sm:bottom-24 left-1/2 -translate-x-1/2 z-20 w-[calc(100%-2rem)] max-w-sm
                        bg-gray-800 rounded-xl p-4 shadow-xl flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-white">Devices</span>
            <button
              onClick={() => setShowSettings(false)}
              aria-label="Close device settings"
              className="p-1 text-gray-400 hover:text-gray-200"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <DeviceSelects
            mics={mics} cams={cams}
            selectedMicId={selectedMicId} selectedCamId={selectedCamId}
            onMic={id => void selectMic(id)} onCam={id => void selectCam(id)}
            blur={{ supported: blurSupported, enabled: blurEnabled, onChange: e => void setBlur(e) }}
          />
          {hasMic && <MicLevelBar level={micLevel} muted={!micOn} />}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3 p-3 pb-5 sm:p-4 sm:pb-6">
        <ControlButton onClick={toggleMic} active={micOn} title={micOn ? 'Mute microphone' : 'Unmute microphone'}>
          <MicIcon on={micOn} />
        </ControlButton>
        <ControlButton onClick={toggleCam} active={camOn} title={camOn ? 'Turn camera off' : 'Turn camera on'}>
          <CamIcon on={camOn} />
        </ControlButton>
        {canShareScreen && (
          <ControlButton
            onClick={() => void (sharingScreen ? stopScreenShare() : startScreenShare())}
            active={!sharingScreen ? undefined : true}
            title={sharingScreen ? 'Stop sharing screen' : 'Share screen'}
          >
            <ScreenIcon sharing={sharingScreen} />
          </ControlButton>
        )}
        <div className="relative">
          <ControlButton onClick={() => setChatOpen(o => !o)} active={chatOpen ? true : undefined} title={chatOpen ? 'Close chat' : 'Open chat'}>
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
          </ControlButton>
          {!chatOpen && unreadChat > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 text-[10px] font-bold
                             rounded-full bg-red-500 text-white flex items-center justify-center pointer-events-none">
              {unreadChat > 9 ? '9+' : unreadChat}
            </span>
          )}
        </div>
        <ControlButton onClick={() => setShowSettings(s => !s)} title="Device settings">
          <GearIcon />
        </ControlButton>
        <ControlButton onClick={copyLink} title="Copy invite link">
          {linkCopied ? <CheckIcon /> : <LinkIcon />}
        </ControlButton>
        <ControlButton onClick={handleHangUpClick} danger title={isHost ? 'Leave or end call' : 'Leave call'}>
          <HangUpIcon />
        </ControlButton>
      </div>
    </div>
  );
}

// ── Icons ──────────────────────────────────────────────────────────────────

function MicIcon({ on, className = 'w-5 h-5' }: { on: boolean; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
      <path d="M19 10v2a7 7 0 01-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      {!on && <line x1="2" y1="2" x2="22" y2="22" />}
    </svg>
  );
}

function CamIcon({ on }: { on: boolean }) {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      {!on && <line x1="2" y1="2" x2="22" y2="22" />}
    </svg>
  );
}

function ScreenIcon({ sharing }: { sharing: boolean }) {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
      {sharing
        ? <line x1="7" y1="10" x2="17" y2="10" />
        : <><line x1="12" y1="7" x2="12" y2="13" /><line x1="9" y1="10" x2="15" y2="10" /></>}
    </svg>
  );
}

function GearIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09A1.65 1.65 0 0015 4.6a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9c.23.5.36 1.05.36 1.62s-.13 1.12-.36 1.62z" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function HangUpIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.7l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.1-.7-.28-.79-.73-1.68-1.36-2.66-1.85-.33-.16-.56-.51-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
    </svg>
  );
}
