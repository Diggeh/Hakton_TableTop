import { EVENTS, MAX_VOICE_PEERS } from '../../shared/events.js';
import { VOICE_STATUS, voiceStore } from '../store/voiceStore.js';

/** Id of the hidden container that owns every remote `<audio>` element. */
export const VOICE_SINK_ID = 'hakton-voice-audio-sink';

const DEFAULT_AUDIO_CONSTRAINTS = Object.freeze({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
});

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

      store.setStatus(VOICE_STATUS.ACQUIRING_MEDIA);
      this.#log('media', 'requesting microphone');
      this.localStream = await this.#acquireMicrophone(options.audio);
      store.setLocalStreamActive(true);
      this.#log('media', `microphone ready (${this.localStream.getAudioTracks?.().length ?? '?'} track)`);

      store.setStatus(VOICE_STATUS.SIGNALING);
      // Bind Socket.io listeners BEFORE registering: a newcomer may be announced mid-handshake.
      this.#bindSocket();
      this.peer = await this.#openPeer(options.peerId);
      store.setPeerId(this.peer.id);
      this.#log('peer', `PeerServer registered id ${this.peer.id}`);

      const ack = await this.#registerWithHost();
      if (!ack.success) throw coded(ack.error || 'Host rejected voice join.', ack.code);
      this.registered = true;

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
      return await this.getUserMedia(constraints);
    } catch (err) {
      throw coded(err?.message || 'Microphone access failed.', micErrorCode(err));
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
    const onDisconnect = (reason) => {
      if (reason === 'io client disconnect') {
        // socket.js `disconnect()` was called on purpose: the table is closed, so is the mic.
        this.leave({ notifyHost: false });
        return;
      }
      if (!this.registered) return;
      // Transport drop: the host frees our slot (everyone hangs up). Keep mic + peer; re-register
      // once the session identity is restored (`session:welcome`).
      this.registered = false;
      this.needsReregister = true;
      this.store.getState().setStatus(VOICE_STATUS.RECONNECTING);
      this.#log('signal', `socket dropped (${reason}); will re-register after rejoin`, null, 'warn');
    };
    const onWelcome = () => {
      if (!this.needsReregister || !this.peer) return;
      this.needsReregister = false;
      this.#registerWithHost().then((ack) => {
        if (ack.success) {
          this.registered = true;
          this.store.getState().setStatus(VOICE_STATUS.CONNECTED);
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
    this.socket.on('disconnect', onDisconnect);
    this.socket.on(EVENTS.SESSION_WELCOME, onWelcome);
    this.socketBindings = [
      [EVENTS.VOICE_PEER_JOINED, onJoined],
      [EVENTS.VOICE_PEER_LEFT, onLeft],
      [EVENTS.SESSION_PEERS, onRoster],
      ['disconnect', onDisconnect],
      [EVENTS.SESSION_WELCOME, onWelcome],
    ];
  }

  #unbindSocket() {
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

  /** `session:peers`: drop any call whose owner is no longer on the authoritative roster. */
  #onRoster(peers) {
    const roster = Array.isArray(peers) ? peers : [];
    this.store.getState().setRoster(roster);
    if (!this.registered) return;
    const live = new Set(roster.map((p) => p.peerId));
    for (const peerId of [...this.connections.keys()]) {
      if (!live.has(peerId)) this.#closeConnection(peerId, 'absent from roster');
    }
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
    this.store.getState().upsertPeer(peerId, {
      direction,
      playerId: info?.playerId ?? null,
      displayName: info?.displayName ?? null,
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
    this.store.getState().upsertPeer(peerId, { streamActive: true });
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
    this.#removeAudio(peerId);
    this.store.getState().removePeer(peerId);
    this.#log('webrtc', `call with ${peerId} closed`);
  }

  #closeConnection(peerId, reason) {
    const record = this.connections.get(peerId);
    if (!record) return;
    this.connections.delete(peerId);
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
    this.#unbindSocket();
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
      this.localStream = null;
    }
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
