import { registerChatHandlers } from '../chat/handlers.js';
import { EVENTS } from '../../shared/events.js';
import { SessionManager, sanitizeParticipant } from '../session/sessionManager.js';

const registeredServers = new WeakSet();

/**
 * Returns the Socket.IO room name for a given session ID.
 * @param {string} sessionId
 */
export function getSessionRoom(sessionId) {
  return `session:${sessionId}`;
}

/**
 * Event routing layer. Validates input, delegates session/player logic to
 * `SessionManager`, manages Socket.IO rooms, and emits acknowledgments & broadcasts.
 *
 * @param {import('socket.io').Server} io
 * @param {ReturnType<typeof import('../../database/repositories.js').createRepositories>} [repos]
 * @param {{ sessionManager?: SessionManager, hostSecret?: string }} [opts]
 * @returns {SessionManager}
 */
export function registerSocketRouter(io, repos, opts = {}) {
  const sessionManager =
    opts.sessionManager ?? new SessionManager({ hostSecret: opts.hostSecret });

  if (registeredServers.has(io)) {
    return sessionManager;
  }
  registeredServers.add(io);

  io.on('connection', (socket) => {
    registerChatHandlers(io, socket, { repository: repos?.chat, sessionManager, roomFor: getSessionRoom });
    socket.removeAllListeners(EVENTS.SESSION_JOIN);
    socket.removeAllListeners(EVENTS.SESSION_LEAVE);
    socket.removeAllListeners(EVENTS.TOKEN_MOVE);

    socket.on(EVENTS.SESSION_JOIN, (rawPayload, maybeAck) => {
      const ack =
        typeof rawPayload === 'function'
          ? rawPayload
          : typeof maybeAck === 'function'
            ? maybeAck
            : null;
      const payload =
        typeof rawPayload === 'object' && rawPayload !== null ? rawPayload : {};

      const result = sessionManager.joinSession({
        ...payload,
        socketId: socket.id,
      });

      if (!result.success) {
        const errorResponse = {
          success: false,
          code: result.code,
          error: result.error,
        };
        if (ack) ack(errorResponse);
        socket.emit(EVENTS.SESSION_ERROR, errorResponse);
        return;
      }

      const { session, participant, welcome, previousSocketId } = result;
      const room = getSessionRoom(session.id);

      // Detach any stale socket previously bound to this player identity
      if (previousSocketId && previousSocketId !== socket.id) {
        const staleSocket = io.sockets.sockets.get(previousSocketId);
        if (staleSocket) {
          staleSocket.leave(room);
          staleSocket.data.playerId = null;
          staleSocket.data.sessionId = null;
          staleSocket.data.role = null;
        }
      }

      socket.join(room);
      socket.data.playerId = participant.id;
      socket.data.sessionId = session.id;
      socket.data.role = participant.role;
      socket.data.displayName = participant.displayName;

      // 1. Deliver authoritative Welcome Packet to joining client
      if (ack) {
        ack({ success: true, welcome });
      }
      socket.emit(EVENTS.SESSION_WELCOME, welcome);

      // 2. Notify session participants of join/reconnection and updated roster
      const publicParticipant = sanitizeParticipant(participant);
      socket.to(room).emit(EVENTS.SESSION_PARTICIPANT_JOINED, publicParticipant);
      io.to(room).emit(EVENTS.SESSION_PARTICIPANTS_UPDATE, welcome.participants);

      // 3. Preserve existing board state emission when repositories are attached
      if (repos?.maps && repos?.tokens) {
        const map = repos.maps.first();
        socket.emit(EVENTS.SESSION_STATE, {
          map:
            map && {
              id: map.id,
              name: map.name,
              gridSize: map.grid_size,
              width: map.width,
              height: map.height,
            },
          tokens: map ? repos.tokens.listByMap(map.id) : [],
        });
      }
    });

    socket.on(EVENTS.SESSION_LEAVE, (rawPayload, maybeAck) => {
      const ack =
        typeof rawPayload === 'function'
          ? rawPayload
          : typeof maybeAck === 'function'
            ? maybeAck
            : null;

      const leaveResult = sessionManager.leaveSession(socket.id);
      if (leaveResult) {
        const room = getSessionRoom(leaveResult.session.id);
        socket.leave(room);
        socket.data.playerId = null;
        socket.data.sessionId = null;
        socket.data.role = null;

        socket.to(room).emit(EVENTS.SESSION_PARTICIPANT_LEFT, leaveResult.participant);
        io.to(room).emit(EVENTS.SESSION_PARTICIPANTS_UPDATE, leaveResult.participants);
      }

      if (ack) {
        ack({ success: true });
      }
    });

    socket.on(EVENTS.TOKEN_MOVE, ({ id, x, y } = {}) => {
      if (typeof id !== 'string' || !Number.isFinite(x) || !Number.isFinite(y)) return;
      if (repos?.tokens?.move(id, x, y)) {
        const sessionId = socket.data.sessionId;
        if (sessionId) {
          socket.to(getSessionRoom(sessionId)).emit(EVENTS.TOKEN_MOVED, { id, x, y });
        } else {
          socket.broadcast.emit(EVENTS.TOKEN_MOVED, { id, x, y });
        }
      }
    });

    socket.on('disconnect', (reason) => {
      const disconnectResult = sessionManager.handleDisconnect(socket.id);
      if (!disconnectResult) return;

      const room = getSessionRoom(disconnectResult.session.id);
      socket.to(room).emit(EVENTS.SESSION_PARTICIPANT_LEFT, {
        ...disconnectResult.participant,
        reason,
      });
      io.to(room).emit(EVENTS.SESSION_PARTICIPANTS_UPDATE, disconnectResult.participants);
    });
  });

  return sessionManager;
}
