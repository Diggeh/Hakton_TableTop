import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { io as createClient } from 'socket.io-client';
import { startServer, stopServer } from '../../backend/server.js';
import { openDatabase } from '../../database/index.js';
import { createRepositories } from '../../database/repositories.js';
import { DEFAULT_SESSION_ID, EVENTS, ROLES } from '../../shared/events.js';

function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function connectRaw(url) {
  return new Promise((resolve, reject) => {
    const socket = createClient(url, { transports: ['websocket'], reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

describe('reconnection state resynchronization', () => {
  let db;
  let repos;
  let map;
  let server;
  let dm;
  let player;
  let playerId;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    repos = createRepositories(db);
    map = repos.maps.createWithCampaign('Campaign', 'Drowned Sanctuary');

    repos.tokens.create({
      id: 'tok-1',
      mapId: map.id,
      label: 'Mira',
      x: 105,
      y: 105,
      ownerId: null,
      locked: false,
      color: '#adfcf9',
    });
    repos.characters.upsert({
      id: 'char-mira',
      ownerId: 'demo-dm',
      name: 'Mira',
      sheetData: { hp: { current: 28, max: 32 } },
    });
    repos.dmRecords.upsert({
      id: 'notes-1',
      category: 'session-notes',
      title: 'Session notes',
      data: { text: 'The tide returns.' },
    });

    server = await startServer({ repos, port: 0, host: '127.0.0.1' });

    dm = await connectRaw(server.localUrl);
    player = await connectRaw(server.localUrl);

    await emitWithAck(dm, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Dungeon Master',
      role: ROLES.DM,
      hostToken: server.hostSecret,
    });

    const playerJoin = await emitWithAck(player, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Aria',
    });
    playerId = playerJoin.welcome.playerId;

    repos.characters.upsert({
      id: 'char-aria',
      ownerId: playerId,
      name: 'Aria',
      sheetData: { hp: { current: 18, max: 18 } },
    });
    repos.characters.upsert({
      id: 'char-thorne',
      ownerId: 'demo-dm',
      name: 'Thorne',
      sheetData: { hp: { current: 36, max: 36 } },
    });
  });

  afterEach(async () => {
    dm?.disconnect();
    player?.disconnect();
    await stopServer();
    db?.close();
  });

  it('returns the full authoritative snapshot to the DM', async () => {
    const response = await emitWithAck(dm, EVENTS.STATE_REQUEST, {});

    assert.equal(response.ok, true);
    assert.equal(response.state.map.id, map.id);
    assert.equal(response.state.map.campaignId, map.campaign_id);
    assert.equal(response.state.tokens.length, 1);
    assert.equal(response.state.tokens[0].x, 105);

    const characterIds = response.state.characters.map((c) => c.id).sort();
    assert.deepEqual(characterIds, ['char-aria', 'char-mira', 'char-thorne']);
    assert.equal(response.state.dmRecords.length, 1);
    assert.equal(response.state.dmRecords[0].data.text, 'The tide returns.');
  });

  it('filters characters by ownership and hides DM records from players', async () => {
    const response = await emitWithAck(player, EVENTS.STATE_REQUEST, {});

    assert.equal(response.ok, true);
    assert.deepEqual(
      response.state.characters.map((c) => c.id),
      ['char-aria'],
      'players only receive sheets they own',
    );
    assert.deepEqual(response.state.dmRecords, []);
  });

  it('reflects a token move in the next state request (reconnect resync)', async () => {
    const move = await emitWithAck(player, EVENTS.TOKEN_MOVE, {
      id: 'tok-1',
      x: 420,
      y: 260,
      moveId: 'move-1',
    });
    assert.equal(move.ok, true);

    const response = await emitWithAck(player, EVENTS.STATE_REQUEST, {});
    const token = response.state.tokens.find((t) => t.id === 'tok-1');
    assert.equal(token.x, 420);
    assert.equal(token.y, 260);
  });

  it('rate-limits a client that spams state requests', async () => {
    let last = null;
    for (let i = 0; i < 7; i += 1) {
      last = await emitWithAck(player, EVENTS.STATE_REQUEST, {});
    }
    assert.equal(last.ok, false);
    assert.equal(last.reason, 'rate_limited');
  });
});
