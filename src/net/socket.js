import { io } from 'socket.io-client';
import {
  CONNECTION_STATUS,
  DEFAULT_PORT,
  DEFAULT_SESSION_ID,
  EVENTS,
  ROLES,
} from '../../shared/events.js';
import { sessionStore } from '../store/sessionStore.js';

let socket = null;
let currentTargetUrl = null;
let pendingConnectContext = null;

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
  sock.off(EVENTS.DICE_ROLLED);

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
 */
export function disconnect() {
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
    sessionStore.getState().resetSession();
    return Promise.resolve({ success: true });
  }
  return new Promise((resolve) => {
    socket.emit(EVENTS.SESSION_LEAVE, {}, (res) => {
      sessionStore.getState().resetSession();
      resolve(res ?? { success: true });
    });
  });
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

  currentTargetUrl = target;
  pendingConnectContext = {
    sessionId,
    displayName:
      opts.displayName ?? (hostToken ? 'Dungeon Master' : 'Adventurer'),
    role: opts.role ?? (hostToken ? ROLES.DM : ROLES.PLAYER),
    hostToken,
    playerId: opts.playerId,
    reconnectToken: opts.reconnectToken,
    autoJoin: opts.autoJoin !== false,
  };

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

  socket.on('connect', () => {
    const currentState = sessionStore.getState();
    currentState.setConnection(CONNECTION_STATUS.CONNECTED, null);

    if (!pendingConnectContext?.autoJoin) return;

    // If we previously joined a session and have a reconnectToken, restore that identity
    const savedUser = currentState.currentUser;
    const savedSession = currentState.session;

    if (savedUser?.id && savedUser?.reconnectToken) {
      joinSession({
        sessionId: savedSession?.id ?? pendingConnectContext.sessionId,
        displayName: savedUser.displayName,
        role: savedUser.role,
        hostToken: pendingConnectContext.hostToken,
        playerId: savedUser.id,
        reconnectToken: savedUser.reconnectToken,
      });
    } else {
      joinSession({
        sessionId: pendingConnectContext.sessionId,
        displayName: pendingConnectContext.displayName,
        role: pendingConnectContext.role,
        hostToken: pendingConnectContext.hostToken,
        playerId: pendingConnectContext.playerId,
        reconnectToken: pendingConnectContext.reconnectToken,
      });
    }
  });

  socket.on('disconnect', (reason) => {
    const s = sessionStore.getState();
    if (reason === 'io client disconnect') {
      s.setConnection(CONNECTION_STATUS.DISCONNECTED, null);
    } else if (socket?.active) {
      s.setConnection(CONNECTION_STATUS.RECONNECTING, `Disconnected (${reason}). Reconnecting...`);
    } else {
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

  socket.on(EVENTS.TOKEN_MOVED, ({ id, x, y } = {}) => {
    sessionStore.getState().moveToken(id, x, y);
  });

  // Remote/confirmed dice roll listener: records the rolled numbers in the log without
  // spawning 3D dice on remote clients (3D physics simulation is strictly client-sided).
  socket.on(EVENTS.DICE_ROLLED, (record) => {
    sessionStore.getState().appendRollRecord(record);
  });

  return socket;
}

/** Optimistic local update + broadcast. */
export function emitTokenMove(id, x, y) {
  sessionStore.getState().moveToken(id, x, y);
  socket?.emit(EVENTS.TOKEN_MOVE, { id, x, y });
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
