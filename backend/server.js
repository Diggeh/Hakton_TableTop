import crypto from 'node:crypto';
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
import { registerSocketRouter } from './socket/router.js';

let activeServer = null;
let startingPromise = null;
let lastServerError = null;

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
    peerServer.on('error', () => {});
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
 *   storage?: { uploadsDir?: string },
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
  });

  const app = express();
  app.get('/health', (_req, res) =>
    res.json({
      ok: true,
      sessionId,
      activeConnections: activeServer ? activeServer.io.engine.clientsCount : 0,
    }),
  );

  // Lossless battle maps / token art. Uploads are stored unmodified on disk;
  // the renderer never needs filesystem access.
  if (storage?.uploadsDir) {
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

      registerSocketRouter(io, repos, { sessionManager, hostSecret });

      const addressInfo = httpServer.address();
      const boundPort =
        typeof addressInfo === 'object' && addressInfo ? addressInfo.port : numericPort;
      const localUrl = `http://127.0.0.1:${boundPort}`;
      const lanIps = getLocalIpAddresses();
      const lanUrls = lanIps.map((ip) => `http://${ip}:${boundPort}`);

      let closingPromise = null;

      const close = () => {
        if (closingPromise) return closingPromise;

        closingPromise = new Promise((done) => {
          stopPeerTimers();

          try {
            io.emit(EVENTS.SERVER_SHUTDOWN, {
              reason: 'Host server is shutting down.',
              timestamp: new Date().toISOString(),
            });
            io.disconnectSockets(true);
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
        return {
          state: closingPromise ? SERVER_STATE.STOPPING : SERVER_STATE.RUNNING,
          running: !closingPromise,
          port: boundPort,
          host,
          localUrl,
          lanIps: currentLanIps,
          lanUrls: currentLanIps.map((ip) => `http://${ip}:${boundPort}`),
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
        sessionId,
        io,
        httpServer,
        sessionManager,
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
