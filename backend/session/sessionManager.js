import crypto from 'node:crypto';
import {
  DEFAULT_SESSION_ID,
  DEFAULT_SESSION_NAME,
  ERROR_CODES,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PEER_ID_LENGTH,
  MAX_SESSION_ID_LENGTH,
  MAX_VOICE_PEERS,
  ROLES,
} from '../../shared/events.js';

const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/;
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
/** PeerJS ids are opaque to the host; restrict to a safe, log-friendly alphabet. */
const PEER_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Validates a PeerJS peer identifier submitted for the voice mesh.
 * @param {unknown} rawPeerId
 * @returns {{ ok: true, value: string } | { ok: false, code: string, error: string }}
 */
export function validatePeerId(rawPeerId) {
  if (typeof rawPeerId !== 'string') {
    return {
      ok: false,
      code: ERROR_CODES.INVALID_PEER_ID,
      error: 'Peer ID must be a string.',
    };
  }
  const trimmed = rawPeerId.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_PEER_ID_LENGTH ||
    !PEER_ID_RE.test(trimmed)
  ) {
    return {
      ok: false,
      code: ERROR_CODES.INVALID_PEER_ID,
      error: `Peer ID must be 1-${MAX_PEER_ID_LENGTH} alphanumeric, hyphen, or underscore characters.`,
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Constant-time string comparison to prevent timing side-channel leaks
 * on host secrets and reconnection tokens.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function safeTokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Reconnect tokens are only ever persisted as a SHA-256 digest. */
function hashReconnectToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/**
 * Validates and normalizes a player display name.
 * @param {unknown} rawName
 * @returns {{ ok: true, value: string } | { ok: false, code: string, error: string }}
 */
export function validateDisplayName(rawName) {
  if (typeof rawName !== 'string') {
    return {
      ok: false,
      code: ERROR_CODES.INVALID_DISPLAY_NAME,
      error: 'Display name must be a non-empty string.',
    };
  }
  const trimmed = rawName.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    return {
      ok: false,
      code: ERROR_CODES.INVALID_DISPLAY_NAME,
      error: `Display name must be between 1 and ${MAX_DISPLAY_NAME_LENGTH} characters.`,
    };
  }
  if (CONTROL_CHARS_RE.test(trimmed)) {
    return {
      ok: false,
      code: ERROR_CODES.INVALID_DISPLAY_NAME,
      error: 'Display name contains invalid control characters.',
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validates a session identifier.
 * @param {unknown} rawSessionId
 * @returns {{ ok: true, value: string } | { ok: false, code: string, error: string }}
 */
export function validateSessionId(rawSessionId) {
  if (rawSessionId === undefined || rawSessionId === null) {
    return { ok: true, value: DEFAULT_SESSION_ID };
  }
  if (typeof rawSessionId !== 'string') {
    return {
      ok: false,
      code: ERROR_CODES.INVALID_SESSION,
      error: 'Session ID must be a string.',
    };
  }
  const trimmed = rawSessionId.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_SESSION_ID_LENGTH ||
    !SESSION_ID_RE.test(trimmed)
  ) {
    return {
      ok: false,
      code: ERROR_CODES.INVALID_SESSION,
      error: 'Session ID must be 1-64 alphanumeric, hyphen, or underscore characters.',
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Strips private fields (reconnectToken) before exposing a participant to clients.
 * @param {object} participant
 */
export function sanitizeParticipant(participant) {
  return {
    ...sanitizeParticipantBase(participant),
    // PeerJS ids are public by design (they are only useful to dial a mic), unlike reconnectToken.
    peerId: participant.peerId ?? null,
  };
}

function sanitizeParticipantBase(participant) {
  return {
    id: participant.id,
    displayName: participant.displayName,
    role: participant.role,
    sessionId: participant.sessionId,
    connected: Boolean(participant.connected),
    joinedAt: participant.joinedAt,
    lastSeenAt: participant.lastSeenAt,
  };
}

/**
 * Authoritative in-memory Session and Player Registry.
 * Decoupled from Socket.IO transport and SQLite persistence.
 */
export class SessionManager {
  /**
   * @param {{
   *   hostSecret?: string,
   *   defaultSessionId?: string,
   *   defaultSessionName?: string,
   *   persistence?: ReturnType<typeof import('../../database/models/sessions.js').createSessionModel>,
   * }} [opts]
   */
  constructor({
    hostSecret = crypto.randomBytes(32).toString('hex'),
    defaultSessionId = DEFAULT_SESSION_ID,
    defaultSessionName = DEFAULT_SESSION_NAME,
    persistence = null,
  } = {}) {
    this.hostSecret = hostSecret;
    this.defaultSessionId = defaultSessionId;
    /** Optional durable identity store (database/models/sessions.js). */
    this.persistence = persistence;
    /** @type {Map<string, { id: string, name: string, createdAt: string, hostPlayerId: string | null, participants: Map<string, object> }>} */
    this.sessions = new Map();
    /** @type {Map<string, { sessionId: string, playerId: string }>} */
    this.socketIndex = new Map();

    if (defaultSessionId) {
      this.createSession({ id: defaultSessionId, name: defaultSessionName });
    }
  }

  /**
   * Creates a new tabletop session if it does not already exist.
   * @param {{ id?: string, name?: string }} [opts]
   */
  createSession({ id = DEFAULT_SESSION_ID, name = DEFAULT_SESSION_NAME } = {}) {
    const check = validateSessionId(id);
    if (!check.ok) {
      throw new Error(check.error);
    }
    const sessionId = check.value;
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }
    const session = {
      id: sessionId,
      name: typeof name === 'string' && name.trim() ? name.trim() : DEFAULT_SESSION_NAME,
      createdAt: new Date().toISOString(),
      hostPlayerId: null,
      participants: new Map(),
    };
    this.sessions.set(sessionId, session);
    this.persistSession(session);
    return session;
  }

  /** Writes a session row. Best-effort: identity persistence must never break a join. */
  persistSession(session) {
    try {
      this.persistence?.upsertSession?.({
        id: session.id,
        name: session.name,
        hostPlayerId: session.hostPlayerId ?? null,
      });
    } catch {
      // Identity persistence is best-effort; the in-memory registry stays authoritative.
    }
  }

  /**
   * Writes a participant row with a hashed reconnect token.
   * @param {object} participant
   */
  persistParticipant(participant) {
    const persistence = this.persistence;
    if (!persistence?.upsertParticipant) return;

    const hash =
      participant.reconnectToken != null
        ? hashReconnectToken(participant.reconnectToken)
        : participant.reconnectTokenHash;
    if (!hash) return;
    participant.reconnectTokenHash = hash;

    try {
      persistence.upsertParticipant({
        id: participant.id,
        sessionId: participant.sessionId,
        displayName: participant.displayName,
        role: participant.role,
        reconnectTokenHash: hash,
        connected: Boolean(participant.connected),
        joinedAt: participant.joinedAt,
        lastSeenAt: participant.lastSeenAt,
        leftAt: null,
      });
    } catch {
      // Best-effort.
    }
  }

  /** Verifies a presented reconnect token against the raw token or its stored hash. */
  verifyReconnectToken(participant, presentedToken) {
    if (typeof presentedToken !== 'string' || presentedToken.length === 0) return false;
    if (typeof participant?.reconnectToken === 'string' && participant.reconnectToken) {
      return safeTokenEquals(presentedToken, participant.reconnectToken);
    }
    if (typeof participant?.reconnectTokenHash === 'string' && participant.reconnectTokenHash) {
      return safeTokenEquals(hashReconnectToken(presentedToken), participant.reconnectTokenHash);
    }
    return false;
  }

  /**
   * Loads persisted sessions and participants into memory. Everyone starts
   * disconnected: the rows describe identities, not live sockets.
   *
   * @returns {{ sessions: number, participants: number }}
   */
  hydrate() {
    const persistence = this.persistence;
    if (!persistence?.listSessions) return { sessions: 0, participants: 0 };

    let sessions = 0;
    let participants = 0;

    for (const stored of persistence.listSessions()) {
      let session = this.sessions.get(stored.id);
      if (!session) {
        session = {
          id: stored.id,
          name: stored.name,
          createdAt: stored.createdAt ?? new Date().toISOString(),
          hostPlayerId: stored.hostPlayerId ?? null,
          participants: new Map(),
        };
        this.sessions.set(stored.id, session);
        sessions += 1;
      } else if (stored.hostPlayerId && !session.hostPlayerId) {
        session.hostPlayerId = stored.hostPlayerId;
      }

      for (const row of persistence.listParticipants(stored.id)) {
        if (row.leftAt) continue;
        if (session.participants.has(row.id)) continue;
        session.participants.set(row.id, {
          id: row.id,
          displayName: row.displayName,
          role: row.role,
          sessionId: stored.id,
          socketId: null,
          connected: false,
          reconnectToken: undefined,
          reconnectTokenHash: row.reconnectTokenHash,
          joinedAt: row.joinedAt,
          lastSeenAt: row.lastSeenAt,
          disconnectedAt: null,
        });
        participants += 1;
      }
    }

    return { sessions, participants };
  }

  /**
   * Returns a session by ID or null if not found.
   * @param {string} sessionId
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Returns sanitized participant list for a session.
   * @param {string} sessionId
   */
  getSanitizedParticipants(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return Array.from(session.participants.values()).map(sanitizeParticipant);
  }

  /**
   * Returns only currently connected participants (sanitized) for a session.
   * @param {string} sessionId
   */
  getConnectedParticipants(sessionId) {
    return this.getSanitizedParticipants(sessionId).filter((p) => p.connected);
  }

  /**
   * Looks up the participant associated with a socket ID.
   * @param {string} socketId
   */
  getParticipantBySocket(socketId) {
    const ref = this.socketIndex.get(socketId);
    if (!ref) return null;
    const session = this.sessions.get(ref.sessionId);
    if (!session) return null;
    return session.participants.get(ref.playerId) ?? null;
  }

  /**
   * Validates and processes a session join or reconnection request.
   *
   * @param {{
   *   socketId: string,
   *   sessionId?: string,
   *   displayName?: string,
   *   role?: string,
   *   hostToken?: string,
   *   playerId?: string,
   *   reconnectToken?: string,
   * }} request
   */
  joinSession(request) {
    if (!request || typeof request !== 'object') {
      return {
        success: false,
        code: ERROR_CODES.INVALID_PAYLOAD,
        error: 'Join request payload must be an object.',
      };
    }

    const {
      socketId,
      sessionId: rawSessionId,
      displayName: rawDisplayName,
      role: requestedRole,
      hostToken,
      playerId: requestedPlayerId,
      reconnectToken,
    } = request;

    if (typeof socketId !== 'string' || !socketId.trim()) {
      return {
        success: false,
        code: ERROR_CODES.INVALID_PAYLOAD,
        error: 'Valid socketId is required.',
      };
    }

    // 1. Validate session ID and existence
    const sessionCheck = validateSessionId(rawSessionId);
    if (!sessionCheck.ok) {
      return {
        success: false,
        code: sessionCheck.code,
        error: sessionCheck.error,
      };
    }
    const session = this.sessions.get(sessionCheck.value);
    if (!session) {
      return {
        success: false,
        code: ERROR_CODES.SESSION_NOT_FOUND,
        error: `Session "${sessionCheck.value}" does not exist.`,
      };
    }

    // 2. Role validation & DM privilege protection
    if (
      requestedRole !== undefined &&
      requestedRole !== ROLES.DM &&
      requestedRole !== ROLES.PLAYER
    ) {
      return {
        success: false,
        code: ERROR_CODES.UNAUTHORIZED_ROLE,
        error: `Invalid role "${String(requestedRole)}".`,
      };
    }

    const hasValidHostToken = safeTokenEquals(hostToken, this.hostSecret);
    if (requestedRole === ROLES.DM && !hasValidHostToken) {
      return {
        success: false,
        code: ERROR_CODES.UNAUTHORIZED_ROLE,
        error: 'Unauthorized: DM privileges require a valid host authentication token.',
      };
    }

    // Determine effective role: only host with valid hostToken receives DM role
    const assignedRole =
      hasValidHostToken && (requestedRole === ROLES.DM || requestedRole === undefined)
        ? ROLES.DM
        : ROLES.PLAYER;

    // 3. Check if this socket is already registered in a session
    const existingSocketRef = this.socketIndex.get(socketId);
    if (existingSocketRef) {
      // If attempting to join again on the exact same active socket without explicit leave
      if (
        existingSocketRef.sessionId === session.id &&
        (!requestedPlayerId || existingSocketRef.playerId === requestedPlayerId)
      ) {
        return {
          success: false,
          code: ERROR_CODES.DUPLICATE_SESSION_MEMBER,
          error: 'Socket is already an active member of this session.',
        };
      }
      // Clean up previous membership if switching sessions
      this.leaveSession(socketId);
    }

    // 4. Identity Restoration (Reconnection flow)
    if (requestedPlayerId !== undefined || reconnectToken !== undefined) {
      if (typeof requestedPlayerId !== 'string' || !requestedPlayerId.trim()) {
        return {
          success: false,
          code: ERROR_CODES.UNAUTHORIZED_IDENTITY,
          error: 'Player ID is required when restoring a session identity.',
        };
      }

      const targetParticipant = session.participants.get(requestedPlayerId);
      if (!targetParticipant) {
        return {
          success: false,
          code: ERROR_CODES.UNAUTHORIZED_IDENTITY,
          error: 'Cannot restore identity: unknown player ID for this session.',
        };
      }

      if (!this.verifyReconnectToken(targetParticipant, reconnectToken)) {
        return {
          success: false,
          code: ERROR_CODES.UNAUTHORIZED_IDENTITY,
          error: 'Unauthorized: invalid or missing reconnection token for requested player ID.',
        };
      }

      // Prevent a player from escalating to DM on reconnect without hostToken
      if (requestedRole === ROLES.DM && targetParticipant.role !== ROLES.DM && !hasValidHostToken) {
        return {
          success: false,
          code: ERROR_CODES.UNAUTHORIZED_ROLE,
          error: 'Unauthorized: cannot escalate player identity to DM.',
        };
      }

      // Optional display name update on reconnect
      if (rawDisplayName !== undefined) {
        const nameCheck = validateDisplayName(rawDisplayName);
        if (!nameCheck.ok) {
          return {
            success: false,
            code: nameCheck.code,
            error: nameCheck.error,
          };
        }
        // Check name collision with other connected participants
        const normalizedNew = nameCheck.value.toLowerCase();
        for (const [otherId, other] of session.participants.entries()) {
          if (
            otherId !== targetParticipant.id &&
            other.connected &&
            other.displayName.toLowerCase() === normalizedNew
          ) {
            return {
              success: false,
              code: ERROR_CODES.DUPLICATE_PLAYER_IDENTITY,
              error: `Display name "${nameCheck.value}" is already in use by another active participant.`,
            };
          }
        }
        targetParticipant.displayName = nameCheck.value;
      }

      const previousSocketId = targetParticipant.socketId;
      if (previousSocketId && previousSocketId !== socketId) {
        this.socketIndex.delete(previousSocketId);
      }

      const now = new Date().toISOString();
      targetParticipant.socketId = socketId;
      targetParticipant.connected = true;
      targetParticipant.disconnectedAt = null;
      targetParticipant.lastSeenAt = now;
      // Keep the raw token in memory so welcome packets can echo it back; only
      // its hash ever reaches SQLite.
      targetParticipant.reconnectToken = reconnectToken;
      this.socketIndex.set(socketId, { sessionId: session.id, playerId: targetParticipant.id });
      this.persistParticipant(targetParticipant);

      return {
        success: true,
        isReconnection: true,
        previousSocketId,
        session,
        participant: targetParticipant,
        welcome: this.buildWelcomePacket(session, targetParticipant),
      };
    }

    // 5. New Participant Registration
    const effectiveRawName =
      rawDisplayName === undefined && assignedRole === ROLES.DM
        ? 'Dungeon Master'
        : rawDisplayName;

    const nameCheck = validateDisplayName(effectiveRawName);
    if (!nameCheck.ok) {
      return {
        success: false,
        code: nameCheck.code,
        error: nameCheck.error,
      };
    }
    const displayName = nameCheck.value;

    // If joining as DM and an existing DM entry exists for this host, allow seamless host re-bind
    if (assignedRole === ROLES.DM && session.hostPlayerId) {
      const existingDm = session.participants.get(session.hostPlayerId);
      if (existingDm) {
        if (existingDm.connected && existingDm.socketId && existingDm.socketId !== socketId) {
          return {
            success: false,
            code: ERROR_CODES.DUPLICATE_PLAYER_IDENTITY,
            error: 'A Dungeon Master is already actively connected to this session.',
          };
        }
        const previousSocketId = existingDm.socketId;
        if (previousSocketId) {
          this.socketIndex.delete(previousSocketId);
        }
        const now = new Date().toISOString();
        existingDm.displayName = displayName;
        existingDm.socketId = socketId;
        existingDm.connected = true;
        existingDm.disconnectedAt = null;
        existingDm.lastSeenAt = now;
        this.socketIndex.set(socketId, { sessionId: session.id, playerId: existingDm.id });
        this.persistParticipant(existingDm);
        this.persistSession(session);

        return {
          success: true,
          isReconnection: true,
          previousSocketId,
          session,
          participant: existingDm,
          welcome: this.buildWelcomePacket(session, existingDm),
        };
      }
    }

    // Check for duplicate active displayName among connected participants
    const normalizedName = displayName.toLowerCase();
    for (const participant of session.participants.values()) {
      if (participant.connected && participant.displayName.toLowerCase() === normalizedName) {
        return {
          success: false,
          code: ERROR_CODES.DUPLICATE_PLAYER_IDENTITY,
          error: `Display name "${displayName}" is already in use by an active participant.`,
        };
      }
    }

    const now = new Date().toISOString();
    const playerId = `p_${crypto.randomUUID()}`;
    const newReconnectToken = crypto.randomBytes(24).toString('hex');

    const participant = {
      id: playerId,
      displayName,
      role: assignedRole,
      sessionId: session.id,
      socketId,
      connected: true,
      reconnectToken: newReconnectToken,
      joinedAt: now,
      lastSeenAt: now,
      disconnectedAt: null,
    };

    session.participants.set(playerId, participant);
    if (assignedRole === ROLES.DM) {
      session.hostPlayerId = playerId;
    }
    this.socketIndex.set(socketId, { sessionId: session.id, playerId });
    this.persistParticipant(participant);
    if (assignedRole === ROLES.DM) this.persistSession(session);

    return {
      success: true,
      isReconnection: false,
      previousSocketId: null,
      session,
      participant,
      welcome: this.buildWelcomePacket(session, participant),
    };
  }

  /**
   * Builds the authoritative Welcome Packet for a joined/reconnected participant.
   * Contains strictly networking foundation fields (no character sheets, maps, tokens, or chat).
   *
   * @param {object} session
   * @param {object} participant
   */
  buildWelcomePacket(session, participant) {
    return {
      sessionId: session.id,
      sessionName: session.name,
      playerId: participant.id,
      displayName: participant.displayName,
      role: participant.role,
      reconnectToken: participant.reconnectToken,
      participants: this.getSanitizedParticipants(session.id),
      serverStatus: {
        status: 'running',
        version: '0.1.0',
        serverTime: new Date().toISOString(),
        sessionId: session.id,
        sessionName: session.name,
        activeParticipantCount: this.getConnectedParticipants(session.id).length,
      },
    };
  }

  /**
   * Marks a socket's participant as disconnected while retaining their identity record
   * so they can safely reconnect using their reconnectToken.
   *
   * @param {string} socketId
   */
  handleDisconnect(socketId) {
    const ref = this.socketIndex.get(socketId);
    if (!ref) return null;

    this.socketIndex.delete(socketId);
    const session = this.sessions.get(ref.sessionId);
    if (!session) return null;

    const participant = session.participants.get(ref.playerId);
    if (!participant) return null;

    // Only mark disconnected if this socket is still the active socket for the player
    let previousPeerId = null;
    if (participant.socketId === socketId) {
      const now = new Date().toISOString();
      previousPeerId = participant.peerId ?? null;
      participant.peerId = null;
      participant.connected = false;
      participant.socketId = null;
      participant.disconnectedAt = now;
      participant.lastSeenAt = now;
      try {
        this.persistence?.setConnected?.(participant.id, false, now);
      } catch {
        // Best-effort.
      }
    }

    return {
      session,
      previousPeerId,
      participant: sanitizeParticipant(participant),
      participants: this.getSanitizedParticipants(session.id),
    };
  }

  /**
   * Explicitly removes a participant from their session (intentional leave).
   *
   * @param {string} socketId
   */
  leaveSession(socketId) {
    const ref = this.socketIndex.get(socketId);
    if (!ref) return null;

    this.socketIndex.delete(socketId);
    const session = this.sessions.get(ref.sessionId);
    if (!session) return null;

    const participant = session.participants.get(ref.playerId);
    if (!participant) return null;

    const previousPeerId = participant.peerId ?? null;
    session.participants.delete(ref.playerId);
    if (session.hostPlayerId === ref.playerId) {
      session.hostPlayerId = null;
      this.persistSession(session);
    }
    try {
      this.persistence?.markLeft?.(ref.playerId, new Date().toISOString());
    } catch {
      // Best-effort.
    }

    return {
      session,
      previousPeerId,
      participant: {
        ...sanitizeParticipant(participant),
        connected: false,
      },
      participants: this.getSanitizedParticipants(session.id),
    };
  }

  /**
   * Resolves the live, connected participant bound to a socket (voice mesh helper).
   * @param {string} socketId
   */
  getActiveParticipant(socketId) {
    const ref = this.socketIndex.get(socketId);
    if (!ref) return null;
    const session = this.sessions.get(ref.sessionId);
    const participant = session?.participants.get(ref.playerId);
    if (!session || !participant) return null;
    if (!participant.connected || participant.socketId !== socketId) return null;
    return { session, participant };
  }

  /**
   * Public voice roster for a session: every connected participant that has registered a PeerJS id.
   * @param {string} sessionId
   * @returns {Array<{ peerId: string, playerId: string, displayName: string, role: string }>}
   */
  getVoicePeers(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return Array.from(session.participants.values())
      .filter((p) => p.connected && typeof p.peerId === 'string' && p.peerId)
      .map((p) => ({
        peerId: p.peerId,
        playerId: p.id,
        displayName: p.displayName,
        role: p.role,
      }));
  }

  /**
   * Binds a PeerJS id to the socket's participant and enforces the voice mesh cap.
   * Re-registering the same id is idempotent (`changed: false`); a new id replaces the old one.
   *
   * @param {{ socketId: string, peerId: unknown }} request
   */
  registerVoicePeer({ socketId, peerId } = {}) {
    const active = this.getActiveParticipant(socketId);
    if (!active) {
      return {
        success: false,
        code: ERROR_CODES.NOT_JOINED,
        error: 'Join a session before joining voice.',
      };
    }
    const { session, participant } = active;

    const check = validatePeerId(peerId);
    if (!check.ok) {
      return { success: false, code: check.code, error: check.error };
    }
    const nextPeerId = check.value;

    let occupiedSlots = 0;
    for (const other of session.participants.values()) {
      if (other.id === participant.id || !other.connected || !other.peerId) continue;
      if (other.peerId === nextPeerId) {
        return {
          success: false,
          code: ERROR_CODES.DUPLICATE_PEER_ID,
          error: 'Peer ID is already registered by another participant.',
        };
      }
      occupiedSlots += 1;
    }
    if (occupiedSlots >= MAX_VOICE_PEERS) {
      return {
        success: false,
        code: ERROR_CODES.VOICE_MESH_FULL,
        error: `Voice mesh is at maximum capacity (${MAX_VOICE_PEERS} peers).`,
      };
    }

    const previousPeerId = participant.peerId ?? null;
    participant.peerId = nextPeerId;

    return {
      success: true,
      changed: previousPeerId !== nextPeerId,
      previousPeerId,
      session,
      participant: sanitizeParticipant(participant),
      peers: this.getVoicePeers(session.id),
    };
  }

  /**
   * Releases the socket participant's voice slot without leaving the session.
   * @param {string} socketId
   * @returns {null | { session: object, participant: object, previousPeerId: string, peers: object[] }}
   */
  unregisterVoicePeer(socketId) {
    const active = this.getActiveParticipant(socketId);
    if (!active?.participant.peerId) return null;
    const { session, participant } = active;
    const previousPeerId = participant.peerId;
    participant.peerId = null;
    return {
      session,
      participant: sanitizeParticipant(participant),
      previousPeerId,
      peers: this.getVoicePeers(session.id),
    };
  }

  /**
   * Clears in-memory sessions and socket mappings (used during host shutdown).
   * Persisted identities are retained and marked disconnected so the next host
   * process can restore them.
   */
  clear() {
    try {
      this.persistence?.markAllDisconnected?.(new Date().toISOString());
    } catch {
      // Best-effort.
    }
    this.socketIndex.clear();
    this.sessions.clear();
  }
}
