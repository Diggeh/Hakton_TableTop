import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { io as createClient } from 'socket.io-client';
import { startServer, stopServer } from '../../backend/server.js';
import {
  CONNECTION_STATUS,
  DEFAULT_SESSION_ID,
  ERROR_CODES,
  EVENTS,
  ROLES,
} from '../../shared/events.js';
import {
  connect as clientConnect,
  disconnect as clientDisconnect,
  getSocket,
} from '../../src/net/socket.js';
import { sessionStore } from '../../src/store/sessionStore.js';

/**
 * Helper to wait for a socket event once with timeout.
 * @param {import('socket.io-client').Socket} socket
 * @param {string} event
 * @param {number} [timeoutMs]
 */
function waitForEvent(socket, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      socket.off('connect_error', onErr);
      reject(new Error(`Timed out waiting for event "${event}"`));
    }, timeoutMs);

    function onErr(err) {
      if (event === 'connect') {
        clearTimeout(timer);
        socket.off(event, handler);
        reject(new Error(`connect_error: ${err?.message || err} (${err?.description?.message || ''})`));
      }
    }

    function handler(payload) {
      clearTimeout(timer);
      socket.off('connect_error', onErr);
      resolve(payload);
    }

    socket.once(event, handler);
    if (event === 'connect') {
      socket.once('connect_error', onErr);
    }
  });
}

/**
 * Helper to emit an event and await acknowledgment.
 * @param {import('socket.io-client').Socket} socket
 * @param {string} event
 * @param {object} payload
 */
function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, resolve);
  });
}

describe('Socket.IO Networking Bus Integration (Router, Client & Store)', () => {
  let server;
  /** @type {import('socket.io-client').Socket[]} */
  let clients = [];

  function connectRawClient(url = server.localUrl) {
    const c = createClient(url, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(c);
    return c;
  }

  beforeEach(async () => {
    clients = [];
    clientDisconnect();
    server = await startServer({
      port: 0,
      host: '127.0.0.1',
      sessionId: DEFAULT_SESSION_ID,
      sessionName: 'Lost Mine of Phandelver',
    });
  });

  afterEach(async () => {
    clientDisconnect();
    for (const c of clients) {
      try {
        c.disconnect();
      } catch {
        // Ignore
      }
    }
    clients = [];
    await stopServer();
  });

  it('allows DM and multiple players to join, delivers authoritative Welcome Packet, and broadcasts roster updates', async () => {
    const dmSocket = connectRawClient();
    await waitForEvent(dmSocket, 'connect');

    // 1. DM joins using server-generated hostSecret
    const dmJoinAck = await emitWithAck(dmSocket, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Dungeon Master',
      role: ROLES.DM,
      hostToken: server.hostSecret,
    });

    assert.equal(dmJoinAck.success, true);
    assert.equal(dmJoinAck.welcome.role, ROLES.DM);
    assert.equal(dmJoinAck.welcome.sessionId, DEFAULT_SESSION_ID);
    assert.equal(dmJoinAck.welcome.displayName, 'Dungeon Master');
    assert.ok(dmJoinAck.welcome.playerId.startsWith('p_'));
    assert.equal(typeof dmJoinAck.welcome.reconnectToken, 'string');
    assert.equal(dmJoinAck.welcome.participants.length, 1);

    // Ensure Welcome Packet does NOT contain out-of-scope game state
    assert.equal('characters' in dmJoinAck.welcome, false);
    assert.equal('inventory' in dmJoinAck.welcome, false);
    assert.equal('tokens' in dmJoinAck.welcome, false);
    assert.equal('map' in dmJoinAck.welcome, false);
    assert.equal('chatHistory' in dmJoinAck.welcome, false);

    // 2. Player 1 connects and joins; DM receives participant joined broadcast
    const p1JoinedOnDm = waitForEvent(dmSocket, EVENTS.SESSION_PARTICIPANT_JOINED);
    const p1Socket = connectRawClient();
    await waitForEvent(p1Socket, 'connect');

    const p1JoinAck = await emitWithAck(p1Socket, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Aria',
    });

    assert.equal(p1JoinAck.success, true);
    assert.equal(p1JoinAck.welcome.role, ROLES.PLAYER);
    assert.equal(p1JoinAck.welcome.participants.length, 2);

    const joinedNotice = await p1JoinedOnDm;
    assert.equal(joinedNotice.id, p1JoinAck.welcome.playerId);
    assert.equal(joinedNotice.displayName, 'Aria');
    assert.equal(joinedNotice.role, ROLES.PLAYER);
    assert.equal('reconnectToken' in joinedNotice, false);

    // 3. Player 2 connects and joins; both DM and Player 1 receive updated participant list
    const rosterUpdateOnP1 = waitForEvent(p1Socket, EVENTS.SESSION_PARTICIPANTS_UPDATE);
    const p2Socket = connectRawClient();
    await waitForEvent(p2Socket, 'connect');

    const p2JoinAck = await emitWithAck(p2Socket, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Brog',
    });

    assert.equal(p2JoinAck.success, true);
    const updatedRoster = await rosterUpdateOnP1;
    assert.equal(updatedRoster.length, 3);
    assert.deepEqual(
      updatedRoster.map((p) => p.displayName),
      ['Dungeon Master', 'Aria', 'Brog'],
    );
  });

  it('handles player disconnect and safe identity restoration upon reconnection', async () => {
    const dmSocket = connectRawClient();
    await waitForEvent(dmSocket, 'connect');
    await emitWithAck(dmSocket, EVENTS.SESSION_JOIN, {
      displayName: 'DM',
      role: ROLES.DM,
      hostToken: server.hostSecret,
    });

    const p1Socket = connectRawClient();
    await waitForEvent(p1Socket, 'connect');
    const p1Join = await emitWithAck(p1Socket, EVENTS.SESSION_JOIN, {
      displayName: 'Aria',
    });
    assert.equal(p1Join.success, true);
    const { playerId, reconnectToken } = p1Join.welcome;
    const firstSocketId = p1Socket.id;

    // Disconnect Player 1; DM receives SESSION_PARTICIPANT_LEFT
    const leftPromise = waitForEvent(dmSocket, EVENTS.SESSION_PARTICIPANT_LEFT);
    p1Socket.disconnect();
    const leftPayload = await leftPromise;
    assert.equal(leftPayload.id, playerId);
    assert.equal(leftPayload.connected, false);

    // Player 1 reconnects on a brand new socket instance using reconnectToken
    const p1ReconnectSocket = connectRawClient();
    await waitForEvent(p1ReconnectSocket, 'connect');
    assert.notEqual(p1ReconnectSocket.id, firstSocketId);

    const rejoinAck = await emitWithAck(p1ReconnectSocket, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Aria',
      playerId,
      reconnectToken,
    });

    assert.equal(rejoinAck.success, true);
    assert.equal(rejoinAck.welcome.playerId, playerId);
    assert.equal(
      rejoinAck.welcome.participants.find((p) => p.id === playerId)?.connected,
      true,
    );
  });

  it('rejects invalid sessions, duplicate identities, unauthorized DM privilege claims, and identity impersonation', async () => {
    const p1Socket = connectRawClient();
    await waitForEvent(p1Socket, 'connect');

    const p1Join = await emitWithAck(p1Socket, EVENTS.SESSION_JOIN, {
      displayName: 'Aria',
    });
    assert.equal(p1Join.success, true);

    const rogueSocket = connectRawClient();
    await waitForEvent(rogueSocket, 'connect');

    // 1. Invalid / nonexistent session
    const badSession = await emitWithAck(rogueSocket, EVENTS.SESSION_JOIN, {
      sessionId: 'nonexistent-session',
      displayName: 'Rogue',
    });
    assert.equal(badSession.success, false);
    assert.equal(badSession.code, ERROR_CODES.SESSION_NOT_FOUND);

    // 2. Unauthorized DM role claim
    const fakeDm = await emitWithAck(rogueSocket, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'RogueDM',
      role: ROLES.DM,
    });
    assert.equal(fakeDm.success, false);
    assert.equal(fakeDm.code, ERROR_CODES.UNAUTHORIZED_ROLE);

    // 3. Duplicate active displayName
    const dupName = await emitWithAck(rogueSocket, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Aria',
    });
    assert.equal(dupName.success, false);
    assert.equal(dupName.code, ERROR_CODES.DUPLICATE_PLAYER_IDENTITY);

    // 4. Identity impersonation without valid reconnectToken
    const impersonate = await emitWithAck(rogueSocket, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Aria',
      playerId: p1Join.welcome.playerId,
      reconnectToken: 'invalid-token',
    });
    assert.equal(impersonate.success, false);
    assert.equal(impersonate.code, ERROR_CODES.UNAUTHORIZED_IDENTITY);
  });

  it('integrates client module (src/net/socket.js) with Zustand store (src/store/sessionStore.js) and prevents duplicate instances', async () => {
    const welcomePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(
          new Error(
            `Timed out waiting for store welcome (connection=${sessionStore.getState().connection}, error=${sessionStore.getState().connectionError})`,
          ),
        );
      }, 4000);
      const unsub = sessionStore.subscribe((state) => {
        if (state.currentUser?.id && state.session?.id) {
          clearTimeout(timer);
          unsub();
          resolve(state);
        }
      });
    });

    const sock1 = await clientConnect({
      host: '127.0.0.1',
      port: server.port,
      displayName: 'Theren',
    });

    // Calling connect() again with the same target returns the exact same socket instance
    const sock2 = await clientConnect({
      host: '127.0.0.1',
      port: server.port,
      displayName: 'Theren',
    });
    assert.equal(sock1, sock2);
    assert.equal(getSocket(), sock1);

    const storeState = await welcomePromise;
    assert.equal(storeState.connection, CONNECTION_STATUS.CONNECTED);
    assert.equal(storeState.currentUser.displayName, 'Theren');
    assert.equal(storeState.currentUser.role, ROLES.PLAYER);
    assert.equal(storeState.session.id, DEFAULT_SESSION_ID);
    assert.equal(storeState.participants.length, 1);

    // Clean disconnect resets store state
    clientDisconnect();
    assert.equal(getSocket(), null);
    assert.equal(sessionStore.getState().connection, CONNECTION_STATUS.DISCONNECTED);
    assert.equal(sessionStore.getState().currentUser, null);
  });
});
