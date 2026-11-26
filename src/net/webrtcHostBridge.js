import { EVENTS } from '../../shared/events.js';
import { decodeRoomCode } from '../../shared/roomCode.js';
import { sessionStore } from '../store/sessionStore.js';
import { buildInternetPeerOptions } from './networkConfig.js';
import {
  MAX_ASSET_BYTES,
  createFrameAssembler,
  encodeFrames,
  sanitizeProxyAssetPath,
  uint8ToBase64,
} from './webrtcProtocol.js';

const DEFAULT_MAX_PEERS = 16;
const OPEN_TIMEOUT_MS = 15_000;
const INTERNAL_SOCKET_EVENTS = new Set(['connect', 'disconnect', 'connect_error']);

async function defaultCreatePeer(peerId, options) {
  const { Peer } = await import('peerjs');
  return new Peer(peerId, options);
}

async function defaultCreateLocalSocket(localUrl, options) {
  const { io } = await import('socket.io-client');
  return io(localUrl, options);
}

function mapHostPeerError(err, code) {
  const type = err?.type;
  if (type === 'unavailable-id') {
    return `Internet room code ${code} is already registered on signaling. Toggle Internet Play off/on to get a fresh session or switch signaling server.`;
  }
  if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
    return 'Could not reach PeerJS signaling server. Check your internet connection or Advanced Network settings.';
  }
  return err?.message || 'Internet Play signaling error.';
}

/**
 * Host-side PeerJS DataChannel -> local Socket.IO loopback proxy.
 * Runs inside the DM's Electron renderer so the embedded backend stays 100% unchanged
 * and authoritative for rooms, permissions, SQLite persistence, chat, dice, and assets.
 */
export class WebRtcHostBridge {
  /**
   * @param {{
   *   internetCode: string,
   *   localUrl: string,
   *   createPeer?: (peerId: string, options: object) => Promise<any> | any,
   *   createLocalSocket?: (url: string, options: object) => Promise<any> | any,
   *   fetchImpl?: typeof fetch,
   *   peerOptions?: object,
   *   maxPeers?: number,
   *   store?: typeof sessionStore,
   * }} opts
   */
  constructor({
    internetCode,
    localUrl,
    createPeer = defaultCreatePeer,
    createLocalSocket = defaultCreateLocalSocket,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    peerOptions = null,
    maxPeers = DEFAULT_MAX_PEERS,
    store = sessionStore,
  }) {
    if (!internetCode) throw new Error('WebRtcHostBridge requires an internetCode.');
    if (!localUrl) throw new Error('WebRtcHostBridge requires a localUrl.');

    const decoded = decodeRoomCode(internetCode);
    if (decoded.mode !== 'webrtc' || !decoded.peerId) {
      throw new Error(`Invalid Internet room code "${internetCode}".`);
    }

    this.code = decoded.code;
    this.peerId = decoded.peerId;
    this.localUrl = String(localUrl).replace(/\/+$/, '');
    this.createPeer = createPeer;
    this.createLocalSocket = createLocalSocket;
    this.fetchImpl = fetchImpl;
    this.peerOptions = peerOptions ?? buildInternetPeerOptions();
    this.maxPeers = maxPeers;
    this.store = store;

    this.peer = null;
    this.stopped = false;
    this.activePeers = new Map();
    this.chunkSeq = 0;
    this.peerSeq = 0;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
  }

  #nextChunkId = () => `hb-${++this.chunkSeq}`;

  #updateStore(patch) {
    this.store?.getState?.().setInternetBridge?.({
      code: this.code,
      peerId: this.peerId,
      peerCount: this.activePeers.size,
      ...patch,
    });
  }

  #send(conn, message) {
    if (!conn || conn.open === false) return false;
    try {
      const frames = encodeFrames(message, this.#nextChunkId);
      for (const frame of frames) {
        conn.send(frame);
      }
      return true;
    } catch {
      return false;
    }
  }

  start() {
    if (this.stopped) return Promise.resolve({ ok: false, error: 'Bridge stopped.' });
    this.#updateStore({ status: 'connecting', error: null });

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(openTimer);
        resolve(result);
      };

      const openTimer = setTimeout(() => {
        const error = 'Timed out connecting to PeerJS signaling server.';
        this.#updateStore({ status: 'error', error });
        finish({ ok: false, error });
      }, OPEN_TIMEOUT_MS);

      Promise.resolve(this.createPeer(this.peerId, this.peerOptions))
        .then((peer) => {
          if (this.stopped) {
            try {
              peer?.destroy?.();
            } catch {
              // Ignore cleanup errors
            }
            finish({ ok: false, error: 'Bridge stopped.' });
            return;
          }

          this.peer = peer;

          peer.on('open', () => {
            this.reconnectAttempt = 0;
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
            this.#updateStore({ status: 'ready', error: null });
            finish({ ok: true, peerId: this.peerId, code: this.code });
          });

          peer.on('connection', (conn) => {
            this.#handleIncomingConnection(conn).catch(() => {});
          });

          peer.on('disconnected', () => {
            if (this.stopped || this.peer !== peer) return;
            this.#updateStore({
              status: 'connecting',
              error: 'Signaling connection interrupted; reconnecting...',
            });
            this.#scheduleSignalingReconnect(peer);
          });

          peer.on('error', (err) => {
            const message = mapHostPeerError(err, this.code);
            if (!settled) {
              this.#updateStore({ status: 'error', error: message });
              finish({ ok: false, error: message });
              return;
            }
            if (!this.stopped) {
              this.#updateStore({ status: 'error', error: message });
            }
          });

          peer.on('close', () => {
            if (this.peer === peer && !this.stopped) {
              this.#updateStore({ status: 'offline', error: null });
            }
          });
        })
        .catch((err) => {
          const error = err?.message || 'Failed to initialize PeerJS host.';
          this.#updateStore({ status: 'error', error });
          finish({ ok: false, error });
        });
    });
  }

  #scheduleSignalingReconnect(peer) {
    if (this.stopped || this.reconnectTimer || this.peer !== peer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 15_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || this.peer !== peer || peer.destroyed) return;
      if (peer.disconnected) {
        try {
          peer.reconnect();
        } catch {
          this.#scheduleSignalingReconnect(peer);
        }
      }
    }, delay);
  }

  async #handleIncomingConnection(conn) {
    if (!conn) return;
    if (this.stopped || this.activePeers.size >= this.maxPeers) {
      const reason = this.stopped ? 'Host ended the session.' : 'Host room is full.';
      if (conn.open) {
        this.#send(conn, { t: 'shutdown', reason });
        setTimeout(() => {
          try {
            conn.close?.();
          } catch {
            // Ignore
          }
        }, 25);
      } else {
        conn.once?.('open', () => {
          this.#send(conn, { t: 'shutdown', reason });
          setTimeout(() => {
            try {
              conn.close?.();
            } catch {
              // Ignore
            }
          }, 25);
        });
      }
      return;
    }

    const entryId = `remote-${++this.peerSeq}`;
    const entry = {
      id: entryId,
      conn,
      localSocket: null,
      localConnected: false,
      queue: [],
      closing: false,
      assembler: null,
    };
    this.activePeers.set(entryId, entry);
    this.#updateStore({});

    const cleanup = () => {
      if (entry.closing) return;
      entry.closing = true;
      this.activePeers.delete(entryId);
      entry.assembler?.clear();
      try {
        entry.localSocket?.offAny?.();
        entry.localSocket?.disconnect?.();
      } catch {
        // Ignore loopback teardown errors
      }
      try {
        conn.close?.();
      } catch {
        // Ignore DataConnection close errors
      }
      this.#updateStore({});
    };

    const localSocket = await this.createLocalSocket(this.localUrl, {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: false,
      timeout: 8000,
    });
    if (this.stopped || entry.closing) {
      try {
        localSocket?.disconnect?.();
      } catch {
        // Ignore
      }
      return;
    }

    entry.localSocket = localSocket;
    entry.localConnected = Boolean(localSocket.connected);

    const dispatchEmit = (msg) => {
      const event = msg.event;
      if (typeof event !== 'string' || !event) return;

      // Never allow remote internet peers to spoof DM hostToken, flip network mode, or end the session
      if (event === EVENTS.SESSION_NETWORK_MODE || event === EVENTS.SESSION_END) {
        if (msg.ackId != null) {
          this.#send(conn, {
            t: 'ack',
            ackId: msg.ackId,
            args: [{ ok: false, error: 'Forbidden.' }],
          });
        }
        return;
      }

      const args = Array.isArray(msg.args) ? [...msg.args] : [];
      if (
        event === EVENTS.SESSION_JOIN &&
        args[0] &&
        typeof args[0] === 'object' &&
        !Array.isArray(args[0])
      ) {
        const sanitized = { ...args[0] };
        delete sanitized.hostToken;
        args[0] = sanitized;
      }

      if (msg.ackId != null) {
        localSocket.emit(event, ...args, (...ackArgs) => {
          if (!entry.closing && !this.stopped) {
            this.#send(conn, { t: 'ack', ackId: msg.ackId, args: ackArgs });
          }
        });
      } else {
        localSocket.emit(event, ...args);
      }
    };

    const flushQueue = () => {
      while (entry.queue.length > 0 && entry.localConnected && !entry.closing) {
        dispatchEmit(entry.queue.shift());
      }
    };

    localSocket.on('connect', () => {
      entry.localConnected = true;
      flushQueue();
    });

    localSocket.onAny?.((event, ...args) => {
      if (INTERNAL_SOCKET_EVENTS.has(event) || entry.closing || this.stopped) return;
      this.#send(conn, { t: 'event', event, args });
    });

    localSocket.on('disconnect', () => {
      if (entry.closing || this.stopped) return;
      this.#send(conn, { t: 'shutdown', reason: 'Host server disconnected.' });
      setTimeout(cleanup, 25);
    });

    localSocket.on('connect_error', () => {
      if (entry.closing || this.stopped) return;
      this.#send(conn, { t: 'shutdown', reason: 'Local host server is unavailable.' });
      setTimeout(cleanup, 25);
    });

    entry.assembler = createFrameAssembler((msg) => {
      if (entry.closing || this.stopped) return;
      if (msg.t === 'ping') {
        this.#send(conn, { t: 'pong', ts: msg.ts });
        return;
      }
      if (msg.t === 'emit') {
        if (entry.localConnected) {
          dispatchEmit(msg);
        } else {
          entry.queue.push(msg);
        }
        return;
      }
      if (msg.t === 'asset:req') {
        this.#handleAssetRequest(conn, msg).catch(() => {});
      }
    });

    conn.on('data', (raw) => entry.assembler.push(raw));
    conn.on('close', cleanup);
    conn.on('error', cleanup);
  }

  async #handleAssetRequest(conn, msg) {
    const reqId = msg?.reqId;
    if (!reqId) return;

    const safePath = sanitizeProxyAssetPath(msg.path);
    if (!safePath) {
      this.#send(conn, {
        t: 'asset:res',
        reqId,
        ok: false,
        error: 'Invalid or forbidden asset path.',
      });
      return;
    }

    if (typeof this.fetchImpl !== 'function') {
      this.#send(conn, {
        t: 'asset:res',
        reqId,
        ok: false,
        error: 'Asset proxy fetch is unavailable on host.',
      });
      return;
    }

    try {
      const response = await this.fetchImpl(`${this.localUrl}${safePath}`);
      if (!response.ok) {
        this.#send(conn, {
          t: 'asset:res',
          reqId,
          ok: false,
          error: `Host returned ${response.status} for asset.`,
        });
        return;
      }

      const contentLength = Number(response.headers?.get?.('content-length') || 0);
      if (contentLength > MAX_ASSET_BYTES) {
        this.#send(conn, {
          t: 'asset:res',
          reqId,
          ok: false,
          error: 'Asset exceeds 25 MiB P2P transfer limit.',
        });
        return;
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_ASSET_BYTES) {
        this.#send(conn, {
          t: 'asset:res',
          reqId,
          ok: false,
          error: 'Asset exceeds 25 MiB P2P transfer limit.',
        });
        return;
      }

      const mimeType = response.headers?.get?.('content-type') || 'application/octet-stream';
      const base64 = uint8ToBase64(new Uint8Array(buffer));
      this.#send(conn, {
        t: 'asset:res',
        reqId,
        ok: true,
        mimeType,
        base64,
      });
    } catch (err) {
      this.#send(conn, {
        t: 'asset:res',
        reqId,
        ok: false,
        error: err?.message || 'Failed to read asset from host.',
      });
    }
  }

  notifyShutdownSync(reason = 'Host ended the session.') {
    if (this.stopped) return;
    for (const entry of this.activePeers.values()) {
      if (entry?.conn && entry.conn.open !== false) {
        try {
          this.#send(entry.conn, { t: 'shutdown', reason });
        } catch {
          // Ignore send errors during synchronous page unload
        }
      }
    }
  }

  async stop({ reason = 'Host ended the session.' } = {}) {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    let notified = false;
    for (const entry of this.activePeers.values()) {
      if (entry.conn?.open !== false) {
        if (this.#send(entry.conn, { t: 'shutdown', reason })) {
          notified = true;
        }
      }
    }
    if (notified) {
      await new Promise((r) => setTimeout(r, 25));
    }

    for (const entry of [...this.activePeers.values()]) {
      entry.closing = true;
      entry.assembler?.clear();
      try {
        entry.localSocket?.offAny?.();
        entry.localSocket?.disconnect?.();
      } catch {
        // Ignore
      }
      try {
        entry.conn?.close?.();
      } catch {
        // Ignore
      }
    }
    this.activePeers.clear();

    if (this.peer) {
      const peer = this.peer;
      this.peer = null;
      try {
        peer.destroy?.();
      } catch {
        // Ignore
      }
    }

    this.#updateStore({
      status: 'offline',
      error: null,
      peerCount: 0,
    });
  }
}

let activeBridge = null;

export function getInternetHostBridge() {
  return activeBridge;
}

export async function startInternetHostBridge(opts) {
  if (activeBridge) {
    await activeBridge.stop({ reason: 'Restarting Internet bridge.' });
    activeBridge = null;
  }
  const bridge = new WebRtcHostBridge(opts);
  activeBridge = bridge;
  const result = await bridge.start();
  return { bridge, ...result };
}

export async function stopInternetHostBridge(opts) {
  if (!activeBridge) return;
  const bridge = activeBridge;
  activeBridge = null;
  await bridge.stop(opts);
}

export function notifyInternetHostShutdownSync(reason) {
  activeBridge?.notifyShutdownSync(reason);
}
