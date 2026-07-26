/**
 * useChimeCall — multi-party video call via the Amazon Chime SDK.
 *
 * Chime is a managed SFU: every participant sees and hears everyone else, and
 * screen share is a first-class content stream (it appears as an extra video
 * tile). The server creates the meeting/attendee; the attendee JoinToken
 * returned by the join endpoint is the only credential the browser holds.
 *
 * Lobby (pre-join) camera preview uses plain getUserMedia; those tracks are
 * stopped right before the Chime session acquires the devices itself.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackgroundBlurVideoFrameProcessor,
  ConsoleLogger,
  DefaultDeviceController,
  DefaultMeetingSession,
  DefaultVideoTransformDevice,
  LogLevel,
  MeetingSessionConfiguration,
  MeetingSessionStatusCode,
  type AudioVideoFacade,
  type AudioVideoObserver,
  type BackgroundBlurProcessor,
  type ContentShareObserver,
  type DataMessage,
  type MeetingSessionStatus,
  type VideoTileState,
} from 'amazon-chime-sdk-js';
import { joinCall, endCall } from '../api/calls';

export type CallStatus = 'idle' | 'connecting' | 'waiting' | 'connected' | 'ended' | 'error';

export interface CallTile {
  tileId: number;
  attendeeId: string;
  externalUserId?: string;
  isLocal: boolean;
  isContent: boolean;
}

export interface ChatMessage {
  id: string;
  senderName: string;
  text: string;
  ts: number;
  self: boolean;
}

/** Parse the "role|Name|suffix" ExternalUserId minted by the join endpoint. */
export function parseExternalUserId(ext?: string): { role: 'host' | 'guest'; name: string } {
  const cleaned = (ext ?? '').replace(/#content$/, '');
  const [role, name] = cleaned.split('|');
  return {
    role: role === 'host' ? 'host' : 'guest',
    name: name?.trim() || (role === 'host' ? 'Host' : 'Guest'),
  };
}

const CHAT_TOPIC = 'chat';
// Buffered server-side for late joiners (Chime max) — chat lives only as long
// as the meeting; nothing is ever persisted.
const CHAT_LIFETIME_MS = 300_000;

const BLUR_STORAGE_KEY = 'chase-call-blur';

const HOST_TRANSFER_TOPIC = 'host-transfer';

// Call-lifetime watchdogs: no call runs forever. A hard per-client cap, plus
// an auto-disconnect after sitting alone (covers forgotten open tabs — once
// every client leaves, Chime ends the empty meeting within ~5 minutes).
const MAX_CALL_MS = 4 * 60 * 60 * 1000;
const ALONE_TIMEOUT_MS = 15 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 30_000;

export interface Participant {
  attendeeId: string;
  name: string;
  isSelf: boolean;
}

export function useChimeCall(callId: string, hostToken: string | null) {
  const [status, setStatus] = useState<CallStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<'HOST' | 'GUEST' | null>(null);
  const [tiles, setTiles] = useState<CallTile[]>([]);
  const [participantCount, setParticipantCount] = useState(1);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [hasCamera, setHasCamera] = useState(false);
  const [hasMic, setHasMic] = useState(false);
  /** Lobby-only camera preview stream (plain getUserMedia). */
  const [localPreview, setLocalPreview] = useState<MediaStream | null>(null);
  /** In-call chat — ephemeral, lives only for the duration of the meeting. */
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  /** Background blur: device capability + user preference (persisted). */
  const [blurSupported, setBlurSupported] = useState<boolean | null>(null);
  const [blurEnabled, setBlurEnabledState] = useState(() => localStorage.getItem(BLUR_STORAGE_KEY) === 'true');
  /** Everyone currently in the call, with display names (from ExternalUserId). */
  const [participants, setParticipants] = useState<Participant[]>([]);
  /** True while this client holds the host token (initially or via handover). */
  const [isHost, setIsHost] = useState(!!hostToken);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState('');
  const [selectedCamId, setSelectedCamId] = useState('');
  /** Live local mic input level, 0..1 (lobby: WebAudio; in-call: Chime volume indicator). */
  const [micLevel, setMicLevel] = useState(0);
  /** Attendee IDs currently producing audio (drives the speaking highlight on tiles). */
  const [speakingIds, setSpeakingIds] = useState<Set<string>>(new Set());

  const sessionRef = useRef<DefaultMeetingSession | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const rosterRef = useRef<Set<string>>(new Set());
  const endedRef = useRef(false);
  const statusRef = useRef<CallStatus>('idle');
  const camOnRef = useRef(true);
  const selectedMicIdRef = useRef('');
  const selectedCamIdRef = useRef('');
  const localAttendeeIdRef = useRef('');
  const meterCleanupRef = useRef<(() => void) | null>(null);
  const displayNameRef = useRef('');
  const blurEnabledRef = useRef(blurEnabled);
  const blurProcessorRef = useRef<BackgroundBlurProcessor | null>(null);
  const transformDeviceRef = useRef<DefaultVideoTransformDevice | null>(null);
  const blurLoggerRef = useRef<ConsoleLogger | null>(null);
  const hostTokenRef = useRef<string | null>(hostToken);
  const participantsRef = useRef<Map<string, string>>(new Map()); // attendeeId → name
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Per-attendee "stopped speaking" timers — a hangover so brief dips between
  // words don't flip the speaking state off (see the volume indicator handler).
  const speakingHoldRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const callStartedAtRef = useRef(0);
  const lastCompanyAtRef = useRef(0);

  const setStatusTracked = useCallback((s: CallStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const av = (): AudioVideoFacade | null => sessionRef.current?.audioVideo ?? null;

  const stopMeter = useCallback(() => {
    meterCleanupRef.current?.();
    meterCleanupRef.current = null;
    setMicLevel(0);
  }, []);

  /** Lobby mic meter: sample the preview stream with an AnalyserNode. */
  const startLobbyMeter = useCallback((stream: MediaStream) => {
    stopMeter();
    if (stream.getAudioTracks().length === 0) return;
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const timer = setInterval(() => {
        if (ctx.state === 'suspended') void ctx.resume();
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
        setMicLevel(Math.min(1, peak / 50));
      }, 100);
      meterCleanupRef.current = () => { clearInterval(timer); void ctx.close(); };
    } catch { /* WebAudio unavailable — no meter, join still works */ }
  }, [stopMeter]);

  const stopPreview = useCallback(() => {
    stopMeter();
    previewStreamRef.current?.getTracks().forEach(t => t.stop());
    previewStreamRef.current = null;
    setLocalPreview(null);
  }, [stopMeter]);

  /** Refresh the mic/camera device lists (labels appear once permission is granted). */
  const refreshDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMics(devices.filter(d => d.kind === 'audioinput' && d.deviceId));
      setCams(devices.filter(d => d.kind === 'videoinput' && d.deviceId));
    } catch { /* enumeration unavailable */ }
  }, []);

  // Track devices being plugged in / removed
  useEffect(() => {
    const handler = () => { void refreshDevices(); };
    navigator.mediaDevices?.addEventListener?.('devicechange', handler);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', handler);
  }, [refreshDevices]);

  // Background blur capability (WASM/worker/GPU check)
  useEffect(() => {
    let cancelled = false;
    BackgroundBlurVideoFrameProcessor.isSupported()
      .then(ok => { if (!cancelled) setBlurSupported(ok); })
      .catch(() => { if (!cancelled) setBlurSupported(false); });
    return () => { cancelled = true; };
  }, []);

  /**
   * Wrap a camera device in the blur pipeline when blur is on. The ML
   * processor is created once and reused; camera switches swap the inner
   * device without rebuilding the pipeline. Falls back to the raw camera on
   * any failure (e.g. model assets unreachable).
   */
  const resolveVideoDevice = useCallback(async (deviceId: string): Promise<string | DefaultVideoTransformDevice> => {
    if (!blurEnabledRef.current) return deviceId;
    try {
      if (!blurProcessorRef.current) {
        blurProcessorRef.current = (await BackgroundBlurVideoFrameProcessor.create()) ?? null;
      }
      if (!blurProcessorRef.current) return deviceId;
      if (transformDeviceRef.current) {
        transformDeviceRef.current = transformDeviceRef.current.chooseNewInnerDevice(deviceId);
      } else {
        blurLoggerRef.current ??= new ConsoleLogger('chase-call-blur', LogLevel.WARN);
        transformDeviceRef.current = new DefaultVideoTransformDevice(
          blurLoggerRef.current, deviceId, [blurProcessorRef.current],
        );
      }
      return transformDeviceRef.current;
    } catch (err) {
      console.error('[call] Background blur unavailable, using raw camera:', err);
      return deviceId;
    }
  }, []);

  /** Toggle background blur; applies live when the camera is already running. */
  const setBlur = useCallback(async (enabled: boolean) => {
    blurEnabledRef.current = enabled;
    setBlurEnabledState(enabled);
    localStorage.setItem(BLUR_STORAGE_KEY, String(enabled));
    const audioVideo = av();
    if (!audioVideo || !camOnRef.current) return; // takes effect at next camera start
    const camId = selectedCamIdRef.current;
    if (!camId) return;
    try {
      if (enabled) {
        await audioVideo.startVideoInput(await resolveVideoDevice(camId));
      } else {
        const transform = transformDeviceRef.current;
        transformDeviceRef.current = null;
        await audioVideo.startVideoInput(camId);
        await transform?.stop();
      }
    } catch (err) {
      console.error('[call] Toggling blur failed:', err);
    }
  }, [resolveVideoDevice]);

  /** Acquire camera/mic for the lobby preview. Degrades gracefully. */
  const initLocalMedia = useCallback(async (): Promise<void> => {
    if (previewStreamRef.current) return;
    const attempts: MediaStreamConstraints[] = [
      { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true },
      { audio: true },
    ];
    for (const constraints of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        previewStreamRef.current = stream;
        const cam = stream.getVideoTracks().length > 0;
        const mic = stream.getAudioTracks().length > 0;
        setHasCamera(cam);
        setHasMic(mic);
        setCamOn(cam);
        camOnRef.current = cam;
        setMicOn(mic);
        setLocalPreview(stream);
        // Remember which physical devices the preview picked so the join and
        // the settings dropdowns start from the same selection.
        const camId = stream.getVideoTracks()[0]?.getSettings().deviceId ?? '';
        const micId = stream.getAudioTracks()[0]?.getSettings().deviceId ?? '';
        setSelectedCamId(camId);
        selectedCamIdRef.current = camId;
        setSelectedMicId(micId);
        selectedMicIdRef.current = micId;
        startLobbyMeter(stream);
        void refreshDevices();
        return;
      } catch { /* try the next, more permissive constraint set */ }
    }
    setHasCamera(false);
    setHasMic(false);
    setCamOn(false);
    camOnRef.current = false;
    setMicOn(false);
    // Join is still possible — receive-only
  }, []);

  const cleanup = useCallback(() => {
    endedRef.current = true;
    const audioVideo = av();
    try {
      audioVideo?.stopContentShare();
      audioVideo?.stop();
    } catch { /* already stopped */ }
    sessionRef.current?.deviceController.destroy?.();
    sessionRef.current = null;
    stopPreview();
    rosterRef.current.clear();
    setTiles([]);
    for (const t of speakingHoldRef.current.values()) clearTimeout(t);
    speakingHoldRef.current.clear();
    setSpeakingIds(new Set());
    setMicLevel(0);
    setChatMessages([]);
    void transformDeviceRef.current?.stop();
    transformDeviceRef.current = null;
    blurProcessorRef.current?.destroy();
    blurProcessorRef.current = null;
    if (watchdogRef.current) { clearInterval(watchdogRef.current); watchdogRef.current = null; }
  }, [stopPreview]);

  const join = useCallback(async (displayName?: string) => {
    if (statusRef.current !== 'idle') return;
    setStatusTracked('connecting');
    endedRef.current = false;
    displayNameRef.current = displayName?.trim() ?? '';

    let info;
    try {
      info = await joinCall(callId, {
        hostToken: hostToken ?? undefined,
        name: displayNameRef.current || undefined,
      });
    } catch (err) {
      const status404 = (err as { response?: { status?: number } }).response?.status === 404;
      setError(status404 ? 'This call has ended or the link is invalid.' : (err as Error).message);
      setStatusTracked('error');
      return;
    }
    setRole(info.role);

    const logger = new ConsoleLogger('chase-call', LogLevel.WARN);
    const deviceController = new DefaultDeviceController(logger);
    const configuration = new MeetingSessionConfiguration(info.meeting, info.attendee);
    const session = new DefaultMeetingSession(configuration, logger, deviceController);
    sessionRef.current = session;
    const audioVideo = session.audioVideo;

    const updateWaitingState = () => {
      if (endedRef.current) return;
      if (statusRef.current !== 'connected' && statusRef.current !== 'waiting') return;
      setStatusTracked(rosterRef.current.size > 1 ? 'connected' : 'waiting');
    };

    const observer: AudioVideoObserver = {
      audioVideoDidStart: () => {
        if (endedRef.current) return;
        if (camOnRef.current) audioVideo.startLocalVideoTile();
        setStatusTracked(rosterRef.current.size > 1 ? 'connected' : 'waiting');

        // Lifetime watchdog — hard cap + auto-leave when alone. Once every
        // client leaves, Chime terminates the empty meeting itself.
        callStartedAtRef.current = Date.now();
        lastCompanyAtRef.current = Date.now();
        if (watchdogRef.current) clearInterval(watchdogRef.current);
        watchdogRef.current = setInterval(() => {
          if (endedRef.current) return;
          const now = Date.now();
          if (rosterRef.current.size > 1) lastCompanyAtRef.current = now;
          let reason: string | null = null;
          if (now - callStartedAtRef.current > MAX_CALL_MS) {
            reason = 'This call reached the 4-hour limit and was disconnected.';
          } else if (now - lastCompanyAtRef.current > ALONE_TIMEOUT_MS) {
            reason = 'You were alone in the call for 15 minutes, so you were disconnected.';
          }
          if (reason) {
            setError(reason);
            cleanup();
            setStatusTracked('ended');
          }
        }, WATCHDOG_INTERVAL_MS);
      },
      audioVideoDidStop: (sessionStatus: MeetingSessionStatus) => {
        if (endedRef.current) return;
        if (sessionStatus.statusCode() === MeetingSessionStatusCode.MeetingEnded) {
          setError('The host ended the call.');
        } else {
          setError('Connection to the call was lost.');
        }
        cleanup();
        setStatusTracked('ended');
      },
      videoTileDidUpdate: (tileState: VideoTileState) => {
        if (tileState.tileId == null || !tileState.boundAttendeeId) return;
        const tile: CallTile = {
          tileId: tileState.tileId,
          attendeeId: tileState.boundAttendeeId,
          externalUserId: tileState.boundExternalUserId ?? undefined,
          isLocal: tileState.localTile,
          isContent: tileState.isContent,
        };
        setTiles(prev => {
          const rest = prev.filter(t => t.tileId !== tile.tileId);
          return [...rest, tile].sort((a, b) => a.tileId - b.tileId);
        });
      },
      videoTileWasRemoved: (tileId: number) => {
        setTiles(prev => prev.filter(t => t.tileId !== tileId));
      },
    };
    audioVideo.addObserver(observer);

    const contentObserver: ContentShareObserver = {
      contentShareDidStop: () => setSharingScreen(false),
    };
    audioVideo.addContentShareObserver(contentObserver);

    localAttendeeIdRef.current = info.attendee.AttendeeId;
    const syncParticipants = () => {
      setParticipants([...participantsRef.current.entries()].map(([attendeeId, name]) => ({
        attendeeId,
        name,
        isSelf: attendeeId === localAttendeeIdRef.current,
      })));
    };
    audioVideo.realtimeSubscribeToAttendeeIdPresence((attendeeId, present, externalUserId) => {
      if (attendeeId.includes('#content')) return; // screen shares aren't people
      if (present) {
        rosterRef.current.add(attendeeId);
        participantsRef.current.set(attendeeId, parseExternalUserId(externalUserId).name);
        syncParticipants();
        // Volume events drive the local mic meter and the speaking highlights
        audioVideo.realtimeSubscribeToVolumeIndicator(attendeeId, (id, volume, muted) => {
          const level = muted ? 0 : (volume ?? 0);
          if (id === localAttendeeIdRef.current) setMicLevel(level);

          // Speaking detection with a release hangover. Volume dips below the
          // threshold constantly during normal speech (gaps between words and
          // syllables), so we mark "speaking" instantly on a loud sample but
          // only clear it after ~0.6s of continuous quiet. This keeps someone
          // steadily on the active-speaker stage (and steadies the speaking
          // ring) instead of flickering off every fraction of a second.
          const holds = speakingHoldRef.current;
          if (level > 0.08) {
            const pending = holds.get(id);
            if (pending) { clearTimeout(pending); holds.delete(id); }
            setSpeakingIds(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
          } else if (!holds.has(id)) {
            holds.set(id, setTimeout(() => {
              holds.delete(id);
              setSpeakingIds(prev => {
                if (!prev.has(id)) return prev;
                const next = new Set(prev);
                next.delete(id);
                return next;
              });
            }, 600));
          }
        });
      } else {
        rosterRef.current.delete(attendeeId);
        participantsRef.current.delete(attendeeId);
        syncParticipants();
        audioVideo.realtimeUnsubscribeFromVolumeIndicator(attendeeId);
        const pendingHold = speakingHoldRef.current.get(attendeeId);
        if (pendingHold) { clearTimeout(pendingHold); speakingHoldRef.current.delete(attendeeId); }
        setSpeakingIds(prev => {
          if (!prev.has(attendeeId)) return prev;
          const next = new Set(prev);
          next.delete(attendeeId);
          return next;
        });
      }
      setParticipantCount(rosterRef.current.size);
      updateWaitingState();
    });

    // Host handover: the departing host broadcasts the host token addressed to
    // one attendee. (Chime data messages have no unicast — other attendees
    // technically receive it too, but its only power is ending this call.)
    audioVideo.realtimeSubscribeToReceiveDataMessage(HOST_TRANSFER_TOPIC, (msg: DataMessage) => {
      try {
        const { target, token } = msg.json() as { target?: string; token?: string };
        if (!target || !token || target !== localAttendeeIdRef.current) return;
        hostTokenRef.current = token;
        sessionStorage.setItem(`call-host-token-${callId}`, token);
        setIsHost(true);
        const { name } = parseExternalUserId(msg.senderExternalUserId);
        setChatMessages(prev => [...prev, {
          id: `sys-${Date.now()}`,
          senderName: 'Call',
          text: `${name} made you the host. You can now end the call for everyone.`,
          ts: Date.now(),
          self: false,
        }]);
      } catch { /* malformed transfer message — ignore */ }
    });

    // Ephemeral in-call chat over Chime data messages. Not echoed back to the
    // sender (sendChat appends locally); buffered ≤5 min for late joiners;
    // gone when the meeting ends.
    audioVideo.realtimeSubscribeToReceiveDataMessage(CHAT_TOPIC, (msg: DataMessage) => {
      const { name } = parseExternalUserId(msg.senderExternalUserId);
      setChatMessages(prev => [...prev, {
        id: `${msg.timestampMs}-${msg.senderAttendeeId}-${prev.length}`,
        senderName: name,
        text: msg.text(),
        ts: msg.timestampMs,
        self: msg.senderAttendeeId === localAttendeeIdRef.current,
      }]);
    });

    if (audioElRef.current) {
      await audioVideo.bindAudioElement(audioElRef.current)
        .catch(err => console.error('[call] Failed to bind audio element:', err));
    }

    // Release the lobby preview before Chime opens the devices itself
    const wantCam = camOnRef.current;
    const wantMic = micOn;
    stopPreview();

    try {
      const micDevices = await audioVideo.listAudioInputDevices();
      const micId = micDevices.some(d => d.deviceId === selectedMicIdRef.current)
        ? selectedMicIdRef.current
        : micDevices[0]?.deviceId;
      if (micId) {
        await audioVideo.startAudioInput(micId);
        setHasMic(true);
      }
    } catch {
      setHasMic(false);
      setMicOn(false);
    }
    try {
      const camDevices = await audioVideo.listVideoInputDevices();
      const camId = camDevices.some(d => d.deviceId === selectedCamIdRef.current)
        ? selectedCamIdRef.current
        : camDevices[0]?.deviceId;
      if (camId) {
        setHasCamera(true);
        selectedCamIdRef.current = camId;
        setSelectedCamId(camId);
        if (wantCam) await audioVideo.startVideoInput(await resolveVideoDevice(camId));
      } else {
        setHasCamera(false);
        setCamOn(false);
        camOnRef.current = false;
      }
    } catch {
      setHasCamera(false);
      setCamOn(false);
      camOnRef.current = false;
    }
    void refreshDevices();

    audioVideo.start();
    if (!wantMic) audioVideo.realtimeMuteLocalAudio();
  }, [callId, hostToken, micOn, cleanup, stopPreview, refreshDevices, setStatusTracked]);

  /** Switch microphone (live in-call; in the lobby it just records the choice for join). */
  const selectMic = useCallback(async (deviceId: string) => {
    selectedMicIdRef.current = deviceId;
    setSelectedMicId(deviceId);
    const audioVideo = av();
    if (!audioVideo) return; // lobby meter keeps sampling the preview stream's original mic
    try {
      await audioVideo.startAudioInput(deviceId); // mute state is signaling-level, survives the swap
    } catch (err) {
      console.error('[call] Failed to switch microphone:', err);
    }
  }, []);

  /** Switch camera — swaps the lobby preview track, or the live Chime video input. */
  const selectCam = useCallback(async (deviceId: string) => {
    selectedCamIdRef.current = deviceId;
    setSelectedCamId(deviceId);
    const audioVideo = av();
    if (audioVideo) {
      if (!camOnRef.current) return; // applied on next camera-on
      try {
        await audioVideo.startVideoInput(await resolveVideoDevice(deviceId));
      } catch (err) {
        console.error('[call] Failed to switch camera:', err);
      }
      return;
    }
    // Lobby: swap the video track inside the live preview stream
    const preview = previewStreamRef.current;
    if (!preview) return;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      const newTrack = fresh.getVideoTracks()[0];
      const oldTrack = preview.getVideoTracks()[0];
      if (oldTrack) { preview.removeTrack(oldTrack); oldTrack.stop(); }
      if (newTrack) {
        newTrack.enabled = camOnRef.current;
        preview.addTrack(newTrack);
        setHasCamera(true);
      }
      // New stream object so the <video> re-binds (track swaps inside a live
      // stream don't always repaint across browsers)
      const rebuilt = new MediaStream(preview.getTracks());
      previewStreamRef.current = rebuilt;
      setLocalPreview(rebuilt);
    } catch (err) {
      console.error('[call] Failed to switch camera:', err);
    }
  }, []);

  /** Bind/unbind a video element to a Chime tile (used by tile components). */
  const bindVideoTile = useCallback((tileId: number, element: HTMLVideoElement | null) => {
    const audioVideo = av();
    if (!audioVideo) return;
    if (element) audioVideo.bindVideoElement(tileId, element);
    else audioVideo.unbindVideoElement(tileId);
  }, []);

  /** Send a chat message to everyone in the call. */
  const sendChat = useCallback((text: string) => {
    const audioVideo = av();
    const trimmed = text.trim();
    if (!audioVideo || !trimmed) return;
    audioVideo.realtimeSendDataMessage(CHAT_TOPIC, trimmed, CHAT_LIFETIME_MS);
    // Data messages aren't echoed to the sender — append locally
    setChatMessages(prev => [...prev, {
      id: `self-${Date.now()}-${prev.length}`,
      senderName: displayNameRef.current || 'You',
      text: trimmed,
      ts: Date.now(),
      self: true,
    }]);
  }, []);

  const toggleMic = useCallback(() => {
    const audioVideo = av();
    if (!audioVideo) {
      // Lobby: toggle the preview track and remember the choice for join
      const track = previewStreamRef.current?.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      setMicOn(track.enabled);
      return;
    }
    if (audioVideo.realtimeIsLocalAudioMuted()) {
      audioVideo.realtimeUnmuteLocalAudio();
      setMicOn(true);
    } else {
      audioVideo.realtimeMuteLocalAudio();
      setMicOn(false);
    }
  }, []);

  const toggleCam = useCallback(() => {
    const audioVideo = av();
    if (!audioVideo) {
      const track = previewStreamRef.current?.getVideoTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      setCamOn(track.enabled);
      camOnRef.current = track.enabled;
      return;
    }
    void (async () => {
      if (camOnRef.current) {
        audioVideo.stopLocalVideoTile();
        await audioVideo.stopVideoInput();
        setCamOn(false);
        camOnRef.current = false;
      } else {
        try {
          const camDevices = await audioVideo.listVideoInputDevices();
          const camId = camDevices.some(d => d.deviceId === selectedCamIdRef.current)
            ? selectedCamIdRef.current
            : camDevices[0]?.deviceId;
          if (!camId) return;
          await audioVideo.startVideoInput(await resolveVideoDevice(camId));
          audioVideo.startLocalVideoTile();
          setCamOn(true);
          camOnRef.current = true;
        } catch (err) {
          console.error('[call] Failed to restart camera:', err);
        }
      }
    })();
  }, []);

  const startScreenShare = useCallback(async () => {
    const audioVideo = av();
    if (!audioVideo || sharingScreen) return;
    try {
      await audioVideo.startContentShareFromScreenCapture();
      setSharingScreen(true);
    } catch { /* user cancelled the picker */ }
  }, [sharingScreen]);

  const stopScreenShare = useCallback(async () => {
    av()?.stopContentShare(); // contentShareDidStop resets the flag
  }, []);

  /**
   * Hand the host token to another participant (broadcast addressed to them),
   * so the current host can leave while the call continues.
   */
  const transferHostTo = useCallback((attendeeId: string) => {
    const audioVideo = av();
    const token = hostTokenRef.current;
    if (!audioVideo || !token) return;
    audioVideo.realtimeSendDataMessage(
      HOST_TRANSFER_TOPIC,
      JSON.stringify({ target: attendeeId, token }),
      CHAT_LIFETIME_MS,
    );
  }, []);

  /**
   * Hang up. `endForEveryone` (host only) tears the meeting down server-side;
   * otherwise this client just leaves and the call continues without it.
   */
  const hangUp = useCallback(async (endForEveryone = false) => {
    const token = hostTokenRef.current;
    cleanup();
    setStatusTracked('ended');
    if (endForEveryone && token) {
      await endCall(callId, token).catch(() => { /* TTL cleans up eventually */ });
    }
  }, [callId, cleanup, setStatusTracked]);

  // Tear everything down if the component unmounts mid-call
  useEffect(() => () => cleanup(), [cleanup]);

  return {
    status, error, role, tiles, participantCount, localPreview,
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
  };
}
