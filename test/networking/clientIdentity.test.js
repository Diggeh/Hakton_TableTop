import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer } from '../../backend/server.js';
import { openDatabase } from '../../database/index.js';
import { createRepositories } from '../../database/repositories.js';
import { DEFAULT_SESSION_ID, EVENTS } from '../../shared/events.js';

// The renderer keeps identity in localStorage; emulate it before importing the
// network layer so the real persistence path is exercised.
const memoryStorage = new Map();
globalThis.localStorage = {
  getItem: (key) => (memoryStorage.has(key) ? memoryStorage.get(key) : null),
  setItem: (key, value) => memoryStorage.set(key, String(value)),
  removeItem: (key) => memoryStorage.delete(key),
};

const { connect, disconnect, requestState } = await import('../../src/net/socket.js');
const { sessionStore } = await import('../../src/store/sessionStore.js');

const IDENTITY_KEY = 'hakton.identity.v1';

function waitFor(predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const value = predicate();
      if (value) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for client state'));
      }
    }, 20);
  });
}

describe('client reconnect identity', () => {
  let db;
  let repos;
  let server;
  let localUrl;

  beforeEach(async () => {
    memoryStorage.clear();
    db = openDatabase(':memory:');
    repos = createRepositories(db);
    const map = repos.maps.createWithCampaign('Campaign', 'Drowned Sanctuary');
    repos.tokens.create({ id: 'tok-1', mapId: map.id, label: 'Mira', x: 70, y: 70 });

    server = await startServer({ repos, port: 0, host: '127.0.0.1' });
    localUrl = server.localUrl;
  });

  afterEach(async () => {
    disconnect({ forgetIdentity: true });
    await stopServer();
    db?.close();
    memoryStorage.clear();
  });

  it('restores the same participant after a transient disconnect', async () => {
    await connect(localUrl, { displayName: 'Aria', role: 'player', sessionId: DEFAULT_SESSION_ID });
    const first = await waitFor(() => sessionStore.getState().currentUser);
    assert.ok(first.id);
    assert.equal(first.role, 'player');

    const stored = JSON.parse(memoryStorage.get(IDENTITY_KEY));
    assert.equal(stored.playerId, first.id);
    assert.equal(stored.reconnectToken, first.reconnectToken);

    disconnect();
    assert.equal(sessionStore.getState().currentUser, null, 'memory state is cleared');
    assert.ok(memoryStorage.has(IDENTITY_KEY), 'identity survives a transient disconnect');

    await connect(localUrl, { displayName: 'Aria', role: 'player', sessionId: DEFAULT_SESSION_ID });
    const second = await waitFor(() => sessionStore.getState().currentUser);

    assert.equal(second.id, first.id, 'same player id');
    assert.equal(second.reconnectToken, first.reconnectToken, 'same reconnect token');
  });

  it('serves a fresh snapshot through requestState', async () => {
    await connect(localUrl, { displayName: 'Aria', role: 'player', sessionId: DEFAULT_SESSION_ID });
    await waitFor(() => sessionStore.getState().currentUser);

    const response = await requestState();
    assert.equal(response.ok, true);
    assert.equal(response.state.map.name, 'Drowned Sanctuary');
    assert.equal(response.state.tokens[0].x, 70);
    assert.equal(sessionStore.getState().map.name, 'Drowned Sanctuary');
  });

  it('forgets the identity only when leaving explicitly', async () => {
    await connect(localUrl, { displayName: 'Aria', role: 'player', sessionId: DEFAULT_SESSION_ID });
    await waitFor(() => sessionStore.getState().currentUser);
    assert.ok(memoryStorage.has(IDENTITY_KEY));

    disconnect({ forgetIdentity: true });
    assert.equal(memoryStorage.has(IDENTITY_KEY), false);
    assert.equal(sessionStore.getState().currentUser, null);
  });
});
