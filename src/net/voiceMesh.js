import { EVENTS, MAX_VOICE_PEERS } from '../../shared/events.js';
import { VOICE_STATUS, voiceStore } from '../store/voiceStore.js';
import { SpeakingDetector } from './speakingDetector.js';

/** Id of the hidden container that owns every remote `<audio>` element. */
export const VOICE_SINK_ID = 'hakton-voice-audio-sink';

const DEFAULT_AUDIO_CONSTRAINTS = Object.freeze({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
});

export const DEFAULT_VIDEO_CONSTRAINTS = Object.freeze({
  width: { ideal: 640, max: 854 },
  height: { ideal: 480, max: 480 },
  frameRate: { ideal: 20, max: 20 },
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

  #findVideoSender(pc) {
    if (!pc) return null;
    const senders = pc.getSenders?.() ?? [];
    const direct = senders.find((s) => s?.track?.kind === 'video');
    if (direct) return direct;
    const transceivers = pc.getTransceivers?.() ?? [];
    const videoTransceiver = transceivers.find(
      (t) => t?.receiver?.track?.kind === 'video' || t?.sender?.track?.kind === 'video',
    );
    return videoTransceiver?.sender ?? null;
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

    const store = this.store.getState();

    if (next) {
      let camStream;
      try {
        camStream = await this.getUserMedia({
          audio: false,
          video: { ...DEFAULT_VIDEO_CONSTRAINTS, ...(videoConstraints ?? {}) },
        });
      } catch (err) {
        const message = err?.message || 'Camera access failed.';
        this.#log('media', `camera failed: ${message}`, null, 'warn');
        return { ok: false, enabled: false, error: message };
      }

      const videoTrack = camStream?.getVideoTracks?.()?.[0];
      if (!videoTrack) {
        return { ok: false, enabled: false, error: 'No camera video track available.' };
      }

      for (const oldTrack of this.localStream.getVideoTracks?.() ?? []) {
        try {
          this.localStream.removeTrack?.(oldTrack);
          oldTrack.stop?.();
        } catch {
          // Ignore
        }
      }
      this.localStream.addTrack?.(videoTrack);
      this.videoEnabled = true;
      store.setLocalVideoEnabled(true);
      store.setLocalStream(this.localStream);
      store.bumpLocalStreamRevision();
      this.#broadcastMediaState();

      for (const [peerId, rec] of [...this.connections.entries()]) {
        const videoSender = this.#findVideoSender(rec.call?.peerConnection);
        if (videoSender?.replaceTrack) {
          try {
            await videoSender.replaceTrack(videoTrack);
            continue;
          } catch {
            // Fall back to redial below
          }
        }
        if (typeof this.peer.call === 'function' && this.peer.open !== false) {
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
            this.#log('webrtc', `camera renegotiate failed for ${peerId}: ${err?.message}`, null, 'warn');
          }
        }
      }

      this.#log('media', 'camera enabled (480p @ 20fps)');
      return { ok: true, enabled: true };
    }

    for (const track of [...(this.localStream.getVideoTracks?.() ?? [])]) {
      try {
        this.localStream.removeTrack?.(track);
        track.stop?.();
      } catch {
        // Ignore
      }
    }
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
      // Bind Socket.io listeners BEFORE registering: a newcomer may be announced mid-handshake.
      this.#bindSocket();
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
    const constraints = {
      audio: { ...DEFAULT_AUDIO_CONSTRAINTS, ...(audio ?? {}) },
      video: false,
    };
    try {
      const stream = await this.getUserMedia(constraints);
      this.listenOnly = false;
      this.audioMuted = false;
      this.store.getState().setListenOnly(false);
      this.store.getState().setLocalAudioMuted(false);
      this.store.getState().setNotice(null);
      return stream;
    } catch (err) {
      const code = micErrorCode(err);
      if (code === 'E_MIC_NOT_FOUND') {
        const silentStream = this.createSilentStream();
        this.listenOnly = true;
        this.audioMuted = true;
        this.store.getState().setListenOnly(true);
        this.store.getState().setLocalAudioMuted(true);
        this.store.getState().setNotice('No mic detected — listen-only');
        this.#log('media', 'no microphone detected; joining in listen-only mode', null, 'warn');
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
      this.connections.delete(peerId);
      this.#safeClose(previous.call);
      this.#removeAudio(peerId);
      this.#log('webrtc', `replacing stale call with ${peerId}`, null, 'warn');
    }

    const record = { call, direction, stream: null, pc: null };
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
    record.stream = stream;
    this.#watchRtc(peerId, record);
    const store = this.store.getState();
    const existing = store.peers[peerId];
    const rosterEntry = store.roster.find((p) => p.peerId === peerId);
    const streamHasVideo = (stream?.getVideoTracks?.() ?? []).some((t) => t.readyState !== 'ended');
    const hasVideo = existing?.mediaStateSynced
      ? Boolean(existing.hasVideo)
      : Boolean(rosterEntry?.videoEnabled || streamHasVideo);
    store.upsertPeer(peerId, { streamActive: true, hasVideo, stream });
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
    this.connections.delete(peerId);
    this.speakingDetector.untrack(peerId);
    this.#removeAudio(peerId);
    this.store.getState().removePeer(peerId);
    this.#log('webrtc', `call with ${peerId} closed`);
  }

  #closeConnection(peerId, reason) {
    const record = this.connections.get(peerId);
    if (!record) return;
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
