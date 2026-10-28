const hydrate = (r) => (r ? { ...r, data: JSON.parse(r.data) } : null);

export function createDmRecordModel(db) {
  const upsert = db.prepare(`
    INSERT INTO dm_records (id, category, title, data, updated_at)
    VALUES (@id, @category, @title, @data, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET category = excluded.category, title = excluded.title,
      data = excluded.data, updated_at = excluded.updated_at`);
  const byId = db.prepare('SELECT * FROM dm_records WHERE id = ?');
  const byCategory = db.prepare('SELECT * FROM dm_records WHERE category = ? ORDER BY title');

  return {
    upsert(r) {
      upsert.run({ id: r.id, category: r.category, title: r.title, data: JSON.stringify(r.data ?? {}) });
      return hydrate(byId.get(r.id));
    },
    get: (id) => hydrate(byId.get(id)),
    listByCategory: (category) => byCategory.all(category).map(hydrate),
  };
}
