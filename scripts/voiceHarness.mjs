#!/usr/bin/env node
/**
 * Real-WebRTC verification of the Hakton P2P voice mesh, with no UI.
 *
 *   npm run voice:harness                      # 3 peers, synthetic tones, headless Chrome/Edge
 *   npm run voice:harness -- --peers 8         # full-size mesh (28 links)
 *   npm run voice:harness -- --mic device      # use Chrome's fake capture device (getUserMedia path)
 *   npm run voice:harness -- --headed          # watch it run
 *   npm run voice:harness -- --manual          # just serve the page; open the printed URL yourself
 *
 * Boots the REAL host (Socket.io + PeerServer), serves test/voice-harness/, launches a browser that
 * creates N real PeerJS peers, and checks per directed link: RTCPeerConnection `connected`, remote
 * stream attached to a hidden <audio>, inbound RTP bytes growing, and (synthetic) the speaker's tone
 * actually detected at the listener. Exit code 0 only if every link passes.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { startServer } from '../backend/server.js';
import { DEFAULT_SESSION_ID } from '../shared/events.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { peers: 3, mic: 'synthetic', headed: false, manual: false, verbose: false, timeout: 90, browser: process.env.HAKTON_BROWSER };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === '--peers') args.peers = Number(next());
    else if (flag === '--mic') args.mic = next();
    else if (flag === '--browser') args.browser = next();
    else if (flag === '--timeout') args.timeout = Number(next());
    else if (flag === '--headed') args.headed = true;
    else if (flag === '--manual') args.manual = true;
    else if (flag === '--verbose') args.verbose = true;
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!Number.isInteger(args.peers) || args.peers < 2 || args.peers > 8) throw new Error('--peers must be 2..8');
  if (!['synthetic', 'device'].includes(args.mic)) throw new Error('--mic must be synthetic|device');
  return args;
}

function findBrowser(explicit) {
  const candidates = [
    explicit,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

const args = parseArgs(process.argv.slice(2));
const { evaluate, formatMatrix } = await import(pathToFileURL(path.join(root, 'test/voice-harness/evaluate.js')));

const server = await startServer({ port: 0, host: '127.0.0.1', sessionId: DEFAULT_SESSION_ID });
const { app } = server;

app.use('/harness', express.static(path.join(root, 'test/voice-harness')));
app.use('/src', express.static(path.join(root, 'src')));
app.use('/shared', express.static(path.join(root, 'shared')));
app.use('/vendor/zustand', express.static(path.join(root, 'node_modules/zustand/esm')));
app.get('/vendor/peerjs.min.js', (_req, res) =>
  res.sendFile(path.join(root, 'node_modules/peerjs/dist/peerjs.min.js')),
);

const reportPromise = new Promise((resolve) => {
  app.post('/harness/report', express.json({ limit: '10mb' }), (req, res) => {
    res.json({ ok: true });
    resolve(req.body);
  });
});

const url = `${server.localUrl}/harness/index.html?peers=${args.peers}&mic=${args.mic}`;
console.log(`[voice-harness] host listening on ${server.localUrl} (Socket.io + /peerjs)`);
console.log(`[voice-harness] harness page: ${url}`);

let browser = null;
let profileDir = null;
let timer = null;
let shuttingDown = false;

async function shutdown(code) {
  shuttingDown = true;
  clearTimeout(timer);
  killTree(browser);
  await server.close().catch(() => {});
  if (profileDir) {
    // Chrome may still hold file handles for a moment after being killed.
    for (let i = 0; i < 5; i += 1) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
  process.exit(code);
}

if (args.manual) {
  console.log('[voice-harness] --manual: open the URL above in Chrome/Edge. Ctrl+C to stop.');
} else {
  const exe = findBrowser(args.browser);
  if (!exe) {
    console.error('[voice-harness] No Chrome/Edge found. Pass --browser <path> or use --manual.');
    await shutdown(2);
  }
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakton-voice-'));
  const flags = [
    ...(args.headed ? [] : ['--headless=new']),
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--autoplay-policy=no-user-gesture-required',
    // Expose real host candidates instead of mDNS names so loopback/LAN ICE works with zero STUN.
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    ...(args.mic === 'device' ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : []),
    url,
  ];
  console.log(`[voice-harness] launching ${path.basename(exe)}${args.headed ? ' (headed)' : ' (headless)'}…`);
  browser = spawn(exe, flags, { stdio: 'ignore' });
  browser.on('exit', (code) => {
    if (!shuttingDown && code && code !== 0) console.error(`[voice-harness] browser exited early with code ${code}`);
  });
}

timer = setTimeout(async () => {
  console.error(`[voice-harness] TIMEOUT after ${args.timeout}s without a report.`);
  await shutdown(3);
}, args.timeout * 1000);
if (args.manual) clearTimeout(timer);

const body = await reportPromise;
if (body.error) {
  console.error(`[voice-harness] harness page crashed:\n${body.error}`);
  await shutdown(1);
}

const { report } = body;
const evaluation = evaluate(report);
console.log(`\nReal WebRTC mesh: ${report.peers} peers, ${report.mic} mic\n`);
console.log(formatMatrix(report, evaluation));

// Host-side truth: the phone book must match what the clients did (one peer left voice mid-run).
const hostPeers = server.sessionManager.getVoicePeers(DEFAULT_SESSION_ID);
const expectedHostPeers = report.leave ? report.peers - 1 : report.peers;
console.log(`\nHost voice roster: ${hostPeers.length} peer(s) (expected ${expectedHostPeers})`);
if (hostPeers.length !== expectedHostPeers) evaluation.failures.push(`host still lists ${hostPeers.length} voice peer(s)`);

if (args.verbose && report.logs) {
  for (const [name, entries] of Object.entries(report.logs)) {
    console.log(`\n--- ${name} connection log (last ${entries.length}) ---`);
    for (const e of entries) console.log(`${e.at} [${e.level}] ${e.scope}: ${e.message}`);
  }
}

if (evaluation.failures.length) {
  console.log('\nRESULT: FAIL');
  for (const failure of evaluation.failures) console.log(` - ${failure}`);
  await shutdown(1);
}
console.log('\nRESULT: PASS - every pair is connected, audio is attached, bytes are flowing, and tones match.');
await shutdown(0);
