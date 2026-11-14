import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../database/index.js';
import { createRepositories } from '../../database/repositories.js';

describe('autosave schema and revision repositories', () => {
  let db;
  let repos;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repos = createRepositories(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('increments character revision on every write and round-trips JSON columns', () => {
    const created = repos.characters.upsert({
      id: 'char-1',
      ownerId: 'p_1',
      name: 'Mira',
      sheetData: { hp: { current: 10, max: 12 } },
      inventoryData: { items: ['rope'] },
    });

    assert.equal(created.revision, 1);
    assert.deepEqual(created.sheet_data.hp, { current: 10, max: 12 });

    const saved = repos.characters.saveWithRevision({
      id: 'char-1',
      baseRevision: 1,
      sheetData: { hp: { current: 7, max: 12 } },
    });

    assert.equal(saved.conflict, false);
    assert.equal(saved.character.revision, 2);
    assert.equal(saved.character.sheet_data.hp.current, 7);
    assert.equal(saved.character.name, 'Mira', 'unchanged fields are preserved');
  });

  it('rejects a stale baseRevision and returns the current document', () => {
    repos.characters.upsert({ id: 'char-1', ownerId: 'p_1', name: 'Mira', sheetData: {} });
    repos.characters.saveWithRevision({ id: 'char-1', baseRevision: 1, sheetData: { hp: 1 } });

    const stale = repos.characters.saveWithRevision({
      id: 'char-1',
      baseRevision: 1,
      sheetData: { hp: 999 },
    });

    assert.equal(stale.conflict, true);
    assert.equal(stale.current.revision, 2);
    assert.equal(repos.characters.get('char-1').sheet_data.hp, 1);
  });

  it('inserts a character when baseRevision is null but never overwrites on a missing row', () => {
    const inserted = repos.characters.saveWithRevision({
      id: 'char-new',
      baseRevision: null,
      ownerId: 'p_2',
      name: 'Aria',
      sheetData: {},
    });
    assert.equal(inserted.conflict, false);
    assert.equal(inserted.character.revision, 1);

    const missing = repos.characters.saveWithRevision({
      id: 'char-missing',
      baseRevision: 4,
      ownerId: 'p_2',
      name: 'Ghost',
    });
    assert.equal(missing.conflict, true);
    assert.equal(missing.current, null);
    assert.equal(repos.characters.get('char-missing'), null);
  });

  it('applies the same revision CAS to DM records', () => {
    const created = repos.dmRecords.saveWithRevision({
      id: 'dm-notes-1',
      baseRevision: null,
      category: 'session-notes',
      title: 'Session notes',
      data: { text: 'The tide returns.' },
    });
    assert.equal(created.conflict, false);
    assert.equal(created.record.revision, 1);

    const saved = repos.dmRecords.saveWithRevision({
      id: 'dm-notes-1',
      baseRevision: 1,
      data: { text: 'The tide has returned.' },
    });
    assert.equal(saved.record.revision, 2);

    const stale = repos.dmRecords.saveWithRevision({
      id: 'dm-notes-1',
      baseRevision: 1,
      data: { text: 'overwrite' },
    });
    assert.equal(stale.conflict, true);
    assert.equal(stale.current.data.text, 'The tide has returned.');
  });

  it('stores one board document per campaign and bumps its revision', () => {
    const map = repos.maps.createWithCampaign('Campaign', 'Drowned Sanctuary');
    assert.equal(repos.maps.active().id, map.id, 'new campaigns set active_map_id');

    const first = repos.board.save(map.campaign_id, { version: 1, activeMapId: map.id }, 'p_dm');
    assert.equal(first.revision, 1);

    const second = repos.board.save(map.campaign_id, { version: 1, activeMapId: map.id }, 'p_dm');
    assert.equal(second.revision, 2);
    assert.equal(repos.board.list().length, 1);
  });

  it('persists sessions, participants, and idempotency receipts', () => {
    repos.sessions.upsertSession({ id: 'default', name: 'Table' });
    repos.sessions.upsertParticipant({
      id: 'p_1',
      sessionId: 'default',
      displayName: 'Aria',
      role: 'player',
      reconnectTokenHash: 'a'.repeat(64),
      connected: true,
      joinedAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
    });

    const participants = repos.sessions.listParticipants('default');
    assert.equal(participants.length, 1);
    assert.equal(participants[0].displayName, 'Aria');

    repos.sessions.markAllDisconnected('2026-01-01T00:01:00.000Z');
    assert.equal(repos.sessions.getParticipant('p_1').connected, false);

    repos.autosaveReceipts.save('save-1', { ok: true, saveId: 'save-1' });
    assert.deepEqual(repos.autosaveReceipts.get('save-1'), { ok: true, saveId: 'save-1' });
  });
});
