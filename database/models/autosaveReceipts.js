/**
 * Idempotency receipts for autosave commits.
 *
 * A client retries with the same `saveId` after a dropped ack or an offline
 * replay. Returning the stored response keeps the operation exactly-once.
 */
export function createAutosaveReceiptModel(db) {
  const byId = db.prepare('SELECT * FROM autosave_receipts WHERE save_id = ?');
  const insert = db.prepare(
    'INSERT OR REPLACE INTO autosave_receipts (save_id, response) VALUES (?, ?)',
  );
  const prune = db.prepare(
    "DELETE FROM autosave_receipts WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)",
  );

  return {
    get(saveId) {
      const row = byId.get(saveId);
      if (!row) return null;
      try {
        return JSON.parse(row.response);
      } catch {
        return null;
      }
    },
    save(saveId, response) {
      insert.run(saveId, JSON.stringify(response ?? {}));
      return response;
    },
    /** Deletes receipts older than `days` (default 7). */
    prune: (days = 7) => prune.run(`-${Number(days) || 7} days`).changes,
  };
}
