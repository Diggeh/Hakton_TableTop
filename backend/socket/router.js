import crypto from 'node:crypto';
import { registerChatHandlers } from '../chat/handlers.js';
import { registerAutosaveHandlers } from '../autosave/handlers.js';
import { characterToWire, dmRecordToWire } from '../autosave/wire.js';
import { ERROR_CODES, EVENTS, ROLES } from '../../shared/events.js';
import { DICE_MESSAGE_TYPE, DICE_VISIBILITY } from '../../shared/dice/constants.js';
import { validateRollSubmission } from '../../shared/dice/validate.js';
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
    campaignId: map.campaign_id ?? map.campaignId ?? null,
    name: map.name,
    gridSize: map.grid_size ?? map.gridSize ?? 70,
    width: map.width,
    height: map.height,
    imageUrl: map.image_file
      ? `/assets/maps/${encodeURIComponent(map.image_file)}`
      : null,
  };
}

/**
 * Authoritative snapshot for a joining/reconnecting client.
 *
 * Board documents and DM records are permission-filtered here, not in the UI.
 *
 * @param {ReturnType<typeof import('../../database/repositories.js').createRepositories>} repos
 * @param {{ role?: string, playerId?: string|null }} viewer
 */
export function buildStateSnapshot(repos, { role, playerId } = {}) {
  const map = repos?.maps?.active?.() ?? repos?.maps?.first?.() ?? null;
  const campaignId = map?.campaign_id ?? null;
  const maps =
    campaignId !== null && repos?.maps?.listByCampaign
      ? repos.maps.listByCampaign(campaignId)
      : map
        ? [map]
        : [];
  const tokens = map && repos?.tokens ? repos.tokens.listByMap(map.id) : [];
  const board =
    campaignId !== null && repos?.board?.get ? repos.board.get(campaignId) : null;

  const isDM = role === ROLES.DM;
  let characters = [];
  if (repos?.characters) {
    characters = isDM
      ? repos.characters.listAll?.() ?? []
      : repos.characters.listByOwner?.(playerId) ?? [];
  }
  const dmRecords =
    isDM && repos?.dmRecords?.listAll ? repos.dmRecords.listAll() : [];

  return {
    campaignId,
    map: mapToWire(map),
    maps: maps.map(mapToWire),
    tokens: tokens.map(tokenToWire),
    board: board
      ? {
          campaignId,
          revision: board.revision,
          data: board.data,
          updatedAt: board.updatedAt,
        }
      : null,
    characters: characters.map(characterToWire),
    dmRecords: dmRecords.map(dmRecordToWire),
    serverTime: new Date().toISOString(),
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
    registerChatHandlers(io, socket, {
      repository: repos?.chat,
      sessionManager,
      roomFor: getSessionRoom,
    });
    socket.removeAllListeners(EVENTS.SESSION_JOIN);
    socket.removeAllListeners(EVENTS.SESSION_LEAVE);
    socket.removeAllListeners(EVENTS.TOKEN_MOVE);
    socket.removeAllListeners(EVENTS.TOKEN_CREATE);
    socket.removeAllListeners(EVENTS.TOKEN_UPDATE);
    socket.removeAllListeners(EVENTS.TOKEN_DELETE);
    socket.removeAllListeners(EVENTS.DICE_ROLL);
    socket.removeAllListeners(EVENTS.STATE_REQUEST);
    socket.removeAllListeners(EVENTS.AUTOSAVE_COMMIT);

    // Register autosave after the listener cleanup above, otherwise the cleanup
    // would remove the handler we just attached.
    registerAutosaveHandlers(io, socket, {
      repos,
      sessionManager,
      autosave: opts.autosave,
    });

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

    /** Queue a server-built board snapshot for the mutated campaign. */
    const markBoardDirty = (map, updatedBy) => {
      const campaignId = map?.campaign_id;
      if (campaignId === null || campaignId === undefined) return;
      try {
        opts.autosave?.markBoardDirty?.(campaignId, updatedBy ?? null);
      } catch {
        // Board checkpoints are derived state; never fail a mutation over them.
      }
    };

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
        socket.emit(
          EVENTS.SESSION_STATE,
          buildStateSnapshot(repos, {
            role: participant.role,
            playerId: participant.id,
          }),
        );
      }
    });

    // Reconnection resync. Cheap enough to call on focus, so it is rate-limited
    // per socket rather than trusted to the client.
    let stateWindowStart = 0;
    let stateRequestCount = 0;
    socket.on(EVENTS.STATE_REQUEST, (payload = {}, maybeAck) => {
      const ack = typeof maybeAck === 'function' ? maybeAck : null;
      const respond = (response) => {
        if (ack) ack(response);
      };

      if (!isJoined()) {
        respond({ ok: false, reason: 'not_joined' });
        return;
      }

      const now = Date.now();
      if (now - stateWindowStart > 5000) {
        stateWindowStart = now;
        stateRequestCount = 0;
      }
      stateRequestCount += 1;
      if (stateRequestCount > 5) {
        respond({ ok: false, reason: 'rate_limited' });
        return;
      }

      if (!repos?.maps) {
        respond({ ok: false, reason: 'state_unavailable' });
        return;
      }

      const state = buildStateSnapshot(repos, {
        role: socket.data.role,
        playerId: socket.data.playerId,
      });
      socket.emit(EVENTS.SESSION_STATE, state);
      respond({ ok: true, state });
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
      markBoardDirty(map, socket.data.playerId);

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
      markBoardDirty(map, socket.data.playerId);

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
      markBoardDirty(currentMap(), socket.data.playerId);

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
      markBoardDirty(currentMap(), socket.data.playerId);

      broadcast(EVENTS.TOKEN_DELETED, { id: payload.id });
      respond({ ok: true, id: payload.id });
    });

    socket.on(EVENTS.DICE_ROLL, (rawPayload, maybeAck) => {
      const ack =
        typeof rawPayload === 'function'
          ? rawPayload
          : typeof maybeAck === 'function'
            ? maybeAck
            : null;

      const validated = validateRollSubmission(rawPayload);
      if (!validated.ok) {
        const errorResponse = {
          success: false,
          code: ERROR_CODES.INVALID_PAYLOAD,
          error: validated.error,
        };
        if (ack) ack(errorResponse);
        socket.emit(EVENTS.SESSION_ERROR, errorResponse);
        return;
      }

      const { roll } = validated;
      const senderId = socket.data.playerId || 'local';
      const senderName = socket.data.displayName || 'Adventurer';
      const senderRole = socket.data.role || ROLES.PLAYER;
      const sessionId = socket.data.sessionId;

      let recipientId = null;
      if (roll.visibility === DICE_VISIBILITY.DM) {
        const session = sessionId ? sessionManager.getSession(sessionId) : null;
        let dmPlayerId = session?.hostPlayerId ?? null;
        if (!dmPlayerId && session) {
          for (const p of session.participants.values()) {
            if (p.role === ROLES.DM) {
              dmPlayerId = p.id;
              break;
            }
          }
        }
        recipientId = dmPlayerId || 'dm';
      }

      const messageId = `roll_${roll.clientRollId}`;
      const payload = {
        clientRollId: roll.clientRollId,
        formula: roll.formula,
        visibility: roll.visibility,
        label: roll.label,
        dice: roll.dice,
        modifier: roll.modifier,
        total: roll.total,
        senderRole,
      };

      let record;
      if (repos?.chat) {
        record = repos.chat.append({
          id: messageId,
          senderId,
          senderName,
          recipientId,
          type: DICE_MESSAGE_TYPE,
          payload,
        });
      } else {
        record = {
          id: messageId,
          sender_id: senderId,
          sender_name: senderName,
          recipient_id: recipientId,
          type: DICE_MESSAGE_TYPE,
          payload,
          created_at: new Date().toISOString(),
        };
      }

      if (roll.visibility === DICE_VISIBILITY.DM) {
        // Secret DM roll: emit ONLY to the rolling socket and to authorized DM sockets in the session.
        socket.emit(EVENTS.DICE_ROLLED, record);
        for (const peerSocket of io.sockets.sockets.values()) {
          if (
            peerSocket.id !== socket.id &&
            peerSocket.data?.role === ROLES.DM &&
            (!sessionId || peerSocket.data?.sessionId === sessionId)
          ) {
            peerSocket.emit(EVENTS.DICE_ROLLED, record);
          }
        }
      } else if (sessionId) {
        io.to(getSessionRoom(sessionId)).emit(EVENTS.DICE_ROLLED, record);
      } else {
        io.emit(EVENTS.DICE_ROLLED, record);
      }

      if (ack) {
        ack({ success: true, roll: record });
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
