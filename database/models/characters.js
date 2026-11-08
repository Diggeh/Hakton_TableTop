const parse = (s) => (s == null ? null : typeof s === 'string' ? JSON.parse(s) : s);

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    revision: row.revision ?? 1,
    sheet_data: parse(row.sheet_data),
    inventory_data: parse(row.inventory_data),
  };
}

/**
 * Character storage with revision-based optimistic concurrency.
 *
 * Every mutation bumps `revision`. Autosave sends the revision it last saw; if
 * the stored revision has moved on, the write is rejected and the caller gets
 * the current row back so it can refresh instead of clobbering another edit.
 */
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
      revision       = characters.revision + 1,
      updated_at     = excluded.updated_at`);
  const byId = db.prepare('SELECT * FROM characters WHERE id = ?');
  const byOwner = db.prepare('SELECT * FROM characters WHERE owner_id = ? ORDER BY name');
  const all = db.prepare('SELECT * FROM characters ORDER BY name');

  const updateWhole = db.prepare(`
    UPDATE characters SET
      owner_id       = @ownerId,
      name           = @name,
      class_level    = @classLevel,
      sheet_data     = @sheetData,
      inventory_data = @inventoryData,
      revision       = revision + 1,
      updated_at     = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = @id`);

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

    /**
     * Compare-and-swap save used by autosave.
     *
     * - `baseRevision == null` means "insert, or overwrite unconditionally".
     * - otherwise the stored revision must match exactly.
     *
     * @returns {{ conflict: false, character: object } | { conflict: true, current: object|null }}
     */
    saveWithRevision: db.transaction((input) => {
      const { id, baseRevision } = input ?? {};
      if (typeof id !== 'string' || !id) throw new TypeError('character save requires id');

      const existing = byId.get(id);
      if (!existing) {
        if (baseRevision !== null && baseRevision !== undefined) {
          return { conflict: true, current: null };
        }
        const created = {
          id,
          ownerId: input.ownerId ?? 'unassigned',
          name: input.name ?? id,
          classLevel: input.classLevel ?? null,
          sheetData: JSON.stringify(input.sheetData ?? {}),
          inventoryData: JSON.stringify(input.inventoryData ?? {}),
        };
        upsert.run(created);
        return { conflict: false, character: hydrate(byId.get(id)) };
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
        ownerId: input.ownerId ?? existing.owner_id,
        name: input.name ?? existing.name,
        classLevel: input.classLevel ?? existing.class_level,
        sheetData: JSON.stringify(input.sheetData ?? parse(existing.sheet_data) ?? {}),
        inventoryData: JSON.stringify(
          input.inventoryData ?? parse(existing.inventory_data) ?? {},
        ),
      });
      return { conflict: false, character: hydrate(byId.get(id)) };
    }),

    get: (id) => hydrate(byId.get(id)),
    listByOwner: (ownerId) => byOwner.all(ownerId).map(hydrate),
    listAll: () => all.all().map(hydrate),

    /** Partial in-place JSON edit via SQLite json_set, e.g. patchSheet(id, '$.hp.current', 12). */
    patchSheet(id, jsonPath, value) {
      return (
        db
          .prepare(`UPDATE characters SET sheet_data = json_set(sheet_data, ?, json(?)),
                    revision = revision + 1,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
          .run(jsonPath, JSON.stringify(value), id).changes > 0
      );
    },
  };
}
