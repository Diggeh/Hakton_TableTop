import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { ExpressPeerServer } from 'peer';
import {
  DEFAULT_PORT,
  DEFAULT_SESSION_ID,
  DEFAULT_SESSION_NAME,
  EVENTS,
  PEER_PATH,
  SERVER_STATE,
} from '../shared/events.js';
import { SessionManager } from './session/sessionManager.js';
import { getSessionRoom, registerSocketRouter } from './socket/router.js';
import { createSoundboardLibrary } from './socket/soundboardLibrary.js';
import { SOUNDBOARD_EVENTS } from '../shared/soundboard.js';
import { createAutosaveService } from './autosave/service.js';
import { typeToStorageKind } from './assetService.js';
import { encodeInternetCode, encodeRoomCode } from '../shared/roomCode.js';

let activeServer = null;
let startingPromise = null;
let lastServerError = null;

/**
 * Creates the Express HTTP application with health, asset catalog, and secure local image streaming routes.
 */
export function createHttpApp({
  repos = null,
  storage = null,
  sessionId = DEFAULT_SESSION_ID,
  getActiveConnections = () => 0,
} = {}) {
  const app = express();
  app.disable?.('x-powered-by');

  app.get('/health', (_req, res) =>
    res.json({
      ok: true,
      sessionId,
      activeConnections: getActiveConnections(),
    }),
  );

  // Read-only catalog metadata endpoints for local/LAN tabletop consumers
  if (repos?.assets) {
    app.get('/assets', (req, res) => {
      try {
        const { type, category, campaignId, search, limit, offset } = req.query ?? {};
        const items = repos.assets.list({
          type: typeof type === 'string' ? type : null,
          category: typeof category === 'string' ? category : null,
          campaignId: campaignId != null ? Number(campaignId) : null,
          search: typeof search === 'string' ? search : null,
          limit: limit != null ? Number(limit) : 200,
          offset: offset != null ? Number(offset) : 0,
        });
        res.json({ ok: true, assets: items });
      } catch (err) {
        res.status(400).json({ ok: false, error: { code: 'E_BAD_REQUEST', message: err.message } });
      }
    });

    app.get('/assets/:id', (req, res) => {
      const asset = repos.assets.get(req.params.id);
      if (!asset) {
        return res
          .status(404)
          .json({ ok: false, error: { code: 'E_ASSET_NOT_FOUND', message: 'Asset not found' } });
      }
      return res.json({ ok: true, asset });
    });
  }

  // Secure local asset binary streaming by verified database ID (never raw filesystem paths)
  if (repos?.assets && storage) {
    app.get('/assets/:id/file', async (req, res) => {
      try {
        const asset = repos.assets.get(req.params.id);
        if (!asset) {
          return res
            .status(404)
            .json({ ok: false, error: { code: 'E_ASSET_NOT_FOUND', message: 'Asset not found' } });
        }

        const kind = typeToStorageKind(asset.type);
        const filePath = storage.getAssetPath(kind, asset.fileName);
        const st = await fs.promises.stat(filePath).catch(() => null);
        if (!st || !st.isFile()) {
          return res
            .status(404)
            .json({ ok: false, error: { code: 'E_ASSET_FILE_MISSING', message: 'Stored asset file is unavailable' } });
        }

        res.setHeader('Content-Type', asset.mimeType || 'application/octet-stream');
        res.setHeader('Content-Length', String(st.size));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cache-Control', 'private, max-age=3600');

        const stream = fs.createReadStream(filePath);
        stream.on('error', () => {
          if (!res.headersSent) {
            res.status(500).end();
          } else {
            res.destroy();
          }
        });
        return stream.pipe(res);
      } catch {
        return res
          .status(400)
          .json({ ok: false, error: { code: 'E_INVALID_ASSET', message: 'Invalid asset request' } });
      }
    });
  }

  // Lossless battle maps / token art static serving (/assets/maps/*, /assets/tokens/*).
  if (storage?.uploadsDir && typeof express.static === 'function') {
    app.use(
      '/assets',
      express.static(storage.uploadsDir, {
        maxAge: '1h',
        setHeaders: (res) => {
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        },
      }),
    );
  }

  return app;
}

/**
 * Enumerates non-internal IPv4 LAN addresses on the host machine so players on
 * the same local network know which IP address to connect to.
 * @returns {string[]}
 */
export function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const entries of Object.values(interfaces)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (
        entry &&
        (entry.family === 'IPv4' || entry.family === 4) &&
        !entry.internal &&
        entry.address
      ) {
        addresses.push(entry.address);
      }
    }
  }
  return Array.from(new Set(addresses));
}

/**
 * Returns the current status of the managed host server.
 */
export function getServerStatus() {
  if (activeServer) {
    return activeServer.getStatus();
  }
  return {
    state: startingPromise
      ? SERVER_STATE.STARTING
      : lastServerError
        ? SERVER_STATE.ERROR
        : SERVER_STATE.STOPPED,
    running: false,
    port: null,
    host: null,
    localUrl: null,
    lanIps: getLocalIpAddresses(),
    lanUrls: [],
    sessionId: null,
    activeConnections: 0,
    participants: [],
    error: lastServerError,
  };
}

/**
 * Stops the currently active host server if one is running.
 * @returns {Promise<void>}
 */
export async function stopServer() {
  if (startingPromise) {
    try {
      const srv = await startingPromise;
      await srv.close();
    } catch {
      // Startup failed; nothing to close.
    }
    return;
  }
  if (activeServer) {
    await activeServer.close();
  }
}

/**
 * Mounts ExpressPeerServer while tracking its internal heartbeat/expiration
 * timers so they can be cleanly stopped when the host server shuts down.
 *
 * @param {import('express').Express} app
 * @param {import('node:http').Server} httpServer
 */
function mountPeerServerWithCleanup(app, httpServer) {
  let closed = false;
  const peerTimers = new Set();
  const origSetTimeout = globalThis.setTimeout;

  function installTrackedTimeout(fn, delay, ...args) {
    if (closed) return null;
    const handle = origSetTimeout(() => {
      peerTimers.delete(handle);
      if (closed) return;
      const prev = globalThis.setTimeout;
      globalThis.setTimeout = installTrackedTimeout;
      try {
        fn(...args);
      } finally {
        globalThis.setTimeout = prev;
      }
    }, delay);
    if (handle && typeof handle.unref === 'function') {
      handle.unref();
    }
    peerTimers.add(handle);
    return handle;
  }

  let peerServer;
  const beforeUpgradeListeners = new Set(httpServer.listeners('upgrade'));
  const guardedUpgradeListeners = [];

  globalThis.setTimeout = installTrackedTimeout;
  try {
    peerServer = ExpressPeerServer(httpServer, { path: '/' });
    peerServer.on?.('error', () => {});
    app.use(PEER_PATH, peerServer);
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }

  // Isolate PeerJS WebSocket upgrade handler to PEER_PATH so ws@8 does not abort /socket.io upgrades
  for (const fn of httpServer.listeners('upgrade')) {
    if (!beforeUpgradeListeners.has(fn)) {
      httpServer.removeListener('upgrade', fn);
      const guarded = (req, socket, head) => {
        if (typeof req.url === 'string' && req.url.startsWith(PEER_PATH)) {
          fn(req, socket, head);
        }
      };
      guardedUpgradeListeners.push(guarded);
      httpServer.on('upgrade', guarded);
    }
  }

  return function stopPeerTimers() {
    closed = true;
    for (const timer of peerTimers) {
      clearTimeout(timer);
    }
    peerTimers.clear();
    for (const guarded of guardedUpgradeListeners) {
      httpServer.removeListener('upgrade', guarded);
    }
    guardedUpgradeListeners.length = 0;
  };
}

/**
 * Starts the embedded HTTP + Socket.IO + PeerJS signaling server.
 * Depends only on the injected `repos` interface: no Electron, no SQL.
 *
 * @param {{
 *   repos?: object,
 *   storage?: { uploadsDir?: string, getAssetPath?: Function },
 *   port?: number,
 *   host?: string,
 *   hostSecret?: string,
 *   sessionId?: string,
 *   sessionName?: string,
 * }} [opts]
 * @returns {Promise<{
 *   port: number,
 *   host: string,
 *   hostSecret: string,
 *   localUrl: string,
 *   lanIps: string[],
 *   lanUrls: string[],
 *   sessionId: string,
 *   app: import('express').Express,
 *   io: import('socket.io').Server,
 *   httpServer: import('node:http').Server,
 *   sessionManager: SessionManager,
 *   getStatus: () => object,
 *   close: () => Promise<void>,
 * }>}
 */
export function startServer({
  repos = null,
  storage = null,
  port = DEFAULT_PORT,
  host = '0.0.0.0',
  hostSecret = crypto.randomBytes(32).toString('hex'),
  sessionId = DEFAULT_SESSION_ID,
  sessionName = DEFAULT_SESSION_NAME,
  autosaveDebounceMs = 500,
  autosaveMaxMs = 5000,
} = {}) {
  if (activeServer || startingPromise) {
    const err = new Error(
      'Host server is already running. Stop the existing server before starting a new instance.',
    );
    err.code = 'E_SERVER_ALREADY_RUNNING';
    return Promise.reject(err);
  }

  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 0 || numericPort > 65535) {
    const err = new Error(
      `Invalid port number: ${String(port)}. Must be an integer between 0 and 65535.`,
    );
    err.code = 'E_INVALID_PORT';
    lastServerError = err.message;
    return Promise.reject(err);
  }

  lastServerError = null;

  const sessionManager = new SessionManager({
    hostSecret,
    defaultSessionId: sessionId,
    defaultSessionName: sessionName,
    persistence: repos?.sessions ?? null,
  });

  // Restore identities from the previous host process before accepting players.
  try {
    sessionManager.hydrate();
  } catch (error) {
    console.warn('[hakton] could not restore session identities:', error?.message ?? error);
  }

  // Old idempotency receipts are only useful for a short replay window.
  try {
    repos?.autosaveReceipts?.prune?.(7);
  } catch {
    // Receipt pruning is housekeeping, never a startup blocker.
  }

  const app = createHttpApp({
    repos,
    storage,
    sessionId,
    getActiveConnections: () => (activeServer ? activeServer.io?.engine?.clientsCount ?? 0 : 0),
  });

  const httpServer = http.createServer(app);

  // Track raw TCP sockets so shutdown never hangs on keep-alive connections
  const openSockets = new Set();
  httpServer.on('connection', (rawSocket) => {
    openSockets.add(rawSocket);
    rawSocket.once('close', () => openSockets.delete(rawSocket));
  });

  startingPromise = new Promise((resolve, reject) => {
    const onStartupError = (err) => {
      startingPromise = null;
      lastServerError =
        err.code === 'EADDRINUSE'
          ? `Port ${numericPort} is already in use.`
          : err.message || 'Failed to start host server.';
      reject(err);
    };

    httpServer.once('error', onStartupError);

    httpServer.listen(numericPort, host, () => {
      httpServer.removeListener('error', onStartupError);

      // Private WebRTC signaling (mounted after successful port bind so failed binds leak nothing)
      const stopPeerTimers = mountPeerServerWithCleanup(app, httpServer);

      const io = new SocketServer(httpServer, {
        cors: { origin: '*' },
        destroyUpgrade: false,
        pingTimeout: 20000,
        pingInterval: 25000,
      });
      const soundboard = storage?.dataDir
        ? createSoundboardLibrary(storage.dataDir, sessionManager)
        : null;
      soundboard?.mount(app, (sessionId) => {
        io.to(getSessionRoom(sessionId)).emit(SOUNDBOARD_EVENTS.CATALOG, {
          sessionId, cues: soundboard.list(sessionId),
        });
      });

      const autosaveService = repos
        ? createAutosaveService({
            repos,
            debounceMs: autosaveDebounceMs,
            maxMs: autosaveMaxMs,
            onSaved: (document) => {
              try {
                io.emit(EVENTS.AUTOSAVE_SAVED, {
                  saveId: null,
                  savedBy: 'server',
                  savedAt: new Date().toISOString(),
                  documents: [
                    {
                      kind: 'board',
                      scopeId: `campaign:${document.campaignId}`,
                      revision: document.revision,
                      updatedAt: document.updatedAt,
                    },
                  ],
                });
              } catch {
                // Best-effort broadcast.
              }
            },
          })
        : null;

      registerSocketRouter(io, repos, {
        sessionManager,
        hostSecret,
        autosave: autosaveService,
        soundboard,
      });

      const addressInfo = httpServer.address();
      const boundPort =
        typeof addressInfo === 'object' && addressInfo ? addressInfo.port : numericPort;
      const localUrl = `http://127.0.0.1:${boundPort}`;
      const lanIps = getLocalIpAddresses();
      const lanUrls = lanIps.map((ip) => `http://${ip}:${boundPort}`);
      const primaryIp = lanIps[0] || '127.0.0.1';
      const roomCode = encodeRoomCode(primaryIp, boundPort);
      const internetCode = encodeInternetCode(`${sessionId}:${primaryIp}:${boundPort}`);

      let closingPromise = null;

      const close = () => {
        if (closingPromise) return closingPromise;

        closingPromise = new Promise((done) => {
          stopPeerTimers();

          // Persist any queued board blueprint before the DB handle goes away.
          try {
            autosaveService?.flushAll?.();
          } catch {
            // Shutdown must not be blocked by a failed checkpoint.
          }

          try {
            io.emit?.(EVENTS.SERVER_SHUTDOWN, {
              reason: 'Host server is shutting down.',
              timestamp: new Date().toISOString(),
            });
            io.disconnectSockets?.(true);
          } catch {
            // Ignore emit/disconnect errors during shutdown
          }

          sessionManager.clear();

          for (const rawSocket of openSockets) {
            try {
              rawSocket.destroy();
            } catch {
              // Ignore socket destroy errors
            }
          }
          openSockets.clear();

          io.close(() => {
            if (activeServer === serverHandle) {
              activeServer = null;
            }
            done();
          });
        });

        return closingPromise;
      };

      const getStatus = () => {
        const currentLanIps = getLocalIpAddresses();
        const currentIp = currentLanIps[0] || '127.0.0.1';
        return {
          state: closingPromise ? SERVER_STATE.STOPPING : SERVER_STATE.RUNNING,
          running: !closingPromise,
          port: boundPort,
          host,
          localUrl,
          lanIps: currentLanIps,
          lanUrls: currentLanIps.map((ip) => `http://${ip}:${boundPort}`),
          roomCode: encodeRoomCode(currentIp, boundPort),
          internetCode,
          sessionId,
          activeConnections: io.engine?.clientsCount ?? 0,
          participants: sessionManager.getSanitizedParticipants(sessionId),
          error: null,
        };
      };

      const serverHandle = {
        port: boundPort,
        host,
        hostSecret,
        localUrl,
        lanIps,
        lanUrls,
        roomCode,
        internetCode,
        sessionId,
        app,
        io,
        httpServer,
        sessionManager,
        autosave: autosaveService,
        getStatus,
        close,
      };

      activeServer = serverHandle;
      startingPromise = null;
      resolve(serverHandle);
    });
  });

  return startingPromise;
}
