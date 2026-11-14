import { AUTOSAVE_KINDS } from '../../shared/events.js';

/** Builds the autosave document for a stored character row. */
export function characterDocument(character) {
  if (!character?.id) throw new TypeError('characterDocument requires a character id');
  return {
    kind: AUTOSAVE_KINDS.CHARACTER,
    scopeId: character.id,
    baseRevision: character.revision ?? null,
    data: {
      name: character.name,
      classLevel: character.classLevel ?? character.class_level ?? null,
      sheetData: character.sheetData ?? character.sheet_data ?? {},
      inventoryData: character.inventoryData ?? character.inventory_data ?? {},
    },
  };
}

/** Builds the autosave document for a DM record. */
export function dmRecordDocument(record) {
  if (!record?.id) throw new TypeError('dmRecordDocument requires a record id');
  return {
    kind: AUTOSAVE_KINDS.DM_RECORD,
    scopeId: record.id,
    baseRevision: record.revision ?? null,
    data: {
      category: record.category ?? 'session-notes',
      title: record.title ?? 'Session notes',
      content: record.data ?? {},
    },
  };
}

/** Stable DM-notes record id for a campaign. */
export function dmNotesRecordId(campaignId) {
  return `session-notes-${campaignId ?? 'default'}`;
}
