/**
 * Repository layer: the ONLY place SQL lives. The backend consumes these
 * plain-object methods and never touches the better-sqlite3 handle.
 */
export function createRepositories(db) {
  const stmts = {
    insertCampaign: db.prepare('INSERT INTO campaigns (name) VALUES (?)'),
    firstMap: db.prepare('SELECT * FROM maps ORDER BY id LIMIT 1'),
    insertMap: db.prepare('INSERT INTO maps (campaign_id, name) VALUES (?, ?)'),
    tokensByMap: db.prepare('SELECT id, label, x, y FROM tokens WHERE map_id = ?'),
    upsertToken: db.prepare(`
      INSERT INTO tokens (id, map_id, label, x, y) VALUES (@id, @mapId, @label, @x, @y)
      ON CONFLICT(id) DO UPDATE SET x = excluded.x, y = excluded.y`),
    moveToken: db.prepare('UPDATE tokens SET x = @x, y = @y WHERE id = @id'),
  };

  return {
    maps: {
      first: () => stmts.firstMap.get() ?? null,
      /** Creates a campaign + map. Returns the map row. */
      createWithCampaign: (campaignName, mapName) =>
        db.transaction(() => {
          const { lastInsertRowid: campaignId } = stmts.insertCampaign.run(campaignName);
          const { lastInsertRowid: mapId } = stmts.insertMap.run(campaignId, mapName);
          return db.prepare('SELECT * FROM maps WHERE id = ?').get(mapId);
        })(),
    },
    tokens: {
      listByMap: (mapId) => stmts.tokensByMap.all(mapId),
      upsert: (token) => stmts.upsertToken.run(token),
      move: (id, x, y) => stmts.moveToken.run({ id, x, y }).changes > 0,
    },
  };
}
