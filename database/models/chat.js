const hydrate = (r) => ({ ...r, payload: JSON.parse(r.payload) });

export function createChatModel(db) {
  // The message id is the client-generated idempotency key. A retry must not
  // create a second row or leak another sender's message.
  const insert = db.prepare(`
    INSERT INTO chat_messages (id, sender_id, sender_name, recipient_id, type, payload)
    VALUES (@id, @senderId, @senderName, @recipientId, @type, @payload)
    ON CONFLICT(id) DO NOTHING`);
  const byId = db.prepare('SELECT * FROM chat_messages WHERE id = ?');
  const keyByParticipant = db.prepare(
    'SELECT public_key FROM whisper_public_keys WHERE session_id = ? AND participant_id = ?',
  );
  const insertKey = db.prepare(
    'INSERT INTO whisper_public_keys (session_id, participant_id, public_key) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
  );
  // Public messages + whispers the user sent or received, newest first.
  const recent = db.prepare(`
    SELECT * FROM chat_messages
    WHERE recipient_id IS NULL OR recipient_id = @userId OR sender_id = @userId
    ORDER BY created_at DESC, rowid DESC LIMIT @limit`);

  const publicHistory = db.prepare(`
    SELECT * FROM chat_messages
    WHERE recipient_id IS NULL AND type = 'text'
      AND json_extract(payload, '$.sessionId') = @sessionId
    ORDER BY created_at DESC, rowid DESC LIMIT @limit`);

  const sessionHistory = db.prepare(`
    SELECT id, sender_id, sender_name, recipient_id, type, created_at,
           json_remove(payload, '$.image', '$.encrypted.imageCiphertext') AS payload
    FROM chat_messages
    WHERE json_extract(payload, '$.sessionId') = @sessionId
      AND type IN ('text', 'whisper', 'image')
      AND (recipient_id IS NULL OR recipient_id = @userId OR sender_id = @userId)
    ORDER BY created_at DESC, rowid DESC LIMIT @limit`);

  return {
    whisperKey: (sessionId, participantId) =>
      keyByParticipant.get(sessionId, participantId)?.public_key ?? null,
    publishWhisperKey(sessionId, participantId, publicKey) {
      insertKey.run(sessionId, participantId, publicKey);
      return keyByParticipant.get(sessionId, participantId).public_key === publicKey;
    },
    historyForSession: (sessionId, userId, limit) =>
      sessionHistory.all({ sessionId, userId, limit }).reverse().map(hydrate),
    publicHistoryForSession: (sessionId, limit = 100) =>
      publicHistory
        .all({
          sessionId,
          limit: Math.max(
            1,
            Math.min(100, Number.isInteger(limit) ? limit : 100),
          ),
        })
        .reverse()
        .map(hydrate),
    /** Insert once; returns the stored row plus whether this call created it. */
    appendIfAbsent(m) {
      const result = insert.run({
        id: m.id,
        senderId: m.senderId,
        senderName: m.senderName,
        recipientId: m.recipientId ?? null,
        type: m.type,
        payload: JSON.stringify(m.payload ?? {}),
      });
      return {
        message: hydrate(byId.get(m.id)),
        inserted: result.changes > 0,
      };
    },
    append(m) {
      return this.appendIfAbsent(m).message;
    },
    get: (id) => {
      const row = byId.get(id);
      return row ? hydrate(row) : null;
    },
    /** History visible to `userId`, returned oldest-first for rendering. */
    historyFor: (userId, limit = 100) =>
      recent.all({ userId, limit }).reverse().map(hydrate),
  };
}
