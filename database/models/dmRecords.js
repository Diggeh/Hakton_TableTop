const parse = (s) => (s == null ? {} : typeof s === 'string' ? JSON.parse(s) : s);

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    data: parse(row.data),
    revision: row.revision ?? 1,
    updated_at: row.updated_at,
    updatedAt: row.updated_at,
  };
}

/**
 * DM-only records (session notes, secrets). Writes use the same revision CAS as
 * character sheets so two DM windows cannot silently overwrite each other.
 */
export function createDmRecordModel(db) {
  const upsert = db.prepare(`
    INSERT INTO dm_records (id, category, title, data, updated_at)
    VALUES (@id, @category, @title, @data, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET category = excluded.category, title = excluded.title,
      data = excluded.data, revision = dm_records.revision + 1,
      updated_at = excluded.updated_at`);
  const byId = db.prepare('SELECT * FROM dm_records WHERE id = ?');
  const byCategory = db.prepare('SELECT * FROM dm_records WHERE category = ? ORDER BY title');
  const all = db.prepare('SELECT * FROM dm_records ORDER BY category, title');
  const updateWhole = db.prepare(`
    UPDATE dm_records SET
      category   = @category,
      title      = @title,
      data       = @data,
      revision   = revision + 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = @id`);

  return {
    upsert(r) {
      upsert.run({
        id: r.id,
        category: r.category,
        title: r.title,
        data: JSON.stringify(r.data ?? {}),
      });
      return hydrate(byId.get(r.id));
    },

    /**
     * Compare-and-swap save used by autosave.
     * @returns {{ conflict: false, record: object } | { conflict: true, current: object|null }}
     */
    saveWithRevision: db.transaction((input) => {
      const { id, baseRevision } = input ?? {};
      if (typeof id !== 'string' || !id) throw new TypeError('dm record save requires id');

      const existing = byId.get(id);
      if (!existing) {
        if (baseRevision !== null && baseRevision !== undefined) {
          return { conflict: true, current: null };
        }
        upsert.run({
          id,
          category: input.category ?? 'session-notes',
          title: input.title ?? 'Session notes',
          data: JSON.stringify(input.data ?? {}),
        });
        return { conflict: false, record: hydrate(byId.get(id)) };
      }

      if (
        baseRevision !== null &&
        baseRevision !== undefined &&
        Number(baseRevision) !== Number(existing.revision ?? 1)
      ) {
        return { conflict: true, current: hydrate(existing) };
      }

      updateWhole.run({
        id,
        category: input.category ?? existing.category,
        title: input.title ?? existing.title,
        data: JSON.stringify(input.data ?? parse(existing.data)),
      });
      return { conflict: false, record: hydrate(byId.get(id)) };
    }),

    get: (id) => hydrate(byId.get(id)),
    listByCategory: (category) => byCategory.all(category).map(hydrate),
    listAll: () => all.all().map(hydrate),
  };
}
