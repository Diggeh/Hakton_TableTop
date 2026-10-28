const parse = (s) => (s == null ? null : JSON.parse(s));

function hydrate(row) {
  if (!row) return null;
  return { ...row, sheet_data: parse(row.sheet_data), inventory_data: parse(row.inventory_data) };
}

export function createCharacterModel(db) {
  const upsert = db.prepare(`
    INSERT INTO characters (id, owner_id, name, class_level, sheet_data, inventory_data, updated_at)
    VALUES (@id, @ownerId, @name, @classLevel, @sheetData, @inventoryData, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET
      owner_id       = excluded.owner_id,
      name           = excluded.name,
      class_level    = excluded.class_level,
      sheet_data     = excluded.sheet_data,
      inventory_data = excluded.inventory_data,
      updated_at     = excluded.updated_at`);
  const byId = db.prepare('SELECT * FROM characters WHERE id = ?');
  const byOwner = db.prepare('SELECT * FROM characters WHERE owner_id = ? ORDER BY name');

  return {
    /**
     * Insert or update a character. JSON fields are passed as objects and stringified here.
     * @param {{id:string, ownerId:string, name:string, classLevel?:string,
     *          sheetData?:object, inventoryData?:object}} c
     * @returns {object} the stored, hydrated row
     */
    upsert(c) {
      if (!c?.id || !c.ownerId || !c.name) throw new TypeError('character requires id, ownerId, name');
      upsert.run({
        id: c.id,
        ownerId: c.ownerId,
        name: c.name,
        classLevel: c.classLevel ?? null,
        sheetData: JSON.stringify(c.sheetData ?? {}),
        inventoryData: JSON.stringify(c.inventoryData ?? {}),
      });
      return hydrate(byId.get(c.id));
    },
    get: (id) => hydrate(byId.get(id)),
    listByOwner: (ownerId) => byOwner.all(ownerId).map(hydrate),
    /** Partial in-place JSON edit via SQLite json_set, e.g. patchSheet(id, '$.hp.current', 12). */
    patchSheet(id, jsonPath, value) {
      return (
        db
          .prepare(`UPDATE characters SET sheet_data = json_set(sheet_data, ?, json(?)),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
          .run(jsonPath, JSON.stringify(value), id).changes > 0
      );
    },
  };
}
