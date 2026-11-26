import { VoiceMeshManager, VOICE_SINK_ID } from '/src/net/voiceMesh.js';
import { resolvePeerOptions } from '/src/net/peerOptions.js';
import { createVoiceStore } from '/src/store/voiceStore.js';
import { evaluate, formatMatrix } from '/harness/evaluate.js';

/**
 * Real-WebRTC harness: N VoiceMeshManagers inside one page, each with its own Socket.io session,
 * PeerJS peer, and RTCPeerConnections to every other. Exercises exactly the production manager.
 *
 * mic=synthetic (default): each peer speaks a distinct sine tone, so we can prove the RIGHT audio
 *                          arrives at the RIGHT listener by detecting its frequency.
 * mic=device:              uses navigator.mediaDevices.getUserMedia (Chrome's fake device when the
 *                          CLI launches it); tone checks are skipped.
 */
const params = new URLSearchParams(location.search);
const PEERS = Math.min(Math.max(Number(params.get('peers') ?? 3), 2), 8);
const MIC = params.get('mic') === 'device' ? 'device' : 'synthetic';
const SETTLE_MS = Number(params.get('settle') ?? 2500);
const STATS_WINDOW_MS = 1500;

const out = document.getElementById('out');
const lines = [];
const say = (message) => {
  lines.push(message);
  out.textContent = lines.join('\n');
  console.log('[harness]', message);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freqFor = (index) => 400 + 200 * index;

const audioCtx = new AudioContext();

function syntheticMic(freq) {
  const osc = audioCtx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const dest = audioCtx.createMediaStreamDestination();
  osc.connect(dest);
  osc.start();
  return dest.stream;
}

const createPeer = async (options, requestedId) =>
  requestedId ? new window.peerjs.Peer(requestedId, options) : new window.peerjs.Peer(options);

async function makeClient(index) {
  const name = `Harness-${index + 1}`;
  const socket = window.io(location.origin, { transports: ['websocket'], reconnection: false });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const ack = await new Promise((resolve) =>
    socket.emit('session:join', { displayName: name }, resolve),
  );
  if (!ack?.success) throw new Error(`${name} session:join failed: ${ack?.error}`);

  const freq = freqFor(index);
  const store = createVoiceStore();
  const micStream = MIC === 'synthetic' ? syntheticMic(freq) : null;
  const manager = new VoiceMeshManager({
    socket,
    createPeer,
    peerOptions: resolvePeerOptions({ socket }),
    ...(micStream ? { getUserMedia: async () => micStream } : {}),
    documentRef: document,
    store,
    logger: (line) => console.log(line),
    label: name,
  });
  return { name, freq, socket, manager, store };
}

/** Dominant frequency of a remote stream via an AnalyserNode. */
async function detectTone(stream) {
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 8192;
  source.connect(analyser);
  const bins = new Float32Array(analyser.frequencyBinCount);
  let best = { hz: null, db: -Infinity };
  for (let i = 0; i < 6; i += 1) {
    await sleep(150);
    analyser.getFloatFrequencyData(bins);
    let peak = 0;
    for (let b = 1; b < bins.length; b += 1) if (bins[b] > bins[peak]) peak = b;
    if (bins[peak] > best.db) {
      best = { hz: (peak * audioCtx.sampleRate) / analyser.fftSize, db: bins[peak] };
    }
  }
  source.disconnect();
  return best;
}

async function run() {
  await audioCtx.resume();
  say(`Mode: ${MIC} mic, ${PEERS} peers, ${navigator.userAgent}`);

  const clients = [];
  for (let i = 0; i < PEERS; i += 1) clients.push(await makeClient(i));
  const byPeerId = new Map();

  // Sequential joins make the dial order deterministic (existing peers dial the newcomer).
  const joins = [];
  for (const client of clients) {
    const result = await client.manager.join();
    joins.push({ name: client.name, ...result });
    if (result.success) byPeerId.set(result.peerId, client);
    say(`${client.name}: voice:join -> ${result.success ? `ok as ${result.peerId}` : `${result.code} ${result.error}`}`);
  }
  if (joins.some((j) => !j.success)) return { peers: PEERS, mic: MIC, joins, links: [], audioTagTotal: 0, leave: null };

  say('Waiting for every pair to connect and stream…');
  await Promise.all(clients.map((c) => c.manager.waitForStreams(PEERS - 1, 25000)));

  say(`Mesh connected. Letting audio flow for ${SETTLE_MS}ms, then sampling WebRTC stats…`);
  await sleep(SETTLE_MS);
  const before = await Promise.all(clients.map((c) => c.manager.getStats()));
  await sleep(STATS_WINDOW_MS);
  const after = await Promise.all(clients.map((c) => c.manager.getStats()));

  const links = [];
  for (const [li, listener] of clients.entries()) {
    for (const [speakerPeerId, rec] of listener.manager.connections) {
      const speaker = byPeerId.get(speakerPeerId);
      const b = before[li][speakerPeerId]?.inbound;
      const a = after[li][speakerPeerId]?.inbound;
      const audio = listener.manager.audioEls.get(speakerPeerId);
      const tone = MIC === 'synthetic' && rec.stream ? await detectTone(rec.stream) : { hz: null, db: null };
      links.push({
        listener: listener.name,
        speaker: speaker?.name ?? speakerPeerId,
        speakerFreq: speaker?.freq ?? null,
        connectionState: rec.call.peerConnection?.connectionState ?? 'unknown',
        iceConnectionState: rec.call.peerConnection?.iceConnectionState ?? 'unknown',
        streamActive: Boolean(listener.store.getState().peers[speakerPeerId]?.streamActive),
        audioTag: Boolean(audio && audio.srcObject === rec.stream && audio.isConnected),
        audioPlaying: Boolean(audio && !audio.paused),
        bytesDelta: (a?.bytesReceived ?? 0) - (b?.bytesReceived ?? 0),
        energyDelta:
          a?.totalAudioEnergy != null && b?.totalAudioEnergy != null
            ? a.totalAudioEnergy - b.totalAudioEnergy
            : null,
        detectedHz: tone.hz,
        toneDb: tone.db,
      });
    }
  }

  const sink = document.getElementById(VOICE_SINK_ID);
  const audioTagTotal = sink ? sink.querySelectorAll('audio').length : 0;

  // Teardown phase: one participant leaves; everyone must hang up and drop its <audio>.
  let leave = null;
  if (PEERS >= 3) {
    const leaver = clients[1];
    const leaverPeerId = leaver.manager.peerId;
    say(`${leaver.name} leaves the mesh…`);
    leaver.manager.leave();
    await sleep(1500);
    leave = {
      leaver: leaver.name,
      remaining: clients
        .filter((c) => c !== leaver)
        .map((c) => ({
          name: c.name,
          connections: c.manager.connections.size,
          audioTagsForLeaver: document.querySelectorAll(
            `#${VOICE_SINK_ID} audio[data-voice-peer-id="${leaverPeerId}"]`,
          ).length,
        })),
    };
  }

  const logs = Object.fromEntries(
    clients.map((c) => [c.name, c.store.getState().connectionLogs.slice(-60)]),
  );
  // Peers stay up on purpose so the CLI can inspect the host's roster; the browser is killed after.
  return { peers: PEERS, mic: MIC, joins, links, audioTagTotal, leave, logs };
}

try {
  const report = await run();
  const evaluation = evaluate(report);
  say('');
  say(formatMatrix(report, evaluation));
  say('');
  say(evaluation.ok ? 'RESULT: PASS' : `RESULT: FAIL\n - ${evaluation.failures.join('\n - ')}`);
  document.title = evaluation.ok ? 'PASS' : 'FAIL';
  await fetch('/harness/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ report }),
  });
} catch (error) {
  say(`HARNESS ERROR: ${error?.stack ?? error}`);
  document.title = 'ERROR';
  await fetch('/harness/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: String(error?.stack ?? error) }),
  }).catch(() => {});
}
