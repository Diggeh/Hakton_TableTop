import { EVENTS, MAX_VOICE_PEERS } from '../../shared/events.js';
import { VOICE_STATUS, voiceStore } from '../store/voiceStore.js';
import {
  defaultEnumerateDevices,
  normalizeDeviceId,
  partitionMediaDevices,
  saveMediaDevicePrefs,
} from './mediaDevices.js';
import { SpeakingDetector } from './speakingDetector.js';

/** Id of the hidden container that owns every remote `<audio>` element. */
export const VOICE_SINK_ID = 'hakton-voice-audio-sink';

const DEFAULT_AUDIO_CONSTRAINTS = Object.freeze({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
});

export const DEFAULT_VIDEO_CONSTRAINTS = Object.freeze({
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 20 },
});

export function defaultCreateSilentStream() {
  try {
    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      const dest = ctx.createMediaStreamDestination();
      const stream = dest.stream;
      stream._haktonAudioContext = ctx;
      return stream;
    }
  } catch {
    // Fall through to empty MediaStream
  }
  if (typeof MediaStream === 'function') {
    return new MediaStream();
  }
  return {
    id: 'silent-listen-only',
    getTracks: () => [],
    getAudioTracks: () => [],
    getVideoTracks: () => [],
  };
}

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function micErrorCode(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return 'E_MIC_DENIED';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'E_MIC_NOT_FOUND';
    default:
      return err?.code ?? 'E_MIC_FAILED';
  }
}

/**
 * Legacy-aware microphone capture. Prefers `navigator.mediaDevices.getUserMedia` and falls back to
 * the callback style `navigator.getUserMedia` family.
 */
export function defaultGetUserMedia(constraints) {
  const nav = globalThis.navigator;
  if (nav?.mediaDevices?.getUserMedia) return nav.mediaDevices.getUserMedia(constraints);
  const legacy = nav?.getUserMedia || nav?.webkitGetUserMedia || nav?.mozGetUserMedia;
  if (legacy) {
    return new Promise((resolve, reject) => legacy.call(nav, constraints, resolve, reject));
  }
  return Promise.reject(coded('Microphone capture is unavailable here.', 'E_MIC_UNAVAILABLE'));
}

/**
 * P2P voice mesh endpoint for ONE local participant.
 *
 *  - Signaling (peer ids) travels over the existing Socket.io connection.
 *  - SDP/ICE handshakes go through the host's embedded PeerServer (`/peerjs`).
 *  - Audio is carried by direct WebRTC `MediaConnection`s between clients; it never reaches the host.
 *
 * Roles are asymmetric by design to avoid WebRTC "glare": a client only DIALS peers announced via
 * `player_joined` after it registered, and only ANSWERS everyone who registered after it joined.
 *
 * All environment access is injected, so the same class runs in the renderer, in a headless
 * harness, and in node:test with fakes.
 */
export class VoiceMeshManager {
  /**
   * @param {{
   *   socket: { on: Function, off: Function, emit: Function, connected?: boolean },
   *   createPeer: (options: object, requestedId?: string) => Promise<object> | object,
   *   peerOptions?: object,
   *   getUserMedia?: (constraints: object) => Promise<MediaStream>,
   *   documentRef?: Document | null,
   *   store?: typeof voiceStore,
   *   logger?: ((line: string, entry: object) => void) | null,
   *   label?: string,
   *   ackTimeoutMs?: number,
   *   openTimeoutMs?: number,
   * }} deps
   */
  constructor({
    socket,
    createPeer,
    peerOptions = {},
    getUserMedia = defaultGetUserMedia,
    enumerateDevices = defaultEnumerateDevices,
    mediaDevicesRef = globalThis.navigator?.mediaDevices ?? null,
    createSilentStream = defaultCreateSilentStream,
    speakingDetector = null,
    audioContextFactory = undefined,
    documentRef = globalThis.document ?? null,
    store = voiceStore,
    logger = (line) => console.log(line),
    label = 'voice',
    ackTimeoutMs = 8000,
    openTimeoutMs = 10000,
  }) {
    if (!socket) throw new Error('VoiceMeshManager requires a Socket.io client.');
    if (typeof createPeer !== 'function') {
      throw new Error('VoiceMeshManager requires a createPeer factory.');
    }
    this.socket = socket;
    this.createPeer = createPeer;
    this.peerOptions = peerOptions;
    this.getUserMedia = getUserMedia;
    this.enumerateDevices = enumerateDevices;
    this.mediaDevicesRef = mediaDevicesRef;
    this.createSilentStream = createSilentStream;
    this.documentRef = documentRef;
    this.store = store;
    this.logger = logger;
    this.label = label;
    this.ackTimeoutMs = ackTimeoutMs;
    this.openTimeoutMs = openTimeoutMs;

    /** @type {any} */
    this.peer = null;
    /** @type {MediaStream | null} */
    this.localStream = null;
    /** @type {Map<string, { call: any, direction: 'incoming'|'outgoing', stream: MediaStream|null, pc: any }>} */
    this.connections = new Map();
    /** @type {Map<string, HTMLAudioElement>} */
    this.audioEls = new Map();
    this.joinPromise = null;
    this.registered = false;
    this.needsReregister = false;
    this.socketBindings = null;
    this.deviceChangeHandler = null;
    this.trackEndedCleanups = { audio: null, video: null };
    this.recoveringAudio = false;
    this.recoveringVideo = false;
    this.listenOnly = false;
    this.audioMuted = false;
    this.deafened = false;
    this.videoEnabled = false;
    this.preDeafenMuted = false;
    this.teardownGeneration = 0;
    this.speakingDetector =
      speakingDetector ??
      new SpeakingDetector({
        audioContextFactory,
        onSpeakingChange: (key, speaking) => {
          const storeApi = this.store.getState();
          if (key === 'local') {
            storeApi.setLocalSpeaking(speaking);
          } else if (this.connections.has(key) || storeApi.peers[key]) {
            storeApi.upsertPeer(key, { speaking });
          }
        },
      });
  }

  // ---------------------------------------------------------------- public API

  get peerId() {
    return this.peer?.id ?? null;
  }

  /** @returns {'disconnected'|'acquiring_media'|'signaling'|'connected'|'reconnecting'|'error'} */
  get status() {
    return this.store.getState().status;
  }

  /**
   * Acquire the mic, open a PeerJS peer on the host, register its id over Socket.io, and start
   * answering/dialing. Idempotent while joining or joined.
   *
   * @param {{ peerId?: string, audio?: object }} [options]
   * @returns {Promise<{ success: true, peerId: string, peers: object[] } | { success: false, code: string, error: string }>}
   */
  join(options = {}) {
    if (this.joinPromise) return this.joinPromise;
    if (this.status === VOICE_STATUS.CONNECTED && this.peer) {
      return Promise.resolve({ success: true, peerId: this.peerId, peers: this.roster() });
    }
    this.joinPromise = this.#join(options).finally(() => {
      this.joinPromise = null;
    });
    return this.joinPromise;
  }

  /** Leaves the mesh, closes every call, stops the mic, destroys the peer. Safe to call twice. */
  leave({ notifyHost = true } = {}) {
    if (notifyHost && this.registered && this.socket.connected !== false) {
      try {
        this.socket.emit(EVENTS.VOICE_LEAVE, {}, () => {});
      } catch {
        // Host unreachable: it clears the slot on socket disconnect anyway.
      }
    }
    this.#teardown();
    this.store.getState().resetMesh();
    this.#log('signal', 'left the voice mesh');
  }

  /** Mutes or unmutes the local microphone track (no-op on unmute in listen-only mode). */
  setAudioMuted(muted) {
    if (!this.localStream) return this.audioMuted;
    if (this.listenOnly) {
      this.audioMuted = true;
      this.store.getState().setLocalAudioMuted(true);
      return true;
    }

    const next = Boolean(muted);
    if (!next && this.deafened) {
      this.deafened = false;
      for (const audio of this.audioEls.values()) {
        audio.muted = false;
      }
      this.store.getState().setLocalDeafened(false);
    }

    this.audioMuted = next;
    for (const track of this.localStream.getAudioTracks?.() ?? []) {
      track.enabled = !next;
    }
    this.speakingDetector.setSuppressed('local', this.audioMuted || this.listenOnly);
    this.store.getState().setLocalAudioMuted(next);
    this.#broadcastMediaState();
    this.#log('media', next ? 'microphone muted' : 'microphone unmuted');
    return next;
  }

  /**
   * Discord-style deafen: silences incoming voice peers (never the tabletop Soundboard)
   * and auto-mutes the local mic, restoring prior mute state on undeafen.
   */
  setDeafened(deafened) {
    const next = Boolean(deafened);
    if (next === this.deafened) return this.deafened;

    const store = this.store.getState();
    if (next) {
      this.preDeafenMuted = this.audioMuted;
      this.deafened = true;
      for (const audio of this.audioEls.values()) {
        audio.muted = true;
      }
      this.audioMuted = true;
      for (const track of this.localStream?.getAudioTracks?.() ?? []) {
        track.enabled = false;
      }
      store.setLocalDeafened(true);
      store.setLocalAudioMuted(true);
      this.#log('media', 'deafened voice audio');
    } else {
      this.deafened = false;
      for (const audio of this.audioEls.values()) {
        audio.muted = false;
      }
      store.setLocalDeafened(false);

      const restoredMuted = this.listenOnly ? true : this.preDeafenMuted;
      this.audioMuted = restoredMuted;
      for (const track of this.localStream?.getAudioTracks?.() ?? []) {
        track.enabled = !restoredMuted;
      }
      store.setLocalAudioMuted(restoredMuted);
      this.#log('media', 'undeafened voice audio');
    }
    this.speakingDetector.setSuppressed('local', this.audioMuted || this.listenOnly);
    for (const peerId of this.connections.keys()) {
      this.speakingDetector.setSuppressed(peerId, this.deafened);
    }
    this.#broadcastMediaState();
    return this.deafened;
  }

  #findSenderByKind(pc, kind) {
    if (!pc) return null;
    const senders = pc.getSenders?.() ?? [];
    const direct = senders.find((s) => s?.track?.kind === kind);
    if (direct) return direct;
    const transceivers = pc.getTransceivers?.() ?? [];
    const transceiver = transceivers.find(
      (t) => t?.receiver?.track?.kind === kind || t?.sender?.track?.kind === kind,
    );
    return transceiver?.sender ?? null;
  }

  #findAudioSender(pc) {
    return this.#findSenderByKind(pc, 'audio');
  }

  #findVideoSender(pc) {
    return this.#findSenderByKind(pc, 'video');
  }

  #isDeviceUnavailableError(err) {
    return (
      err?.name === 'OverconstrainedError' ||
      err?.name === 'NotFoundError' ||
      err?.name === 'DevicesNotFoundError'
    );
  }

  #unwatchLocalTrackEnded(kind) {
    const cleanup = this.trackEndedCleanups?.[kind];
    if (cleanup) {
      this.trackEndedCleanups[kind] = null;
      cleanup();
    }
  }

  #watchLocalTrackEnded(kind, track) {
    this.#unwatchLocalTrackEnded(kind);
    if (!track || typeof track.addEventListener !== 'function') return;
    const gen = this.teardownGeneration;
    const onEnded = () => {
      if (gen !== this.teardownGeneration || !this.localStream) return;
      if (kind === 'audio') {
        void this.#handleAudioDeviceLost();
      } else {
        void this.#handleVideoDeviceLost();
      }
    };
    track.addEventListener('ended', onEnded);
    this.trackEndedCleanups[kind] = () => track.removeEventListener?.('ended', onEnded);
  }

  #bindDeviceChange() {
    if (this.deviceChangeHandler || !this.mediaDevicesRef?.addEventListener) return;
    const gen = this.teardownGeneration;
    this.deviceChangeHandler = () => {
      if (gen !== this.teardownGeneration) return;
      void this.refreshDevices({ handleRemovedActive: true });
    };
    this.mediaDevicesRef.addEventListener('devicechange', this.deviceChangeHandler);
  }

  #unbindDeviceChange() {
    if (!this.deviceChangeHandler) return;
    const handler = this.deviceChangeHandler;
    this.deviceChangeHandler = null;
    try {
      this.mediaDevicesRef?.removeEventListener?.('devicechange', handler);
    } catch {
      // Ignore cleanup errors
    }
  }

  /** Refreshes available audio/video input devices and falls back if a selected device disappeared. */
  async refreshDevices({ handleRemovedActive = false } = {}) {
    const raw = await this.enumerateDevices();
    const { audioInputs, videoInputs } = partitionMediaDevices(raw);
    const store = this.store.getState();
    store.setMediaDevices({ audioInputs, videoInputs });

    const hasRealAudioIds = audioInputs.some((d) => Boolean(d.deviceId));
    if (
      hasRealAudioIds &&
      store.selectedAudioInputId &&
      !audioInputs.some((d) => d.deviceId === store.selectedAudioInputId)
    ) {
      store.setSelectedAudioInputId('');
      saveMediaDevicePrefs({ audioInputId: '' });
      if (handleRemovedActive && this.localStream && !this.listenOnly) {
        void this.#handleAudioDeviceLost();
      }
    }

    const hasRealVideoIds = videoInputs.some((d) => Boolean(d.deviceId));
    if (
      hasRealVideoIds &&
      store.selectedVideoInputId &&
      !videoInputs.some((d) => d.deviceId === store.selectedVideoInputId)
    ) {
      store.setSelectedVideoInputId('');
      saveMediaDevicePrefs({ videoInputId: '' });
      if (handleRemovedActive && this.videoEnabled) {
        void this.#handleVideoDeviceLost();
      }
    }

    return { audioInputs, videoInputs };
  }

  #redialPeer(peerId) {
    if (typeof this.peer?.call !== 'function' || this.peer.open === false || !this.localStream) {
      return;
    }
    const store = this.store.getState();
    try {
      const peerMeta = store.peers[peerId];
      const call = this.peer.call(peerId, this.localStream, {
        metadata: {
          playerId: peerMeta?.playerId ?? null,
          from: this.peerId,
          renegotiate: true,
        },
      });
      if (call) {
        this.#register(call, 'outgoing', {
          playerId: peerMeta?.playerId ?? null,
          displayName: peerMeta?.displayName ?? null,
        });
      }
    } catch (err) {
      this.#log('webrtc', `renegotiate failed for ${peerId}: ${err?.message}`, null, 'warn');
    }
  }

  async #replaceOrRedialTrack(kind, track) {
    for (const [peerId, rec] of [...this.connections.entries()]) {
      const sender = this.#findSenderByKind(rec.call?.peerConnection, kind);
      if (sender?.replaceTrack) {
        try {
          await sender.replaceTrack(track);
          continue;
        } catch {
          // Fall through to redial
        }
      }
      if (track) {
        this.#redialPeer(peerId);
      }
    }
  }

  #stopTracksOfKind(kind) {
    if (!this.localStream) return;
    const tracks =
      kind === 'audio'
        ? [...(this.localStream.getAudioTracks?.() ?? [])]
        : [...(this.localStream.getVideoTracks?.() ?? [])];
    for (const track of tracks) {
      try {
        this.localStream.removeTrack?.(track);
        track.stop?.();
      } catch {
        // Ignore stopped tracks
      }
    }
    if (kind === 'audio' && this.localStream._haktonAudioContext) {
      try {
        this.localStream._haktonAudioContext.close?.();
      } catch {
        // Ignore AudioContext close errors
      }
      this.localStream._haktonAudioContext = null;
    }
  }

  async #swapAudioTrackInCall(newTrack, newStream) {
    const store = this.store.getState();
    this.#unwatchLocalTrackEnded('audio');
    if (typeof this.localStream.addTrack === 'function') {
      this.#stopTracksOfKind('audio');
      this.localStream.addTrack(newTrack);
    } else {
      this.#stopTracksOfKind('audio');
      for (const vidTrack of this.localStream.getVideoTracks?.() ?? []) {
        newStream.addTrack?.(vidTrack);
      }
      this.localStream = newStream;
    }
    this.#watchLocalTrackEnded('audio', newTrack);

    store.setLocalStream(this.localStream);
    store.bumpLocalStreamRevision();

    await this.#replaceOrRedialTrack('audio', newTrack);

    this.speakingDetector.untrack('local');
    this.speakingDetector.track('local', this.localStream);
    this.speakingDetector.setSuppressed('local', this.audioMuted || this.listenOnly);
  }

  async #swapVideoTrackInCall(videoTrack) {
    const store = this.store.getState();
    this.#unwatchLocalTrackEnded('video');
    this.#stopTracksOfKind('video');
    this.localStream.addTrack?.(videoTrack);
    this.#watchLocalTrackEnded('video', videoTrack);

    this.videoEnabled = true;
    store.setLocalVideoEnabled(true);
    store.setLocalStream(this.localStream);
    store.bumpLocalStreamRevision();
    this.#broadcastMediaState();

    await this.#replaceOrRedialTrack('video', videoTrack);
  }

  #cameraErrorMessage(err) {
    switch (err?.name) {
      case 'NotAllowedError':
      case 'SecurityError':
      case 'PermissionDeniedError':
        return 'Camera permission was denied.';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'Camera is busy in another app or could not be started.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'No camera detected.';
      case 'OverconstrainedError':
      case 'ConstraintNotSatisfiedError':
        return 'Selected camera could not satisfy video settings.';
      default:
        return err?.message || 'Camera access failed.';
    }
  }

  async #acquireCameraTrack(deviceId, videoConstraints, { allowDefaultFallback = false } = {}) {
    const normalizedId = normalizeDeviceId(deviceId);
    const tryAcquire = async (video) => {
      const camStream = await this.getUserMedia({ audio: false, video });
      const videoTrack = camStream?.getVideoTracks?.()?.[0];
      if (!videoTrack) {
        throw coded('No camera video track available.', 'E_CAMERA_NO_TRACK');
      }
      return videoTrack;
    };

    const buildConstraints = (id) => {
      const cfg = { ...DEFAULT_VIDEO_CONSTRAINTS, ...(videoConstraints ?? {}) };
      if (id) cfg.deviceId = { exact: id };
      else delete cfg.deviceId;
      return cfg;
    };

    const isConstraintErr = (err) =>
      err?.name === 'OverconstrainedError' || err?.name === 'ConstraintNotSatisfiedError';

    try {
      return await tryAcquire(buildConstraints(normalizedId));
    } catch (err) {
      if (isConstraintErr(err)) {
        try {
          return await tryAcquire(normalizedId ? { deviceId: { exact: normalizedId } } : true);
        } catch (relaxedErr) {
          err = relaxedErr;
        }
      }

      if (allowDefaultFallback && normalizedId && this.#isDeviceUnavailableError(err)) {
        this.store.getState().setSelectedVideoInputId('');
        saveMediaDevicePrefs({ videoInputId: '' });
        this.#log('media', `preferred camera unavailable (${normalizedId}); falling back to default`, null, 'warn');
        try {
          return await tryAcquire(buildConstraints(''));
        } catch (fallbackErr) {
          if (isConstraintErr(fallbackErr)) {
            return tryAcquire(true);
          }
          throw fallbackErr;
        }
      }

      throw err;
    }
  }

  /**
   * Switches the active microphone mid-call (or saves preference when not in a call).
   * Seamlessly replaces the PeerJS/WebRTC audio sender track and rebinds SpeakingDetector.
   */
  async setAudioInputDevice(deviceId = '') {
    const nextId = normalizeDeviceId(deviceId);
    const store = this.store.getState();

    if (!this.localStream || !this.peer) {
      store.setSelectedAudioInputId(nextId);
      saveMediaDevicePrefs({ audioInputId: nextId });
      return { ok: true, deviceId: nextId };
    }

    const swapGen = this.teardownGeneration;
    const constraints = {
      audio: {
        ...DEFAULT_AUDIO_CONSTRAINTS,
        ...(nextId ? { deviceId: { exact: nextId } } : {}),
      },
      video: false,
    };

    let nextStream;
    try {
      nextStream = await this.getUserMedia(constraints);
    } catch (err) {
      if (nextId && this.#isDeviceUnavailableError(err)) {
        void this.refreshDevices();
      }
      const message = err?.message || 'Could not switch microphone.';
      this.#log('media', `mic switch failed: ${message}`, null, 'warn');
      return { ok: false, error: message };
    }

    if (swapGen !== this.teardownGeneration || !this.localStream) {
      for (const t of nextStream?.getTracks?.() ?? []) t.stop?.();
      return { ok: false, error: 'Call ended while switching microphone.' };
    }

    const newTrack = nextStream?.getAudioTracks?.()?.[0];
    if (!newTrack) {
      for (const t of nextStream?.getTracks?.() ?? []) t.stop?.();
      return { ok: false, error: 'Selected microphone returned no audio track.' };
    }

    const wasListenOnly = this.listenOnly;
    const nextMuted = wasListenOnly ? Boolean(this.deafened) : Boolean(this.audioMuted);
    newTrack.enabled = !nextMuted;

    if (wasListenOnly) {
      this.listenOnly = false;
      this.audioMuted = nextMuted;
      store.setListenOnly(false);
      store.setLocalAudioMuted(nextMuted);
      store.setNotice(null);
    }

    store.setSelectedAudioInputId(nextId);
    saveMediaDevicePrefs({ audioInputId: nextId });

    await this.#swapAudioTrackInCall(newTrack, nextStream);
    this.#broadcastMediaState();
    void this.refreshDevices();
    this.#log('media', `microphone set to ${newTrack.label || nextId || 'system default'}`);
    return { ok: true, deviceId: nextId };
  }

  /**
   * Selects the active camera device. When camera is OFF, persists the choice without turning
   * the camera on; when camera is ON, hot-swaps the active WebRTC video track immediately.
   */
  async setVideoInputDevice(deviceId = '', videoConstraints) {
    const nextId = normalizeDeviceId(deviceId);
    const store = this.store.getState();

    if (!this.videoEnabled || !this.localStream || !this.peer) {
      store.setSelectedVideoInputId(nextId);
      saveMediaDevicePrefs({ videoInputId: nextId });
      return { ok: true, deviceId: nextId, active: false };
    }

    const swapGen = this.teardownGeneration;
    let videoTrack;
    try {
      videoTrack = await this.#acquireCameraTrack(nextId, videoConstraints, {
        allowDefaultFallback: false,
      });
    } catch (err) {
      if (nextId && this.#isDeviceUnavailableError(err)) {
        void this.refreshDevices();
      }
      const message = this.#cameraErrorMessage(err);
      this.#log('media', `camera switch failed: ${message}`, null, 'warn');
      return { ok: false, error: message, active: true };
    }

    if (swapGen !== this.teardownGeneration || !this.localStream || !this.videoEnabled) {
      videoTrack.stop?.();
      return { ok: false, error: 'Camera state changed while switching device.', active: false };
    }

    store.setSelectedVideoInputId(nextId);
    saveMediaDevicePrefs({ videoInputId: nextId });
    await this.#swapVideoTrackInCall(videoTrack);
    void this.refreshDevices();
    this.#log('media', `camera set to ${videoTrack.label || nextId || 'system default'}`);
    return { ok: true, deviceId: nextId, active: true };
  }

  async #handleAudioDeviceLost() {
    if (!this.localStream || !this.peer || this.listenOnly || this.recoveringAudio) return;
    this.recoveringAudio = true;
    const gen = this.teardownGeneration;
    try {
      this.#log('media', 'active microphone disconnected; falling back to default', null, 'warn');
      const store = this.store.getState();
      store.setSelectedAudioInputId('');
      saveMediaDevicePrefs({ audioInputId: '' });

      const switched = await this.setAudioInputDevice('');
      if (switched.ok || gen !== this.teardownGeneration || !this.localStream) {
        return;
      }

      // No working microphone remains: drop cleanly to listen-only so the call stays alive.
      this.#unwatchLocalTrackEnded('audio');
      this.#stopTracksOfKind('audio');
      const silentStream = this.createSilentStream();
      const silentTrack = silentStream?.getAudioTracks?.()?.[0] ?? null;
      if (silentTrack && typeof this.localStream.addTrack === 'function') {
        this.localStream.addTrack(silentTrack);
        if (silentStream._haktonAudioContext) {
          this.localStream._haktonAudioContext = silentStream._haktonAudioContext;
        }
      } else if (!this.videoEnabled) {
        this.localStream = silentStream;
      }

      this.listenOnly = true;
      this.audioMuted = true;
      store.setListenOnly(true);
      store.setLocalAudioMuted(true);
      store.setLocalStream(this.localStream);
      store.bumpLocalStreamRevision();
      store.setNotice('Microphone disconnected — listen-only');
      await this.#replaceOrRedialTrack('audio', silentTrack);
      this.speakingDetector.untrack('local');
      this.speakingDetector.track('local', this.localStream);
      this.speakingDetector.setSuppressed('local', true);
      this.#broadcastMediaState();
      void this.refreshDevices();
    } finally {
      this.recoveringAudio = false;
    }
  }

  async #handleVideoDeviceLost() {
    if (!this.videoEnabled || !this.localStream || !this.peer || this.recoveringVideo) return;
    this.recoveringVideo = true;
    const gen = this.teardownGeneration;
    try {
      this.#log('media', 'active camera disconnected; falling back to default', null, 'warn');
      const store = this.store.getState();
      store.setSelectedVideoInputId('');
      saveMediaDevicePrefs({ videoInputId: '' });

      const switched = await this.setVideoInputDevice('');
      if (!switched.ok && gen === this.teardownGeneration && this.videoEnabled) {
        await this.setCameraEnabled(false);
        this.store.getState().setNotice('Camera disconnected');
      }
    } finally {
      this.recoveringVideo = false;
    }
  }

  #broadcastMediaState() {
    if (!this.registered || this.socket.connected === false) return;
    try {
      this.socket.emit(EVENTS.VOICE_MEDIA_STATE, {
        muted: Boolean(this.audioMuted),
        deafened: Boolean(this.deafened),
        videoEnabled: Boolean(this.videoEnabled),
      });
    } catch {
      // Best-effort sync; transport drops will re-sync on welcome.
    }
  }

  /**
   * Toggles the 480p @ 20fps camera track mid-call without dropping active audio.
   * @param {boolean} enabled
   * @param {object} [videoConstraints]
   */
  async setCameraEnabled(enabled, videoConstraints) {
    const next = Boolean(enabled);
    if (!this.peer || !this.localStream) {
      return { ok: false, enabled: false, error: 'Join the call before enabling camera.' };
    }
    if (next === this.videoEnabled) {
      return { ok: true, enabled: this.videoEnabled };
    }

    if (next) {
      const camGen = this.teardownGeneration;
      const preferredId = this.store.getState().selectedVideoInputId;
      let videoTrack;
      try {
        videoTrack = await this.#acquireCameraTrack(preferredId, videoConstraints, {
          allowDefaultFallback: true,
        });
      } catch (err) {
        const message = this.#cameraErrorMessage(err);
        this.#log('media', `camera failed: ${message}`, null, 'warn');
        return { ok: false, enabled: false, error: message };
      }

      if (camGen !== this.teardownGeneration || !this.localStream) {
        videoTrack.stop?.();
        return { ok: false, enabled: false, error: 'Call ended while opening camera.' };
      }

      await this.#swapVideoTrackInCall(videoTrack);
      void this.refreshDevices();
      this.#log('media', 'camera enabled (480p @ 20fps)');
      return { ok: true, enabled: true };
    }

    this.#unwatchLocalTrackEnded('video');
    this.#stopTracksOfKind('video');
    for (const rec of this.connections.values()) {
      const videoSender = this.#findVideoSender(rec.call?.peerConnection);
      if (videoSender?.replaceTrack) {
        try {
          await videoSender.replaceTrack(null);
        } catch {
          // Ignore
        }
      }
    }
    const store = this.store.getState();
    this.videoEnabled = false;
    store.setLocalVideoEnabled(false);
    store.setLocalStream(this.localStream);
    store.bumpLocalStreamRevision();
    this.#broadcastMediaState();
    this.#log('media', 'camera disabled');
    return { ok: true, enabled: false };
  }

  /** Remote peers with an active MediaStream (what a future UI would list). */
  roster() {
    return Object.values(this.store.getState().peers);
  }

  /** Resolve once `count` remote streams are flowing, or reject on timeout. */
  waitForStreams(count, timeoutMs = 10000) {
    const active = (s) => Object.values(s.peers).filter((p) => p.streamActive).length;
    return new Promise((resolve, reject) => {
      if (active(this.store.getState()) >= count) return resolve(this.roster());
      const timer = setTimeout(() => {
        unsubscribe();
        reject(
          coded(
            `[${this.label}] timed out waiting for ${count} remote stream(s); have ${active(this.store.getState())}.`,
            'E_VOICE_TIMEOUT',
          ),
        );
      }, timeoutMs);
      const unsubscribe = this.store.subscribe((state) => {
        if (active(state) >= count) {
          clearTimeout(timer);
          unsubscribe();
          resolve(this.roster());
        }
      });
    });
  }

  /**
   * Live WebRTC statistics per remote peer: proves audio is actually flowing (`inbound.bytesReceived`
   * must grow) rather than merely "connected". Returns `available: false` when no RTCPeerConnection.
   */
  async getStats() {
    const out = {};
    for (const [peerId, rec] of this.connections) {
      const pc = rec.call?.peerConnection;
      if (!pc?.getStats) {
        out[peerId] = { available: false, direction: rec.direction };
        continue;
      }
      const entry = {
        available: true,
        direction: rec.direction,
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        inbound: null,
        outbound: null,
      };
      try {
        const report = await pc.getStats();
        report.forEach((stat) => {
          const isAudio = stat.kind === 'audio' || stat.mediaType === 'audio';
          if (stat.type === 'inbound-rtp' && isAudio) {
            entry.inbound = {
              bytesReceived: stat.bytesReceived ?? 0,
              packetsReceived: stat.packetsReceived ?? 0,
              packetsLost: stat.packetsLost ?? 0,
              jitter: stat.jitter ?? null,
              audioLevel: stat.audioLevel ?? null,
              totalAudioEnergy: stat.totalAudioEnergy ?? null,
            };
          } else if (stat.type === 'outbound-rtp' && isAudio) {
            entry.outbound = {
              bytesSent: stat.bytesSent ?? 0,
              packetsSent: stat.packetsSent ?? 0,
            };
          }
        });
      } catch (err) {
        entry.error = err?.message ?? String(err);
      }
      out[peerId] = entry;
    }
    return out;
  }

  // ------------------------------------------------------------------- join flow

  async #join(options) {
    const store = this.store.getState();
    try {
      // A retry after an error/reconnect must not leak the previous mic, peer, or listeners.
      this.#teardown();
      store.resetMesh();
      const joinGen = this.teardownGeneration;

      store.setStatus(VOICE_STATUS.ACQUIRING_MEDIA);
      this.#log('media', 'requesting microphone');
      this.localStream = await this.#acquireMicrophone(options.audio);
      if (joinGen !== this.teardownGeneration || this.socket.connected === false) {
        this.#teardown();
        store.resetMesh();
        return { success: false, code: 'E_NOT_CONNECTED', error: 'Session closed while joining call.' };
      }
      store.setLocalStream(this.localStream);
      store.setLocalStreamActive(true);
      this.speakingDetector.track('local', this.localStream);
      this.speakingDetector.setSuppressed('local', this.listenOnly || this.audioMuted);
      this.#log('media', `microphone ready (${this.localStream.getAudioTracks?.().length ?? '?'} track)`);

      store.setStatus(VOICE_STATUS.SIGNALING);
      // Bind Socket.io listeners & devicechange BEFORE registering: newcomers may be announced mid-handshake.
      this.#bindSocket();
      this.#bindDeviceChange();
      this.peer = await this.#openPeer(options.peerId);
      if (joinGen !== this.teardownGeneration || this.socket.connected === false) {
        this.#teardown();
        store.resetMesh();
        return { success: false, code: 'E_NOT_CONNECTED', error: 'Session closed while joining call.' };
      }
      store.setPeerId(this.peer.id);
      this.#log('peer', `PeerServer registered id ${this.peer.id}`);

      const ack = await this.#registerWithHost();
      if (!ack.success) throw coded(ack.error || 'Host rejected voice join.', ack.code);
      this.registered = true;
      this.#broadcastMediaState();

      store.setStatus(VOICE_STATUS.CONNECTED);
      this.#log(
        'signal',
        `joined voice mesh as ${this.peer.id}; ${ack.peers.length} existing peer(s) will dial in`,
      );
      return { success: true, peerId: this.peer.id, peers: ack.peers };
    } catch (err) {
      const code = err?.code && String(err.code).startsWith('E_') ? err.code : micErrorCode(err);
      const message = err?.message || 'Voice join failed.';
      this.#log('error', `join failed: ${message}`, { code }, 'error');
      this.#teardown();
      this.store.getState().resetMesh();
      this.store.getState().setStatus(VOICE_STATUS.ERROR, message);
      return { success: false, code, error: message };
    }
  }

  async #acquireMicrophone(audio) {
    const store = this.store.getState();
    const explicitDevice =
      typeof audio?.deviceId === 'object' ? audio.deviceId.exact || audio.deviceId.ideal : audio?.deviceId;
    const preferredId = explicitDevice
      ? normalizeDeviceId(explicitDevice)
      : normalizeDeviceId(store.selectedAudioInputId);

    const buildConstraints = (deviceId) => {
      const audioConstraint = { ...DEFAULT_AUDIO_CONSTRAINTS, ...(audio ?? {}) };
      if (deviceId) {
        audioConstraint.deviceId = { exact: deviceId };
      } else {
        delete audioConstraint.deviceId;
      }
      return { audio: audioConstraint, video: false };
    };

    try {
      let stream;
      try {
        stream = await this.getUserMedia(buildConstraints(preferredId));
      } catch (err) {
        if (preferredId && this.#isDeviceUnavailableError(err)) {
          store.setSelectedAudioInputId('');
          saveMediaDevicePrefs({ audioInputId: '' });
          this.#log(
            'media',
            `preferred microphone unavailable (${preferredId}); falling back to default`,
            null,
            'warn',
          );
          stream = await this.getUserMedia(buildConstraints(''));
        } else {
          throw err;
        }
      }
      this.listenOnly = false;
      this.audioMuted = false;
      store.setListenOnly(false);
      store.setLocalAudioMuted(false);
      store.setNotice(null);
      this.#watchLocalTrackEnded('audio', stream?.getAudioTracks?.()?.[0]);
      void this.refreshDevices();
      return stream;
    } catch (err) {
      const code = micErrorCode(err);
      if (code === 'E_MIC_NOT_FOUND') {
        const silentStream = this.createSilentStream();
        this.listenOnly = true;
        this.audioMuted = true;
        store.setListenOnly(true);
        store.setLocalAudioMuted(true);
        store.setNotice('No mic detected — listen-only');
        this.#log('media', 'no microphone detected; joining in listen-only mode', null, 'warn');
        void this.refreshDevices();
        return silentStream;
      }
      throw coded(err?.message || 'Microphone access failed.', code);
    }
  }

  async #openPeer(requestedId) {
    const peer = await this.createPeer(this.peerOptions, requestedId);
    return new Promise((resolve, reject) => {
      let opened = false;
      const timer = setTimeout(() => {
        try {
          peer.destroy?.();
        } catch {
          // Already gone.
        }
        reject(coded('Timed out reaching the host PeerServer.', 'E_PEER_TIMEOUT'));
      }, this.openTimeoutMs);

      peer.on('open', () => {
        opened = true;
        clearTimeout(timer);
        resolve(peer);
      });
      peer.on('call', (call) => this.#onIncomingCall(call));
      peer.on('error', (err) => {
        const type = err?.type ?? 'unknown';
        this.#log('peer', `peer error (${type}): ${err?.message ?? err}`, { type }, 'warn');
        if (!opened) {
          clearTimeout(timer);
          reject(coded(err?.message || 'PeerJS failed to open.', 'E_PEER_FAILED'));
        }
      });
      peer.on('disconnected', () => {
        // Our own teardown destroys the peer too; only react to unexpected signaling loss.
        if (this.peer !== peer) return;
        this.#log('peer', 'lost the PeerServer websocket; reconnecting', null, 'warn');
        setTimeout(() => {
          if (this.peer === peer && peer.disconnected && !peer.destroyed) {
            try {
              peer.reconnect();
            } catch {
              // Reconnect is best-effort; live MediaConnections are unaffected.
            }
          }
        }, 1000);
      });
      peer.on('close', () => {
        if (this.peer === peer) this.#log('peer', 'peer closed unexpectedly', null, 'warn');
      });
    });
  }

  #registerWithHost() {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ success: false, code: 'E_ACK_TIMEOUT', error: 'Host did not acknowledge voice:join.' });
      }, this.ackTimeoutMs);
      this.socket.emit(EVENTS.VOICE_JOIN, { peerId: this.peer.id }, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(
          response?.success
            ? { success: true, peers: Array.isArray(response.peers) ? response.peers : [] }
            : {
                success: false,
                code: response?.code ?? 'E_VOICE_JOIN_FAILED',
                error: response?.error ?? 'Voice join rejected.',
              },
        );
      });
    });
  }

  // ------------------------------------------------------------- socket signaling

  #bindSocket() {
    if (this.socketBindings) return;
    const onJoined = (payload) => this.#onPeerJoined(payload);
    const onLeft = (payload) => this.#onPeerLeft(payload);
    const onRoster = (peers) => this.#onRoster(peers);
    const onMediaState = (payload) => this.#onPeerMediaState(payload);
    const onDisconnect = (reason) => {
      if (reason === 'io client disconnect' || reason === 'io server disconnect') {
        // Intentional close or explicit host kick: tear down the P2P call immediately.
        this.leave({ notifyHost: false });
        return;
      }
      if (!this.registered) return;
      // Close active peer media immediately so audio stops on the spot even while Socket.IO retries.
      for (const peerId of [...this.connections.keys()]) {
        this.#closeConnection(peerId, `socket dropped (${reason})`);
      }
      // Transport drop: the host frees our slot (everyone hangs up). Keep mic + peer; re-register
      // once the session identity is restored (`session:welcome`).
      this.registered = false;
      this.needsReregister = true;
      this.store.getState().setStatus(VOICE_STATUS.RECONNECTING);
      this.#log('signal', `socket dropped (${reason}); will re-register after rejoin`, null, 'warn');
    };
    const onShutdown = () => {
      this.#log('signal', 'host ended session; leaving voice mesh');
      this.leave({ notifyHost: false });
    };
    const onReconnectFailed = () => {
      this.#log('signal', 'session reconnect failed; leaving voice mesh', null, 'warn');
      this.leave({ notifyHost: false });
    };
    const onWelcome = () => {
      if (!this.needsReregister || !this.peer) return;
      this.needsReregister = false;
      this.#registerWithHost().then((ack) => {
        if (ack.success) {
          this.registered = true;
          this.store.getState().setStatus(VOICE_STATUS.CONNECTED);
          this.#broadcastMediaState();
          this.#log('signal', 're-registered after socket reconnect');
        } else {
          this.store.getState().setStatus(VOICE_STATUS.ERROR, ack.error);
          this.#log('error', `re-register failed: ${ack.error}`, { code: ack.code }, 'error');
        }
      });
    };

    this.socket.on(EVENTS.VOICE_PEER_JOINED, onJoined);
    this.socket.on(EVENTS.VOICE_PEER_LEFT, onLeft);
    this.socket.on(EVENTS.SESSION_PEERS, onRoster);
    this.socket.on(EVENTS.VOICE_MEDIA_STATE, onMediaState);
    this.socket.on('disconnect', onDisconnect);
    this.socket.on(EVENTS.SERVER_SHUTDOWN, onShutdown);
    this.socket.on(EVENTS.SESSION_WELCOME, onWelcome);
    this.socket.io?.on?.('reconnect_failed', onReconnectFailed);
    this.socketBindings = [
      [EVENTS.VOICE_PEER_JOINED, onJoined],
      [EVENTS.VOICE_PEER_LEFT, onLeft],
      [EVENTS.SESSION_PEERS, onRoster],
      [EVENTS.VOICE_MEDIA_STATE, onMediaState],
      ['disconnect', onDisconnect],
      [EVENTS.SERVER_SHUTDOWN, onShutdown],
      [EVENTS.SESSION_WELCOME, onWelcome],
    ];
    this.ioReconnectFailedHandler = onReconnectFailed;
  }

  #unbindSocket() {
    if (this.ioReconnectFailedHandler) {
      this.socket.io?.off?.('reconnect_failed', this.ioReconnectFailedHandler);
      this.ioReconnectFailedHandler = null;
    }
    if (!this.socketBindings) return;
    for (const [event, handler] of this.socketBindings) this.socket.off(event, handler);
    this.socketBindings = null;
  }

  /** `player_joined`: an existing client dials the newcomer. */
  #onPeerJoined(payload) {
    const remoteId = payload?.peerId;
    if (typeof remoteId !== 'string' || !remoteId) return;
    if (remoteId === this.peerId) return;
    if (!this.peer || !this.localStream || this.peer.open === false) return;

    this.#log('signal', `player_joined ${payload.displayName ?? ''} (${remoteId})`);
    if (this.connections.size >= MAX_VOICE_PEERS - 1 && !this.connections.has(remoteId)) {
      this.#log('signal', `refusing to dial ${remoteId}: mesh cap reached`, null, 'warn');
      return;
    }
    if (this.connections.has(remoteId)) {
      this.#log('webrtc', `already connected to ${remoteId}; not dialing again`);
      return;
    }

    let call;
    try {
      call = this.peer.call(remoteId, this.localStream, {
        metadata: { playerId: payload.playerId ?? null, from: this.peerId },
      });
    } catch (err) {
      this.#log('webrtc', `peer.call(${remoteId}) threw: ${err?.message}`, null, 'error');
      return;
    }
    if (!call) {
      this.#log('webrtc', `peer.call(${remoteId}) returned nothing`, null, 'error');
      return;
    }
    this.#register(call, 'outgoing', {
      playerId: payload.playerId ?? null,
      displayName: payload.displayName ?? null,
    });
  }

  #onPeerLeft(payload) {
    const remoteId = payload?.peerId;
    if (typeof remoteId !== 'string' || !remoteId) return;
    this.#log('signal', `player_left ${payload.displayName ?? ''} (${remoteId})`);
    this.#closeConnection(remoteId, 'player_left');
  }

  /** `session:peers`: drop any call whose owner is no longer on the authoritative roster, and sync media flags. */
  #onRoster(peers) {
    const roster = Array.isArray(peers) ? peers : [];
    const store = this.store.getState();
    store.setRoster(roster);
    for (const entry of roster) {
      if (!entry?.peerId || entry.peerId === this.peerId) continue;
      if (store.peers[entry.peerId]) {
        const muted = Boolean(entry.muted);
        store.upsertPeer(entry.peerId, {
          ...(entry.playerId ? { playerId: entry.playerId } : {}),
          ...(entry.displayName ? { displayName: entry.displayName } : {}),
          muted,
          deafened: Boolean(entry.deafened),
          hasVideo: Boolean(entry.videoEnabled),
          ...(muted ? { speaking: false } : {}),
        });
      }
    }
    if (!this.registered) return;
    const live = new Set(roster.map((p) => p.peerId));
    for (const peerId of [...this.connections.keys()]) {
      if (!live.has(peerId)) this.#closeConnection(peerId, 'absent from roster');
    }
  }

  #onPeerMediaState(payload) {
    const remoteId = payload?.peerId;
    if (typeof remoteId !== 'string' || !remoteId || remoteId === this.peerId) return;
    const muted = payload.muted !== undefined ? Boolean(payload.muted) : undefined;
    this.store.getState().upsertPeer(remoteId, {
      ...(payload.playerId ? { playerId: payload.playerId } : {}),
      ...(muted !== undefined ? { muted } : {}),
      ...(payload.deafened !== undefined ? { deafened: Boolean(payload.deafened) } : {}),
      ...(payload.videoEnabled !== undefined ? { hasVideo: Boolean(payload.videoEnabled) } : {}),
      ...(muted ? { speaking: false } : {}),
      mediaStateSynced: true,
    });
  }

  // -------------------------------------------------------------- media connections

  /** `peer.on('call')`: answer everyone with our mic. */
  #onIncomingCall(call) {
    if (!this.localStream) {
      this.#log('webrtc', `rejecting call from ${call.peer}: no local stream`, null, 'warn');
      try {
        call.close();
      } catch {
        // Nothing to clean up.
      }
      return;
    }
    this.#log('webrtc', `incoming call from ${call.peer}; answering`);
    call.answer(this.localStream);
    const meta = call.metadata ?? {};
    const known = this.store.getState().roster.find((p) => p.peerId === call.peer);
    this.#register(call, 'incoming', {
      playerId: meta.playerId ?? known?.playerId ?? null,
      displayName: known?.displayName ?? null,
    });
  }

  #register(call, direction, info) {
    const peerId = call.peer;
    const previous = this.connections.get(peerId);
    if (previous && previous.call !== call) {
      previous.streamTrackCleanup?.();
      this.connections.delete(peerId);
      this.#safeClose(previous.call);
      this.#removeAudio(peerId);
      this.#log('webrtc', `replacing stale call with ${peerId}`, null, 'warn');
    }

    const record = { call, direction, stream: null, pc: null, streamTrackCleanup: null };
    this.connections.set(peerId, record);
    const store = this.store.getState();
    const existing = store.peers[peerId];
    const rosterEntry = store.roster.find((p) => p.peerId === peerId);
    store.upsertPeer(peerId, {
      direction,
      playerId: info?.playerId ?? existing?.playerId ?? rosterEntry?.playerId ?? null,
      displayName: info?.displayName ?? existing?.displayName ?? rosterEntry?.displayName ?? null,
      muted: existing?.muted ?? Boolean(rosterEntry?.muted),
      deafened: existing?.deafened ?? Boolean(rosterEntry?.deafened),
      hasVideo: existing?.hasVideo ?? Boolean(rosterEntry?.videoEnabled),
      speaking: existing?.speaking ?? false,
      stream: null,
      streamActive: false,
      connectionState: 'new',
      iceConnectionState: 'new',
    });

    call.on('stream', (stream) => this.#onRemoteStream(peerId, record, stream));
    call.on('close', () => this.#onCallClosed(peerId, record));
    call.on('error', (err) => {
      this.#log('webrtc', `call with ${peerId} errored: ${err?.message ?? err}`, null, 'error');
    });
    this.#watchRtc(peerId, record);
  }

  /** Mirrors RTCPeerConnection state transitions into the store + log. */
  #watchRtc(peerId, record) {
    const pc = record.call.peerConnection;
    if (!pc || record.pc === pc || typeof pc.addEventListener !== 'function') return;
    record.pc = pc;
    const sync = (kind) => {
      if (this.connections.get(peerId) !== record) return;
      const patch = {
        connectionState: pc.connectionState ?? 'unknown',
        iceConnectionState: pc.iceConnectionState ?? 'unknown',
      };
      const current = this.store.getState().peers[peerId];
      if (pc.connectionState === 'connected' && !current?.connectedAt) {
        patch.connectedAt = new Date().toISOString();
      }
      this.store.getState().upsertPeer(peerId, patch);
      const level = pc.connectionState === 'failed' ? 'error' : 'info';
      this.#log(
        'webrtc',
        `${peerId} ${kind}: connection=${patch.connectionState} ice=${patch.iceConnectionState}`,
        null,
        level,
      );
    };
    pc.addEventListener('connectionstatechange', () => sync('connectionstatechange'));
    pc.addEventListener('iceconnectionstatechange', () => sync('iceconnectionstatechange'));
    sync('attached');
  }

  #onRemoteStream(peerId, record, stream) {
    if (this.connections.get(peerId) !== record) return;
    record.streamTrackCleanup?.();
    record.streamTrackCleanup = null;
    record.stream = stream;
    this.#watchRtc(peerId, record);
    const store = this.store.getState();
    const existing = store.peers[peerId];
    const rosterEntry = store.roster.find((p) => p.peerId === peerId);
    const streamHasVideo = (stream?.getVideoTracks?.() ?? []).some((t) => t.readyState !== 'ended');
    const hasVideo = existing?.mediaStateSynced
      ? Boolean(existing.hasVideo)
      : Boolean(rosterEntry?.videoEnabled || streamHasVideo);
    store.upsertPeer(peerId, {
      streamActive: true,
      hasVideo,
      stream,
      streamRevision: (existing?.streamRevision ?? 0) + 1,
    });
    if (typeof stream?.addEventListener === 'function') {
      const onTrackListChange = (event) => {
        if (this.connections.get(peerId) !== record) return;
        const kind = event?.track?.kind;
        if (kind && kind !== 'video') return;
        const api = this.store.getState();
        const current = api.peers[peerId];
        const liveVideo = (stream.getVideoTracks?.() ?? []).some((t) => t.readyState !== 'ended');
        const nextHasVideo =
          event?.type === 'addtrack' ? liveVideo || Boolean(current?.hasVideo) : liveVideo;
        api.upsertPeer(peerId, {
          hasVideo: nextHasVideo,
          streamRevision: (current?.streamRevision ?? 0) + 1,
        });
      };
      stream.addEventListener('addtrack', onTrackListChange);
      stream.addEventListener('removetrack', onTrackListChange);
      record.streamTrackCleanup = () => {
        stream.removeEventListener?.('addtrack', onTrackListChange);
        stream.removeEventListener?.('removetrack', onTrackListChange);
      };
    }
    this.speakingDetector.track(peerId, stream);
    this.speakingDetector.setSuppressed(peerId, this.deafened);
    const audio = this.#attachAudio(peerId, stream);
    this.#log(
      'media',
      `remote stream from ${peerId} (${stream.getAudioTracks?.().length ?? '?'} audio track)` +
        (audio ? ' -> <audio> attached' : ' (no DOM sink)'),
    );
  }

  #onCallClosed(peerId, record) {
    if (this.connections.get(peerId) !== record) return;
    record.streamTrackCleanup?.();
    record.streamTrackCleanup = null;
    this.connections.delete(peerId);
    this.speakingDetector.untrack(peerId);
    this.#removeAudio(peerId);
    this.store.getState().removePeer(peerId);
    this.#log('webrtc', `call with ${peerId} closed`);
  }

  #closeConnection(peerId, reason) {
    const record = this.connections.get(peerId);
    if (!record) return;
    record.streamTrackCleanup?.();
    record.streamTrackCleanup = null;
    this.connections.delete(peerId);
    this.speakingDetector.untrack(peerId);
    this.#removeAudio(peerId);
    this.store.getState().removePeer(peerId);
    this.#safeClose(record.call);
    this.#log('webrtc', `closed call with ${peerId} (${reason})`);
  }

  #safeClose(call) {
    try {
      call?.close?.();
    } catch {
      // Already closed.
    }
  }

  // ------------------------------------------------------------- hidden <audio> sink

  #sink() {
    const doc = this.documentRef;
    if (!doc) return null;
    let sink = doc.getElementById?.(VOICE_SINK_ID) ?? null;
    if (!sink) {
      sink = doc.createElement('div');
      sink.id = VOICE_SINK_ID;
      sink.setAttribute('aria-hidden', 'true');
      sink.style.display = 'none';
      (doc.body ?? doc.documentElement).appendChild(sink);
    }
    return sink;
  }

  #attachAudio(peerId, stream) {
    const sink = this.#sink();
    if (!sink) return null;
    let audio = this.audioEls.get(peerId);
    if (!audio) {
      audio = this.documentRef.createElement('audio');
      audio.autoplay = true;
      audio.setAttribute('playsinline', '');
      audio.setAttribute('data-voice-peer-id', peerId);
      sink.appendChild(audio);
      this.audioEls.set(peerId, audio);
    }
    if (audio.srcObject !== stream) audio.srcObject = stream;
    audio.muted = Boolean(this.deafened);
    try {
      const playing = audio.play?.();
      playing?.catch?.((err) =>
        this.#log('media', `audio.play() for ${peerId} blocked: ${err?.message ?? err}`, null, 'warn'),
      );
    } catch (err) {
      this.#log('media', `audio.play() for ${peerId} threw: ${err?.message ?? err}`, null, 'warn');
    }
    return audio;
  }

  #removeAudio(peerId) {
    const audio = this.audioEls.get(peerId);
    if (!audio) return;
    this.audioEls.delete(peerId);
    try {
      audio.pause?.();
      audio.srcObject = null;
      audio.remove();
    } catch {
      // Detached already.
    }
  }

  // ----------------------------------------------------------------------- teardown

  #teardown() {
    this.teardownGeneration += 1;
    this.#unbindSocket();
    this.#unbindDeviceChange();
    this.#unwatchLocalTrackEnded('audio');
    this.#unwatchLocalTrackEnded('video');
    this.speakingDetector.destroy();
    for (const peerId of [...this.connections.keys()]) this.#closeConnection(peerId, 'teardown');
    for (const peerId of [...this.audioEls.keys()]) this.#removeAudio(peerId);

    if (this.localStream) {
      for (const track of this.localStream.getTracks?.() ?? []) {
        try {
          track.stop();
        } catch {
          // Track already ended.
        }
      }
      try {
        this.localStream._haktonAudioContext?.close?.();
      } catch {
        // Ignore AudioContext close errors.
      }
      this.localStream = null;
    }
    this.listenOnly = false;
    this.audioMuted = false;
    this.deafened = false;
    this.videoEnabled = false;
    this.preDeafenMuted = false;
    if (this.peer) {
      const peer = this.peer;
      this.peer = null;
      try {
        peer.destroy?.();
      } catch {
        // Already destroyed.
      }
    }
    this.registered = false;
    this.needsReregister = false;
  }

  // ------------------------------------------------------------------------ logging

  #log(scope, message, detail = null, level = 'info') {
    const entry = {
      at: new Date().toISOString(),
      level,
      scope,
      peerId: this.peerId,
      message,
      ...(detail ? { detail } : {}),
    };
    this.store.getState().appendLog(entry);
    if (this.logger) {
      try {
        this.logger(`[hakton:${this.label}] ${scope}: ${message}`, entry);
      } catch {
        // A faulty logger must never break signaling.
      }
    }
  }
}
