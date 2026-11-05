const hydrate = (r) => ({ ...r, payload: JSON.parse(r.payload) });

export function createChatModel(db) {
  // The message id is the client-generated idempotency key. A retry must not
  // create a second row or leak another sender's message.
  const insert = db.prepare(`
    INSERT INTO chat_messages (id, sender_id, sender_name, recipient_id, type, payload)
    VALUES (@id, @senderId, @senderName, @recipientId, @type, @payload)
    ON CONFLICT(id) DO NOTHING`);
  const byId = db.prepare('SELECT * FROM chat_messages WHERE id = ?');
  // Public messages + whispers the user sent or received, newest first.
  const recent = db.prepare(`
    SELECT * FROM chat_messages
    WHERE recipient_id IS NULL OR recipient_id = @userId OR sender_id = @userId
    ORDER BY created_at DESC, rowid DESC LIMIT @limit`);

  return {
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
    historyFor: (userId, limit = 100) => recent.all({ userId, limit }).reverse().map(hydrate),
  };
}
