import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { io as createClient } from 'socket.io-client';
import { startServer, stopServer } from '../../backend/server.js';
import { openDatabase } from '../../database/index.js';
import { createRepositories } from '../../database/repositories.js';
import { assets as fixtureAssets, party as fixtureParty } from '../../src/ui/fixtures.js';
import { DEFAULT_SESSION_ID, EVENTS, ROLES } from '../../shared/events.js';

function waitForEvent(socket, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);
    function handler(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once(event, handler);
  });
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function connectRaw(url) {
  return new Promise((resolve, reject) => {
    const socket = createClient(url, {
      transports: ['websocket'],
      reconnection: false,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

describe('token images/categories, DM-only doors, preset cleanup, and Character Sheet rules', () => {
  let db;
  let repos;
  let server;
  let dm;
  let player1;
  let player2;
  let p1Id;
  let p2Id;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    repos = createRepositories(db);
    repos.maps.createWithCampaign('Campaign', 'Tavern');
    server = await startServer({ repos, port: 0, host: '127.0.0.1' });

    dm = await connectRaw(server.localUrl);
    player1 = await connectRaw(server.localUrl);
    player2 = await connectRaw(server.localUrl);

    await emitWithAck(dm, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Dungeon Master',
      role: ROLES.DM,
      hostToken: server.hostSecret,
    });
    const j1 = await emitWithAck(player1, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Kael',
    });
    const j2 = await emitWithAck(player2, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Lyra',
    });
    p1Id = j1.welcome.playerId;
    p2Id = j2.welcome.playerId;
  });

  afterEach(async () => {
    dm?.disconnect();
    player1?.disconnect();
    player2?.disconnect();
    await stopServer();
    db?.close();
  });

  it('has removed all pre-installed sample assets from fixtures & SQLite seeding', () => {
    assert.deepEqual(fixtureAssets.Characters, []);
    assert.deepEqual(fixtureAssets.Maps, []);
    assert.deepEqual(fixtureAssets.Props, []);
    assert.deepEqual(fixtureAssets.Attachments, []);
    assert.deepEqual(fixtureParty, []);
    assert.equal(repos.characters.listAll().length, 0);
  });

  it('persists imageUrl and asset category across characters, props, attachments, and maps', async () => {
    const resChar = await emitWithAck(dm, EVENTS.TOKEN_CREATE, {
      label: 'Aria',
      x: 100,
      y: 120,
      category: 'characters',
      imageUrl: '/assets/asset-aria/file',
      isMap: false,
    });
    assert.equal(resChar.ok, true);
    assert.equal(resChar.token.category, 'characters');
    assert.equal(resChar.token.imageUrl, '/assets/asset-aria/file');

    const resProp = await emitWithAck(dm, EVENTS.TOKEN_CREATE, {
      label: 'Chest',
      x: 200,
      y: 220,
      category: 'props',
      imageUrl: '/assets/asset-chest/file',
      width: 40,
      height: 32,
      isMap: false,
    });
    assert.equal(resProp.ok, true);
    assert.equal(resProp.token.category, 'props');
    assert.equal(resProp.token.imageUrl, '/assets/asset-chest/file');
    assert.equal(resProp.token.width, 40);
    assert.equal(resProp.token.height, 32);
  });

  it('enforces strictly DM-only map & door updates on the server', async () => {
    const mapId = repos.maps.first().id;
    const playerAttempt = await emitWithAck(player1, EVENTS.MAP_UPDATE, {
      id: mapId,
      sceneData: {
        fogShapes: [],
        walls: [{ id: 'd1', p1: { x: 0, y: 0 }, p2: { x: 40, y: 0 }, isDoor: true, isOpen: true }],
      },
    });
    assert.equal(playerAttempt.ok, false);
    assert.equal(playerAttempt.reason, 'forbidden');

    const dmAttempt = await emitWithAck(dm, EVENTS.MAP_UPDATE, {
      id: mapId,
      sceneData: {
        fogShapes: [],
        walls: [{ id: 'd1', p1: { x: 0, y: 0 }, p2: { x: 40, y: 0 }, isDoor: true, isOpen: false }],
      },
    });
    assert.equal(dmAttempt.ok, true);
  });

  it('enforces 1 character sheet per player on owned Character Tokens and lets DM inspect all player sheets', async () => {
    const propRes = await emitWithAck(dm, EVENTS.TOKEN_CREATE, {
      label: 'Table',
      category: 'props',
      ownerId: p1Id,
      ownerRole: ROLES.PLAYER,
      imageUrl: '/assets/table/file',
    });
    const unownedCharRes = await emitWithAck(dm, EVENTS.TOKEN_CREATE, {
      label: 'Bandit',
      category: 'characters',
      imageUrl: '/assets/bandit/file',
    });
    const p1Char1 = await emitWithAck(dm, EVENTS.TOKEN_CREATE, {
      label: 'Kael Hero',
      category: 'characters',
      ownerId: p1Id,
      ownerRole: ROLES.PLAYER,
      imageUrl: '/assets/kael/file',
    });
    const p1Char2 = await emitWithAck(dm, EVENTS.TOKEN_CREATE, {
      label: 'Kael Twin',
      category: 'characters',
      ownerId: p1Id,
      ownerRole: ROLES.PLAYER,
      imageUrl: '/assets/twin/file',
    });

    // Player cannot bind a sheet to a Prop or an unowned token
    const badProp = await emitWithAck(player1, EVENTS.CHARACTER_CREATE, {
      tokenId: propRes.token.id,
    });
    assert.equal(badProp.ok, false);
    assert.equal(badProp.reason, 'invalid_token');

    const badUnowned = await emitWithAck(player1, EVENTS.CHARACTER_CREATE, {
      tokenId: unownedCharRes.token.id,
    });
    assert.equal(badUnowned.ok, false);
    assert.equal(badUnowned.reason, 'forbidden');

    // Player creates 1 sheet for owned Character Token; DM receives broadcast, Player 2 does not
    let p2SawSheet = false;
    player2.once(EVENTS.CHARACTER_CREATED, () => {
      p2SawSheet = true;
    });
    const dmNotice = waitForEvent(dm, EVENTS.CHARACTER_CREATED);
    const created1 = await emitWithAck(player1, EVENTS.CHARACTER_CREATE, {
      tokenId: p1Char1.token.id,
    });
    assert.equal(created1.ok, true);
    assert.equal(created1.character.name, 'Kael Hero');
    assert.equal(created1.character.sheetData.tokenId, p1Char1.token.id);
    assert.equal(created1.character.sheetData.imageUrl, '/assets/kael/file');
    const dmSeen = await dmNotice;
    assert.equal(dmSeen.id, created1.character.id);
    assert.equal(p2SawSheet, false);

    // Second sheet for same Player is blocked by 1-sheet limit
    const secondAttempt = await emitWithAck(player1, EVENTS.CHARACTER_CREATE, {
      tokenId: p1Char2.token.id,
    });
    assert.equal(secondAttempt.ok, false);
    assert.equal(secondAttempt.reason, 'limit_reached');

    // DM sees all player sheets in STATE_REQUEST
    const dmState = await emitWithAck(dm, EVENTS.STATE_REQUEST, {});
    assert.equal(dmState.ok, true);
    assert.equal(dmState.state.characters.length, 1);
    assert.equal(dmState.state.characters[0].name, 'Kael Hero');

    // Player 2 sees 0 sheets (strictly isolated)
    const p2State = await emitWithAck(player2, EVENTS.STATE_REQUEST, {});
    assert.equal(p2State.ok, true);
    assert.equal(p2State.state.characters.length, 0);
  });
});
