import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { io as createClient } from 'socket.io-client';
import { startServer, stopServer } from '../../backend/server.js';
import { openDatabase } from '../../database/index.js';
import { createRepositories } from '../../database/repositories.js';
import {
  DEFAULT_SESSION_ID,
  ERROR_CODES,
  EVENTS,
  ROLES,
} from '../../shared/events.js';
import { DICE_MESSAGE_TYPE, DICE_VISIBILITY } from '../../shared/dice/constants.js';
import { rollFormula } from '../../shared/dice/roller.js';

function waitForEvent(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);
    function onEvent(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once(event, onEvent);
  });
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, resolve);
  });
}

describe('3D Dice Roll Network Sync, SQLite Persistence & DM Secrecy', () => {
  let db;
  let repos;
  let server;
  let clients = [];

  function connectClient() {
    const c = createClient(server.localUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(c);
    return c;
  }

  beforeEach(async () => {
    clients = [];
    db = openDatabase(':memory:');
    repos = createRepositories(db);
    server = await startServer({
      repos,
      port: 0,
      host: '127.0.0.1',
      sessionId: DEFAULT_SESSION_ID,
      sessionName: 'Curse of Strahd',
    });
  });

  afterEach(async () => {
    for (const c of clients) {
      try {
        c.disconnect();
      } catch {
        // Ignore
      }
    }
    clients = [];
    await stopServer();
    db.close();
  });

  it('broadcasts public rolls to all session peers and logs to SQLite chat_messages', async () => {
    const dmSocket = connectClient();
    const playerSocket = connectClient();
    await Promise.all([waitForEvent(dmSocket, 'connect'), waitForEvent(playerSocket, 'connect')]);

    const dmJoin = await emitWithAck(dmSocket, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Dungeon Master',
      role: ROLES.DM,
      hostToken: server.hostSecret,
    });
    const playerJoin = await emitWithAck(playerSocket, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Mira',
      role: ROLES.PLAYER,
    });
    assert.equal(dmJoin.success, true);
    assert.equal(playerJoin.success, true);

    const rolled = rollFormula('/r 2d20kh1+5 # Perception');
    assert.equal(rolled.ok, true);

    const dmReceivedPromise = waitForEvent(dmSocket, EVENTS.DICE_ROLLED);
    const playerReceivedPromise = waitForEvent(playerSocket, EVENTS.DICE_ROLLED);

    const ack = await emitWithAck(playerSocket, EVENTS.DICE_ROLL, rolled.roll);
    assert.equal(ack.success, true);
    assert.equal(ack.roll.type, DICE_MESSAGE_TYPE);
    assert.equal(ack.roll.sender_name, 'Mira');
    assert.equal(ack.roll.payload.total, rolled.roll.total);
    assert.equal(ack.roll.payload.label, 'Perception');

    const [dmBroadcast, playerBroadcast] = await Promise.all([
      dmReceivedPromise,
      playerReceivedPromise,
    ]);
    assert.equal(dmBroadcast.payload.total, rolled.roll.total);
    assert.equal(playerBroadcast.payload.total, rolled.roll.total);

    // Verify SQLite persistence via repositories
    const history = repos.chat.historyFor(playerJoin.welcome.playerId);
    assert.equal(history.length, 1);
    assert.equal(history[0].type, DICE_MESSAGE_TYPE);
    assert.equal(history[0].payload.formula, '2d20kh1+5');
    assert.equal(history[0].payload.total, rolled.roll.total);
  });

  it('restricts secret DM rolls strictly to the DM and roller, never leaking to other players or their SQLite history', async () => {
    const dmSocket = connectClient();
    const player1Socket = connectClient();
    const player2Socket = connectClient();
    await Promise.all([
      waitForEvent(dmSocket, 'connect'),
      waitForEvent(player1Socket, 'connect'),
      waitForEvent(player2Socket, 'connect'),
    ]);

    const dmJoin = await emitWithAck(dmSocket, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Dungeon Master',
      role: ROLES.DM,
      hostToken: server.hostSecret,
    });
    const p1Join = await emitWithAck(player1Socket, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Mira',
      role: ROLES.PLAYER,
    });
    const p2Join = await emitWithAck(player2Socket, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Thorne',
      role: ROLES.PLAYER,
    });

    let leakedToPlayer = false;
    player1Socket.on(EVENTS.DICE_ROLLED, () => {
      leakedToPlayer = true;
    });
    player2Socket.on(EVENTS.DICE_ROLLED, () => {
      leakedToPlayer = true;
    });

    // DM performs a secret roll
    const dmSecret = rollFormula('/gmroll 1d20+9 # Stealth Monster');
    assert.equal(dmSecret.ok, true);
    assert.equal(dmSecret.roll.visibility, DICE_VISIBILITY.DM);

    const dmEventPromise = waitForEvent(dmSocket, EVENTS.DICE_ROLLED);
    const ack = await emitWithAck(dmSocket, EVENTS.DICE_ROLL, dmSecret.roll);
    assert.equal(ack.success, true);

    const dmEvent = await dmEventPromise;
    assert.equal(dmEvent.payload.visibility, DICE_VISIBILITY.DM);
    assert.equal(dmEvent.payload.total, dmSecret.roll.total);

    // Wait briefly to confirm no player socket receives the secret roll
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(leakedToPlayer, false, 'Secret DM roll must not be emitted to player sockets');

    // Verify SQLite history: DM sees it, Player 1 and Player 2 do NOT see it
    const dmHistory = repos.chat.historyFor(dmJoin.welcome.playerId);
    const p1History = repos.chat.historyFor(p1Join.welcome.playerId);
    const p2History = repos.chat.historyFor(p2Join.welcome.playerId);
    assert.equal(dmHistory.length, 1);
    assert.equal(p1History.length, 0);
    assert.equal(p2History.length, 0);
  });

  it('rejects tampered or out-of-range dice roll payloads', async () => {
    const playerSocket = connectClient();
    await waitForEvent(playerSocket, 'connect');
    await emitWithAck(playerSocket, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Mira',
      role: ROLES.PLAYER,
    });

    const badRoll = {
      clientRollId: 'tampered_1',
      formula: '1d20+2',
      visibility: 'public',
      dice: [{ termIndex: 0, sides: 20, sign: 1, value: 99, kept: true }],
      modifier: 2,
      total: 101,
    };

    const ack = await emitWithAck(playerSocket, EVENTS.DICE_ROLL, badRoll);
    assert.equal(ack.success, false);
    assert.equal(ack.code, ERROR_CODES.INVALID_PAYLOAD);
  });
});
