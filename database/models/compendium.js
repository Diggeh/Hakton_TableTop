/**
 * Turns raw user input into a safe FTS5 MATCH expression:
 * each term is quoted (neutralises operators/punctuation like - " * : ) and the
 * last term gets a prefix wildcard for search-as-you-type. Terms are AND-ed.
 */
export function toFtsQuery(input) {
  const terms = String(input ?? '')
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (!terms.length) return null;
  return terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(' ');
}

const parse = (s) => JSON.parse(s);

export function createCompendiumModel(db) {
  const insert = db.prepare(`
    INSERT INTO compendium_entries (id, source, category, name, data)
    VALUES (@id, @source, @category, @name, @data)
    ON CONFLICT(id) DO UPDATE SET
      source = excluded.source, category = excluded.category,
      name = excluded.name, data = excluded.data`);
  const byId = db.prepare('SELECT * FROM compendium_entries WHERE id = ?');

  // bm25() is lower = better; column weights follow fts5 column order: name, category, source.
  const search = db.prepare(`
    SELECT e.id, e.source, e.category, e.name, e.data,
           bm25(compendium_fts, 10.0, 2.0, 1.0) AS rank
    FROM compendium_fts
    JOIN compendium_entries e ON e.rowid = compendium_fts.rowid
    WHERE compendium_fts MATCH @q
      AND (@category IS NULL OR e.category = @category)
    ORDER BY rank
    LIMIT @limit OFFSET @offset`);

  const toRow = (e) => ({ ...e, data: typeof e.data === 'string' ? parse(e.data) : e.data });

  return {
    /** Single upsert; the FTS index is kept in sync by triggers. */
    upsert(e) {
      insert.run({ ...e, data: JSON.stringify(e.data ?? {}) });
    },
    /** Bulk import in ONE transaction (orders of magnitude faster for SRD-sized datasets). */
    bulkUpsert: db.transaction((entries) => {
      for (const e of entries) insert.run({ ...e, data: JSON.stringify(e.data ?? {}) });
      return entries.length;
    }),
    get: (id) => {
      const r = byId.get(id);
      return r ? toRow(r) : null;
    },
    /**
     * Ranked full-text search over name/category/source.
     * @param {string} text raw user input (sanitised internally)
     * @param {{category?:string, limit?:number, offset?:number}} [opts]
     */
    search(text, { category = null, limit = 20, offset = 0 } = {}) {
      const q = toFtsQuery(text);
      if (!q) return [];
      return search.all({ q, category, limit: Math.min(limit, 100), offset }).map(toRow);
    },
    /** Maintenance: rebuild the index from the content table (after bulk raw SQL edits). */
    rebuildIndex: () => db.exec("INSERT INTO compendium_fts(compendium_fts) VALUES ('rebuild')"),
  };
}
