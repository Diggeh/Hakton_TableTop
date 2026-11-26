import { EVENTS } from '../../shared/events.js';
import { buildInternetPeerOptions } from './networkConfig.js';
import { createFrameAssembler, encodeFrames } from './webrtcProtocol.js';

const DEFAULT_RECONNECTION_ATTEMPTS = 5;
const DEFAULT_RECONNECTION_DELAY = 1200;
const DEFAULT_RECONNECTION_DELAY_MAX = 6000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 12_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 35_000;

async function defaultCreatePeer(options) {
  const { Peer } = await import('peerjs');
  return new Peer(undefined, options);
}

function parseTarget(targetUrl) {
  const hostPeerId = String(targetUrl || '')
    .replace(/^webrtc:\/\//i, '')
    .replace(/\/+$/, '');
  const rawSuffix = hostPeerId.replace(/^hakton-net-/i, '').toUpperCase();
  const displayCode =
    rawSuffix.length === 8
      ? `NET-${rawSuffix.slice(0, 4)}-${rawSuffix.slice(4, 8)}`
      : `NET-${rawSuffix}`;
  return { hostPeerId, displayCode };
}

function mapPeerError(err, displayCode) {
  const type = err?.type;
  if (type === 'peer-unavailable') {
    return `Room code ${displayCode} not found or the DM is offline.`;
  }
  if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
    return 'Could not reach PeerJS signaling server. Check your internet connection or Advanced Network settings.';
  }
  if (type === 'webrtc') {
    return 'Peer-to-peer connection blocked by firewall or strict NAT.';
  }
  return err?.message || `Unable to connect to ${displayCode}.`;
}

class MiniEmitter {
  constructor() {
    this.listeners = new Map();
  }

  on(event, fn) {
    if (typeof fn !== 'function') return this;
    let list = this.listeners.get(event);
    if (!list) {
      list = new Set();
      this.listeners.set(event, list);
    }
    list.add(fn);
    return this;
  }

  off(event, fn) {
    if (!fn) {
      this.listeners.delete(event);
      return this;
    }
    const list = this.listeners.get(event);
    if (list) {
      list.delete(fn);
      if (list.size === 0) this.listeners.delete(event);
    }
    return this;
  }

  once(event, fn) {
    if (typeof fn !== 'function') return this;
    const wrapper = (...args) => {
      this.off(event, wrapper);
      fn(...args);
    };
    return this.on(event, wrapper);
  }

  emitLocal(event, ...args) {
    const list = this.listeners.get(event);
    if (!list) return;
    for (const fn of [...list]) {
      fn(...args);
    }
  }
}

/**
 * Socket.IO-compatible client transport over a reliable PeerJS DataConnection.
 * Supports `.on`, `.off`, `.once`, `.emit` (with acks), `.timeout(ms).emit`,
 * `.connected`, `.active`, `.io` lifecycle events, and chunked P2P asset requests.
 */
export class WebRtcSocketAdapter extends MiniEmitter {
  /**
   * @param {string} targetUrl `webrtc://hakton-net-...`
   * @param {{
   *   createPeer?: (options: object) => Promise<any> | any,
   *   peerOptions?: object,
   *   reconnectionAttempts?: number,
   *   reconnectionDelay?: number,
   *   reconnectionDelayMax?: number,
   *   attemptTimeoutMs?: number,
   *   heartbeatIntervalMs?: number,
   *   heartbeatTimeoutMs?: number,
   *   onPhaseChange?: (message: string) => void,
   * }} [opts]
   */
  constructor(targetUrl, opts = {}) {
    super();
    const { hostPeerId, displayCode } = parseTarget(targetUrl);
    this.targetUrl = targetUrl;
    this.hostPeerId = hostPeerId;
    this.displayCode = displayCode;

    this.createPeer = opts.createPeer ?? defaultCreatePeer;
    this.peerOptions = opts.peerOptions ?? buildInternetPeerOptions();
    this.reconnectionAttempts = opts.reconnectionAttempts ?? DEFAULT_RECONNECTION_ATTEMPTS;
    this.reconnectionDelay = opts.reconnectionDelay ?? DEFAULT_RECONNECTION_DELAY;
    this.reconnectionDelayMax = opts.reconnectionDelayMax ?? DEFAULT_RECONNECTION_DELAY_MAX;
    this.attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.onPhaseChange = opts.onPhaseChange ?? null;

    this.connected = false;
    this.active = false;
    this.id = null;

    const ioBus = new MiniEmitter();
    ioBus.uri = targetUrl;
    this.io = ioBus;

    this.peer = null;
    this.conn = null;
    this.assembler = null;
    this.pendingAcks = new Map();
    this.pendingAssets = new Map();
    this.seq = 0;
    this.chunkSeq = 0;
    this.reconnectCount = 0;
    this.reconnectTimer = null;
    this.attemptTimer = null;
    this.heartbeatTimer = null;
    this.lastPongAt = 0;
    this.lastErrorMessage = null;
    this.generation = 0;
  }

  #nextChunkId = () => `wc-${++this.chunkSeq}`;

  #sendFrame(message) {
    if (!this.conn || !this.connected) return false;
    try {
      const frames = encodeFrames(message, this.#nextChunkId);
      for (const frame of frames) {
        this.conn.send(frame);
      }
      return true;
    } catch {
      return false;
    }
  }

  #rejectAllPending(reason) {
    for (const [id, pending] of this.pendingAcks.entries()) {
      this.pendingAcks.delete(id);
      clearTimeout(pending.timer);
      if (pending.isTimeoutStyle) {
        pending.cb?.(new Error(reason));
      }
    }
    for (const [id, pending] of this.pendingAssets.entries()) {
      this.pendingAssets.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
  }

  #clearAttemptTimers() {
    clearTimeout(this.attemptTimer);
    this.attemptTimer = null;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  #teardownAttemptTransport() {
    this.#clearAttemptTimers();
    this.assembler?.clear();
    this.assembler = null;

    if (this.conn) {
      const conn = this.conn;
      this.conn = null;
      try {
        conn.close?.();
      } catch {
        // Ignore
      }
    }
    if (this.peer) {
      const peer = this.peer;
      this.peer = null;
      try {
        peer.destroy?.();
      } catch {
        // Ignore
      }
    }
    this.connected = false;
    this.id = null;
  }

  connect() {
    if (this.connected || this.peer) return this;
    this.active = true;
    this.reconnectCount = 0;
    this.lastErrorMessage = null;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.#startAttempt();
    return this;
  }

  disconnect() {
    this.active = false;
    this.generation += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const wasConnected = this.connected;
    this.#rejectAllPending('Disconnected by client.');
    this.#teardownAttemptTransport();
    if (wasConnected) {
      this.emitLocal('disconnect', 'io client disconnect');
    }
    return this;
  }

  emit(event, ...args) {
    let ack = null;
    const payloadArgs = [...args];
    if (payloadArgs.length > 0 && typeof payloadArgs[payloadArgs.length - 1] === 'function') {
      ack = payloadArgs.pop();
    }

    if (!this.connected) return this;

    let ackId = null;
    if (ack) {
      ackId = `a-${++this.seq}`;
      this.pendingAcks.set(ackId, { cb: ack, timer: null, isTimeoutStyle: false });
    }

    this.#sendFrame({ t: 'emit', event, args: payloadArgs, ackId });
    return this;
  }

  timeout(timeoutMs) {
    return {
      emit: (event, ...args) => {
        const payloadArgs = [...args];
        const ack =
          payloadArgs.length > 0 && typeof payloadArgs[payloadArgs.length - 1] === 'function'
            ? payloadArgs.pop()
            : null;

        if (!this.connected) {
          ack?.(new Error('Socket is not connected.'));
          return this;
        }

        const ackId = `a-${++this.seq}`;
        const timer = setTimeout(() => {
          const pending = this.pendingAcks.get(ackId);
          if (!pending) return;
          this.pendingAcks.delete(ackId);
          pending.cb?.(new Error('Operation has timed out.'));
        }, timeoutMs);

        this.pendingAcks.set(ackId, { cb: ack, timer, isTimeoutStyle: true });
        this.#sendFrame({ t: 'emit', event, args: payloadArgs, ackId });
        return this;
      },
    };
  }

  requestAsset(path, timeoutMs = 20_000) {
    if (!this.connected) {
      return Promise.reject(new Error('Cannot fetch asset while disconnected.'));
    }
    const reqId = `req-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingAssets.has(reqId)) return;
        this.pendingAssets.delete(reqId);
        reject(new Error('Asset request timed out over P2P.'));
      }, timeoutMs);
      this.pendingAssets.set(reqId, { resolve, reject, timer });
      const sent = this.#sendFrame({ t: 'asset:req', reqId, path });
      if (!sent) {
        clearTimeout(timer);
        this.pendingAssets.delete(reqId);
        reject(new Error('Failed to send asset request over P2P.'));
      }
    });
  }

  #startAttempt() {
    if (!this.active) return;
    const gen = ++this.generation;
    let attemptFailed = false;

    const failAttempt = (message) => {
      if (attemptFailed || gen !== this.generation || !this.active) return;
      attemptFailed = true;
      this.lastErrorMessage = message;
      const wasConnected = this.connected;
      this.#rejectAllPending(message);
      this.#teardownAttemptTransport();

      if (wasConnected) {
        this.emitLocal('disconnect', 'transport close');
      } else {
        this.emitLocal('connect_error', new Error(message));
      }

      if (!this.active) return;

      if (this.reconnectCount >= this.reconnectionAttempts) {
        this.active = false;
        this.emitLocal('connect_error', new Error(message));
        this.io.emitLocal('reconnect_failed');
        return;
      }

      this.reconnectCount += 1;
      const delay = Math.min(
        this.reconnectionDelay * 2 ** (this.reconnectCount - 1),
        this.reconnectionDelayMax,
      );
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.active || gen !== this.generation) return;
        this.io.emitLocal('reconnect_attempt', this.reconnectCount);
        this.#startAttempt();
      }, delay);
    };

    this.onPhaseChange?.('Connecting to PeerJS signaling...');
    this.attemptTimer = setTimeout(() => {
      failAttempt(
        `Timed out connecting to ${this.displayCode} — firewall or strict NAT may be blocking direct P2P.`,
      );
    }, this.attemptTimeoutMs);

    Promise.resolve(this.createPeer(this.peerOptions))
      .then((peer) => {
        if (gen !== this.generation || !this.active || attemptFailed) {
          try {
            peer?.destroy?.();
          } catch {
            // Ignore
          }
          return;
        }
        this.peer = peer;

        peer.on('open', (myPeerId) => {
          if (gen !== this.generation || !this.active || attemptFailed) return;
          this.onPhaseChange?.(`Dialing host ${this.displayCode}...`);
          let conn;
          try {
            conn = peer.connect(this.hostPeerId, { reliable: true });
          } catch (err) {
            failAttempt(err?.message || `Failed to dial ${this.displayCode}.`);
            return;
          }
          if (!conn) {
            failAttempt(`Failed to dial ${this.displayCode}.`);
            return;
          }
          this.conn = conn;
          this.#bindDataConnection(conn, myPeerId, gen, failAttempt);
        });

        peer.on('error', (err) => {
          failAttempt(mapPeerError(err, this.displayCode));
        });

        peer.on('disconnected', () => {
          if (!this.connected) {
            failAttempt('Lost connection to PeerJS signaling server.');
          }
        });
      })
      .catch((err) => {
        failAttempt(err?.message || 'Failed to initialize WebRTC client.');
      });
  }

  #bindDataConnection(conn, myPeerId, gen, failAttempt) {
    const onOpen = () => {
      if (gen !== this.generation || !this.active) return;
      clearTimeout(this.attemptTimer);
      this.attemptTimer = null;

      const reconnected = this.reconnectCount > 0;
      this.reconnectCount = 0;
      this.lastErrorMessage = null;
      this.connected = true;
      this.id = myPeerId || `webrtc-${Date.now()}`;
      this.lastPongAt = Date.now();

      this.heartbeatTimer = setInterval(() => {
        if (!this.connected || gen !== this.generation) return;
        if (Date.now() - this.lastPongAt > this.heartbeatTimeoutMs) {
          failAttempt('Connection to host timed out.');
          return;
        }
        this.#sendFrame({ t: 'ping', ts: Date.now() });
      }, this.heartbeatIntervalMs);

      if (reconnected) {
        this.io.emitLocal('reconnect', this.reconnectCount);
      }
      this.emitLocal('connect');
    };

    this.assembler = createFrameAssembler((msg) => {
      if (gen !== this.generation) return;
      if (msg.t === 'pong') {
        this.lastPongAt = Date.now();
        return;
      }
      if (msg.t === 'event') {
        this.emitLocal(msg.event, ...(Array.isArray(msg.args) ? msg.args : []));
        return;
      }
      if (msg.t === 'ack') {
        const pending = this.pendingAcks.get(msg.ackId);
        if (!pending) return;
        this.pendingAcks.delete(msg.ackId);
        clearTimeout(pending.timer);
        const args = Array.isArray(msg.args) ? msg.args : [];
        if (pending.isTimeoutStyle) {
          pending.cb?.(null, ...args);
        } else {
          pending.cb?.(...args);
        }
        return;
      }
      if (msg.t === 'asset:res') {
        const pending = this.pendingAssets.get(msg.reqId);
        if (!pending) return;
        this.pendingAssets.delete(msg.reqId);
        clearTimeout(pending.timer);
        if (msg.ok) {
          pending.resolve({ mimeType: msg.mimeType, base64: msg.base64 });
        } else {
          pending.reject(new Error(msg.error || 'Asset unavailable on host.'));
        }
        return;
      }
      if (msg.t === 'shutdown') {
        const reason = msg.reason || 'Host ended the session.';
        this.active = false;
        this.generation += 1;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.#rejectAllPending(reason);
        this.#teardownAttemptTransport();
        this.emitLocal('disconnect', 'io server disconnect');
        this.emitLocal(EVENTS.SERVER_SHUTDOWN, { reason });
      }
    });

    conn.on('data', (raw) => this.assembler?.push(raw));
    conn.on('open', onOpen);
    conn.on('close', () => failAttempt('Host connection closed.'));
    conn.on('error', (err) =>
      failAttempt(err?.message || 'Peer-to-peer DataChannel error.'),
    );

    const pc = conn.peerConnection;
    if (pc && typeof pc.addEventListener === 'function') {
      pc.addEventListener('iceconnectionstatechange', () => {
        if (pc.iceConnectionState === 'failed') {
          failAttempt('Peer-to-peer link blocked by firewall or strict NAT.');
        }
      });
    }

    if (conn.open) {
      onOpen();
    }
  }
}

export function createWebRtcSocket(targetUrl, opts = {}) {
  return new WebRtcSocketAdapter(targetUrl, opts);
}
