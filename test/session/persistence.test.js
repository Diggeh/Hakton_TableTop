import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

describe('session identity persistence across host restarts', () => {
  let db;
  let repos;
  let server;
  let socket;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repos = createRepositories(db);
  });

  afterEach(async () => {
    socket?.disconnect();
    socket = null;
    await stopServer();
    db?.close();
  });

  it('restores a player identity and reconnect token after the host restarts', async () => {
    server = await startServer({ repos, port: 0, host: '127.0.0.1' });
    socket = await connectRaw(server.localUrl);

    const first = await emitWithAck(socket, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Aria',
    });
    assert.equal(first.success, true);

    const { playerId, reconnectToken } = first.welcome;
    assert.match(playerId, /^p_/);
    assert.equal(typeof reconnectToken, 'string');

    // Only the digest is stored, never the raw token.
    const stored = repos.sessions.getParticipant(playerId);
    assert.equal(stored.reconnectTokenHash, crypto.createHash('sha256').update(reconnectToken).digest('hex'));
    assert.notEqual(stored.reconnectTokenHash, reconnectToken);

    socket.disconnect();
    socket = null;
    await stopServer();
    server = null;
    assert.equal(repos.sessions.getParticipant(playerId).connected, false);

    // Host restarts: new SessionManager, same SQLite file.
    server = await startServer({ repos, port: 0, host: '127.0.0.1' });
    socket = await connectRaw(server.localUrl);

    const restored = await emitWithAck(socket, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Aria',
      playerId,
      reconnectToken,
    });

    assert.equal(restored.success, true);
    assert.equal(restored.welcome.playerId, playerId);
    assert.equal(restored.welcome.reconnectToken, reconnectToken);
    assert.equal(restored.welcome.role, ROLES.PLAYER);
    assert.equal(
      restored.welcome.participants.find((p) => p.id === playerId)?.connected,
      true,
    );
  });

  it('rejects a forged reconnect token after restoring identities', async () => {
    server = await startServer({ repos, port: 0, host: '127.0.0.1' });
    socket = await connectRaw(server.localUrl);

    const first = await emitWithAck(socket, EVENTS.SESSION_JOIN, {
      displayName: 'Aria',
    });
    const { playerId, reconnectToken } = first.welcome;

    socket.disconnect();
    socket = null;
    await stopServer();
    server = null;

    server = await startServer({ repos, port: 0, host: '127.0.0.1' });
    socket = await connectRaw(server.localUrl);

    const forged = await emitWithAck(socket, EVENTS.SESSION_JOIN, {
      displayName: 'Aria',
      playerId,
      reconnectToken: 'not-the-real-token',
    });

    assert.equal(forged.success, false);
    assert.equal(forged.code, 'E_UNAUTHORIZED_IDENTITY');
    assert.notEqual(reconnectToken, 'not-the-real-token');
  });
});
