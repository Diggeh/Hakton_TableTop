/**
 * Demo party seeded into `characters` so the sheet has real, autosavable rows.
 * `demo-dm` is a sentinel owner: only the DM may edit these until a player is
 * explicitly assigned ownership.
 */
export const DEMO_CHARACTERS = Object.freeze([
  {
    id: 'char-mira',
    ownerId: 'demo-dm',
    name: 'Mira',
    classLevel: 'Ranger 4',
    sheetData: {
      hp: { current: 28, max: 32 },
      ac: 15,
      speed: 30,
      detail: 'Half-elf ranger · Level 4',
      initials: 'MI',
      color: '#adfcf9',
      abilities: { str: 12, dex: 16, con: 14, int: 10, wis: 15, cha: 8 },
      inventory: [
        {
          group: 'Backpack',
          open: true,
          items: [
            { name: 'Rations', qty: '5 days' },
            { name: 'Rope', qty: '50 ft' },
          ],
        },
        {
          group: 'Bag of Holding',
          open: false,
          items: [{ name: 'Healing potion', qty: '2' }],
        },
      ],
    },
    inventoryData: {},
  },
  {
    id: 'char-thorne',
    ownerId: 'demo-dm',
    name: 'Thorne',
    classLevel: 'Paladin 4',
    sheetData: {
      hp: { current: 36, max: 36 },
      ac: 18,
      speed: 30,
      detail: 'Human paladin · Level 4',
      initials: 'TH',
      color: '#d7cba0',
      abilities: { str: 16, dex: 10, con: 15, int: 9, wis: 13, cha: 14 },
      inventory: [{ group: 'Backpack', open: true, items: [{ name: 'Shield', qty: '1' }] }],
    },
    inventoryData: {},
  },
  {
    id: 'char-ilyra',
    ownerId: 'demo-dm',
    name: 'Ilyra',
    classLevel: 'Wizard 4',
    sheetData: {
      hp: { current: 19, max: 24 },
      ac: 12,
      speed: 30,
      detail: 'Tiefling wizard · Level 4',
      initials: 'IL',
      color: '#b6bbdf',
      abilities: { str: 8, dex: 14, con: 13, int: 17, wis: 12, cha: 11 },
      inventory: [{ group: 'Backpack', open: true, items: [{ name: 'Spellbook', qty: '1' }] }],
    },
    inventoryData: {},
  },
]);

/**
 * Seeds a default campaign/map so a fresh install starts on a clean blank gridded
 * tabletop and backfills any missing demo character sheets.
 *
 * Idempotent: existing rows are never overwritten.
 */
export async function seedIfEmpty(repos) {
  if (!repos?.maps) return;

  const map = repos.maps.first();

  if (!map) {
    repos.maps.createWithCampaign('First Campaign', 'Untitled Scene');
  }

  if (repos.characters?.get) {
    for (const character of DEMO_CHARACTERS) {
      try {
        if (!repos.characters.get(character.id)) {
          repos.characters.upsert(character);
        }
      } catch (error) {
        console.warn(`[hakton] could not seed character ${character.id}:`, error.message);
      }
    }
  }
}
