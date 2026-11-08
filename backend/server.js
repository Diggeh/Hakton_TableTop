import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { ExpressPeerServer } from 'peer';
import { DEFAULT_PORT, PEER_PATH } from '../shared/events.js';
import { registerSocketRouter } from './socket/router.js';
import { typeToStorageKind } from './assetService.js';

/**
 * Creates the Express HTTP application with health, asset catalog, and secure local image streaming routes.
 */
export function createHttpApp({ repos, storage = null } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Read-only catalog metadata endpoints for local/LAN tabletop consumers
  if (repos?.assets) {
    app.get('/assets', (req, res) => {
      try {
        const { type, category, campaignId, search, limit, offset } = req.query;
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
        return res.status(404).json({ ok: false, error: { code: 'E_ASSET_NOT_FOUND', message: 'Asset not found' } });
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
          return res.status(404).json({ ok: false, error: { code: 'E_ASSET_NOT_FOUND', message: 'Asset not found' } });
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
        return res.status(400).json({ ok: false, error: { code: 'E_INVALID_ASSET', message: 'Invalid asset request' } });
      }
    });
  }

  return app;
}

/**
 * Starts the embedded HTTP + Socket.io + PeerJS signaling server.
 * Depends only on the injected `repos` (and optional `storage`) interfaces: no Electron, no SQL.
 *
 * @param {{ repos: object, storage?: object, port?: number, host?: string }} opts
 * @returns {Promise<{ port: number, app: Function, close: () => Promise<void> }>}
 */
export function startServer({ repos, storage = null, port = DEFAULT_PORT, host = '0.0.0.0' }) {
  const app = createHttpApp({ repos, storage });
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
        app,
        close: () =>
          new Promise((done) => {
            io.close(() => done()); // also closes the underlying http server
          }),
      });
    });
  });
}
