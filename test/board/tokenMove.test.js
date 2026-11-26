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

    // Locked tokens cannot be deleted until unlocked
    const lockedDelete = await emitWithAck(dm, EVENTS.TOKEN_DELETE, {
      id: created.token.id,
    });
    assert.equal(lockedDelete.ok, false);
    assert.equal(lockedDelete.reason, 'locked');
    assert.ok(repos.tokens.get(created.token.id));

    const unlocked = await emitWithAck(dm, EVENTS.TOKEN_UPDATE, {
      id: created.token.id,
      locked: false,
    });
    assert.equal(unlocked.ok, true);
    assert.equal(unlocked.token.locked, false);

    const deletedNotice = waitForEvent(player, EVENTS.TOKEN_DELETED);
    const deleted = await emitWithAck(dm, EVENTS.TOKEN_DELETE, {
      id: created.token.id,
    });
    const deletedWire = await deletedNotice;

    assert.equal(deleted.ok, true);
    assert.equal(deletedWire.id, created.token.id);
    assert.equal(repos.tokens.get(created.token.id), null);
  });

  it('persists and broadcasts map tiles (isMap/imageUrl/width/height) and token light toggles', async () => {
    const mapNotice = waitForEvent(player, EVENTS.TOKEN_CREATED);
    const mapAck = await emitWithAck(dm, EVENTS.TOKEN_CREATE, {
      label: 'Dungeon Map',
      color: '#8fd2c5',
      x: 500,
      y: 400,
      isMap: true,
      imageUrl: '/assets/map-1/file',
      width: 1200,
      height: 800,
    });
    const mapWire = await mapNotice;

    assert.equal(mapAck.ok, true);
    assert.equal(mapAck.token.isMap, true);
    assert.equal(mapAck.token.imageUrl, '/assets/map-1/file');
    assert.equal(mapAck.token.width, 1200);
    assert.equal(mapAck.token.height, 800);
    assert.equal(mapWire.isMap, true);
    assert.equal(mapWire.imageUrl, '/assets/map-1/file');

    const lightNotice = waitForEvent(dm, EVENTS.TOKEN_UPDATED);
    const lightAck = await emitWithAck(player, EVENTS.TOKEN_UPDATE, {
      id: 'tok-free',
      light: {
        enabled: true,
        type: 'torch',
        range: 40,
        angle: 90,
        rotation: 0,
      },
    });
    const lightWire = await lightNotice;

    assert.equal(lightAck.ok, true);
    assert.deepEqual(lightAck.token.light, {
      enabled: true,
      type: 'torch',
      range: 40,
      angle: 90,
      rotation: 0,
    });
    assert.deepEqual(lightWire.light, lightAck.token.light);

    const forbiddenMapChange = await emitWithAck(player, EVENTS.TOKEN_UPDATE, {
      id: 'tok-free',
      isMap: true,
    });
    assert.equal(forbiddenMapChange.ok, false);
    assert.equal(forbiddenMapChange.reason, 'forbidden');
  });

  it('allows creating, moving, and rotating tokens across the extended full-screen canvas', async () => {
    const extendedCreate = await emitWithAck(dm, EVENTS.TOKEN_CREATE, {
      label: 'Scout',
      x: -245,
      y: 2100,
      rotation: 90,
    });
    assert.equal(extendedCreate.ok, true);
    assert.equal(extendedCreate.token.x, -245);
    assert.equal(extendedCreate.token.y, 2100);
    assert.equal(extendedCreate.token.rotation, 90);

    const moveAck = await emitWithAck(player, EVENTS.TOKEN_MOVE, {
      id: 'tok-free',
      x: -350,
      y: 2450,
    });
    assert.equal(moveAck.ok, true);
    assert.equal(moveAck.token.x, -350);
    assert.equal(moveAck.token.y, 2450);

    const playerRotateNotice = waitForEvent(dm, EVENTS.TOKEN_UPDATED);
    const playerRotateAck = await emitWithAck(player, EVENTS.TOKEN_UPDATE, {
      id: 'tok-free',
      rotation: 225,
      light: {
        enabled: true,
        type: 'vision',
        range: 30,
        angle: 90,
        rotation: 225,
      },
    });
    const broadcastRotated = await playerRotateNotice;
    assert.equal(playerRotateAck.ok, true);
    assert.equal(playerRotateAck.token.rotation, 225);
    assert.equal(broadcastRotated.rotation, 225);
    assert.equal(repos.tokens.get('tok-free').rotation, 225);

    const dmRotateAck = await emitWithAck(dm, EVENTS.TOKEN_UPDATE, {
      id: extendedCreate.token.id,
      rotation: -45,
    });
    assert.equal(dmRotateAck.ok, true);
    assert.equal(dmRotateAck.token.rotation, 315);
    assert.equal(repos.tokens.get(extendedCreate.token.id).rotation, 315);
  });

  it('persists resizing, rotating, and locking placed map/scene images', async () => {
    const mapCreate = await emitWithAck(dm, EVENTS.TOKEN_CREATE, {
      label: 'Imported Courtyard',
      x: 700,
      y: 490,
      isMap: true,
      imageUrl: '/assets/courtyard/file',
      width: 1000,
      height: 700,
      rotation: 0,
    });
    assert.equal(mapCreate.ok, true);
    const mapId = mapCreate.token.id;

    const resizeRotateLockNotice = waitForEvent(player, EVENTS.TOKEN_UPDATED);
    const updateAck = await emitWithAck(dm, EVENTS.TOKEN_UPDATE, {
      id: mapId,
      width: 1450,
      height: 1015,
      rotation: 90,
      locked: true,
    });
    const broadcasted = await resizeRotateLockNotice;

    assert.equal(updateAck.ok, true);
    assert.equal(updateAck.token.width, 1450);
    assert.equal(updateAck.token.height, 1015);
    assert.equal(updateAck.token.rotation, 90);
    assert.equal(updateAck.token.locked, true);
    assert.equal(broadcasted.width, 1450);
    assert.equal(broadcasted.rotation, 90);
    assert.equal(broadcasted.locked, true);

    const stored = repos.tokens.get(mapId);
    assert.equal(stored.width, 1450);
    assert.equal(stored.height, 1015);
    assert.equal(stored.rotation, 90);
    assert.equal(stored.locked, 1);
  });

  it('persists scene switching, isolates tokens per scene, and restores active scene after reconnect', async () => {
    const selectedNotice = waitForEvent(player, EVENTS.MAP_SELECTED);
    const selectRes = await emitWithAck(dm, EVENTS.MAP_SELECT, {
      name: 'Moonlit Tavern',
      width: 2400,
      height: 1600,
      gridSize: 35,
    });
    const playerSelected = await selectedNotice;

    assert.equal(selectRes.ok, true);
    assert.equal(selectRes.map.name, 'Moonlit Tavern');
    assert.equal(selectRes.map.gridSize, 35);
    assert.equal(playerSelected.map.name, 'Moonlit Tavern');
    assert.equal(selectRes.tokens.length, 0);

    // Create a scene map image token inside Moonlit Tavern (must persist to the active scene map_id)
    const tavernTokenRes = await emitWithAck(dm, EVENTS.TOKEN_CREATE, {
      label: 'Moonlit Tavern',
      x: 1200,
      y: 800,
      isMap: true,
      imageUrl: '/assets/tavern/file',
      width: 2400,
      height: 1600,
    });
    assert.equal(tavernTokenRes.ok, true);
    assert.equal(tavernTokenRes.token.mapId, selectRes.map.id);

    // Update grid size and fog shapes for Moonlit Tavern
    const mapUpdateNotice = waitForEvent(player, EVENTS.MAP_UPDATED);
    const updateRes = await emitWithAck(dm, EVENTS.MAP_UPDATE, {
      id: selectRes.map.id,
      gridSize: 45,
      sceneData: {
        fogShapes: [{ id: 'fog-1', type: 'rect', x: 10, y: 10, width: 100, height: 100 }],
        walls: [],
      },
    });
    const broadcastedMap = await mapUpdateNotice;
    assert.equal(updateRes.ok, true);
    assert.equal(updateRes.map.gridSize, 45);
    assert.equal(broadcastedMap.map.gridSize, 45);
    assert.equal(broadcastedMap.map.sceneData.fogShapes.length, 1);

    // Simulate closing and reopening Electron by disconnecting DM and joining with a fresh client socket
    dm.disconnect();
    const freshDm = await connectRaw(server.localUrl);
    const statePromise = waitForEvent(freshDm, EVENTS.SESSION_STATE);
    await join(freshDm, {
      displayName: 'Dungeon Master',
      role: ROLES.DM,
      hostToken: server.hostSecret,
    });
    const restoredState = await statePromise;

    assert.equal(restoredState.map.name, 'Moonlit Tavern');
    assert.equal(restoredState.map.gridSize, 45);
    assert.equal(restoredState.map.sceneData.fogShapes.length, 1);
    assert.equal(restoredState.tokens.length, 1);
    assert.equal(restoredState.tokens[0].label, 'Moonlit Tavern');

    // Switch back to original Map and verify Moonlit Tavern token is isolated
    const backRes = await emitWithAck(freshDm, EVENTS.MAP_SELECT, {
      name: 'Map',
    });
    freshDm.disconnect();
    assert.equal(backRes.ok, true);
    assert.equal(backRes.map.name, 'Map');
    assert.equal(backRes.tokens.length, 1);
    assert.equal(backRes.tokens[0].id, 'tok-free');
  });

  it('isolates scenes per campaignKey across DM joins', async () => {
    dm.disconnect();
    const dmCampaignA = await connectRaw(server.localUrl);
    const stateA = waitForEvent(dmCampaignA, EVENTS.SESSION_STATE);
    await join(dmCampaignA, {
      displayName: 'Dungeon Master',
      role: ROLES.DM,
      hostToken: server.hostSecret,
      campaignKey: 'camp-a',
      campaignName: 'Campaign Alpha',
    });
    const snapA = await stateA;
    assert.equal(snapA.map.name, 'Untitled Scene');
    assert.equal(snapA.map.gridSize, 35);

    const selA = await emitWithAck(dmCampaignA, EVENTS.MAP_SELECT, {
      name: 'Alpha Keep',
    });
    assert.equal(selA.ok, true);
    assert.equal(selA.map.name, 'Alpha Keep');
    dmCampaignA.disconnect();

    const dmCampaignB = await connectRaw(server.localUrl);
    const stateB = waitForEvent(dmCampaignB, EVENTS.SESSION_STATE);
    await join(dmCampaignB, {
      displayName: 'Dungeon Master',
      role: ROLES.DM,
      hostToken: server.hostSecret,
      campaignKey: 'camp-b',
      campaignName: 'Campaign Beta',
    });
    const snapB = await stateB;
    assert.equal(snapB.map.name, 'Untitled Scene');
    dmCampaignB.disconnect();

    const dmReturnA = await connectRaw(server.localUrl);
    const stateReturnA = waitForEvent(dmReturnA, EVENTS.SESSION_STATE);
    await join(dmReturnA, {
      displayName: 'Dungeon Master',
      role: ROLES.DM,
      hostToken: server.hostSecret,
      campaignKey: 'camp-a',
      campaignName: 'Campaign Alpha',
    });
    const snapReturnA = await stateReturnA;
    assert.equal(snapReturnA.map.name, 'Alpha Keep');
    dmReturnA.disconnect();
  });

  it('persists combat properties, isolates DM vs Player HP visibility, and preserves Player HP when DM updates initiative', async () => {
    const dmUserId = dm.playerId;
    const playerUserId = 'user-aria-1';
    const playerTokenRes = await emitWithAck(dm, EVENTS.TOKEN_CREATE, {
      label: 'Aria',
      x: 150,
      y: 160,
      ownerId: playerUserId,
      ownerRole: 'player',
      combat: { enabled: true, initiative: 18, hp: 27, maxHp: 32 },
    });
    assert.equal(playerTokenRes.ok, true);
    const ariaId = playerTokenRes.token.id;

    // DM creates a DM-owned monster token
    const monsterRes = await emitWithAck(dm, EVENTS.TOKEN_CREATE, {
      label: 'Owlbear',
      x: 240,
      y: 260,
      ownerId: dmUserId,
      ownerRole: 'dm',
      combat: { enabled: true, initiative: 11, hp: 59, maxHp: 59 },
    });
    assert.equal(monsterRes.ok, true);
    const monsterId = monsterRes.token.id;

    // DM updates Aria's initiative without sending HP — stored Player HP must remain intact
    const dmInitUpdate = await emitWithAck(dm, EVENTS.TOKEN_UPDATE, {
      id: ariaId,
      combat: { enabled: true, initiative: 21 },
    });
    assert.equal(dmInitUpdate.ok, true);
    assert.equal(dmInitUpdate.token.combat.initiative, 21);
    assert.equal(dmInitUpdate.token.combat.hpHidden, true);
    assert.equal(dmInitUpdate.token.combat.hp, null);

    // Reconnect both DM and Player to verify SESSION_STATE role filtering + SQLite persistence
    dm.disconnect();
    player.disconnect();

    const freshDm = await connectRaw(server.localUrl);
    const dmSnapPromise = waitForEvent(freshDm, EVENTS.SESSION_STATE);
    await join(freshDm, {
      displayName: 'Dungeon Master',
      role: ROLES.DM,
      hostToken: server.hostSecret,
    });
    const dmSnap = await dmSnapPromise;

    const dmAria = dmSnap.tokens.find((t) => t.id === ariaId);
    const dmMonster = dmSnap.tokens.find((t) => t.id === monsterId);
    assert.equal(dmAria.combat.initiative, 21);
    assert.equal(dmAria.combat.hpHidden, true);
    assert.equal(dmAria.combat.hp, null);
    assert.equal(dmMonster.combat.hp, 59);
    assert.equal(dmMonster.combat.maxHp, 59);
    freshDm.disconnect();

    const freshPlayer = await connectRaw(server.localUrl);
    const playerSnapPromise = waitForEvent(freshPlayer, EVENTS.SESSION_STATE);
    await join(freshPlayer, {
      displayName: 'Aria',
      role: ROLES.PLAYER,
      userId: playerUserId,
    });
    const playerSnap = await playerSnapPromise;

    const playerAria = playerSnap.tokens.find((t) => t.id === ariaId);
    const playerMonster = playerSnap.tokens.find((t) => t.id === monsterId);
    assert.equal(playerAria.combat.initiative, 21);
    assert.equal(playerAria.combat.hp, 27);
    assert.equal(playerAria.combat.maxHp, 32);
    assert.equal(playerMonster.combat.initiative, 11);
    assert.equal(playerMonster.combat.hpHidden, true);
    assert.equal(playerMonster.combat.hp, null);
    freshPlayer.disconnect();
  });

  it('replays saved dice rolls on reconnect in SESSION_STATE.rollHistory while keeping DM-secret rolls private', async () => {
    const dmUserId = dm.playerId;
    repos.chat.append({
      id: 'roll-public',
      senderId: dmUserId,
      senderName: 'Dungeon Master',
      type: 'dice_roll',
      payload: {
        id: 'roll-public',
        formula: '1d20',
        total: 19,
        rolls: [{ die: 20, value: 19 }],
      },
    });
    repos.chat.append({
      id: 'roll-secret',
      senderId: dmUserId,
      senderName: 'Dungeon Master',
      recipientId: dmUserId,
      type: 'dice_roll',
      payload: {
        id: 'roll-secret',
        formula: '1d20',
        total: 2,
        isSecret: true,
        rolls: [{ die: 20, value: 2 }],
      },
    });

    dm.disconnect();
    player.disconnect();

    const freshDm = await connectRaw(server.localUrl);
    const dmSnapPromise = waitForEvent(freshDm, EVENTS.SESSION_STATE);
    await join(freshDm, {
      displayName: 'Dungeon Master',
      role: ROLES.DM,
      hostToken: server.hostSecret,
    });
    const dmSnap = await dmSnapPromise;
    assert.equal(
      dmSnap.rollHistory.some((r) => r.id === 'roll-public'),
      true,
    );
    assert.equal(
      dmSnap.rollHistory.some((r) => r.id === 'roll-secret'),
      true,
    );
    freshDm.disconnect();

    const freshPlayer = await connectRaw(server.localUrl);
    const playerSnapPromise = waitForEvent(freshPlayer, EVENTS.SESSION_STATE);
    await join(freshPlayer, {
      displayName: 'Aria',
      role: ROLES.PLAYER,
      userId: 'user-aria-2',
    });
    const playerSnap = await playerSnapPromise;
    assert.equal(
      playerSnap.rollHistory.some((r) => r.id === 'roll-public'),
      true,
    );
    assert.equal(
      playerSnap.rollHistory.some((r) => r.id === 'roll-secret'),
      false,
    );
    freshPlayer.disconnect();
  });
});
