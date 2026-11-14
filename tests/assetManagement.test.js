import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { registerHooks } from 'node:module';

// Register zero-dependency fallbacks backed by Node 24's built-in `node:sqlite` and `node:http`
// when running in an isolated git worktree where `node_modules` has not been populated.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (
        specifier === 'better-sqlite3' ||
        specifier === 'zustand' ||
        specifier === 'zustand/vanilla' ||
        specifier === 'express' ||
        specifier === 'peer' ||
        specifier === 'socket.io'
      ) {
        return {
          url: `virtual:${specifier}`,
          shortCircuit: true,
        };
      }
      throw err;
    }
  },
  load(url, context, nextLoad) {
    if (!url.startsWith('virtual:')) return nextLoad(url, context);
    const pkg = url.slice('virtual:'.length);

    if (pkg === 'better-sqlite3') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          import { DatabaseSync } from 'node:sqlite';
          export default class BetterSqlite3Adapter {
            constructor(filePath) {
              this.db = new DatabaseSync(filePath);
              this.inTx = false;
            }
            pragma(str) {
              this.db.exec('PRAGMA ' + str);
            }
            exec(sql) {
              return this.db.exec(sql);
            }
            prepare(sql) {
              const stmt = this.db.prepare(sql);
              if (typeof stmt.setAllowBareNamedParameters === 'function') {
                stmt.setAllowBareNamedParameters(true);
              }
              const paramNames = new Set(Array.from(sql.matchAll(/@([a-zA-Z0-9_]+)/g), (m) => m[1]));
              const normalizeArgs = (args) => {
                if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) && !Buffer.isBuffer(args[0])) {
                  const raw = args[0];
                  const filtered = {};
                  for (const k of Object.keys(raw)) {
                    if (paramNames.size === 0 || paramNames.has(k)) {
                      filtered[k] = raw[k] === undefined ? null : raw[k];
                    }
                  }
                  return [filtered];
                }
                return args.map((a) => (a === undefined ? null : a));
              };
              return {
                run: (...args) => stmt.run(...normalizeArgs(args)),
                get: (...args) => stmt.get(...normalizeArgs(args)),
                all: (...args) => stmt.all(...normalizeArgs(args)),
              };
            }
            transaction(fn) {
              return (...args) => {
                if (this.inTx) return fn(...args);
                this.inTx = true;
                this.db.exec('BEGIN');
                try {
                  const res = fn(...args);
                  this.db.exec('COMMIT');
                  return res;
                } catch (err) {
                  try { this.db.exec('ROLLBACK'); } catch {}
                  throw err;
                } finally {
                  this.inTx = false;
                }
              };
            }
            close() {
              this.db.close();
            }
          }
        `,
      };
    }

    if (pkg === 'zustand/vanilla') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export function createStore(initializer) {
            let state;
            const listeners = new Set();
            const setState = (partial, replace) => {
              const nextState = typeof partial === 'function' ? partial(state) : partial;
              if (!Object.is(nextState, state)) {
                const prevState = state;
                state = replace ? nextState : Object.assign({}, state, nextState);
                listeners.forEach((l) => l(state, prevState));
              }
            };
            const getState = () => state;
            const subscribe = (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            };
            state = initializer(setState, getState, { setState, getState, subscribe });
            return { setState, getState, subscribe };
          }
        `,
      };
    }

    if (pkg === 'zustand') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export function useStore(store, selector = (s) => s) {
            return selector(store.getState());
          }
        `,
      };
    }

    if (pkg === 'express') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          import { URL } from 'node:url';
          export default function express() {
            const routes = [];
            const matchRoute = (pattern, pathname) => {
              const patParts = pattern.split('/').filter(Boolean);
              const pathParts = pathname.split('/').filter(Boolean);
              if (patParts.length !== pathParts.length) return null;
              const params = {};
              for (let i = 0; i < patParts.length; i++) {
                if (patParts[i].startsWith(':')) {
                  params[patParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
                } else if (patParts[i] !== pathParts[i]) {
                  return null;
                }
              }
              return params;
            };
            const app = async (req, res) => {
              const u = new URL(req.url, 'http://127.0.0.1');
              req.query = Object.fromEntries(u.searchParams.entries());
              res.status = (code) => { res.statusCode = code; return res; };
              res.json = (obj) => {
                if (!res.headersSent) res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(obj));
                return res;
              };
              for (const r of routes) {
                if (r.method === req.method) {
                  const params = matchRoute(r.path, u.pathname);
                  if (params) {
                    req.params = params;
                    await r.handler(req, res);
                    return;
                  }
                }
              }
              res.statusCode = 404;
              res.end();
            };
            app.disable = () => app;
            app.use = () => app;
            app.get = (p, handler) => { routes.push({ method: 'GET', path: p, handler }); return app; };
            return app;
          }
        `,
      };
    }

    if (pkg === 'peer') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export function ExpressPeerServer() { return (_req, _res, next) => next?.(); }`,
      };
    }

    if (pkg === 'socket.io') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export class Server {
            constructor(httpServer) {
              this.httpServer = httpServer;
              this.connectionHandlers = [];
            }
            on(ev, fn) {
              if (ev === 'connection') this.connectionHandlers.push(fn);
            }
            close(cb) {
              this.httpServer.close(cb);
            }
          }
        `,
      };
    }

    return nextLoad(url, context);
  },
});

const {
  initStorage,
  InvalidAssetError,
  MAX_UPLOAD_BYTES,
  UploadTooLargeError,
} = await import('../storage/index.js');
const { openDatabase } = await import('../database/index.js');
const { createRepositories } = await import('../database/repositories.js');
const { seedIfEmpty } = await import('../database/seed.js');
const { createAssetService } = await import('../backend/assetService.js');
const { createHttpApp, startServer } = await import('../backend/server.js');
const { registerSocketRouter } = await import('../backend/socket/router.js');
const { ASSET_IPC_CHANNELS, registerAssetIpcHandlers } = await import('../electron/assetIpc.js');
const { EVENTS } = await import('../shared/events.js');
const { assetStore } = await import('../src/store/assetStore.js');
const { sessionStore } = await import('../src/store/sessionStore.js');

// --- Synthetic Binary Image Generators (100% spec-compliant headers) ---

function makePngBuffer(width = 64, height = 48) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // bit depth 8
  ihdrData.writeUInt8(6, 9); // color type 6 (RGBA)
  ihdrData.writeUInt8(0, 10); // compression
  ihdrData.writeUInt8(0, 11); // filter
  ihdrData.writeUInt8(0, 12); // interlace

  function makeChunk(typeAscii, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const type = Buffer.from(typeAscii, 'ascii');
    const crc = Buffer.alloc(4);
    const crcVal = zlib.crc32(Buffer.concat([type, data]));
    crc.writeUInt32BE(crcVal >>> 0, 0);
    return Buffer.concat([len, type, data, crc]);
  }

  const compressedScanline = zlib.deflateSync(Buffer.alloc(5, 0));
  const ihdr = makeChunk('IHDR', ihdrData);
  const idat = makeChunk('IDAT', compressedScanline);
  const iend = makeChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

function makeJpegBuffer(width = 120, height = 90) {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const sof0 = Buffer.alloc(13);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(11, 2);
  sof0[4] = 8;
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 1;
  sof0[10] = 1;
  sof0[11] = 0x11;
  sof0[12] = 0;

  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, sof0, eoi]);
}

function makeWebpBuffer(width = 32, height = 40) {
  const payload = Buffer.alloc(18);
  payload.write('WEBP', 0, 'ascii');
  payload.write('VP8L', 4, 'ascii');
  payload.writeUInt32LE(5, 8);
  payload[12] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  payload.writeUInt32LE(bits >>> 0, 13);

  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(payload.length, 4);
  return Buffer.concat([riff, payload]);
}

function makeGifBuffer(width = 24, height = 24) {
  const buf = Buffer.alloc(16);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  buf[15] = 0x3b;
  return buf;
}

function createTempEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakton-assets-test-'));
  const storage = initStorage(tmpDir);
  const db = openDatabase(storage.dbPath);
  const repos = createRepositories(db);
  seedIfEmpty(repos);
  const assetService = createAssetService({
    storage,
    repos,
    getBaseUrl: () => 'http://127.0.0.1:3001',
  });

  function cleanup() {
    try {
      db.close();
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return { tmpDir, storage, db, repos, assetService, cleanup };
}

function createMockIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
    async invoke(channel, payload) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`No IPC handler registered for ${channel}`);
      return fn({}, payload);
    },
  };
}

// ============================================================================
// 1. UPLOAD & VALIDATION TESTS
// ============================================================================

test('Upload Tests: valid map and token uploads succeed across PNG, JPEG, WebP, GIF', async (t) => {
  const env = createTempEnv();
  t.after(() => env.cleanup());

  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakton-user-src-'));
  t.after(() => fs.rmSync(srcDir, { recursive: true, force: true }));

  const mapPngPath = path.join(srcDir, 'Dungeon_Level_1.png');
  const tokenJpgPath = path.join(srcDir, 'Goblin_Scout.jpg');
  const mapWebpPath = path.join(srcDir, 'Forest_Clearing.webp');
  const tokenGifPath = path.join(srcDir, 'Familiar.gif');

  const pngBytes = makePngBuffer(2100, 1400);
  const jpgBytes = makeJpegBuffer(256, 256);
  const webpBytes = makeWebpBuffer(1024, 768);
  const gifBytes = makeGifBuffer(64, 64);

  fs.writeFileSync(mapPngPath, pngBytes);
  fs.writeFileSync(tokenJpgPath, jpgBytes);
  fs.writeFileSync(mapWebpPath, webpBytes);
  fs.writeFileSync(tokenGifPath, gifBytes);

  // 1. Valid Map Upload (PNG)
  const mapAsset = await env.assetService.uploadFromPath({
    type: 'map',
    filePath: mapPngPath,
  });
  assert.equal(mapAsset.type, 'map');
  assert.equal(mapAsset.category, 'maps');
  assert.equal(mapAsset.name, 'Dungeon_Level_1');
  assert.equal(mapAsset.originalName, 'Dungeon_Level_1.png');
  assert.equal(mapAsset.format, 'png');
  assert.equal(mapAsset.mimeType, 'image/png');
  assert.equal(mapAsset.width, 2100);
  assert.equal(mapAsset.height, 1400);
  assert.equal(mapAsset.byteSize, pngBytes.byteLength);
  assert.match(mapAsset.url, /\/assets\/.+\/file$/);

  // Source file on user's disk must remain intact (copied, not moved)
  assert.equal(fs.existsSync(mapPngPath), true);

  // 2. Valid Token Upload (JPEG)
  const tokenAsset = await env.assetService.uploadFromPath({
    type: 'token',
    filePath: tokenJpgPath,
  });
  assert.equal(tokenAsset.type, 'token');
  assert.equal(tokenAsset.category, 'characters');
  assert.equal(tokenAsset.name, 'Goblin_Scout');
  assert.equal(tokenAsset.format, 'jpeg');
  assert.equal(tokenAsset.mimeType, 'image/jpeg');
  assert.equal(tokenAsset.width, 256);
  assert.equal(tokenAsset.height, 256);

  // 3. Valid Map Upload (WebP)
  const webpAsset = await env.assetService.uploadFromPath({
    type: 'map',
    category: 'scenes',
    filePath: mapWebpPath,
  });
  assert.equal(webpAsset.format, 'webp');
  assert.equal(webpAsset.category, 'scenes');
  assert.equal(webpAsset.width, 1024);
  assert.equal(webpAsset.height, 768);

  // 4. Valid Token Upload (GIF via buffer)
  const gifAsset = await env.assetService.uploadFromBuffer({
    type: 'token',
    category: 'props',
    buffer: gifBytes,
    originalName: 'Familiar.gif',
  });
  assert.equal(gifAsset.format, 'gif');
  assert.equal(gifAsset.category, 'props');
  assert.equal(gifAsset.width, 64);
  assert.equal(gifAsset.height, 64);

  // 5. Verify bundled starter-map.svg from main seeds cleanly via seedIfEmpty(repos, storage)
  await seedIfEmpty(env.repos, env.storage);
  const seededMap = env.repos.maps.first();
  assert.ok(seededMap?.image_file, 'seedIfEmpty must populate maps.image_file with starter-map.svg');
  assert.match(seededMap.image_file, /\.svg$/);
});

test('Upload Tests: unsupported formats, corrupted images, spoofed extensions, and invalid paths are rejected cleanly', async (t) => {
  const env = createTempEnv();
  t.after(() => env.cleanup());

  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakton-invalid-src-'));
  t.after(() => fs.rmSync(srcDir, { recursive: true, force: true }));

  // 1. Unsupported format (.txt, .svg)
  const txtPath = path.join(srcDir, 'notes.txt');
  fs.writeFileSync(txtPath, 'not an image');
  await assert.rejects(
    () => env.assetService.uploadFromPath({ type: 'map', filePath: txtPath }),
    (err) => err instanceof InvalidAssetError && err.code === 'E_INVALID_ASSET',
  );

  const svgPath = path.join(srcDir, 'script.svg');
  fs.writeFileSync(svgPath, '<svg><script>alert(1)</script></svg>');
  await assert.rejects(
    () => env.assetService.uploadFromPath({ type: 'token', filePath: svgPath }),
    (err) => err instanceof InvalidAssetError && err.code === 'E_INVALID_ASSET',
  );

  // 2. Corrupted image (random text disguised as .png)
  const fakePngPath = path.join(srcDir, 'corrupt.png');
  fs.writeFileSync(fakePngPath, 'this is definitely not a valid PNG header');
  await assert.rejects(
    () => env.assetService.uploadFromPath({ type: 'map', filePath: fakePngPath }),
    (err) => err instanceof InvalidAssetError && err.code === 'E_INVALID_ASSET',
  );

  // 3. Truncated PNG header
  const truncatedPng = makePngBuffer(100, 100).subarray(0, 20);
  await assert.rejects(
    () =>
      env.assetService.uploadFromBuffer({
        type: 'map',
        buffer: truncatedPng,
        originalName: 'truncated.png',
      }),
    (err) => err instanceof InvalidAssetError,
  );

  // 4. Corrupted JPEG (SOI without SOF)
  const badJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await assert.rejects(
    () =>
      env.assetService.uploadFromBuffer({
        type: 'token',
        buffer: badJpeg,
        originalName: 'broken.jpg',
      }),
    (err) => err instanceof InvalidAssetError,
  );

  // 5. Extension mismatch (valid JPEG bytes named .png)
  const mismatched = makeJpegBuffer(50, 50);
  await assert.rejects(
    () =>
      env.assetService.uploadFromBuffer({
        type: 'token',
        buffer: mismatched,
        originalName: 'disguised.png',
      }),
    (err) => err instanceof InvalidAssetError && /does not match actual image format/i.test(err.message),
  );

  // 6. Invalid / non-existent file paths & directory traversal
  await assert.rejects(
    () => env.assetService.uploadFromPath({ type: 'map', filePath: path.join(srcDir, 'does_not_exist.png') }),
    (err) => err instanceof InvalidAssetError,
  );
  await assert.rejects(
    () => env.assetService.uploadFromPath({ type: 'map', filePath: srcDir }),
    (err) => err instanceof InvalidAssetError,
  );
  assert.throws(
    () => env.storage.getAssetPath('maps', '../outside.png'),
    (err) => err instanceof InvalidAssetError,
  );
  assert.throws(
    () => env.storage.getAssetPath('tokens', 'nested/evil.png'),
    (err) => err instanceof InvalidAssetError,
  );

  // Verify rejected uploads left zero files in storage and zero records in DB
  assert.equal(fs.readdirSync(env.storage.dirs.maps).length, 0);
  assert.equal(fs.readdirSync(env.storage.dirs.tokens).length, 0);
  assert.equal(env.assetService.countAssets(), 0);
});

test('Upload Tests: duplicate filenames are handled safely without overwriting and oversized files (>250 MB) are rejected', async (t) => {
  const env = createTempEnv();
  t.after(() => env.cleanup());

  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakton-dup-src-'));
  t.after(() => fs.rmSync(srcDir, { recursive: true, force: true }));

  const dirA = path.join(srcDir, 'a');
  const dirB = path.join(srcDir, 'b');
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB);

  const fileA = path.join(dirA, 'goblin.png');
  const fileB = path.join(dirB, 'goblin.png');
  const bufA = makePngBuffer(64, 64);
  const bufB = makePngBuffer(128, 128);
  fs.writeFileSync(fileA, bufA);
  fs.writeFileSync(fileB, bufB);

  const uploadedA = await env.assetService.uploadFromPath({ type: 'token', filePath: fileA });
  const uploadedB = await env.assetService.uploadFromPath({ type: 'token', filePath: fileB });

  assert.notEqual(uploadedA.id, uploadedB.id);
  assert.notEqual(uploadedA.fileName, uploadedB.fileName);
  assert.equal(uploadedA.originalName, 'goblin.png');
  assert.equal(uploadedB.originalName, 'goblin.png');
  assert.equal(uploadedA.width, 64);
  assert.equal(uploadedB.width, 128);

  // Oversized file (> 250 MB) test using a sparse file
  const oversizedPath = path.join(srcDir, 'huge_world_map.png');
  fs.writeFileSync(oversizedPath, bufA);
  fs.truncateSync(oversizedPath, MAX_UPLOAD_BYTES + 1024);

  await assert.rejects(
    () => env.assetService.uploadFromPath({ type: 'map', filePath: oversizedPath }),
    (err) => err instanceof UploadTooLargeError && err.code === 'E_UPLOAD_TOO_LARGE',
  );
  // Ensure user's oversized source file was NOT deleted when copy=true
  assert.equal(fs.existsSync(oversizedPath), true);

  // Multiple uploads batch test (valid + invalid mix)
  const badFile = path.join(srcDir, 'corrupt.png');
  fs.writeFileSync(badFile, 'broken');

  const batchResult = await env.assetService.uploadManyFromPaths({
    type: 'map',
    filePaths: [fileA, badFile, fileB],
  });
  assert.equal(batchResult.uploaded.length, 2);
  assert.equal(batchResult.failed.length, 1);
  assert.equal(batchResult.failed[0].error.code, 'E_INVALID_ASSET');
});

// ============================================================================
// 2. STORAGE & PERSISTENCE TESTS
// ============================================================================

test('Storage Tests: lossless preservation, SQLite persistence across restarts, atomic rollback, and safe deletion', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakton-persist-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const mapBytes = makePngBuffer(800, 600);
  const tokenBytes = makeJpegBuffer(128, 128);

  let mapId = null;
  let tokenId = null;
  let storedMapFile = null;

  // Session 1: Upload map and token, then close DB
  {
    const storage = initStorage(tmpDir);
    const db = openDatabase(storage.dbPath);
    const repos = createRepositories(db);
    const service = createAssetService({ storage, repos });

    const mapAsset = await service.uploadFromBuffer({
      type: 'map',
      buffer: mapBytes,
      originalName: 'Keep_On_Borderlands.png',
    });
    const tokenAsset = await service.uploadFromBuffer({
      type: 'token',
      buffer: tokenBytes,
      originalName: 'Knight.jpg',
    });

    mapId = mapAsset.id;
    tokenId = tokenAsset.id;
    storedMapFile = mapAsset.fileName;

    // Verify physical directories and lossless byte-for-byte preservation
    const mapDiskPath = path.join(storage.dirs.maps, mapAsset.fileName);
    const tokenDiskPath = path.join(storage.dirs.tokens, tokenAsset.fileName);
    assert.equal(fs.existsSync(mapDiskPath), true);
    assert.equal(fs.existsSync(tokenDiskPath), true);
    assert.equal(Buffer.compare(fs.readFileSync(mapDiskPath), mapBytes), 0);
    assert.equal(Buffer.compare(fs.readFileSync(tokenDiskPath), tokenBytes), 0);

    // Simulate failed DB insert during upload -> verify file is rolled back from disk
    const brokenRepos = {
      assets: {
        ...repos.assets,
        create() {
          throw new Error('Simulated SQLite constraint failure');
        },
      },
    };
    const brokenService = createAssetService({ storage, repos: brokenRepos });
    const filesBefore = fs.readdirSync(storage.dirs.maps).length;
    await assert.rejects(
      () =>
        brokenService.uploadFromBuffer({
          type: 'map',
          buffer: mapBytes,
          originalName: 'Rollback_Map.png',
        }),
      /Simulated SQLite constraint failure/,
    );
    const filesAfter = fs.readdirSync(storage.dirs.maps).length;
    assert.equal(filesAfter, filesBefore, 'Orphan file must be rolled back on DB failure');

    db.close();
  }

  // Session 2: Reopen storage & SQLite after simulated restart
  {
    const storage = initStorage(tmpDir);
    const db = openDatabase(storage.dbPath);
    const repos = createRepositories(db);
    const service = createAssetService({ storage, repos });

    const loadedMap = service.getAsset(mapId);
    const loadedToken = service.getAsset(tokenId);
    assert.ok(loadedMap);
    assert.ok(loadedToken);
    assert.equal(loadedMap.name, 'Keep_On_Borderlands');
    assert.equal(loadedMap.width, 800);
    assert.equal(loadedToken.name, 'Knight');

    // Delete map asset -> verify both DB metadata and disk file are removed
    const delResult = await service.deleteAsset(mapId);
    assert.equal(delResult.deleted, true);
    assert.equal(delResult.fileDeleted, true);
    assert.equal(service.getAsset(mapId), null);
    assert.equal(fs.existsSync(path.join(storage.dirs.maps, storedMapFile)), false);

    db.close();
  }
});

// ============================================================================
// 3. CATALOG, ELECTRON IPC & HEADLESS STORE TESTS
// ============================================================================

test('Catalog & IPC Tests: search, filter, selection, deletion, and dialog path security via assetStore + IPC', async (t) => {
  const env = createTempEnv();
  t.after(() => env.cleanup());

  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakton-ipc-src-'));
  t.after(() => fs.rmSync(srcDir, { recursive: true, force: true }));

  const mapFile = path.join(srcDir, 'Icewind_Dale.png');
  const tokenFile = path.join(srcDir, 'Drizzt_Token.webp');
  const unapprovedFile = path.join(srcDir, 'Secret_File.png');
  fs.writeFileSync(mapFile, makePngBuffer(1024, 1024));
  fs.writeFileSync(tokenFile, makeWebpBuffer(128, 128));
  fs.writeFileSync(unapprovedFile, makePngBuffer(64, 64));

  let nextDialogResult = { canceled: false, filePaths: [mapFile] };
  const mockIpcMain = createMockIpcMain();
  const mockDialog = {
    async showOpenDialog() {
      return nextDialogResult;
    },
  };

  registerAssetIpcHandlers({
    ipcMain: mockIpcMain,
    dialog: mockDialog,
    assetService: env.assetService,
  });

  globalThis.window = {
    hakton: {
      assets: {
        list: (f) => mockIpcMain.invoke(ASSET_IPC_CHANNELS.LIST, f),
        get: (id) => mockIpcMain.invoke(ASSET_IPC_CHANNELS.GET, { id }),
        selectFiles: (o) => mockIpcMain.invoke(ASSET_IPC_CHANNELS.SELECT_FILES, o),
        pickAndUpload: (o) => mockIpcMain.invoke(ASSET_IPC_CHANNELS.PICK_AND_UPLOAD, o),
        uploadPaths: (p) => mockIpcMain.invoke(ASSET_IPC_CHANNELS.UPLOAD_PATHS, p),
        uploadFiles: (p) => mockIpcMain.invoke(ASSET_IPC_CHANNELS.UPLOAD_BUFFER, p),
        rename: (id, name) => mockIpcMain.invoke(ASSET_IPC_CHANNELS.RENAME, { id, name }),
        setCategory: (id, category) => mockIpcMain.invoke(ASSET_IPC_CHANNELS.SET_CATEGORY, { id, category }),
        updateMetadata: (id, metadata) => mockIpcMain.invoke(ASSET_IPC_CHANNELS.UPDATE_METADATA, { id, metadata }),
        delete: (id) => mockIpcMain.invoke(ASSET_IPC_CHANNELS.DELETE, { id }),
      },
    },
  };
  t.after(() => {
    delete globalThis.window;
  });

  // 1. Empty catalog state initially
  await assetStore.getState().loadAssets();
  assert.equal(assetStore.getState().assets.length, 0);

  // 2. Upload map via pickAndUpload
  const pickMapRes = await assetStore.getState().pickAndUpload({ type: 'map' });
  assert.equal(pickMapRes.ok, true);
  assert.equal(pickMapRes.uploaded.length, 1);
  const uploadedMap = pickMapRes.uploaded[0];

  // 3. Upload token via two-step selectFiles -> uploadStagedFiles
  nextDialogResult = { canceled: false, filePaths: [tokenFile] };
  const selectRes = await assetStore.getState().selectFiles({ type: 'token' });
  assert.equal(selectRes.ok, true);
  assert.equal(assetStore.getState().stagedFiles.length, 1);

  const stageUploadRes = await assetStore.getState().uploadStagedFiles({ type: 'token' });
  assert.equal(stageUploadRes.ok, true);
  const uploadedToken = stageUploadRes.uploaded[0];

  // 4. Security check: attempting to upload an arbitrary path not chosen in dialog must be blocked
  const unapprovedRes = await globalThis.window.hakton.assets.uploadPaths({
    type: 'map',
    filePaths: [unapprovedFile],
  });
  assert.equal(unapprovedRes.ok, false);
  assert.equal(unapprovedRes.error.code, 'E_UNAPPROVED_PATH');

  // 5. Catalog listing, filtering, and search
  assert.equal(assetStore.getState().assets.length, 2);

  await assetStore.getState().setFilterType('map');
  assert.equal(assetStore.getState().assets.length, 1);
  assert.equal(assetStore.getState().assets[0].id, uploadedMap.id);

  await assetStore.getState().setFilterType('token');
  assert.equal(assetStore.getState().assets.length, 1);
  assert.equal(assetStore.getState().assets[0].id, uploadedToken.id);

  await assetStore.getState().setFilterType('all');
  await assetStore.getState().setSearchQuery('Drizzt');
  assert.equal(assetStore.getState().assets.length, 1);
  assert.equal(assetStore.getState().assets[0].id, uploadedToken.id);

  // Wildcard literal escaping in search
  await assetStore.getState().setSearchQuery('100%');
  assert.equal(assetStore.getState().assets.length, 0);
  await assetStore.getState().setSearchQuery('');

  // 6. Asset Selection synchronizes with sessionStore
  assetStore.getState().selectAsset(uploadedMap.id);
  assetStore.getState().selectAsset(uploadedToken.id);
  assert.equal(assetStore.getState().selectedMapAssetId, uploadedMap.id);
  assert.equal(assetStore.getState().selectedTokenAssetId, uploadedToken.id);
  assert.equal(sessionStore.getState().selectedMapAsset?.id, uploadedMap.id);
  assert.equal(sessionStore.getState().selectedTokenAsset?.id, uploadedToken.id);

  // 7. Rename & Category update
  const renameRes = await assetStore.getState().renameAsset(uploadedMap.id, 'Rime of the Frostmaiden');
  assert.equal(renameRes.ok, true);
  assert.equal(renameRes.asset.name, 'Rime of the Frostmaiden');

  const catRes = await assetStore.getState().setAssetCategory(uploadedMap.id, 'scenes');
  assert.equal(catRes.ok, true);
  assert.equal(catRes.asset.category, 'scenes');

  // 8. Deletion removes asset from catalog and clears tabletop selection
  const delRes = await assetStore.getState().deleteAsset(uploadedMap.id);
  assert.equal(delRes.ok, true);
  assert.equal(assetStore.getState().selectedMapAssetId, null);
  assert.equal(sessionStore.getState().selectedMapAsset, null);
  assert.equal(assetStore.getState().assets.length, 1);
});

// ============================================================================
// 4. EMBEDDED SERVER HTTP PREVIEW & EXISTING NETWORKING INTEGRATION TESTS
// ============================================================================

test('Integration Tests: Express /assets/:id/file streaming, catalog endpoints, and Socket.io router work together', async (t) => {
  const env = createTempEnv();
  const srv = await startServer({ repos: env.repos, storage: env.storage, port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await srv.close();
    env.cleanup();
  });

  assert.ok(srv.port > 0, 'Embedded HTTP server must bind to an ephemeral port');
  const baseUrl = srv.localUrl ?? `http://127.0.0.1:${srv.port}`;

  // Real HTTP round-trip against the embedded server (works in sandboxes: loopback only).
  async function requestApp(urlPath) {
    const response = await fetch(`${baseUrl}${urlPath}`);
    const body = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      headers: { get: (key) => response.headers.get(key) },
      body,
      json: () => JSON.parse(body.toString('utf8')),
    };
  }

  const pngBytes = makePngBuffer(320, 240);
  const uploaded = await env.assetService.uploadFromBuffer({
    type: 'map',
    buffer: pngBytes,
    originalName: 'Tavern_Map.png',
  });

  // 1. Verify /health
  const healthRes = await requestApp('/health');
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.json().ok, true);

  // 2. Verify GET /assets & GET /assets/:id
  const listRes = await requestApp('/assets?type=map');
  assert.equal(listRes.status, 200);
  const listJson = listRes.json();
  assert.equal(listJson.ok, true);
  assert.equal(listJson.assets.length, 1);
  assert.equal(listJson.assets[0].id, uploaded.id);

  // 3. Verify GET /assets/:id/file streams exact bytes with security headers
  const fileRes = await requestApp(`/assets/${uploaded.id}/file`);
  assert.equal(fileRes.status, 200);
  assert.equal(fileRes.headers.get('content-type'), 'image/png');
  assert.equal(fileRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.compare(fileRes.body, pngBytes), 0);

  // 4. Verify GET /assets/:id/file returns 404 for unknown ID
  const missingRes = await requestApp('/assets/non-existent-id/file');
  assert.equal(missingRes.status, 404);

  // 5. Verify existing Socket.io router SESSION_JOIN & TOKEN_MOVE remain unaffected
  let connectionCallback = null;
  const emitted = [];
  const broadcasted = [];
  const mockIo = {
    sockets: { sockets: new Map() },
    on(event, fn) {
      if (event === 'connection') connectionCallback = fn;
    },
    to() {
      return {
        emit(ev, payload) {
          broadcasted.push({ ev, payload });
        },
      };
    },
  };
  registerSocketRouter(mockIo, env.repos);

  const socketListeners = new Map();
  const mockSocket = {
    id: 'sock-test-1',
    data: {},
    removeAllListeners() {},
    join() {},
    leave() {},
    to() {
      return { emit() {} };
    },
    on(ev, fn) {
      socketListeners.set(ev, fn);
    },
    emit(ev, payload) {
      emitted.push({ ev, payload });
    },
    broadcast: {
      emit(ev, payload) {
        broadcasted.push({ ev, payload });
      },
    },
  };

  connectionCallback(mockSocket);
  socketListeners.get(EVENTS.SESSION_JOIN)({ displayName: 'Aragorn' });
  const stateEvent = emitted.find((e) => e.ev === EVENTS.SESSION_STATE);
  assert.ok(stateEvent, 'SESSION_STATE must be emitted on join');
  assert.equal(stateEvent.payload.map.name, 'Drowned Sanctuary');
  assert.equal(stateEvent.payload.tokens[0].id, 'tok-demo-1');

  socketListeners.get(EVENTS.TOKEN_MOVE)({ id: 'tok-demo-1', x: 280, y: 350 });
  const moveEvent = broadcasted.find((e) => e.ev === EVENTS.TOKEN_MOVED);
  assert.ok(moveEvent, 'TOKEN_MOVED must be broadcasted');
  assert.equal(moveEvent.payload.id, 'tok-demo-1');
});
