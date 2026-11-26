#!/usr/bin/env node
/**
 * Standalone CLI diagnostic harness for the Hakton P2P WebRTC voice mesh.
 *
 * Usage:
 *   node test/networking/voiceMeshHarness.js            # 3-peer mesh ( expandable up to 8 via --peers N )
 *   node test/networking/voiceMeshHarness.js --peers 8  # Full 8-peer concurrency test (28 bidirectional links)
 *   npm run voice:harness                               # Real Chromium WebRTC + WebAudio FFT tone verification
 */
import { io as createClient } from 'socket.io-client';
import { startServer, stopServer } from '../../backend/server.js';
import { DEFAULT_SESSION_ID, EVENTS, MAX_VOICE_PEERS, ROLES } from '../../shared/events.js';
import { VOICE_SINK_ID, VoiceMeshManager } from '../../src/net/voiceMesh.js';
import { createVoiceStore } from '../../src/store/voiceStore.js';
import { FakeDocument, FakePeerNetwork, FakeStream } from './voiceFakes.js';

function parsePeerCount(argv) {
  const idx = argv.indexOf('--peers');
  if (idx >= 0 && argv[idx + 1]) {
    const n = Number(argv[idx + 1]);
    if (Number.isInteger(n) && n >= 2 && n <= MAX_VOICE_PEERS) return n;
  }
  return 3;
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function runHarness() {
  const peerCount = parsePeerCount(process.argv.slice(2));
  console.log(`\n=== Hakton P2P Voice Mesh Headless Harness (${peerCount} peers) ===\n`);

  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    sessionId: DEFAULT_SESSION_ID,
    sessionName: 'Voice Mesh Diagnostic Session',
  });
  console.log(`[host] Server started at ${server.localUrl} (PeerServer mounted at /peerjs)\n`);

  const network = new FakePeerNetwork();
  const clients = [];

  try {
    for (let i = 0; i < peerCount; i += 1) {
      const isDm = i === 0;
      const name = isDm ? 'DM-Host' : `Player-${i}`;
      const peerId = `hakton-peer-${i + 1}`;

      const socket = createClient(server.localUrl, {
        transports: ['websocket'],
        reconnection: false,
      });
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });

      const joinRes = await emitAck(socket, EVENTS.SESSION_JOIN, {
        sessionId: DEFAULT_SESSION_ID,
        displayName: name,
        ...(isDm ? { role: ROLES.DM, hostToken: server.hostSecret } : {}),
      });
      if (!joinRes?.success) {
        throw new Error(`Failed to join session for ${name}: ${joinRes?.error}`);
      }

      const store = createVoiceStore();
      const doc = new FakeDocument();
      const mic = new FakeStream(name);
      const manager = new VoiceMeshManager({
        socket,
        createPeer: network.createPeer,
        getUserMedia: async () => mic,
        documentRef: doc,
        store,
        logger: (line) => console.log(line),
        label: name,
      });

      clients.push({ name, peerId, socket, manager, store, doc, mic });
    }

    // Sequentially join voice mesh so existing peers receive `player_joined` and dial newcomers
    for (const client of clients) {
      const res = await client.manager.join({ peerId: client.peerId });
      if (!res.success) {
        throw new Error(`${client.name} failed voice:join (${res.code}): ${res.error}`);
      }
    }

    // Wait for all N*(N-1)/2 bidirectional streams to settle
    await Promise.all(clients.map((c) => c.manager.waitForStreams(peerCount - 1, 5000)));

    console.log('\n--- Mesh Connectivity & Hidden <audio> Sink Matrix ---');
    const colWidth = 18;
    const header =
      'Listener \\ Speaker'.padEnd(20) +
      clients.map((c) => c.name.padEnd(colWidth)).join('');
    console.log(header);
    console.log('-'.repeat(header.length));

    for (const listener of clients) {
      let row = listener.name.padEnd(20);
      const audioEls = listener.doc.audioElements();
      const peersState = listener.store.getState().peers;

      for (const speaker of clients) {
        if (speaker === listener) {
          row += '-'.padEnd(colWidth);
          continue;
        }
        const peerEntry = peersState[speaker.peerId];
        const audioTag = audioEls.find((a) => a.peerId === speaker.peerId);
        const ok =
          peerEntry?.connectionState === 'connected' &&
          peerEntry?.streamActive === true &&
          audioTag?.el?.srcObject === speaker.mic &&
          audioTag?.el?.paused === false;
        row += (ok ? 'CONNECTED [audio]' : 'FAILED').padEnd(colWidth);
      }
      console.log(row);
    }

    const totalCalls = network.calls.length;
    const expectedCalls = (peerCount * (peerCount - 1)) / 2;
    const totalAudioTags = clients.reduce(
      (sum, c) => sum + (c.doc.getElementById(VOICE_SINK_ID)?.children.length ?? 0),
      0,
    );

    console.log(`\nTotal P2P calls dialed : ${totalCalls} (expected ${expectedCalls})`);
    console.log(`Total hidden <audio>   : ${totalAudioTags} (expected ${peerCount * (peerCount - 1)})`);
    console.log(
      `Host voice peer roster : ${server.sessionManager.getVoicePeers(DEFAULT_SESSION_ID).length} active peers`,
    );

    // Verify teardown when last peer leaves
    const leaver = clients[clients.length - 1];
    console.log(`\nSimulating ${leaver.name} (${leaver.peerId}) leaving voice mesh...`);
    leaver.manager.leave();
    await new Promise((r) => setTimeout(r, 50));

    for (const remaining of clients.slice(0, -1)) {
      const stillHasLeaver = remaining.doc
        .audioElements()
        .some((a) => a.peerId === leaver.peerId);
      if (stillHasLeaver) {
        throw new Error(`${remaining.name} still has <audio> element for departed peer ${leaver.peerId}`);
      }
    }
    console.log(
      `Verified: all remaining peers closed MediaConnection and removed <audio> for ${leaver.peerId}.\n`,
    );
    console.log('RESULT: PASS');
  } finally {
    for (const c of clients) {
      c.manager.leave({ notifyHost: false });
      c.socket.disconnect();
    }
    await stopServer();
  }
}

runHarness().catch((err) => {
  console.error('HARNESS FAILED:', err);
  process.exit(1);
});
