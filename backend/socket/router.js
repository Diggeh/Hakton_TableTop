import crypto from 'node:crypto';
import { EVENTS, ROLES } from '../../shared/events.js';
import { SessionManager, sanitizeParticipant } from '../session/sessionManager.js';

const registeredServers = new WeakSet();

/**
 * Returns the Socket.IO room name for a given session ID.
 * @param {string} sessionId
 */
export function getSessionRoom(sessionId) {
  return `session:${sessionId}`;
}

/** Convert a SQLite token row into the wire shape consumed by the renderer. */
export function tokenToWire(token) {
  if (!token) return null;
  return {
    id: token.id,
    mapId: token.map_id ?? token.mapId ?? null,
    label: token.label,
    x: token.x,
    y: token.y,
    ownerId: token.owner_id ?? token.ownerId ?? null,
    locked: Boolean(token.locked),
    color: token.color ?? null,
  };
}

/** Convert a SQLite map row into the wire shape consumed by the renderer. */
export function mapToWire(map) {
  if (!map) return null;
  return {
    id: map.id,
    name: map.name,
    gridSize: map.grid_size ?? map.gridSize ?? 70,
    width: map.width,
    height: map.height,
    imageUrl: map.image_file
      ? `/assets/maps/${encodeURIComponent(map.image_file)}`
      : null,
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function cellCentre(value, grid) {
  const size = grid > 0 ? grid : 70;
  return Math.floor(value / size) * size + size / 2;
}

function normalizeColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
    ? value
    : null;
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
    socket.removeAllListeners(EVENTS.SESSION_JOIN);
    socket.removeAllListeners(EVENTS.SESSION_LEAVE);
    socket.removeAllListeners(EVENTS.TOKEN_MOVE);
    socket.removeAllListeners(EVENTS.TOKEN_CREATE);
    socket.removeAllListeners(EVENTS.TOKEN_UPDATE);
    socket.removeAllListeners(EVENTS.TOKEN_DELETE);

    const roomForSocket = () =>
      socket.data.sessionId ? getSessionRoom(socket.data.sessionId) : null;

    const broadcast = (event, payload) => {
      const room = roomForSocket();
      if (room) io.to(room).emit(event, payload);
      else socket.broadcast.emit(event, payload);
    };

    const isDM = () => socket.data.role === ROLES.DM;
    const isJoined = () => Boolean(socket.data.playerId && socket.data.sessionId);

    const currentMap = () => repos?.maps?.first?.() ?? null;

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

      // 3. Deliver the persisted board snapshot to the joining client.
      if (repos?.maps && repos?.tokens) {
        const map = repos.maps.first();
        socket.emit(EVENTS.SESSION_STATE, {
          map: mapToWire(map),
          tokens: map ? repos.tokens.listByMap(map.id).map(tokenToWire) : [],
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

    /**
     * Authoritative token movement:
     *  1. validate identity/ownership/lock
     *  2. persist synchronously to SQLite
     *  3. broadcast the persisted coordinates to every client (sender included)
     *  4. acknowledge so the sender can revert a rejected optimistic drag
     */
    socket.on(EVENTS.TOKEN_MOVE, (payload = {}, maybeAck) => {
      const ack = typeof maybeAck === 'function' ? maybeAck : null;
      const respond = (response) => {
        if (ack) ack(response);
      };

      if (!repos?.tokens?.get || !repos?.tokens?.move) {
        respond({ ok: false, reason: 'board_unavailable' });
        return;
      }
      if (!isJoined()) {
        respond({ ok: false, reason: 'not_joined' });
        return;
      }

      const { id, x, y, moveId } = payload;
      if (typeof id !== 'string' || !Number.isFinite(x) || !Number.isFinite(y)) {
        respond({ ok: false, reason: 'invalid_payload' });
        return;
      }

      const token = repos.tokens.get(id);
      if (!token) {
        respond({ ok: false, reason: 'not_found' });
        return;
      }

      const ownerId = token.owner_id ?? null;
      const locked = Boolean(token.locked);
      const mayMove =
        isDM() ||
        (!locked && (!ownerId || ownerId === socket.data.playerId));

      if (!mayMove) {
        respond({
          ok: false,
          reason: locked ? 'locked' : 'forbidden',
          token: tokenToWire(token),
        });
        return;
      }

      const map = currentMap();
      const maxX = map?.width ?? Number.POSITIVE_INFINITY;
      const maxY = map?.height ?? Number.POSITIVE_INFINITY;
      const nextX = clamp(x, 0, maxX);
      const nextY = clamp(y, 0, maxY);

      if (!repos.tokens.move(id, nextX, nextY)) {
        respond({ ok: false, reason: 'move_failed' });
        return;
      }

      const updated = tokenToWire(repos.tokens.get(id));
      broadcast(EVENTS.TOKEN_MOVED, {
        ...updated,
        moveId: typeof moveId === 'string' ? moveId : null,
        movedBy: socket.data.playerId,
        serverTime: Date.now(),
      });
      respond({ ok: true, token: updated });
    });

    socket.on(EVENTS.TOKEN_CREATE, (payload = {}, maybeAck) => {
      const ack = typeof maybeAck === 'function' ? maybeAck : null;
      const respond = (response) => {
        if (ack) ack(response);
      };

      if (!repos?.tokens?.create) {
        respond({ ok: false, reason: 'board_unavailable' });
        return;
      }
      if (!isJoined() || !isDM()) {
        respond({ ok: false, reason: 'forbidden' });
        return;
      }

      const map = currentMap();
      if (!map) {
        respond({ ok: false, reason: 'no_map' });
        return;
      }

      const grid = map.grid_size || 70;
      const label =
        typeof payload.label === 'string' && payload.label.trim()
          ? payload.label.trim().slice(0, 40)
          : 'Token';
      const x = clamp(
        Number.isFinite(payload.x) ? payload.x : cellCentre(map.width / 2, grid),
        0,
        map.width,
      );
      const y = clamp(
        Number.isFinite(payload.y) ? payload.y : cellCentre(map.height / 2, grid),
        0,
        map.height,
      );
      const ownerId =
        typeof payload.ownerId === 'string' && payload.ownerId
          ? payload.ownerId
          : null;

      const token = repos.tokens.create({
        id: crypto.randomUUID(),
        mapId: map.id,
        label,
        x,
        y,
        ownerId,
        locked: Boolean(payload.locked),
        color: normalizeColor(payload.color),
      });

      const wire = tokenToWire(token);
      broadcast(EVENTS.TOKEN_CREATED, wire);
      respond({ ok: true, token: wire });
    });

    socket.on(EVENTS.TOKEN_UPDATE, (payload = {}, maybeAck) => {
      const ack = typeof maybeAck === 'function' ? maybeAck : null;
      const respond = (response) => {
        if (ack) ack(response);
      };

      if (!repos?.tokens?.update) {
        respond({ ok: false, reason: 'board_unavailable' });
        return;
      }
      if (!isJoined() || !isDM()) {
        respond({ ok: false, reason: 'forbidden' });
        return;
      }
      if (typeof payload.id !== 'string') {
        respond({ ok: false, reason: 'invalid_payload' });
        return;
      }

      const patch = {};
      if (typeof payload.label === 'string' && payload.label.trim()) {
        patch.label = payload.label.trim().slice(0, 40);
      }
      if ('ownerId' in payload) {
        patch.ownerId =
          typeof payload.ownerId === 'string' && payload.ownerId
            ? payload.ownerId
            : null;
      }
      if ('locked' in payload) patch.locked = Boolean(payload.locked);
      if ('color' in payload) patch.color = normalizeColor(payload.color);

      const token = repos.tokens.update(payload.id, patch);
      if (!token) {
        respond({ ok: false, reason: 'not_found' });
        return;
      }

      const wire = tokenToWire(token);
      broadcast(EVENTS.TOKEN_UPDATED, wire);
      respond({ ok: true, token: wire });
    });

    socket.on(EVENTS.TOKEN_DELETE, (payload = {}, maybeAck) => {
      const ack = typeof maybeAck === 'function' ? maybeAck : null;
      const respond = (response) => {
        if (ack) ack(response);
      };

      if (!repos?.tokens?.delete) {
        respond({ ok: false, reason: 'board_unavailable' });
        return;
      }
      if (!isJoined() || !isDM()) {
        respond({ ok: false, reason: 'forbidden' });
        return;
      }
      if (typeof payload.id !== 'string') {
        respond({ ok: false, reason: 'invalid_payload' });
        return;
      }

      if (!repos.tokens.delete(payload.id)) {
        respond({ ok: false, reason: 'not_found' });
        return;
      }

      broadcast(EVENTS.TOKEN_DELETED, { id: payload.id });
      respond({ ok: true, id: payload.id });
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
