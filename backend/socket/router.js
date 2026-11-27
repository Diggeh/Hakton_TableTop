import crypto from 'node:crypto';
import { registerChatHandlers } from '../chat/handlers.js';
import { registerSoundboard } from './soundboard.js';
import { registerAutosaveHandlers } from '../autosave/handlers.js';
import { characterToWire, dmRecordToWire } from '../autosave/wire.js';
import {
  DEFAULT_GRID_SIZE,
  ERROR_CODES,
  EVENTS,
  MAX_GRID_SIZE,
  MIN_GRID_SIZE,
  ROLES,
} from '../../shared/events.js';
import { DICE_MESSAGE_TYPE, DICE_VISIBILITY } from '../../shared/dice/constants.js';
import { validateRollSubmission } from '../../shared/dice/validate.js';
import {
  canViewTokenHp,
  normalizeOwnerRole,
  sanitizeCombat,
  stripHiddenCombatFields,
} from '../../shared/combat.js';
import { sanitizeRulerPayload } from '../../shared/ruler.js';
import { SessionManager, sanitizeParticipant } from '../session/sessionManager.js';
import { announceVoicePeerLeft, registerVoiceHandlers } from '../voice/handlers.js';

const registeredServers = new WeakSet();
const CANVAS_COORD_LIMIT = 100000;

function sanitizeRotation(value) {
  const n = Number(value);
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : 0;
}

/**
 * Returns the Socket.IO room name for a given session ID.
 * @param {string} sessionId
 */
export function getSessionRoom(sessionId) {
  return `session:${sessionId}`;
}

function sanitizeLight(light) {
  if (!light || typeof light !== 'object') return null;
  const range = Number(light.range);
  const angle = Number(light.angle);
  const rotation = Number(light.rotation);
  return {
    enabled: Boolean(light.enabled),
    type: light.type === 'vision' ? 'vision' : 'torch',
    range: Number.isFinite(range) ? Math.max(5, Math.min(300, range)) : 30,
    angle: Number.isFinite(angle) ? Math.max(15, Math.min(360, angle)) : 90,
    rotation: Number.isFinite(rotation) ? rotation : 0,
  };
}

function parseTokenLight(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return sanitizeLight(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return sanitizeLight(raw);
}

function parseTokenCombat(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return sanitizeCombat(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return sanitizeCombat(raw);
}

/** Convert a SQLite token row into the wire shape consumed by the renderer. */
export function tokenToWire(token) {
  if (!token) return null;
  const isMap = Boolean(token.is_map ?? token.isMap);
  return {
    id: token.id,
    mapId: token.map_id ?? token.mapId ?? null,
    label: token.label,
    x: token.x,
    y: token.y,
    ownerId: token.owner_id ?? token.ownerId ?? null,
    ownerRole: normalizeOwnerRole(token.owner_role ?? token.ownerRole),
    locked: Boolean(token.locked),
    color: token.color ?? null,
    category: token.category || (isMap ? 'maps' : 'characters'),
    isMap,
    imageUrl: token.image_url ?? token.imageUrl ?? null,
    width: token.width ?? null,
    height: token.height ?? null,
    light: parseTokenLight(token.light),
    combat: parseTokenCombat(token.combat),
    rotation: sanitizeRotation(token.rotation),
  };
}

function parseSceneData(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = null;
    }
  }
  if (!obj || typeof obj !== 'object') {
    return { fogShapes: [], walls: [] };
  }
  return {
    fogShapes: Array.isArray(obj.fogShapes) ? obj.fogShapes : [],
    walls: Array.isArray(obj.walls) ? obj.walls : [],
  };
}

/** Convert a SQLite map row into the wire shape consumed by the renderer. */
export function mapToWire(map) {
  if (!map) return null;
  return {
    id: map.id,
    campaignId: map.campaign_id ?? map.campaignId ?? null,
    name: map.name,
    gridSize: map.grid_size ?? map.gridSize ?? DEFAULT_GRID_SIZE,
    width: map.width,
    height: map.height,
    imageUrl: map.image_file
      ? `/assets/maps/${encodeURIComponent(map.image_file)}`
      : null,
    sceneData: parseSceneData(map.scene_data ?? map.sceneData),
  };
}

/**
 * Authoritative snapshot for a joining/reconnecting client.
 *
 * Board documents and DM records are permission-filtered here, not in the UI.
 *
 * @param {ReturnType<typeof import('../../database/repositories.js').createRepositories>} repos
 * @param {{ role?: string, playerId?: string|null, campaignId?: number|string|null }} viewer
 */
export function buildStateSnapshot(repos, { role, playerId, campaignId: requestedCampaignId } = {}) {
  const map =
    (requestedCampaignId != null && repos?.maps?.activeForCampaign
      ? repos.maps.activeForCampaign(requestedCampaignId)
      : null) ??
    repos?.maps?.active?.() ??
    repos?.maps?.first?.() ??
    null;
  const campaignId = requestedCampaignId ?? map?.campaign_id ?? null;
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
  const rollHistory = repos?.chat?.diceHistoryFor
    ? repos.chat.diceHistoryFor(role, 100)
    : [];

  return {
    campaignId,
    map: mapToWire(map),
    maps: maps.map(mapToWire),
    tokens: tokens.map((t) => stripHiddenCombatFields(tokenToWire(t), role)),
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
    rollHistory,
    serverTime: new Date().toISOString(),
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function cellCentre(value, grid) {
  const size = grid > 0 ? grid : DEFAULT_GRID_SIZE;
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
  const sessionCampaignIds = new Map();

  const resolveActiveMap = (sessionId) => {
    const campaignId = sessionId ? sessionCampaignIds.get(sessionId) : null;
    if (campaignId != null && repos?.maps?.activeForCampaign) {
      return repos.maps.activeForCampaign(campaignId) ?? repos?.maps?.active?.() ?? repos?.maps?.first?.() ?? null;
    }
    return repos?.maps?.active?.() ?? repos?.maps?.first?.() ?? null;
  };

  io.on('connection', (socket) => {
    registerSoundboard(socket, { io, sessionManager, roomFor: getSessionRoom, library: opts.soundboard });
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
    socket.removeAllListeners(EVENTS.MAP_SELECT);
    socket.removeAllListeners(EVENTS.MAP_UPDATE);
    socket.removeAllListeners(EVENTS.MAP_DELETE);
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

    // P2P voice mesh signaling: Peer ID phone book only, audio never routes through the host.
    registerVoiceHandlers(io, socket, { sessionManager, roomFor: getSessionRoom });

    const roomForSocket = () =>
      socket.data.sessionId ? getSessionRoom(socket.data.sessionId) : null;

    const broadcast = (event, payload) => {
      const room = roomForSocket();
      if (room) io.to(room).emit(event, payload);
      else socket.broadcast.emit(event, payload);
    };

    const emitPerSocketRole = (event, buildPayload) => {
      const room = roomForSocket();
      const roomSockets = room ? io.sockets?.adapter?.rooms?.get?.(room) : null;
      if (roomSockets && io.sockets?.sockets) {
        for (const sid of roomSockets) {
          const peer = io.sockets.sockets.get(sid);
          if (peer) peer.emit(event, buildPayload(peer.data?.role));
        }
      } else {
        broadcast(event, buildPayload(socket.data.role));
      }
    };

    const broadcastTokenForRole = (event, fullWire) => {
      emitPerSocketRole(event, (viewerRole) =>
        stripHiddenCombatFields(fullWire, viewerRole),
      );
    };

    const resolveOwnerRole = (ownerId, explicitRole) => {
      if (ownerId) {
        const session = socket.data.sessionId
          ? sessionManager.getSession(socket.data.sessionId)
          : null;
        const participant = session?.participants?.get?.(ownerId) ?? null;
        const fromSession = normalizeOwnerRole(participant?.role);
        if (fromSession) return fromSession;
      }
      return normalizeOwnerRole(explicitRole);
    };

    const isDM = () => socket.data.role === ROLES.DM;
    const isJoined = () => Boolean(socket.data.playerId && socket.data.sessionId);

    const currentMap = () => resolveActiveMap(socket.data.sessionId);

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

      if (
        participant.role === ROLES.DM &&
        typeof payload.campaignKey === 'string' &&
        payload.campaignKey.trim() &&
        repos?.campaigns?.ensureByKey
      ) {
        const ensured = repos.campaigns.ensureByKey(
          payload.campaignKey.trim(),
          typeof payload.campaignName === 'string' ? payload.campaignName : undefined,
        );
        if (ensured?.campaign?.id != null) {
          sessionCampaignIds.set(session.id, ensured.campaign.id);
        }
      }

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
            campaignId: sessionCampaignIds.get(session.id) ?? null,
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
        campaignId: sessionCampaignIds.get(socket.data.sessionId) ?? null,
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
        socket.to(room).emit(EVENTS.RULER_CLEAR, {
          senderId: leaveResult.participant.id,
        });
        announceVoicePeerLeft(
          io,
          { sessionManager, roomFor: getSessionRoom },
          leaveResult,
        );
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
      const nextX = clamp(x, -CANVAS_COORD_LIMIT, CANVAS_COORD_LIMIT);
      const nextY = clamp(y, -CANVAS_COORD_LIMIT, CANVAS_COORD_LIMIT);

      if (!repos.tokens.move(id, nextX, nextY)) {
        respond({ ok: false, reason: 'move_failed' });
        return;
      }
      markBoardDirty(map, socket.data.playerId);

      const fullWire = tokenToWire(repos.tokens.get(id));
      const moveMeta = {
        moveId: typeof moveId === 'string' ? moveId : null,
        movedBy: socket.data.playerId,
        serverTime: Date.now(),
      };
      emitPerSocketRole(EVENTS.TOKEN_MOVED, (viewerRole) => ({
        ...stripHiddenCombatFields(fullWire, viewerRole),
        ...moveMeta,
      }));
      respond({ ok: true, token: stripHiddenCombatFields(fullWire, socket.data.role) });
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

      const grid = map.grid_size || DEFAULT_GRID_SIZE;
      const label =
        typeof payload.label === 'string' && payload.label.trim()
          ? payload.label.trim().slice(0, 40)
          : 'Token';
      const x = clamp(
        Number.isFinite(payload.x) ? payload.x : cellCentre(map.width / 2, grid),
        -CANVAS_COORD_LIMIT,
        CANVAS_COORD_LIMIT,
      );
      const y = clamp(
        Number.isFinite(payload.y) ? payload.y : cellCentre(map.height / 2, grid),
        -CANVAS_COORD_LIMIT,
        CANVAS_COORD_LIMIT,
      );
      const ownerId =
        typeof payload.ownerId === 'string' && payload.ownerId
          ? payload.ownerId
          : null;
      const ownerRole = resolveOwnerRole(ownerId, payload.ownerRole);

      const widthNum = Number(payload.width);
      const heightNum = Number(payload.height);
      const rawCat =
        typeof payload.category === 'string' ? payload.category.trim().toLowerCase() : '';
      const validCats = new Set(['characters', 'maps', 'props', 'attachments', 'scenes']);
      const category = validCats.has(rawCat)
        ? rawCat
        : Boolean(payload.isMap)
          ? 'maps'
          : 'characters';
      const token = repos.tokens.create({
        id: crypto.randomUUID(),
        mapId: map.id,
        label,
        x,
        y,
        ownerId,
        ownerRole,
        locked: Boolean(payload.locked),
        color: normalizeColor(payload.color),
        category,
        isMap: Boolean(payload.isMap),
        imageUrl:
          typeof payload.imageUrl === 'string' && payload.imageUrl.trim()
            ? payload.imageUrl.trim()
            : null,
        width: Number.isFinite(widthNum) && widthNum > 0 ? widthNum : null,
        height: Number.isFinite(heightNum) && heightNum > 0 ? heightNum : null,
        light: sanitizeLight(payload.light),
        combat: sanitizeCombat(payload.combat),
        rotation: sanitizeRotation(payload.rotation),
      });
      markBoardDirty(map, socket.data.playerId);

      const wire = tokenToWire(token);
      broadcastTokenForRole(EVENTS.TOKEN_CREATED, wire);
      respond({ ok: true, token: stripHiddenCombatFields(wire, socket.data.role) });
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
      if (!isJoined()) {
        respond({ ok: false, reason: 'forbidden' });
        return;
      }
      if (typeof payload.id !== 'string') {
        respond({ ok: false, reason: 'invalid_payload' });
        return;
      }

      const existing = repos.tokens.get?.(payload.id) ?? null;
      if (!existing) {
        respond({ ok: false, reason: 'not_found' });
        return;
      }
      const existingWire = tokenToWire(existing);

      if (!isDM()) {
        const hasForbiddenKeys =
          'locked' in payload ||
          'ownerId' in payload ||
          'ownerRole' in payload ||
          'isMap' in payload;
        const hasAllowedKeys =
          (typeof payload.label === 'string' && payload.label.trim().length > 0) ||
          'light' in payload ||
          'rotation' in payload ||
          'combat' in payload;
        const mayEditCombat =
          !('combat' in payload) ||
          (!existingWire.locked &&
            existingWire.ownerRole !== 'dm' &&
            (!existingWire.ownerId || existingWire.ownerId === socket.data.playerId));
        if (hasForbiddenKeys || !hasAllowedKeys || !mayEditCombat) {
          respond({ ok: false, reason: 'forbidden' });
          return;
        }
      }

      const patch = {};
      if (typeof payload.label === 'string' && payload.label.trim()) {
        patch.label = payload.label.trim().slice(0, 40);
      }
      if ('ownerId' in payload || 'ownerRole' in payload) {
        const nextOwnerId =
          'ownerId' in payload
            ? typeof payload.ownerId === 'string' && payload.ownerId
              ? payload.ownerId
              : null
            : existingWire.ownerId;
        if ('ownerId' in payload) patch.ownerId = nextOwnerId;
        patch.ownerRole = resolveOwnerRole(
          nextOwnerId,
          'ownerRole' in payload ? payload.ownerRole : undefined,
        );
      }
      if ('locked' in payload) patch.locked = Boolean(payload.locked);
      if ('color' in payload) patch.color = normalizeColor(payload.color);
      if ('category' in payload && typeof payload.category === 'string') {
        const cleanCat = payload.category.trim().toLowerCase();
        if (['characters', 'maps', 'props', 'attachments', 'scenes'].includes(cleanCat)) {
          patch.category = cleanCat;
        }
      }
      if ('light' in payload) patch.light = sanitizeLight(payload.light);
      if ('rotation' in payload) patch.rotation = sanitizeRotation(payload.rotation);
      if ('isMap' in payload) patch.isMap = Boolean(payload.isMap);
      if ('imageUrl' in payload) {
        patch.imageUrl =
          typeof payload.imageUrl === 'string' && payload.imageUrl.trim()
            ? payload.imageUrl.trim()
            : null;
      }
      if ('width' in payload) {
        const w = Number(payload.width);
        patch.width = Number.isFinite(w) && w > 0 ? w : null;
      }
      if ('height' in payload) {
        const h = Number(payload.height);
        patch.height = Number.isFinite(h) && h > 0 ? h : null;
      }
      if ('combat' in payload) {
        const sanitized = sanitizeCombat(payload.combat);
        if (!sanitized) {
          patch.combat = null;
        } else {
          const effectiveToken = {
            ...existingWire,
            ownerId: 'ownerId' in patch ? patch.ownerId : existingWire.ownerId,
            ownerRole: 'ownerRole' in patch ? patch.ownerRole : existingWire.ownerRole,
          };
          const viewerCanSeeHp = canViewTokenHp(effectiveToken, socket.data.role);
          patch.combat = viewerCanSeeHp
            ? sanitized
            : {
                ...sanitized,
                hp: existingWire.combat?.hp ?? null,
                maxHp: existingWire.combat?.maxHp ?? null,
                tempHp: existingWire.combat?.tempHp ?? 0,
              };
        }
      }

      const token = repos.tokens.update(payload.id, patch);
      if (!token) {
        respond({ ok: false, reason: 'not_found' });
        return;
      }
      markBoardDirty(currentMap(), socket.data.playerId);

      const wire = tokenToWire(token);
      broadcastTokenForRole(EVENTS.TOKEN_UPDATED, wire);

      if (repos?.characters?.listAll && ('label' in patch || 'imageUrl' in patch || 'color' in patch)) {
        const linked = repos.characters
          .listAll()
          .filter((c) => c.sheet_data?.tokenId === wire.id);
        for (const ch of linked) {
          const updatedChar = repos.characters.upsert({
            id: ch.id,
            ownerId: ch.owner_id,
            name: wire.label || ch.name,
            classLevel: ch.class_level ?? null,
            sheetData: {
              ...(ch.sheet_data ?? {}),
              tokenId: wire.id,
              imageUrl: wire.imageUrl ?? null,
              color: wire.color ?? ch.sheet_data?.color ?? '#adfcf9',
            },
            inventoryData: ch.inventory_data ?? {},
          });
          const charWire = characterToWire(updatedChar);
          const sessId = socket.data.sessionId;
          for (const peer of io.sockets.sockets.values()) {
            if (sessId && peer.data?.sessionId !== sessId) continue;
            if (peer.data?.role === ROLES.DM || peer.data?.playerId === charWire.ownerId) {
              peer.emit(EVENTS.CHARACTER_CREATED, charWire);
            }
          }
        }
      }

      respond({ ok: true, token: stripHiddenCombatFields(wire, socket.data.role) });
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

      const existing = repos.tokens.get?.(payload.id) ?? null;
      if (!existing) {
        respond({ ok: false, reason: 'not_found' });
        return;
      }
      if (Boolean(existing.locked)) {
        respond({ ok: false, reason: 'locked', token: tokenToWire(existing) });
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

    socket.on(EVENTS.MAP_SELECT, (payload = {}, maybeAck) => {
      const ack = typeof maybeAck === 'function' ? maybeAck : null;
      const respond = (response) => {
        if (ack) ack(response);
      };

      if (!repos?.maps?.setActive || !repos?.tokens?.listByMap) {
        respond({ ok: false, reason: 'board_unavailable' });
        return;
      }
      if (!isJoined() || !isDM()) {
        respond({ ok: false, reason: 'forbidden' });
        return;
      }

      const active = currentMap();
      const campaignId =
        active?.campaign_id ?? sessionCampaignIds.get(socket.data.sessionId) ?? null;
      if (campaignId == null) {
        respond({ ok: false, reason: 'no_campaign' });
        return;
      }

      let targetMap = null;
      let wasCreated = false;

      if (payload.mapId != null) {
        const candidate = repos.maps.get?.(payload.mapId) ?? null;
        if (candidate && candidate.campaign_id === campaignId) {
          targetMap = candidate;
        }
      }
      if (!targetMap && typeof payload.name === 'string' && payload.name.trim()) {
        targetMap = repos.maps.findByName?.(campaignId, payload.name.trim()) ?? null;
      }

      const reqWidth = Number(payload.width);
      const reqHeight = Number(payload.height);
      const reqGrid = Number(payload.gridSize);

      if (!targetMap && payload.createIfMissing !== false) {
        const cleanName =
          typeof payload.name === 'string' && payload.name.trim()
            ? payload.name.trim().slice(0, 80)
            : '';
        if (!cleanName) {
          respond({ ok: false, reason: 'invalid_payload' });
          return;
        }
        const activeScene = active ? parseSceneData(active.scene_data ?? active.sceneData) : null;
        const activeIsEmptyUntitled =
          active &&
          active.name === 'Untitled Scene' &&
          !active.image_file &&
          repos.tokens.listByMap(active.id).length === 0 &&
          activeScene.fogShapes.length === 0 &&
          activeScene.walls.length === 0;

        if (activeIsEmptyUntitled && repos.maps.update) {
          targetMap = repos.maps.update(active.id, {
            name: cleanName,
            ...(Number.isFinite(reqWidth) && reqWidth > 0 ? { width: reqWidth } : {}),
            ...(Number.isFinite(reqHeight) && reqHeight > 0 ? { height: reqHeight } : {}),
            ...(Number.isFinite(reqGrid) && reqGrid > 0 ? { gridSize: reqGrid } : {}),
          });
        } else if (repos.maps.create) {
          targetMap = repos.maps.create({
            campaignId,
            name: cleanName,
            ...(Number.isFinite(reqWidth) && reqWidth > 0 ? { width: reqWidth } : {}),
            ...(Number.isFinite(reqHeight) && reqHeight > 0 ? { height: reqHeight } : {}),
            ...(Number.isFinite(reqGrid) && reqGrid > 0 ? { gridSize: reqGrid } : {}),
          });
        }
        wasCreated = Boolean(targetMap);
      }

      if (!targetMap) {
        respond({ ok: false, reason: 'not_found' });
        return;
      }

      repos.maps.setActive(campaignId, targetMap.id);
      const tokens = repos.tokens.listByMap(targetMap.id);
      const maps = repos.maps.listByCampaign ? repos.maps.listByCampaign(campaignId) : [targetMap];
      markBoardDirty(targetMap, socket.data.playerId);

      const basePayload = {
        ok: true,
        map: mapToWire(targetMap),
        maps: maps.map(mapToWire),
        wasCreated,
      };
      const rawTokens = tokens.map(tokenToWire);
      emitPerSocketRole(EVENTS.MAP_SELECTED, (viewerRole) => ({
        ...basePayload,
        tokens: rawTokens.map((t) => stripHiddenCombatFields(t, viewerRole)),
      }));
      respond({
        ...basePayload,
        tokens: rawTokens.map((t) => stripHiddenCombatFields(t, socket.data.role)),
      });
    });

    socket.on(EVENTS.MAP_UPDATE, (payload = {}, maybeAck) => {
      const ack = typeof maybeAck === 'function' ? maybeAck : null;
      const respond = (response) => {
        if (ack) ack(response);
      };

      if (!repos?.maps?.update) {
        respond({ ok: false, reason: 'board_unavailable' });
        return;
      }
      if (!isJoined()) {
        respond({ ok: false, reason: 'forbidden' });
        return;
      }

      const active = currentMap();
      const targetId = payload.id ?? active?.id;
      const target = targetId != null ? repos.maps.get?.(targetId) ?? null : null;
      if (!target) {
        respond({ ok: false, reason: 'not_found' });
        return;
      }

      if (!isDM()) {
        respond({ ok: false, reason: 'forbidden' });
        return;
      }

      const patch = {};
      if (typeof payload.name === 'string' && payload.name.trim()) {
        patch.name = payload.name.trim().slice(0, 80);
      }
      if ('gridSize' in payload) {
        const g = Number(payload.gridSize);
        if (Number.isFinite(g) && g > 0) {
          patch.gridSize = clamp(Math.round(g), MIN_GRID_SIZE, MAX_GRID_SIZE);
        }
      }
      if ('width' in payload) {
        const w = Number(payload.width);
        if (Number.isFinite(w) && w > 0) patch.width = Math.round(w);
      }
      if ('height' in payload) {
        const h = Number(payload.height);
        if (Number.isFinite(h) && h > 0) patch.height = Math.round(h);
      }
      if ('sceneData' in payload && payload.sceneData && typeof payload.sceneData === 'object') {
        patch.sceneData = parseSceneData(payload.sceneData);
      }

      const updated = repos.maps.update(target.id, patch);
      if (!updated) {
        respond({ ok: false, reason: 'not_found' });
        return;
      }
      markBoardDirty(updated, socket.data.playerId);

      const wire = mapToWire(updated);
      broadcast(EVENTS.MAP_UPDATED, { map: wire });
      respond({ ok: true, map: wire });
    });

    socket.on(EVENTS.MAP_DELETE, (payload = {}, maybeAck) => {
      const ack = typeof maybeAck === 'function' ? maybeAck : null;
      const respond = (response) => {
        if (ack) ack(response);
      };

      if (!repos?.maps?.delete) {
        respond({ ok: false, reason: 'board_unavailable' });
        return;
      }
      if (!isJoined() || !isDM()) {
        respond({ ok: false, reason: 'forbidden' });
        return;
      }

      const active = currentMap();
      const campaignId =
        active?.campaign_id ?? sessionCampaignIds.get(socket.data.sessionId) ?? null;

      let target = null;
      if (payload.id != null) {
        const candidate = repos.maps.get?.(payload.id) ?? null;
        if (candidate && (campaignId == null || candidate.campaign_id === campaignId)) {
          target = candidate;
        }
      } else if (typeof payload.name === 'string' && payload.name.trim() && campaignId != null) {
        target = repos.maps.findByName?.(campaignId, payload.name.trim()) ?? null;
      }

      if (!target) {
        respond({ ok: false, reason: 'not_found' });
        return;
      }

      const { deleted, activeMap: nextActive } = repos.maps.delete(target.id);
      const maps =
        campaignId != null && repos.maps.listByCampaign
          ? repos.maps.listByCampaign(campaignId)
          : nextActive
            ? [nextActive]
            : [];
      const tokens = nextActive && repos.tokens?.listByMap ? repos.tokens.listByMap(nextActive.id) : [];
      if (nextActive) markBoardDirty(nextActive, socket.data.playerId);

      const basePayload = {
        ok: true,
        deleted,
        deletedId: target.id,
        map: mapToWire(nextActive),
        maps: maps.map(mapToWire),
      };
      const rawTokens = tokens.map(tokenToWire);
      emitPerSocketRole(EVENTS.MAP_DELETED, (viewerRole) => ({
        ...basePayload,
        tokens: rawTokens.map((t) => stripHiddenCombatFields(t, viewerRole)),
      }));
      respond({
        ...basePayload,
        tokens: rawTokens.map((t) => stripHiddenCombatFields(t, socket.data.role)),
      });
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

    socket.on(EVENTS.RULER_UPDATE, (rawPayload = {}) => {
      if (!isJoined()) return;
      const room = getSessionRoom(socket.data.sessionId);
      if (isDM() && rawPayload?.shared === false) {
        socket.to(room).emit(EVENTS.RULER_CLEAR, { senderId: socket.data.playerId });
        return;
      }
      const clean = sanitizeRulerPayload(rawPayload);
      if (!clean) return;
      socket.to(room).emit(EVENTS.RULER_UPDATE, {
        senderId: socket.data.playerId,
        senderName: socket.data.displayName || 'Adventurer',
        role: socket.data.role || ROLES.PLAYER,
        points: clean.points,
        mode: clean.mode,
        feetPerCell: clean.feetPerCell,
        color: clean.color,
      });
    });

    socket.on(EVENTS.RULER_CLEAR, () => {
      if (!isJoined()) return;
      const room = getSessionRoom(socket.data.sessionId);
      socket.to(room).emit(EVENTS.RULER_CLEAR, {
        senderId: socket.data.playerId,
      });
    });

    socket.on(EVENTS.CHARACTER_CREATE, (payload = {}, maybeAck) => {
      const ack = typeof maybeAck === 'function' ? maybeAck : null;
      const respond = (response) => {
        if (ack) ack(response);
      };

      if (!repos?.characters?.upsert || !repos?.tokens?.get) {
        respond({ ok: false, reason: 'storage_unavailable' });
        return;
      }
      if (!isJoined()) {
        respond({ ok: false, reason: 'forbidden' });
        return;
      }
      if (typeof payload?.tokenId !== 'string' || !payload.tokenId) {
        respond({ ok: false, reason: 'invalid_payload' });
        return;
      }

      const token = repos.tokens.get(payload.tokenId);
      if (!token) {
        respond({ ok: false, reason: 'not_found' });
        return;
      }
      const tokenCategory =
        token.category || (Boolean(token.is_map) ? 'maps' : 'characters');
      if (Boolean(token.is_map) || tokenCategory !== 'characters') {
        respond({ ok: false, reason: 'invalid_token' });
        return;
      }

      const existingAll = repos.characters.listAll?.() ?? [];
      if (existingAll.some((c) => c.sheet_data?.tokenId === token.id)) {
        respond({ ok: false, reason: 'already_exists' });
        return;
      }

      const dm = isDM();
      const callerId = socket.data.playerId;
      let targetOwnerId = callerId;
      let ownerName = socket.data.displayName || (dm ? 'DM' : 'Player');
      let ownerRole = dm ? ROLES.DM : ROLES.PLAYER;

      if (!dm) {
        if (!token.owner_id || token.owner_id !== callerId) {
          respond({ ok: false, reason: 'forbidden' });
          return;
        }
        if ((repos.characters.listByOwner?.(callerId) ?? []).length > 0) {
          respond({ ok: false, reason: 'limit_reached' });
          return;
        }
      } else if (token.owner_id && token.owner_role === ROLES.PLAYER) {
        if ((repos.characters.listByOwner?.(token.owner_id) ?? []).length > 0) {
          respond({ ok: false, reason: 'limit_reached' });
          return;
        }
        const sessionObj = sessionManager.getSession(socket.data.sessionId);
        const targetParticipant = sessionObj?.participants?.find(
          (p) => p.id === token.owner_id,
        );
        targetOwnerId = token.owner_id;
        ownerName = targetParticipant?.displayName || 'Player';
        ownerRole = ROLES.PLAYER;
      }

      const saved = repos.characters.upsert({
        id: `char_${crypto.randomUUID()}`,
        ownerId: targetOwnerId,
        name: token.label || 'Character',
        classLevel: null,
        sheetData: {
          tokenId: token.id,
          imageUrl: token.image_url ?? null,
          color: token.color ?? '#adfcf9',
          ownerName,
          ownerRole,
        },
        inventoryData: {},
      });
      const wire = characterToWire(saved);
      const sessId = socket.data.sessionId;
      for (const peer of io.sockets.sockets.values()) {
        if (sessId && peer.data?.sessionId !== sessId) continue;
        if (peer.data?.role === ROLES.DM || peer.data?.playerId === wire.ownerId) {
          peer.emit(EVENTS.CHARACTER_CREATED, wire);
        }
      }
      respond({ ok: true, character: wire });
    });

    socket.on(EVENTS.CHARACTER_DELETE, (payload = {}, maybeAck) => {
      const ack = typeof maybeAck === 'function' ? maybeAck : null;
      const respond = (response) => {
        if (ack) ack(response);
      };

      if (!repos?.characters?.get || !repos?.characters?.delete) {
        respond({ ok: false, reason: 'storage_unavailable' });
        return;
      }
      if (!isJoined()) {
        respond({ ok: false, reason: 'forbidden' });
        return;
      }
      if (typeof payload?.id !== 'string' || !payload.id) {
        respond({ ok: false, reason: 'invalid_payload' });
        return;
      }

      const existing = repos.characters.get(payload.id);
      if (!existing) {
        respond({ ok: false, reason: 'not_found' });
        return;
      }
      if (!isDM() && existing.owner_id !== socket.data.playerId) {
        respond({ ok: false, reason: 'forbidden' });
        return;
      }

      const ownerId = existing.owner_id;
      repos.characters.delete(existing.id);
      const sessId = socket.data.sessionId;
      for (const peer of io.sockets.sockets.values()) {
        if (sessId && peer.data?.sessionId !== sessId) continue;
        if (peer.data?.role === ROLES.DM || peer.data?.playerId === ownerId) {
          peer.emit(EVENTS.CHARACTER_DELETED, { id: existing.id });
        }
      }
      respond({ ok: true, id: existing.id });
    });

    socket.on('disconnect', (reason) => {
      const disconnectResult = sessionManager.handleDisconnect(socket.id);
      if (!disconnectResult) return;

      const room = getSessionRoom(disconnectResult.session.id);
      socket.to(room).emit(EVENTS.RULER_CLEAR, {
        senderId: disconnectResult.participant.id,
      });
      socket.to(room).emit(EVENTS.SESSION_PARTICIPANT_LEFT, {
        ...disconnectResult.participant,
        reason,
      });
      io.to(room).emit(EVENTS.SESSION_PARTICIPANTS_UPDATE, disconnectResult.participants);
      announceVoicePeerLeft(
        io,
        { sessionManager, roomFor: getSessionRoom },
        disconnectResult,
      );
    });
  });

  return sessionManager;
}
