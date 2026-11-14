import { bindChat, unbindChat } from './chat.js';
import { io } from 'socket.io-client';
import {
  CONNECTION_STATUS,
  DEFAULT_PORT,
  DEFAULT_SESSION_ID,
  EVENTS,
  ROLES,
} from '../../shared/events.js';
import { sessionStore } from '../store/sessionStore.js';
import { canvasStore } from '../canvas/canvasStore.js';
import { autosave } from '../autosave/index.js';
import { setAutosaveTransport } from '../autosave/transport.js';
import { clearIdentity, loadIdentity, saveIdentity } from './identity.js';

let socket = null;
let currentTargetUrl = null;
let pendingConnectContext = null;
let lastResyncAt = 0;
let resyncBound = false;

/** moveId -> { started: performance.now() } for the sync-latency readout. */
const pendingMoves = new Map();

/**
 * Autosave transport: the protocol runs over `autosave:commit` with an ack.
 * Installed once at module load so the engine can batch edits even before a
 * component mounts.
 */
setAutosaveTransport((payload) => emitWithAck(EVENTS.AUTOSAVE_COMMIT, payload, 6000));

/** Persist the raw reconnect token locally; SQLite only keeps its hash. */
function rememberIdentity(welcome) {
  if (!welcome?.playerId || !welcome?.reconnectToken) return null;
  const identity = saveIdentity({
    playerId: welcome.playerId,
    reconnectToken: welcome.reconnectToken,
    displayName: welcome.displayName,
    role: welcome.role,
    sessionId: welcome.sessionId,
  });
  if (pendingConnectContext) {
    pendingConnectContext.playerId = welcome.playerId;
    pendingConnectContext.reconnectToken = welcome.reconnectToken;
    pendingConnectContext.identity = identity;
  }
  return identity;
}

function createMessageId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `mv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  );
}

function recordMoveLatency(moveId) {
  if (!moveId) return;
  const pending = pendingMoves.get(moveId);
  if (!pending) return;
  pendingMoves.delete(moveId);
  sessionStore.getState().setMoveLatency(performance.now() - pending.started);
}

/**
 * Resolve a server-relative asset path against the active host origin.
 * Keeps `/assets/maps/...` working in dev (Vite :5173) and packaged file://.
 */
export function resolveAssetUrl(assetPath) {
  if (!assetPath) return null;
  if (/^(https?:|data:|blob:)/i.test(assetPath)) return assetPath;

  const base =
    currentTargetUrl ||
    socket?.io?.uri ||
    (typeof window !== 'undefined' ? window.location?.origin : null);
  if (!base) return assetPath;
  const normalizedBase = String(base).replace(/\/+$/, '');
  const normalizedPath = assetPath.startsWith('/') ? assetPath : `/${assetPath}`;
  return `${normalizedBase}${normalizedPath}`;
}

/**
 * Normalizes a host/IP/URL and port into a valid HTTP URL for Socket.IO.
 * @param {string | { url?: string, host?: string, port?: number | string }} [input]
 * @returns {string | null}
 */
export function resolveTargetUrl(input) {
  if (!input) return null;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `http://${trimmed}`;
  }
  if (typeof input === 'object') {
    if (typeof input.url === 'string' && input.url.trim()) {
      return resolveTargetUrl(input.url);
    }
    if (typeof input.host === 'string' && input.host.trim()) {
      const host = input.host.trim().replace(/^https?:\/\//i, '');
      const port = Number(input.port) || DEFAULT_PORT;
      return `http://${host}:${port}`;
    }
  }
  return null;
}

/**
 * Removes all registered listeners from the active socket and its Manager.
 * @param {import('socket.io-client').Socket | null} sock
 */
function detachListeners(sock) {
  if (!sock) return;
  sock.off('connect');
  sock.off('disconnect');
  sock.off('connect_error');
  sock.off(EVENTS.SESSION_WELCOME);
  sock.off(EVENTS.SESSION_PARTICIPANT_JOINED);
  sock.off(EVENTS.SESSION_PARTICIPANT_LEFT);
  sock.off(EVENTS.SESSION_PARTICIPANTS_UPDATE);
  sock.off(EVENTS.SESSION_ERROR);
  sock.off(EVENTS.SERVER_SHUTDOWN);
  sock.off(EVENTS.SESSION_STATE);
  sock.off(EVENTS.TOKEN_MOVED);
  sock.off(EVENTS.TOKEN_CREATED);
  sock.off(EVENTS.TOKEN_UPDATED);
  sock.off(EVENTS.TOKEN_DELETED);
  sock.off(EVENTS.DICE_ROLLED);
  sock.off(EVENTS.AUTOSAVE_SAVED);
  sock.off(EVENTS.AUTOSAVE_ERROR);

  if (sock.io) {
    sock.io.off('reconnect_attempt');
    sock.io.off('reconnect');
    sock.io.off('reconnect_error');
    sock.io.off('reconnect_failed');
  }
}

/**
 * Returns the active Socket.IO client instance, if any.
 */
export function getSocket() {
  return socket;
}

/**
 * Intentionally closes the active client connection and releases all listeners.
 *
 * `forgetIdentity` is only set for an explicit "leave table": preview toggles
 * and transient disconnects must keep the reconnect token so the player can
 * resume after an app restart.
 *
 * @param {{ forgetIdentity?: boolean }} [options]
 */
export function disconnect({ forgetIdentity = false } = {}) {
  unbindChat();
  try {
    if (forgetIdentity) {
      autosave.flush().catch(() => {});
      autosave.discard();
      clearIdentity();
    } else {
      autosave.suspend();
    }
  } catch {
    // Never let autosave bookkeeping block a disconnect.
  }

  if (socket) {
    detachListeners(socket);
    try {
      socket.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    socket = null;
  }
  currentTargetUrl = null;
  pendingConnectContext = null;
  pendingMoves.clear();

  const state = sessionStore.getState();
  state.setConnection(CONNECTION_STATUS.DISCONNECTED, null);
  state.resetSession();
}

/**
 * Sends a session join (or identity restoration) request and waits for server acknowledgment.
 *
 * @param {{
 *   sessionId?: string,
 *   displayName?: string,
 *   role?: string,
 *   hostToken?: string,
 *   playerId?: string,
 *   reconnectToken?: string,
 *   timeoutMs?: number,
 * }} [params]
 * @returns {Promise<{ success: boolean, welcome?: object, code?: string, error?: string }>}
 */
export function joinSession(params = {}) {
  if (!socket || !socket.connected) {
    return Promise.resolve({
      success: false,
      error: 'Cannot join session: socket is not connected.',
    });
  }

  const {
    sessionId = DEFAULT_SESSION_ID,
    displayName,
    role,
    hostToken,
    playerId,
    reconnectToken,
    timeoutMs = 8000,
  } = params;

  const payload = {
    sessionId,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(hostToken !== undefined ? { hostToken } : {}),
    ...(playerId !== undefined ? { playerId } : {}),
    ...(reconnectToken !== undefined ? { reconnectToken } : {}),
  };

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = 'Session join acknowledgment timed out.';
      sessionStore.getState().setConnection(CONNECTION_STATUS.CONNECTED, error);
      resolve({ success: false, error });
    }, timeoutMs);

    socket.emit(EVENTS.SESSION_JOIN, payload, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (response?.success && response.welcome) {
        sessionStore.getState().applyWelcome(response.welcome, {
          isHost: Boolean(hostToken),
        });
        rememberIdentity(response.welcome);
        resolve({ success: true, welcome: response.welcome });
      } else {
        const error = response?.error || 'Failed to join session.';
        sessionStore.getState().setConnection(CONNECTION_STATUS.CONNECTED, error);
        resolve({
          success: false,
          code: response?.code,
          error,
        });
      }
    });
  });
}

/**
 * Explicitly leaves the current session without necessarily closing the transport.
 */
export function leaveSession() {
  if (!socket || !socket.connected) {
    clearIdentity();
    sessionStore.getState().resetSession();
    return Promise.resolve({ success: true });
  }
  return new Promise((resolve) => {
    socket.emit(EVENTS.SESSION_LEAVE, {}, (res) => {
      clearIdentity();
      sessionStore.getState().resetSession();
      resolve(res ?? { success: true });
    });
  });
}

/**
 * Joins with the resolved identity, falling back to a fresh participant when
 * the host no longer recognizes it (database reset or a recreated session).
 *
 * @param {object} context `pendingConnectContext`
 */
async function joinWithIdentity(context) {
  const attempt = (identity) =>
    joinSession({
      sessionId: context.sessionId,
      displayName: context.displayName,
      role: context.role,
      hostToken: context.hostToken,
      playerId: identity?.playerId,
      reconnectToken: identity?.reconnectToken,
    });

  const identity = context.identity;
  const result = identity ? await attempt(identity) : await attempt(null);

  if (identity && !result.success) {
    const recoverable =
      result.code === 'E_UNAUTHORIZED_IDENTITY' ||
      result.code === 'E_DUPLICATE_SESSION_MEMBER' ||
      result.code === 'E_DUPLICATE_PLAYER_IDENTITY';

    if (recoverable) {
      clearIdentity();
      context.identity = null;
      context.playerId = undefined;
      context.reconnectToken = undefined;
      return attempt(null);
    }
  }

  return result;
}

/** Wakes the connection up on focus/online so a sleeping laptop resyncs fast. */
function bindResyncListeners() {
  if (resyncBound || typeof window === 'undefined') return;
  resyncBound = true;

  const resync = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (!socket?.connected) return;
    const now = Date.now();
    if (now - lastResyncAt < 2000) return;
    lastResyncAt = now;
    requestState().catch(() => {});
  };

  window.addEventListener('focus', resync);
  window.addEventListener('online', resync);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', resync);
  }
}

/**
 * Connects to the embedded backend (or a remote host URL/IP:port) and binds events to the Zustand store.
 *
 * @param {string | {
 *   url?: string,
 *   host?: string,
 *   port?: number | string,
 *   sessionId?: string,
 *   displayName?: string,
 *   role?: string,
 *   hostToken?: string,
 *   playerId?: string,
 *   reconnectToken?: string,
 *   autoJoin?: boolean,
 * }} [options]
 */
export async function connect(options) {
  const opts =
    typeof options === 'string'
      ? { url: options }
      : options && typeof options === 'object'
        ? { ...options }
        : {};

  const store = sessionStore.getState();

  let target = resolveTargetUrl(opts);
  let hostToken = opts.hostToken;
  let sessionId = opts.sessionId ?? DEFAULT_SESSION_ID;

  // If no explicit target URL/host was provided, query the Electron preload bridge
  if (!target && typeof window !== 'undefined' && window.hakton?.getServerInfo) {
    try {
      const info = await window.hakton.getServerInfo();
      store.setServerInfo(info);
      if (info?.url) {
        target = info.url;
        if (!hostToken && info.hostSecret && opts.role !== ROLES.PLAYER) {
          hostToken = info.hostSecret;
        }
        if (!opts.sessionId && info.sessionId) {
          sessionId = info.sessionId;
        }
      }
    } catch (err) {
      store.setConnection(
        CONNECTION_STATUS.FAILED,
        err?.message || 'Unable to query local host server status.',
      );
      return null;
    }
  }

  if (!target) {
    target = `http://127.0.0.1:${DEFAULT_PORT}`;
  }

  // Reuse existing socket if already connected/connecting to the exact same target
  if (socket && currentTargetUrl === target) {
    if (!socket.connected && !socket.active) {
      store.setConnection(CONNECTION_STATUS.CONNECTING, null);
      socket.connect();
    }
    return socket;
  }

  // If switching targets, clean up the previous socket instance first
  if (socket) {
    disconnect();
  }

  const requestedRole = opts.role ?? (hostToken ? ROLES.DM : ROLES.PLAYER);
  // Explicit identity args win, then the in-memory session, then the token
  // persisted in localStorage by a previous app run.
  const storedIdentity = loadIdentity();
  const memoryUser = sessionStore.getState().currentUser;
  const candidateIdentity =
    opts.playerId && opts.reconnectToken
      ? { playerId: opts.playerId, reconnectToken: opts.reconnectToken }
      : memoryUser?.id && memoryUser?.reconnectToken
        ? {
            playerId: memoryUser.id,
            reconnectToken: memoryUser.reconnectToken,
            displayName: memoryUser.displayName,
            role: memoryUser.role,
            sessionId: sessionStore.getState().session?.id,
          }
        : storedIdentity;

  const identity =
    candidateIdentity &&
    (!candidateIdentity.sessionId || candidateIdentity.sessionId === sessionId) &&
    (!candidateIdentity.role || candidateIdentity.role === requestedRole)
      ? candidateIdentity
      : null;

  currentTargetUrl = target;
  pendingConnectContext = {
    sessionId,
    displayName:
      opts.displayName ?? identity?.displayName ?? (hostToken ? 'Dungeon Master' : 'Adventurer'),
    role: requestedRole,
    hostToken,
    playerId: identity?.playerId,
    reconnectToken: identity?.reconnectToken,
    identity,
    autoJoin: opts.autoJoin !== false,
  };

  bindResyncListeners();

  store.setConnection(CONNECTION_STATUS.CONNECTING, null);

  socket = io(target, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 8,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 8000,
  });

  detachListeners(socket);
  bindChat(socket);

  socket.on('connect', async () => {
    const currentState = sessionStore.getState();
    currentState.setConnection(CONNECTION_STATUS.CONNECTED, null);

    const context = pendingConnectContext;
    if (!context?.autoJoin) return;

    // A transport reconnect must restore the identity we most recently joined
    // with, which may be newer than the token captured when connect() started.
    const savedUser = currentState.currentUser;
    if (savedUser?.id && savedUser?.reconnectToken) {
      context.identity = {
        playerId: savedUser.id,
        reconnectToken: savedUser.reconnectToken,
        displayName: savedUser.displayName,
        role: savedUser.role,
        sessionId: currentState.session?.id ?? context.sessionId,
      };
      context.displayName = savedUser.displayName ?? context.displayName;
      context.role = savedUser.role ?? context.role;
    }

    const result = await joinWithIdentity(context);
    if (result?.success) {
      autosave.resume();
      requestState();
    }
  });

  socket.on('disconnect', (reason) => {
    const s = sessionStore.getState();
    if (reason === 'io client disconnect') {
      s.setConnection(CONNECTION_STATUS.DISCONNECTED, null);
    } else if (socket?.active) {
      // Queue in-flight edits so they replay once the transport is back.
      autosave.suspend();
      s.setConnection(CONNECTION_STATUS.RECONNECTING, `Disconnected (${reason}). Reconnecting...`);
    } else {
      autosave.suspend();
      s.setConnection(CONNECTION_STATUS.DISCONNECTED, `Disconnected: ${reason}`);
    }
  });

  socket.on('connect_error', (err) => {
    const s = sessionStore.getState();
    const message = err?.message || 'Unable to reach host server.';
    if (socket?.active) {
      s.setConnection(CONNECTION_STATUS.RECONNECTING, message);
    } else {
      s.setConnection(CONNECTION_STATUS.FAILED, message);
    }
  });

  if (socket.io) {
    socket.io.on('reconnect_attempt', (attempt) => {
      sessionStore
        .getState()
        .setConnection(CONNECTION_STATUS.RECONNECTING, `Reconnecting (attempt ${attempt})...`);
    });

    socket.io.on('reconnect_failed', () => {
      sessionStore
        .getState()
        .setConnection(
          CONNECTION_STATUS.FAILED,
          'Reconnection failed after maximum attempts.',
        );
    });
  }

  socket.on(EVENTS.SESSION_WELCOME, (welcome) => {
    sessionStore.getState().applyWelcome(welcome, {
      isHost: Boolean(pendingConnectContext?.hostToken),
    });
    rememberIdentity(welcome);
    autosave.resume();
  });

  socket.on(EVENTS.SESSION_PARTICIPANT_JOINED, (participant) => {
    sessionStore.getState().upsertParticipant(participant);
  });

  socket.on(EVENTS.SESSION_PARTICIPANT_LEFT, (participant) => {
    sessionStore.getState().markParticipantLeft(participant);
  });

  socket.on(EVENTS.SESSION_PARTICIPANTS_UPDATE, (participants) => {
    sessionStore.getState().setParticipants(participants);
  });

  socket.on(EVENTS.SESSION_ERROR, (errPayload) => {
    const s = sessionStore.getState();
    s.setConnection(s.connection, errPayload?.error || 'Session error occurred.');
  });

  socket.on(EVENTS.SERVER_SHUTDOWN, (info) => {
    const s = sessionStore.getState();
    s.setConnection(
      CONNECTION_STATUS.DISCONNECTED,
      info?.reason || 'Host server has shut down.',
    );
  });

  // Existing board state listeners
  socket.on(EVENTS.SESSION_STATE, (snapshot) => {
    sessionStore.getState().applySnapshot(snapshot);
  });

  socket.on(EVENTS.TOKEN_MOVED, (payload = {}) => {
    const { id, x, y, moveId } = payload;
    if (typeof id !== 'string' || !Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    // A remote update must not yank a token out from under a local drag.
    if (canvasStore.getState().draggingIds.includes(id)) {
      recordMoveLatency(moveId);
      return;
    }
    sessionStore.getState().moveToken(id, x, y);
    recordMoveLatency(moveId);
  });

  socket.on(EVENTS.TOKEN_CREATED, (token) => {
    sessionStore.getState().upsertToken(token);
  });

  socket.on(EVENTS.TOKEN_UPDATED, (token) => {
    sessionStore.getState().upsertToken(token);
  });

  socket.on(EVENTS.TOKEN_DELETED, ({ id } = {}) => {
    if (typeof id === 'string') sessionStore.getState().removeToken(id);
  });

  // Remote/confirmed dice roll listener: records the rolled numbers in the log without
  // spawning 3D dice on remote clients (3D physics simulation is strictly client-sided).
  socket.on(EVENTS.DICE_ROLLED, (record) => {
    sessionStore.getState().appendRollRecord(record);
  });

  // Peer autosave broadcasts (DM sees player edits, players see shared docs).
  socket.on(EVENTS.AUTOSAVE_SAVED, (payload) => {
    sessionStore.getState().applyAutosaveSaved(payload);
  });

  return socket;
}

/**
 * Asks the host for a fresh authoritative snapshot. Used after reconnects and
 * when the window regains focus, so late edits and peer changes are not missed.
 *
 * @returns {Promise<{ ok: boolean, reason?: string, state?: object }>}
 */
export function requestState() {
  const active = socket;
  if (!active?.connected) return Promise.resolve({ ok: false, reason: 'disconnected' });

  // Flush pending edits first: a resync snapshot must not clobber them.
  const pending = autosave.hasPending() ? autosave.flush() : Promise.resolve();

  return pending
    .catch(() => {})
    .then(
      () =>
        new Promise((resolve) => {
          if (!active.connected) {
            resolve({ ok: false, reason: 'disconnected' });
            return;
          }
          active.timeout(5000).emit(EVENTS.STATE_REQUEST, {}, (error, response) => {
            if (error) {
              resolve({ ok: false, reason: 'timeout' });
              return;
            }
            if (response?.state) sessionStore.getState().applySnapshot(response.state);
            resolve(response ?? { ok: false, reason: 'no_response' });
          });
        }),
    );
}

/** Emit an event and resolve with the server ack (or a timeout result). */
function emitWithAck(event, payload, timeoutMs = 5000) {
  const active = socket;
  if (!active?.connected) {
    return Promise.resolve({ ok: false, reason: 'disconnected' });
  }
  return new Promise((resolve) => {
    active.timeout(timeoutMs).emit(event, payload, (error, response) => {
      if (error) {
        resolve({ ok: false, reason: 'timeout' });
        return;
      }
      resolve(response ?? { ok: false, reason: 'no_response' });
    });
  });
}

/**
 * Optimistic local update + `token:move` emit on drop.
 * The server persists first, then echoes authoritative coordinates to every
 * client (including this one) so all boards converge.
 */
export function emitTokenMove(id, x, y) {
  sessionStore.getState().moveToken(id, x, y);

  const active = socket;
  if (!active?.connected) return Promise.resolve({ ok: true, offline: true });

  const moveId = createMessageId();
  pendingMoves.set(moveId, { started: performance.now() });

  return new Promise((resolve) => {
    active.timeout(5000).emit(
      EVENTS.TOKEN_MOVE,
      { id, x, y, moveId },
      (error, response) => {
        if (error) {
          pendingMoves.delete(moveId);
          resolve({ ok: false, reason: 'timeout' });
          return;
        }
        if (!response?.ok && response?.token) {
          // Rejected (locked/not owned): snap back to authoritative coordinates.
          sessionStore
            .getState()
            .moveToken(id, response.token.x, response.token.y);
        }
        if (response?.ok) recordMoveLatency(moveId);
        pendingMoves.delete(moveId);
        resolve(response ?? { ok: false, reason: 'no_response' });
      },
    );
  });
}

/** DM-only: create a persisted token. */
export function createToken(token) {
  return emitWithAck(EVENTS.TOKEN_CREATE, token).then((response) => {
    if (response?.ok && response.token) {
      sessionStore.getState().upsertToken(response.token);
    }
    return response;
  });
}

/** DM-only: patch label/owner/locked/color. */
export function updateToken(id, patch) {
  return emitWithAck(EVENTS.TOKEN_UPDATE, { id, ...patch }).then((response) => {
    if (response?.ok && response.token) {
      sessionStore.getState().upsertToken(response.token);
    }
    return response;
  });
}

/** DM-only: remove a persisted token. */
export function deleteToken(id) {
  return emitWithAck(EVENTS.TOKEN_DELETE, { id }).then((response) => {
    if (response?.ok) sessionStore.getState().removeToken(id);
    return response;
  });
}

/**
 * Launches the client-side 3D physics roll animation, logs the roll locally,
 * and broadcasts the pre-determined outcome over Socket.IO for SQLite persistence
 * and peer chat synchronization.
 *
 * @param {import('../../shared/dice/roller.js').RollResult} roll
 * @param {{ senderName?: string, animate?: boolean }} [opts]
 * @returns {Promise<{ success: boolean, roll?: object, error?: string }>}
 */
export function emitDiceRoll(roll, { senderName, animate = true } = {}) {
  const store = sessionStore.getState();
  const resolvedName = senderName || store.currentUser?.displayName || 'Adventurer';

  if (animate) {
    store.startLocalRoll(roll, resolvedName);
  }
  store.appendRollRecord(
    {
      ...roll,
      senderName: resolvedName,
      createdAt: new Date().toISOString(),
    },
    resolvedName,
  );

  if (!socket || !socket.connected) {
    return Promise.resolve({ success: true, localOnly: true });
  }

  return new Promise((resolve) => {
    socket.emit(EVENTS.DICE_ROLL, roll, (ack) => {
      if (ack?.success && ack.roll) {
        store.appendRollRecord(ack.roll, resolvedName);
      }
      resolve(ack ?? { success: true });
    });
  });
}
