import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { ROLES } from '../../shared/events.js';
import {
  AUDIO_PATH,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
} from '../../shared/soundboard.js';

const MAX_CUES = 64;
const MAX_LIBRARY_BYTES = 250 * 1024 * 1024;
const CUE_ID = /^custom-[a-f0-9-]{36}$/;

function audioType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44) return null;
  const header = bytes.toString('latin1', 0, 64);
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WAVE')
    return 'audio/wav';
  if (header.startsWith('OggS') && /OpusHead|vorbis/.test(header))
    return 'audio/ogg';
  if (header.startsWith('fLaC')) return 'audio/flac';
  if (
    header.startsWith('ID3') ||
    (bytes[0] === 0xff && (bytes[1] & 0xe6) === 0xe2)
  ) {
    return 'audio/mpeg';
  }
  return null;
}

export function createSoundboardLibrary(dataDir, sessionManager) {
  const grants = new Map();
  const bySocket = new WeakMap();
  const libraries = new Map();
  const uploading = new Set();
  const folder = (id) =>
    path.join(
      dataDir,
      'soundboard',
      createHash('sha256').update(id).digest('hex'),
    );
  const file = (id, cueId) => path.join(folder(id), cueId + '.audio');
  const metadata = (id, cueId) => path.join(folder(id), cueId + '.json');

  function catalog(id) {
    if (libraries.has(id)) return libraries.get(id);
    const entries = new Map();
    let files;
    try {
      files = fs.readdirSync(folder(id));
    } catch {
      files = [];
    }
    for (const entry of files) {
      const cueId = path.basename(entry, '.json');
      if (!entry.endsWith('.json') || !CUE_ID.test(cueId)) continue;
      try {
        const cue = JSON.parse(fs.readFileSync(metadata(id, cueId), 'utf8'));
        const stat = fs.statSync(file(id, cueId));
        if (cue.id === cueId && stat.isFile() && stat.size === cue.bytes)
          entries.set(cueId, cue);
      } catch {
        // An incomplete import is never exposed in the catalog.
      }
    }
    libraries.set(id, entries);
    return entries;
  }

  function issue(socket, participant) {
    const previous = bySocket.get(socket);
    if (
      previous?.sessionId === participant.sessionId &&
      previous.playerId === participant.id
    )
      return previous.token;
    if (previous) grants.delete(previous.token);
    const grant = {
      token: randomUUID(),
      socketId: socket.id,
      playerId: participant.id,
      sessionId: participant.sessionId,
    };
    bySocket.set(socket, grant);
    grants.set(grant.token, grant);
    if (!previous) {
      socket.once('disconnect', () =>
        grants.delete(bySocket.get(socket)?.token),
      );
    }
    return grant.token;
  }

  function authorize(token) {
    const grant = typeof token === 'string' ? grants.get(token) : null;
    if (!grant) return null;
    const member = sessionManager.getParticipantBySocket(grant.socketId);
    return member?.connected &&
      member.socketId === grant.socketId &&
      member.id === grant.playerId &&
      member.sessionId === grant.sessionId
      ? member
      : null;
  }

  function mount(app, onCatalogChange) {
    app.use(AUDIO_PATH, (_req, res, next) => {
      res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      next();
    });
    app.options(AUDIO_PATH, (_req, res) => res.sendStatus(204));
    const parseAudio = express.raw({
      type: 'application/octet-stream',
      limit: MAX_AUDIO_BYTES,
      inflate: false,
    });
    app.post(AUDIO_PATH, (req, res) => {
      const token = req
        .get('Authorization')
        ?.match(/^Bearer ([a-f0-9-]+)$/)?.[1];
      const member = authorize(token);
      if (member?.role !== ROLES.DM)
        return res
          .status(403)
          .json({ error: 'Only the Dungeon Master can import audio.' });
      const id = member.sessionId;
      if (uploading.has(id))
        return res
          .status(409)
          .json({ error: 'An audio import is already running.' });
      uploading.add(id);
      parseAudio(req, res, async (err) => {
        try {
          if (err)
            return res
              .status(err.status === 413 ? 413 : 400)
              .json({ error: 'Audio must be 25 MiB or smaller.' });
          if (authorize(token)?.role !== ROLES.DM)
            return res
              .status(403)
              .json({ error: 'Session authorization expired.' });
          const mime = audioType(req.body);
          const name =
            typeof req.query.name === 'string'
              ? req.query.name.trim().slice(0, 80)
              : '';
          const { kind } = req.query;
          const seconds =
            typeof req.query.seconds === 'string'
              ? Number(req.query.seconds)
              : NaN;
          if (
            !mime ||
            !name ||
            /[\x00-\x1f\x7f]/.test(name) ||
            !['loop', 'effect'].includes(kind) ||
            !Number.isFinite(seconds) ||
            seconds <= 0 ||
            seconds > MAX_AUDIO_SECONDS
          ) {
            return res.status(400).json({
              error: 'Choose a valid MP3, WAV, Ogg, or FLAC audio file.',
            });
          }
          const entries = catalog(id);
          const used = [...entries.values()].reduce(
            (sum, entry) => sum + entry.bytes,
            0,
          );
          if (
            entries.size >= MAX_CUES ||
            used + req.body.length > MAX_LIBRARY_BYTES
          ) {
            return res
              .status(413)
              .json({ error: 'The session audio library is full.' });
          }
          const cue = {
            id: 'custom-' + randomUUID(),
            name,
            kind,
            seconds,
            mime,
            bytes: req.body.length,
          };
          await fs.promises.mkdir(folder(id), { recursive: true });
          const target = file(id, cue.id);
          const manifest = metadata(id, cue.id);
          try {
            await fs.promises.writeFile(target, req.body, { flag: 'wx' });
            await fs.promises.writeFile(
              manifest + '.tmp',
              JSON.stringify(cue),
              { flag: 'wx' },
            );
            await fs.promises.rename(manifest + '.tmp', manifest);
          } catch (error) {
            await Promise.allSettled([
              fs.promises.unlink(target),
              fs.promises.unlink(manifest + '.tmp'),
            ]);
            throw error;
          }
          entries.set(cue.id, cue);
          onCatalogChange(id);
          res.status(201).json({ ok: true });
        } catch {
          if (!res.headersSent)
            res.status(500).json({ error: 'Audio could not be saved.' });
        } finally {
          uploading.delete(id);
        }
      });
    });
    app.get(AUDIO_PATH + '/:id', (req, res) => {
      const member = authorize(req.query.access);
      const cue = member && catalog(member.sessionId).get(req.params.id);
      if (!cue) return res.sendStatus(404);
      res.type(cue.mime).sendFile(file(member.sessionId, cue.id));
    });
  }

  return {
    issue,
    mount,
    get: (id, cueId) => catalog(id).get(cueId),
    list: (id) =>
      [...catalog(id).values()].map(({ id, name, kind, seconds }) => ({
        id,
        name,
        kind,
        seconds,
      })),
    remove(id, cueId) {
      const entries = catalog(id);
      if (!entries.has(cueId)) return false;
      fs.unlinkSync(metadata(id, cueId));
      entries.delete(cueId);
      try {
        fs.unlinkSync(file(id, cueId));
      } catch {
        /* A playing client can still hold the file on Windows. */
      }
      return true;
    },
  };
}
