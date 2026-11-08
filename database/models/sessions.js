function hydrateSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    hostPlayerId: row.host_player_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateParticipant(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    displayName: row.display_name,
    role: row.role,
    reconnectTokenHash: row.reconnect_token_hash,
    connected: Boolean(row.connected),
    joinedAt: row.joined_at,
    lastSeenAt: row.last_seen_at,
    leftAt: row.left_at ?? null,
  };
}

/**
 * Durable session + participant identity.
 *
 * Only the SHA-256 hash of a reconnect token is stored. The raw token lives on
 * the client (localStorage) and in memory while the host process runs.
 */
export function createSessionModel(db) {
  const upsertSessionStmt = db.prepare(`
    INSERT INTO sessions (id, name, host_player_id)
    VALUES (@id, @name, @hostPlayerId)
    ON CONFLICT(id) DO UPDATE SET
      name           = excluded.name,
      host_player_id = COALESCE(excluded.host_player_id, sessions.host_player_id),
      updated_at     = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  const sessionById = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const allSessions = db.prepare('SELECT * FROM sessions ORDER BY created_at');

  const upsertParticipantStmt = db.prepare(`
    INSERT INTO session_participants
      (id, session_id, display_name, role, reconnect_token_hash, connected, joined_at, last_seen_at, left_at)
    VALUES
      (@id, @sessionId, @displayName, @role, @reconnectTokenHash, @connected, @joinedAt, @lastSeenAt, @leftAt)
    ON CONFLICT(id) DO UPDATE SET
      display_name         = excluded.display_name,
      role                 = excluded.role,
      reconnect_token_hash = excluded.reconnect_token_hash,
      connected            = excluded.connected,
      last_seen_at         = excluded.last_seen_at,
      left_at              = excluded.left_at`);
  const participantsForSession = db.prepare(
    'SELECT * FROM session_participants WHERE session_id = ? ORDER BY joined_at',
  );
  const participantById = db.prepare('SELECT * FROM session_participants WHERE id = ?');
  const setConnectedStmt = db.prepare(
    'UPDATE session_participants SET connected = ?, last_seen_at = ? WHERE id = ?',
  );
  const markAllDisconnectedStmt = db.prepare(
    'UPDATE session_participants SET connected = 0, last_seen_at = ? WHERE connected = 1',
  );
  const markLeftStmt = db.prepare(
    'UPDATE session_participants SET connected = 0, left_at = ?, last_seen_at = ? WHERE id = ?',
  );
  const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE id = ?');

  return {
    upsertSession({ id, name, hostPlayerId = null }) {
      upsertSessionStmt.run({ id, name, hostPlayerId });
      return hydrateSession(sessionById.get(id));
    },
    getSession: (id) => hydrateSession(sessionById.get(id)),
    listSessions: () => allSessions.all().map(hydrateSession),

    upsertParticipant(p) {
      upsertParticipantStmt.run({
        id: p.id,
        sessionId: p.sessionId,
        displayName: p.displayName,
        role: p.role,
        reconnectTokenHash: p.reconnectTokenHash,
        connected: p.connected ? 1 : 0,
        joinedAt: p.joinedAt,
        lastSeenAt: p.lastSeenAt,
        leftAt: p.leftAt ?? null,
      });
      return hydrateParticipant(participantById.get(p.id));
    },
    getParticipant: (id) => hydrateParticipant(participantById.get(id)),
    listParticipants: (sessionId) =>
      participantsForSession.all(sessionId).map(hydrateParticipant),
    setConnected: (id, connected, at) =>
      setConnectedStmt.run(connected ? 1 : 0, at ?? new Date().toISOString(), id).changes > 0,
    markAllDisconnected: (at) =>
      markAllDisconnectedStmt.run(at ?? new Date().toISOString()).changes,
    markLeft: (id, at) => {
      const stamp = at ?? new Date().toISOString();
      return markLeftStmt.run(stamp, stamp, id).changes > 0;
    },
    removeSession: (id) => deleteSessionStmt.run(id).changes > 0,
  };
}
