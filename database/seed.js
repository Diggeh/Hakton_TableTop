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
 * Seeds a default campaign/map/tokens so a fresh install renders something.
 * Also installs the bundled sample battle map into lossless local storage.
 *
 * Idempotent: an existing map keeps its tokens; only a missing map image is
 * backfilled from the sample.
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
