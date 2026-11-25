import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../database/index.js';
import { createRepositories } from '../../database/repositories.js';

describe('token persistence', () => {
  it('survives closing and reopening the SQLite database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakton-token-'));
    const file = path.join(dir, 'hakton.db');

    try {
      let db = openDatabase(file);
      let repos = createRepositories(db);
      const map = repos.maps.createWithCampaign('Campaign', 'Map');

      repos.tokens.create({
        id: 'tok-persist',
        mapId: map.id,
        label: 'Mira',
        x: 105,
        y: 105,
        color: '#adfcf9',
      });

      assert.equal(repos.tokens.move('tok-persist', 315, 245), true);
      db.close();

      db = openDatabase(file);
      repos = createRepositories(db);
      const token = repos.tokens.get('tok-persist');

      assert.ok(token);
      assert.equal(token.x, 315);
      assert.equal(token.y, 245);
      assert.equal(token.label, 'Mira');
      assert.equal(token.color, '#adfcf9');
      assert.equal(token.locked, 0);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists ownership and lock updates', () => {
    const db = openDatabase(':memory:');
    const repos = createRepositories(db);
    const map = repos.maps.createWithCampaign('Campaign', 'Map');

    repos.tokens.create({
      id: 'tok-owned',
      mapId: map.id,
      label: 'Sentinel',
      x: 35,
      y: 35,
    });

    repos.tokens.update('tok-owned', { ownerId: 'player-1', locked: true });
    const token = repos.tokens.get('tok-owned');

    assert.equal(token.owner_id, 'player-1');
    assert.equal(token.locked, 1);
    db.close();
  });

  it('persists map placement graphics and token light properties across reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakton-token-extras-'));
    const file = path.join(dir, 'hakton.db');

    try {
      let db = openDatabase(file);
      let repos = createRepositories(db);
      const map = repos.maps.createWithCampaign('Campaign', 'Map');

      repos.tokens.create({
        id: 'tok-map',
        mapId: map.id,
        label: 'Cave Level',
        x: 700,
        y: 500,
        isMap: true,
        imageUrl: '/assets/map-1/file',
        width: 1200,
        height: 800,
      });

      repos.tokens.create({
        id: 'tok-hero',
        mapId: map.id,
        label: 'Mira',
        x: 105,
        y: 105,
        rotation: 45,
      });

      repos.tokens.update('tok-hero', {
        rotation: 135,
        light: { enabled: true, type: 'vision', range: 45, angle: 90, rotation: 135 },
      });
      db.close();

      db = openDatabase(file);
      repos = createRepositories(db);
      const storedMap = repos.tokens.get('tok-map');
      const storedHero = repos.tokens.get('tok-hero');

      assert.equal(storedMap.is_map, 1);
      assert.equal(storedMap.image_url, '/assets/map-1/file');
      assert.equal(storedMap.width, 1200);
      assert.equal(storedMap.height, 800);
      assert.equal(storedHero.rotation, 135);

      const parsedLight = JSON.parse(storedHero.light);
      assert.deepEqual(parsedLight, {
        enabled: true,
        type: 'vision',
        range: 45,
        angle: 90,
        rotation: 135,
      });
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
