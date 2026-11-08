import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_MAP = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'storage',
  'samples',
  'starter-map.svg',
);

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
 * Seeds a default campaign/map/tokens so a fresh install renders something.
 * Also installs the bundled sample battle map into lossless local storage and
 * backfills any missing demo character sheets.
 *
 * Idempotent: existing rows are never overwritten.
 */
export async function seedIfEmpty(repos, storage) {
  if (!repos?.maps) return;

  let map = repos.maps.first();

  if (!map) {
    map = repos.maps.createWithCampaign('First Campaign', 'Drowned Sanctuary');

    const tokens = [
      { id: 'tok-demo-1', label: 'Mira', x: 455, y: 455, color: '#adfcf9' },
      { id: 'tok-demo-2', label: 'Thorne', x: 525, y: 455, color: '#d7cba0' },
      { id: 'tok-demo-3', label: 'Sentinel', x: 875, y: 665, color: '#db9685' },
    ];

    for (const token of tokens) {
      repos.tokens.create({ ...token, mapId: map.id, ownerId: null, locked: false });
    }
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

  if (storage?.saveAsset && map && !map.image_file) {
    try {
      const bytes = await fs.promises.readFile(SAMPLE_MAP);
      const { fileName } = await storage.saveAsset('maps', bytes, {
        originalName: 'starter-map.svg',
      });
      repos.maps.setImage(map.id, fileName);
    } catch (error) {
      console.warn('[hakton] could not install sample map:', error.message);
    }
  }
}
