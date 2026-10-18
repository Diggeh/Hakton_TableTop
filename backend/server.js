import http from 'node:http';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { ExpressPeerServer } from 'peer';
import { DEFAULT_PORT, PEER_PATH } from '../shared/events.js';
import { registerSocketRouter } from './socket/router.js';

/**
 * Starts the embedded HTTP + Socket.io + PeerJS signaling server.
 * Depends only on the injected `repos` interface: no Electron, no SQL.
 *
 * @param {{ repos: object, port?: number, host?: string }} opts
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export function startServer({ repos, port = DEFAULT_PORT, host = '0.0.0.0' }) {
  const app = express();
  app.get('/health', (_req, res) => res.json({ ok: true }));

  const httpServer = http.createServer(app);

  // Private WebRTC signaling (no dependence on the public PeerJS cloud).
  app.use(PEER_PATH, ExpressPeerServer(httpServer, { path: '/' }));

  const io = new SocketServer(httpServer, { cors: { origin: '*' } });
  registerSocketRouter(io, repos);

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      resolve({
        port: httpServer.address().port,
        close: () =>
          new Promise((done) => {
            io.close(() => done()); // also closes the underlying http server
          }),
      });
    });
  });
}
