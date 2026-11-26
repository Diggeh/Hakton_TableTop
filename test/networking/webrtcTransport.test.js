import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as createClient } from 'socket.io-client';
import { startServer, stopServer } from '../../backend/server.js';
import { openDatabase } from '../../database/index.js';
import { createRepositories } from '../../database/repositories.js';
import { initStorage } from '../../storage/index.js';
import { DEFAULT_SESSION_ID, ERROR_CODES, EVENTS, ROLES } from '../../shared/events.js';
import { resolveTargetUrl } from '../../src/net/socket.js';
import { WebRtcHostBridge } from '../../src/net/webrtcHostBridge.js';
import { createWebRtcSocket } from '../../src/net/webrtcClientAdapter.js';
import { sessionStore } from '../../src/store/sessionStore.js';
import { CHAT_EVENTS } from '../../shared/chatEvents.js';

class FakeDataConnection extends EventEmitter {
  constructor(network, ownerPeer, remotePeerId) {
    super();
    this.network = network;
    this.ownerPeer = ownerPeer;
    this.peer = remotePeerId;
    this.open = false;
    this.closed = false;
    this.twin = null;
  }

  send(data) {
    if (this.closed || !this.open || !this.twin || this.twin.closed) return;
    setImmediate(() => {
      if (!this.twin.closed) {
        this.twin.emit('data', data);
      }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.emit('close');
    if (this.twin && !this.twin.closed) {
      const twin = this.twin;
      setImmediate(() => twin.close());
    }
  }
}

class FakeDataPeer extends EventEmitter {
  constructor(network, id) {
    super();
    this.network = network;
    this.id = id;
    this.open = false;
    this.destroyed = false;
    this.disconnected = false;
    this.connections = new Set();
  }

  connect(remotePeerId) {
    const outgoing = new FakeDataConnection(this.network, this, remotePeerId);
    this.connections.add(outgoing);
    const target = this.network.peers.get(remotePeerId);
    if (!target || target.destroyed || !target.open) {
      setImmediate(() => {
        if (!this.destroyed) {
          this.emit('error', {
            type: 'peer-unavailable',
            message: `Could not connect to peer ${remotePeerId}`,
          });
        }
      });
      return outgoing;
    }
    const incoming = new FakeDataConnection(this.network, target, this.id);
    target.connections.add(incoming);
    outgoing.twin = incoming;
    incoming.twin = outgoing;
    setImmediate(() => {
      if (this.destroyed || target.destroyed) return;
      target.emit('connection', incoming);
      outgoing.open = true;
      incoming.open = true;
      outgoing.emit('open');
      incoming.emit('open');
    });
    return outgoing;
  }

  reconnect() {
    if (this.destroyed) return;
    this.disconnected = false;
    setImmediate(() => {
      if (!this.destroyed) this.emit('open', this.id);
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.open = false;
    this.network.peers.delete(this.id);
    for (const c of [...this.connections]) c.close();
    this.connections.clear();
    this.emit('close');
  }
}

class FakeDataPeerNetwork {
  constructor() {
    this.peers = new Map();
    this.seq = 0;
  }

  createHostPeer = async (peerId) => {
    const peer = new FakeDataPeer(this, peerId);
    this.peers.set(peerId, peer);
    setImmediate(() => {
      if (peer.destroyed) return;
      peer.open = true;
      peer.emit('open', peerId);
    });
    return peer;
  };

  createClientPeer = async () => {
    const id = `client-peer-${++this.seq}`;
    const peer = new FakeDataPeer(this, id);
    this.peers.set(id, peer);
    setImmediate(() => {
      if (peer.destroyed) return;
      peer.open = true;
      peer.emit('open', id);
    });
    return peer;
  };
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function onceEvent(socket, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe('PeerJS WebRTC Internet Transport (Host Bridge + Client Adapter)', () => {
  let tmpDir;
  let storage;
  let db;
  let repos;
  let server;
  let dmSocket;
  let fakeNet;
  let bridge;
  let largeAssetBytes;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakton-webrtc-test-'));
    storage = initStorage(tmpDir);
    largeAssetBytes = Buffer.alloc(48 * 1024);
    for (let i = 0; i < largeAssetBytes.length; i += 1) {
      largeAssetBytes[i] = i % 251;
    }
    fs.writeFileSync(path.join(storage.dirs.maps, 'large-map.bin'), largeAssetBytes);

    db = openDatabase(':memory:');
    repos = createRepositories(db);
    const map = repos.maps.createWithCampaign('Internet Test', 'Drowned Sanctuary');
    repos.tokens.create({
      id: 'tok-hero',
      mapId: map.id,
      label: 'Hero',
      x: 100,
      y: 100,
      ownerId: null,
      locked: false,
      color: '#adfcf9',
    });

    server = await startServer({ repos, storage, port: 0, host: '127.0.0.1' });

    dmSocket = createClient(server.localUrl, { transports: ['websocket'], reconnection: false });
    await new Promise((resolve, reject) => {
      dmSocket.once('connect', resolve);
      dmSocket.once('connect_error', reject);
    });
    const dmJoin = await emitWithAck(dmSocket, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Dungeon Master',
      role: ROLES.DM,
      hostToken: server.hostSecret,
    });
    assert.equal(dmJoin.success, true);

    fakeNet = new FakeDataPeerNetwork();
    bridge = new WebRtcHostBridge({
      internetCode: server.internetCode,
      localUrl: server.localUrl,
      createPeer: fakeNet.createHostPeer,
      createLocalSocket: (url, opts) => createClient(url, opts),
    });
    const started = await bridge.start();
    assert.equal(started.ok, true);
  });

  afterEach(async () => {
    await bridge?.stop();
    dmSocket?.disconnect();
    await stopServer();
    db?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves webrtc:// scheme in resolveTargetUrl instead of prepending http://', () => {
    assert.equal(
      resolveTargetUrl('webrtc://hakton-net-7h9k42m1'),
      'webrtc://hakton-net-7h9k42m1',
    );
    assert.equal(resolveTargetUrl('192.168.1.5:3001'), 'http://192.168.1.5:3001');
  });

  it('connects a remote player over WebRTC DataChannel, strips hostToken, syncs state/moves/chat, and serves chunked >32KiB assets', async () => {
    const targetUrl = `webrtc://${bridge.peerId}`;
    const client = createWebRtcSocket(targetUrl, {
      createPeer: fakeNet.createClientPeer,
      reconnectionAttempts: 2,
      reconnectionDelay: 50,
    });
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
      client.connect();
    });
    assert.equal(client.connected, true);

    // Security: hostToken escalation attempt must be stripped by WebRtcHostBridge
    const escalation = await emitWithAck(client, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Spoofer',
      role: ROLES.DM,
      hostToken: server.hostSecret,
    });
    assert.equal(escalation.success, false);
    assert.equal(escalation.code, ERROR_CODES.UNAUTHORIZED_ROLE);

    // Normal player join + authoritative state snapshot
    const statePromise = onceEvent(client, EVENTS.SESSION_STATE);
    const joinRes = await emitWithAck(client, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'RemoteAria',
      role: ROLES.PLAYER,
    });
    assert.equal(joinRes.success, true);
    assert.equal(joinRes.welcome.role, ROLES.PLAYER);

    const snapshot = await statePromise;
    assert.equal(snapshot.tokens.length, 1);
    assert.equal(snapshot.tokens[0].id, 'tok-hero');

    // Token move propagates back to DM
    const movedOnDm = onceEvent(dmSocket, EVENTS.TOKEN_MOVED);
    const moveAck = await new Promise((resolve) => {
      client.timeout(4000).emit(
        EVENTS.TOKEN_MOVE,
        { id: 'tok-hero', x: 350, y: 245, moveId: 'm-1' },
        (err, res) => resolve({ err, res }),
      );
    });
    assert.equal(moveAck.err, null);
    assert.equal(moveAck.res.ok, true);
    const dmMove = await movedOnDm;
    assert.equal(dmMove.x, 350);
    assert.equal(dmMove.y, 245);

    // Chat send via timeout-style ack propagates to DM
    const chatOnDm = onceEvent(dmSocket, CHAT_EVENTS.MESSAGE);
    const chatAck = await new Promise((resolve) => {
      client.timeout(4000).emit(
        CHAT_EVENTS.SEND,
        { text: 'Hello over PeerJS!', type: 'text', requestId: 'req-chat-1' },
        (err, res) => resolve({ err, res }),
      );
    });
    assert.equal(chatAck.err, null);
    assert.equal(chatAck.res.success, true);
    const receivedChat = await chatOnDm;
    assert.equal(receivedChat.text, 'Hello over PeerJS!');

    // Chunked >32 KiB asset proxy succeeds & matches exact bytes
    const fetched = await client.requestAsset('/assets/maps/large-map.bin');
    assert.equal(Buffer.from(fetched.base64, 'base64').equals(largeAssetBytes), true);

    // Path traversal is rejected
    await assert.rejects(
      () => client.requestAsset('/assets/../secret.txt'),
      /Invalid or forbidden/i,
    );

    // Host intentional stop triggers SERVER_SHUTDOWN and halts retries immediately
    const shutdownPromise = onceEvent(client, EVENTS.SERVER_SHUTDOWN);
    await bridge.stop({ reason: 'Host ended the session.' });
    const shutdownInfo = await shutdownPromise;
    assert.equal(shutdownInfo.reason, 'Host ended the session.');
    assert.equal(client.active, false);
    assert.equal(sessionStore.getState().internetBridge.status, 'offline');
  });

  it('reports human-readable peer-unavailable errors and stops after bounded retries', async () => {
    const offlineClient = createWebRtcSocket('webrtc://hakton-net-missing99', {
      createPeer: fakeNet.createClientPeer,
      reconnectionAttempts: 1,
      reconnectionDelay: 20,
      reconnectionDelayMax: 40,
      attemptTimeoutMs: 1000,
    });

    const errors = [];
    offlineClient.on('connect_error', (err) => errors.push(err.message));

    await new Promise((resolve) => {
      offlineClient.io.once('reconnect_failed', resolve);
      offlineClient.connect();
    });

    assert.equal(offlineClient.active, false);
    assert.ok(errors.some((m) => /not found|offline/i.test(m)));
    assert.equal(errors.some((m) => /websocket error/i.test(m)), false);
  });
});
