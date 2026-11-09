import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { io as createClient } from 'socket.io-client';
import { startServer, stopServer } from '../../backend/server.js';
import { SessionManager, sanitizeParticipant } from '../../backend/session/sessionManager.js';
import {
  DEFAULT_SESSION_ID,
  ERROR_CODES,
  EVENTS,
  MAX_VOICE_PEERS,
  ROLES,
} from '../../shared/events.js';
import { VOICE_SINK_ID, VoiceMeshManager } from '../../src/net/voiceMesh.js';
import { createVoiceStore, VOICE_STATUS } from '../../src/store/voiceStore.js';
import { FakeDocument, FakePeerNetwork, FakeStream } from './voiceFakes.js';

const TIMEOUT = { timeout: 30000 };

function emitAck(socket, event, payload) {
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

async function waitFor(predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

const sortedIds = (doc) =>
  doc
    .audioElements()
    .map((a) => a.peerId)
    .sort();

describe('SessionManager voice peer registry (backend/session/sessionManager.js)', () => {
  /** @type {SessionManager} */
  let manager;

  beforeEach(() => {
    manager = new SessionManager({ hostSecret: 'h'.repeat(48) });
    for (let i = 1; i <= 9; i += 1) {
      const res = manager.joinSession({ socketId: `s${i}`, displayName: `P${i}` });
      assert.equal(res.success, true);
    }
  });

  it('registers peer ids, exposes them publicly, but never the reconnect token', () => {
    const res = manager.registerVoicePeer({ socketId: 's1', peerId: 'peer-1' });
    assert.equal(res.success, true);
    assert.equal(res.changed, true);
    assert.equal(res.participant.peerId, 'peer-1');
    assert.deepEqual(
      manager.getVoicePeers(DEFAULT_SESSION_ID).map((p) => p.peerId),
      ['peer-1'],
    );

    const participant = manager.getParticipantBySocket('s1');
    const wire = sanitizeParticipant(participant);
    assert.equal(wire.peerId, 'peer-1');
    assert.equal('reconnectToken' in wire, false);
  });

  it('is idempotent for the same id and lets a participant swap ids', () => {
    manager.registerVoicePeer({ socketId: 's1', peerId: 'peer-1' });
    const again = manager.registerVoicePeer({ socketId: 's1', peerId: 'peer-1' });
    assert.equal(again.success, true);
    assert.equal(again.changed, false);

    const swapped = manager.registerVoicePeer({ socketId: 's1', peerId: 'peer-1b' });
    assert.equal(swapped.success, true);
    assert.equal(swapped.changed, true);
    assert.equal(swapped.previousPeerId, 'peer-1');
    assert.equal(manager.getVoicePeers(DEFAULT_SESSION_ID).length, 1);
  });

  it('rejects unknown sockets, malformed ids, and duplicate ids', () => {
    assert.equal(
      manager.registerVoicePeer({ socketId: 'ghost', peerId: 'x' }).code,
      ERROR_CODES.NOT_JOINED,
    );
    for (const bad of [undefined, null, 42, '', '   ', 'has space', '../etc', 'a'.repeat(129)]) {
      assert.equal(
        manager.registerVoicePeer({ socketId: 's1', peerId: bad }).code,
        ERROR_CODES.INVALID_PEER_ID,
        `peerId ${String(bad)}`,
      );
    }
    manager.registerVoicePeer({ socketId: 's1', peerId: 'taken' });
    assert.equal(
      manager.registerVoicePeer({ socketId: 's2', peerId: 'taken' }).code,
      ERROR_CODES.DUPLICATE_PEER_ID,
    );
  });

  it(`caps the mesh at ${MAX_VOICE_PEERS} peers and frees slots on unregister`, () => {
    for (let i = 1; i <= MAX_VOICE_PEERS; i += 1) {
      assert.equal(manager.registerVoicePeer({ socketId: `s${i}`, peerId: `peer-${i}` }).success, true);
    }
    const ninth = manager.registerVoicePeer({ socketId: 's9', peerId: 'peer-9' });
    assert.equal(ninth.success, false);
    assert.equal(ninth.code, ERROR_CODES.VOICE_MESH_FULL);

    // An existing member re-registering is not a new slot.
    assert.equal(manager.registerVoicePeer({ socketId: 's1', peerId: 'peer-1' }).success, true);

    const released = manager.unregisterVoicePeer('s2');
    assert.equal(released.previousPeerId, 'peer-2');
    assert.equal(manager.unregisterVoicePeer('s2'), null);
    assert.equal(manager.registerVoicePeer({ socketId: 's9', peerId: 'peer-9' }).success, true);
  });

  it('reports and clears the peer id on disconnect and on explicit leave', () => {
    manager.registerVoicePeer({ socketId: 's1', peerId: 'peer-1' });
    manager.registerVoicePeer({ socketId: 's2', peerId: 'peer-2' });

    const disc = manager.handleDisconnect('s1');
    assert.equal(disc.previousPeerId, 'peer-1');
    assert.equal(disc.participant.peerId, null);
    assert.deepEqual(
      manager.getVoicePeers(DEFAULT_SESSION_ID).map((p) => p.peerId),
      ['peer-2'],
    );

    const left = manager.leaveSession('s2');
    assert.equal(left.previousPeerId, 'peer-2');
    assert.equal(manager.getVoicePeers(DEFAULT_SESSION_ID).length, 0);
  });
});

describe('P2P voice mesh over the real host signaling (Socket.io + fake WebRTC)', () => {
  let server;
  let network;
  /** @type {import('socket.io-client').Socket[]} */
  let sockets;
  /** @type {VoiceMeshManager[]} */
  let managers;

  beforeEach(async () => {
    sockets = [];
    managers = [];
    network = new FakePeerNetwork();
    server = await startServer({ port: 0, host: '127.0.0.1', sessionId: DEFAULT_SESSION_ID });
  });

  afterEach(async () => {
    for (const m of managers) m.leave({ notifyHost: false });
    for (const s of sockets) s.disconnect();
    await stopServer();
  });

  async function connectSocket({ reconnection = false } = {}) {
    const socket = createClient(server.localUrl, {
      transports: ['websocket'],
      reconnection,
      reconnectionDelay: 50,
      reconnectionDelayMax: 100,
    });
    sockets.push(socket);
    await onceEvent(socket, 'connect');
    return socket;
  }

  /** A joined session participant with a voice manager wired to fakes (not yet in the voice mesh). */
  async function makeClient(name, { dm = false, reconnection = false } = {}) {
    const socket = await connectSocket({ reconnection });
    const joinAck = await emitAck(socket, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: name,
      ...(dm ? { role: ROLES.DM, hostToken: server.hostSecret } : {}),
    });
    assert.equal(joinAck.success, true, `${name} session:join`);

    const store = createVoiceStore();
    const doc = new FakeDocument();
    const mic = new FakeStream(name);
    const manager = new VoiceMeshManager({
      socket,
      createPeer: network.createPeer,
      getUserMedia: async () => mic,
      documentRef: doc,
      store,
      logger: null,
      label: name,
      ackTimeoutMs: 3000,
      openTimeoutMs: 3000,
    });
    managers.push(manager);
    return { name, socket, manager, store, doc, mic, welcome: joinAck.welcome };
  }

  it('builds a full 3-peer mesh: each pair is dialed exactly once, answered, and attached to a hidden <audio>', TIMEOUT, async () => {
    const a = await makeClient('Dungeon Master', { dm: true });
    const b = await makeClient('Aria');
    const c = await makeClient('Brog');

    assert.deepEqual(await a.manager.join({ peerId: 'peer-a' }), {
      success: true,
      peerId: 'peer-a',
      peers: [],
    });
    const bJoin = await b.manager.join({ peerId: 'peer-b' });
    assert.deepEqual(bJoin.peers.map((p) => p.peerId), ['peer-a']);
    await c.manager.join({ peerId: 'peer-c' });

    await Promise.all([a, b, c].map((x) => x.manager.waitForStreams(2)));

    // Existing clients dial newcomers; nobody dials backwards, so there is no glare.
    assert.deepEqual(
      network.calls.map((x) => `${x.from}>${x.to}`).sort(),
      ['peer-a>peer-b', 'peer-a>peer-c', 'peer-b>peer-c'],
    );

    const expected = { a: ['peer-b', 'peer-c'], b: ['peer-a', 'peer-c'], c: ['peer-a', 'peer-b'] };
    for (const [key, client] of Object.entries({ a, b, c })) {
      assert.deepEqual(sortedIds(client.doc), expected[key], `${client.name} <audio> tags`);
      const sink = client.doc.getElementById(VOICE_SINK_ID);
      assert.equal(sink.style.display, 'none');
      assert.equal(sink.getAttribute('aria-hidden'), 'true');
      for (const { el } of client.doc.audioElements()) {
        assert.equal(el.autoplay, true);
        assert.equal(el.paused, false, 'audio.play() was called');
      }
      for (const peer of Object.values(client.store.getState().peers)) {
        assert.equal(peer.streamActive, true);
        assert.equal(peer.connectionState, 'connected');
        assert.equal(peer.iceConnectionState, 'connected');
        assert.ok(peer.connectedAt);
      }
    }

    // The <audio> for B inside A's DOM plays B's microphone stream, i.e. the right track.
    const bInA = a.doc.audioElements().find((x) => x.peerId === 'peer-b');
    assert.equal(bInA.el.srcObject, b.mic);

    assert.equal(a.store.getState().peers['peer-b'].direction, 'outgoing');
    assert.equal(b.store.getState().peers['peer-a'].direction, 'incoming');
    assert.equal(a.store.getState().peers['peer-b'].displayName, 'Aria');

    // Verbose state log is populated for headless diagnosis.
    const logs = a.store.getState().connectionLogs.map((l) => `${l.scope}: ${l.message}`);
    assert.ok(logs.some((l) => l.includes('player_joined') && l.includes('peer-b')));
    assert.ok(logs.some((l) => l.includes('connection=connected')));
    assert.ok(logs.some((l) => l.includes('<audio> attached')));

    // Host is only the phone book.
    assert.deepEqual(
      server.sessionManager.getVoicePeers(DEFAULT_SESSION_ID).map((p) => p.peerId).sort(),
      ['peer-a', 'peer-b', 'peer-c'],
    );

    const stats = await a.manager.getStats();
    assert.ok(stats['peer-b'].inbound.bytesReceived > 0);
    assert.ok(stats['peer-b'].outbound.bytesSent > 0);
  });

  it(`supports ${MAX_VOICE_PEERS} concurrent peers (28 links) and rejects a 9th until a slot frees`, TIMEOUT, async () => {
    const clients = [];
    for (let i = 1; i <= MAX_VOICE_PEERS + 1; i += 1) clients.push(await makeClient(`P${i}`));
    const members = clients.slice(0, MAX_VOICE_PEERS);
    const ninth = clients[MAX_VOICE_PEERS];

    for (const [i, client] of members.entries()) {
      const res = await client.manager.join({ peerId: `peer-${i + 1}` });
      assert.equal(res.success, true, `${client.name} joined`);
    }
    await Promise.all(members.map((m) => m.manager.waitForStreams(MAX_VOICE_PEERS - 1, 15000)));

    const links = (MAX_VOICE_PEERS * (MAX_VOICE_PEERS - 1)) / 2;
    assert.equal(links, 28);
    assert.equal(network.calls.length, links, 'exactly one call per pair');
    for (const m of members) {
      assert.equal(m.doc.audioElements().length, MAX_VOICE_PEERS - 1, `${m.name} hears 7 peers`);
    }

    // 9th participant: rejected, mic released, peer destroyed, mesh untouched.
    const rejected = await ninth.manager.join({ peerId: 'peer-9' });
    assert.equal(rejected.success, false);
    assert.equal(rejected.code, ERROR_CODES.VOICE_MESH_FULL);
    assert.equal(ninth.store.getState().status, VOICE_STATUS.ERROR);
    assert.equal(ninth.mic.tracks[0].readyState, 'ended');
    assert.equal(network.peers.has('peer-9'), false);
    assert.equal(network.calls.length, links);
    assert.equal(server.sessionManager.getVoicePeers(DEFAULT_SESSION_ID).length, MAX_VOICE_PEERS);

    // A member leaves; the 9th can now take the slot and everyone dials them.
    members[0].manager.leave();
    await waitFor(
      () => members.slice(1).every((m) => m.manager.connections.size === MAX_VOICE_PEERS - 2),
      'remaining members to hang up on the leaver',
    );
    ninth.mic.tracks[0].readyState = 'live';
    const retry = await ninth.manager.join({ peerId: 'peer-9' });
    assert.equal(retry.success, true);
    await ninth.manager.waitForStreams(MAX_VOICE_PEERS - 1, 15000);
    assert.equal(network.calls.length, links + (MAX_VOICE_PEERS - 1));
  });

  it('tears down cleanly: socket drop and voice:leave hang up, remove <audio>, and release the mic', TIMEOUT, async () => {
    const a = await makeClient('A');
    const b = await makeClient('B');
    const c = await makeClient('C');
    await a.manager.join({ peerId: 'peer-a' });
    await b.manager.join({ peerId: 'peer-b' });
    await c.manager.join({ peerId: 'peer-c' });
    await Promise.all([a, b, c].map((x) => x.manager.waitForStreams(2)));

    // 1. B closes its table (socket.js `disconnect()` -> 'io client disconnect').
    const leftOnA = onceEvent(a.socket, EVENTS.VOICE_PEER_LEFT);
    b.socket.disconnect();
    const left = await leftOnA;
    assert.equal(left.peerId, 'peer-b');
    assert.equal(left.displayName, 'B');
    assert.equal(left.sessionId, DEFAULT_SESSION_ID);

    await waitFor(
      () => a.manager.connections.size === 1 && c.manager.connections.size === 1,
      'A and C to drop B',
    );
    assert.deepEqual(sortedIds(a.doc), ['peer-c']);
    assert.deepEqual(sortedIds(c.doc), ['peer-a']);
    assert.equal(b.mic.tracks[0].readyState, 'ended', "B's microphone released");
    assert.equal(b.store.getState().status, VOICE_STATUS.DISCONNECTED);
    assert.equal(b.doc.audioElements().length, 0);
    assert.deepEqual(
      server.sessionManager.getVoicePeers(DEFAULT_SESSION_ID).map((p) => p.peerId).sort(),
      ['peer-a', 'peer-c'],
    );

    // 2. C leaves voice only; it stays in the session.
    c.manager.leave();
    await waitFor(() => a.manager.connections.size === 0, 'A to drop C');
    assert.equal(a.doc.audioElements().length, 0);
    assert.equal(c.mic.tracks[0].readyState, 'ended');
    const cRow = server.sessionManager
      .getSanitizedParticipants(DEFAULT_SESSION_ID)
      .find((p) => p.displayName === 'C');
    assert.equal(cRow.connected, true);
    assert.equal(cRow.peerId, null);
  });

  it('re-registers and is re-dialed after a transport drop once the session identity is restored', TIMEOUT, async () => {
    const a = await makeClient('A');
    const b = await makeClient('B', { reconnection: true });

    // Mirrors src/net/socket.js: restore the identity on every reconnect.
    b.socket.on('connect', () =>
      b.socket.emit(EVENTS.SESSION_JOIN, {
        sessionId: DEFAULT_SESSION_ID,
        displayName: 'B',
        playerId: b.welcome.playerId,
        reconnectToken: b.welcome.reconnectToken,
      }),
    );

    await a.manager.join({ peerId: 'peer-a' });
    await b.manager.join({ peerId: 'peer-b' });
    await Promise.all([a.manager.waitForStreams(1), b.manager.waitForStreams(1)]);

    const seen = new Set();
    b.store.subscribe((s) => seen.add(s.status));

    b.socket.io.engine.close(); // simulate a Wi-Fi blip, not an intentional disconnect

    await waitFor(
      () =>
        b.store.getState().status === VOICE_STATUS.CONNECTED &&
        seen.has(VOICE_STATUS.RECONNECTING) &&
        a.manager.connections.size === 1 &&
        b.manager.connections.size === 1 &&
        a.doc.audioElements().length === 1 &&
        b.doc.audioElements().length === 1,
      'voice mesh to heal after reconnect',
      10000,
    );
    assert.equal(b.mic.tracks[0].readyState, 'live', 'mic stays open across the blip');
    assert.deepEqual(
      server.sessionManager.getVoicePeers(DEFAULT_SESSION_ID).map((p) => p.peerId).sort(),
      ['peer-a', 'peer-b'],
    );
  });

  it('speaks the documented wire contract (player_joined / player_left / session:peers) and validates input', TIMEOUT, async () => {
    const x = await connectSocket();
    const y = await connectSocket();
    const stranger = await connectSocket();

    // Not joined to a session yet.
    const early = await emitAck(stranger, EVENTS.VOICE_JOIN, { peerId: 'nope' });
    assert.equal(early.success, false);
    assert.equal(early.code, ERROR_CODES.NOT_JOINED);

    for (const [socket, name] of [[x, 'X'], [y, 'Y']]) {
      const ack = await emitAck(socket, EVENTS.SESSION_JOIN, { displayName: name });
      assert.equal(ack.success, true);
    }

    for (const bad of ['', 'has space', 'a'.repeat(129), 123, null]) {
      const res = await emitAck(x, EVENTS.VOICE_JOIN, { peerId: bad });
      assert.equal(res.code, ERROR_CODES.INVALID_PEER_ID);
    }

    // Y is already in voice; X joins and must announce itself to Y only.
    await emitAck(y, EVENTS.VOICE_JOIN, { peerId: 'peer-y' });
    const joinedOnY = onceEvent(y, EVENTS.VOICE_PEER_JOINED);
    const rosterOnX = onceEvent(x, EVENTS.SESSION_PEERS);
    let xHeardItself = false;
    x.on(EVENTS.VOICE_PEER_JOINED, () => {
      xHeardItself = true;
    });

    const xAck = await emitAck(x, EVENTS.VOICE_JOIN, { peerId: 'peer-x' });
    assert.equal(xAck.success, true);
    assert.equal(xAck.peerId, 'peer-x');
    assert.deepEqual(xAck.peers.map((p) => p.peerId), ['peer-y']);

    const payload = await joinedOnY;
    assert.equal(payload.peerId, 'peer-x');
    assert.equal(payload.displayName, 'X');
    assert.equal(payload.sessionId, DEFAULT_SESSION_ID);
    assert.ok(payload.playerId.startsWith('p_'));
    assert.equal('reconnectToken' in payload, false);

    const roster = await rosterOnX;
    assert.deepEqual(roster.map((p) => p.peerId).sort(), ['peer-x', 'peer-y']);

    // Same id again: acknowledged, but not re-announced (clients would double-dial).
    let reannounced = false;
    y.on(EVENTS.VOICE_PEER_JOINED, () => {
      reannounced = true;
    });
    assert.equal((await emitAck(x, EVENTS.VOICE_JOIN, { peerId: 'peer-x' })).success, true);

    // Duplicate id from another participant.
    const dup = await emitAck(y, EVENTS.VOICE_JOIN, { peerId: 'peer-x' });
    assert.equal(dup.code, ERROR_CODES.DUPLICATE_PEER_ID);

    // Leave is broadcast with the departed id.
    const leftOnY = onceEvent(y, EVENTS.VOICE_PEER_LEFT);
    assert.equal((await emitAck(x, EVENTS.VOICE_LEAVE, {})).success, true);
    assert.equal((await leftOnY).peerId, 'peer-x');

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(xHeardItself, false);
    assert.equal(reannounced, false);
  });
});
