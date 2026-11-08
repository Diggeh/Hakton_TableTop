import { createCharacterModel } from './models/characters.js';
import { createCompendiumModel } from './models/compendium.js';
import { createChatModel } from './models/chat.js';
import { createDmRecordModel } from './models/dmRecords.js';
import { createAssetModel } from './models/assets.js';

/**
 * Repository layer: the ONLY place SQL lives. The backend consumes these
 * plain-object methods and never touches the better-sqlite3 handle.
 */
export function createRepositories(db) {
  const tokenColumns = 'id, map_id, label, x, y, owner_id, locked, color';

  const stmts = {
    insertCampaign: db.prepare('INSERT INTO campaigns (name) VALUES (?)'),
    firstMap: db.prepare('SELECT * FROM maps ORDER BY id LIMIT 1'),
    insertMap: db.prepare('INSERT INTO maps (campaign_id, name) VALUES (?, ?)'),
    setMapImage: db.prepare('UPDATE maps SET image_file = ? WHERE id = ?'),
    tokensByMap: db.prepare(
      `SELECT ${tokenColumns} FROM tokens WHERE map_id = ? ORDER BY rowid`,
    ),
    tokenById: db.prepare(`SELECT ${tokenColumns} FROM tokens WHERE id = ?`),
    insertToken: db.prepare(`
      INSERT INTO tokens (id, map_id, label, x, y, owner_id, locked, color)
      VALUES (@id, @mapId, @label, @x, @y, @ownerId, @locked, @color)`),
    upsertToken: db.prepare(`
      INSERT INTO tokens (id, map_id, label, x, y) VALUES (@id, @mapId, @label, @x, @y)
      ON CONFLICT(id) DO UPDATE SET x = excluded.x, y = excluded.y`),
    deleteToken: db.prepare('DELETE FROM tokens WHERE id = ?'),
    moveToken: db.prepare('UPDATE tokens SET x = @x, y = @y WHERE id = @id'),
  };

  return {
    characters: createCharacterModel(db),
    compendium: createCompendiumModel(db),
    chat: createChatModel(db),
    dmRecords: createDmRecordModel(db),
    assets: createAssetModel(db),
    maps: {
      first: () => stmts.firstMap.get() ?? null,
      /** Creates a campaign + map. Returns the map row. */
      createWithCampaign: (campaignName, mapName) =>
        db.transaction(() => {
          const { lastInsertRowid: campaignId } = stmts.insertCampaign.run(campaignName);
          const { lastInsertRowid: mapId } = stmts.insertMap.run(campaignId, mapName);
          return db.prepare('SELECT * FROM maps WHERE id = ?').get(mapId);
        })(),
      setImage: (mapId, fileName) =>
        stmts.setMapImage.run(fileName, mapId).changes > 0,
    },
    tokens: {
      listByMap: (mapId) => stmts.tokensByMap.all(mapId),
      get: (id) => stmts.tokenById.get(id) ?? null,
      upsert: (token) => stmts.upsertToken.run(token),
      create: ({
        id,
        mapId,
        label,
        x = 0,
        y = 0,
        ownerId = null,
        locked = false,
        color = null,
      }) => {
        stmts.insertToken.run({
          id,
          mapId,
          label,
          x,
          y,
          ownerId,
          locked: locked ? 1 : 0,
          color,
        });
        return stmts.tokenById.get(id);
      },
      update: (id, patch = {}) => {
        const columns = {
          label: 'label',
          ownerId: 'owner_id',
          locked: 'locked',
          color: 'color',
        };
        const fields = Object.keys(columns).filter((key) => key in patch);
        if (fields.length === 0) return stmts.tokenById.get(id) ?? null;

        const params = { id };
        for (const field of fields) {
          const value = patch[field];
          params[field] =
            field === 'locked' ? (value ? 1 : 0) : value === undefined ? null : value;
        }
        const assignments = fields
          .map((field) => `${columns[field]} = @${field}`)
          .join(', ');
        const result = db
          .prepare(`UPDATE tokens SET ${assignments} WHERE id = @id`)
          .run(params);
        return result.changes > 0 ? stmts.tokenById.get(id) : null;
      },
      delete: (id) => stmts.deleteToken.run(id).changes > 0,
      move: (id, x, y) => stmts.moveToken.run({ id, x, y }).changes > 0,
    },
  };
}
