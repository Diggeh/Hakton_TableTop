import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { io as createClient } from 'socket.io-client';
import { startServer, stopServer } from '../../backend/server.js';
import { openDatabase } from '../../database/index.js';
import { createRepositories } from '../../database/repositories.js';
import {
  DEFAULT_SESSION_ID,
  EVENTS,
  ROLES,
} from '../../shared/events.js';

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
  return new Promise((resolve) => {
    socket.emit(event, payload, resolve);
  });
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

async function join(socket, payload) {
  return emitWithAck(socket, EVENTS.SESSION_JOIN, {
    sessionId: DEFAULT_SESSION_ID,
    ...payload,
  });
}

describe('token:move realtime pipeline', () => {
  let server;
  let db;
  let repos;
  let map;
  let dm;
  let player;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    repos = createRepositories(db);
    map = repos.maps.createWithCampaign('Campaign', 'Map');

    repos.tokens.create({
      id: 'tok-free',
      mapId: map.id,
      label: 'Mira',
      x: 105,
      y: 105,
      color: '#adfcf9',
    });

    server = await startServer({ repos, port: 0, host: '127.0.0.1' });
    dm = await connectRaw(server.localUrl);
    player = await connectRaw(server.localUrl);

    const dmAck = await join(dm, {
      displayName: 'Dungeon Master',
      role: ROLES.DM,
      hostToken: server.hostSecret,
    });
    const playerAck = await join(player, {
      displayName: 'Theren',
      role: ROLES.PLAYER,
    });

    assert.equal(dmAck.success, true);
    assert.equal(playerAck.success, true);
    dm.playerId = dmAck.welcome.playerId;
  });

  afterEach(async () => {
    dm?.disconnect();
    player?.disconnect();
    await stopServer();
    db?.close();
  });

  it('persists a move and broadcasts it to every client within 500 ms', async () => {
    const dmSaw = waitForEvent(dm, EVENTS.TOKEN_MOVED);
    const playerSaw = waitForEvent(player, EVENTS.TOKEN_MOVED);

    const started = Date.now();
    const ack = await emitWithAck(player, EVENTS.TOKEN_MOVE, {
      id: 'tok-free',
      x: 315,
      y: 245,
      moveId: 'move-1',
    });
    const [toDm, toPlayer] = await Promise.all([dmSaw, playerSaw]);
    const elapsed = Date.now() - started;

    assert.equal(ack.ok, true);
    assert.ok(elapsed < 500, `broadcast took ${elapsed}ms`);

    for (const update of [toDm, toPlayer]) {
      assert.equal(update.id, 'tok-free');
      assert.equal(update.x, 315);
      assert.equal(update.y, 245);
    }

    const stored = repos.tokens.get('tok-free');
    assert.equal(stored.x, 315);
    assert.equal(stored.y, 245);
  });

  it('rejects a move on a token owned by someone else', async () => {
    repos.tokens.create({
      id: 'tok-owned',
      mapId: map.id,
      label: 'Ward',
      x: 35,
      y: 35,
      ownerId: dm.playerId,
    });

    const ack = await emitWithAck(player, EVENTS.TOKEN_MOVE, {
      id: 'tok-owned',
      x: 385,
      y: 385,
    });

    assert.equal(ack.ok, false);
    assert.equal(ack.reason, 'forbidden');
    assert.equal(ack.token.x, 35);

    const stored = repos.tokens.get('tok-owned');
    assert.equal(stored.x, 35);
    assert.equal(stored.y, 35);
  });

  it('rejects a move on a locked token for players', async () => {
    repos.tokens.create({
      id: 'tok-locked',
      mapId: map.id,
      label: 'Statue',
      x: 105,
      y: 315,
      locked: true,
    });

    const ack = await emitWithAck(player, EVENTS.TOKEN_MOVE, {
      id: 'tok-locked',
      x: 455,
      y: 455,
    });

    assert.equal(ack.ok, false);
    assert.equal(ack.reason, 'locked');
    assert.equal(repos.tokens.get('tok-locked').x, 105);
  });

  it('lets the DM move owned or locked tokens', async () => {
    repos.tokens.create({
      id: 'tok-dm',
      mapId: map.id,
      label: 'Ward',
      x: 35,
      y: 35,
      ownerId: 'someone-else',
      locked: true,
    });

    const ack = await emitWithAck(dm, EVENTS.TOKEN_MOVE, {
      id: 'tok-dm',
      x: 665,
      y: 595,
    });

    assert.equal(ack.ok, true);
    assert.equal(repos.tokens.get('tok-dm').x, 665);
  });

  it('persists DM token create, update, and delete and rejects players', async () => {
    const createdNotice = waitForEvent(player, EVENTS.TOKEN_CREATED);
    const created = await emitWithAck(dm, EVENTS.TOKEN_CREATE, {
      label: 'Goblin',
      color: '#db9685',
      x: 385,
      y: 245,
    });
    const createdWire = await createdNotice;

    assert.equal(created.ok, true);
    assert.equal(createdWire.label, 'Goblin');
    assert.equal(repos.tokens.get(created.token.id).label, 'Goblin');

    const forbidden = await emitWithAck(player, EVENTS.TOKEN_CREATE, {
      label: 'Cheat',
    });
    assert.equal(forbidden.ok, false);

    const updatedNotice = waitForEvent(player, EVENTS.TOKEN_UPDATED);
    const updated = await emitWithAck(dm, EVENTS.TOKEN_UPDATE, {
      id: created.token.id,
      label: 'Goblin Boss',
      locked: true,
    });
    const updatedWire = await updatedNotice;

    assert.equal(updated.ok, true);
    assert.equal(updatedWire.label, 'Goblin Boss');
    assert.equal(updatedWire.locked, true);
    assert.equal(repos.tokens.get(created.token.id).locked, 1);

    const deletedNotice = waitForEvent(player, EVENTS.TOKEN_DELETED);
    const deleted = await emitWithAck(dm, EVENTS.TOKEN_DELETE, {
      id: created.token.id,
    });
    const deletedWire = await deletedNotice;

    assert.equal(deleted.ok, true);
    assert.equal(deletedWire.id, created.token.id);
    assert.equal(repos.tokens.get(created.token.id), null);
  });
});
