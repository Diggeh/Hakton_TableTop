/** Wire shapes for autosaved documents (camelCase; never leak SQL columns). */

export function characterToWire(character) {
  if (!character) return null;
  return {
    id: character.id,
    ownerId: character.owner_id ?? character.ownerId ?? null,
    name: character.name,
    classLevel: character.class_level ?? character.classLevel ?? null,
    sheetData: character.sheet_data ?? character.sheetData ?? {},
    inventoryData: character.inventory_data ?? character.inventoryData ?? {},
    revision: character.revision ?? 1,
    updatedAt: character.updated_at ?? character.updatedAt ?? null,
  };
}

export function dmRecordToWire(record) {
  if (!record) return null;
  return {
    id: record.id,
    category: record.category,
    title: record.title,
    data: record.data ?? {},
    revision: record.revision ?? 1,
    updatedAt: record.updated_at ?? record.updatedAt ?? null,
  };
}
