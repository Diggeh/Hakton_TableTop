import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as createClient } from 'socket.io-client';
import { startServer, stopServer } from '../../backend/server.js';
import { checkpoint } from '../../database/index.js';
import { openDatabaseWithRecovery } from '../../database/recovery.js';
import { createRepositories } from '../../database/repositories.js';
import { DEFAULT_SESSION_ID, EVENTS, ROLES } from '../../shared/events.js';

function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function waitForSaved(socket, kind, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(EVENTS.AUTOSAVE_SAVED, handler);
      reject(new Error(`Timed out waiting for a "${kind}" autosave broadcast`));
    }, timeoutMs);

    function handler(payload) {
      if (!(payload?.documents ?? []).some((doc) => doc.kind === kind)) return;
      clearTimeout(timer);
      socket.off(EVENTS.AUTOSAVE_SAVED, handler);
      resolve(payload);
    }

    socket.on(EVENTS.AUTOSAVE_SAVED, handler);
  });
}

function connectRaw(url) {
  return new Promise((resolve, reject) => {
    const socket = createClient(url, { transports: ['websocket'], reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

describe('autosaved documents survive a host restart', () => {
  let dir;
  let socket;
  let db;

  afterEach(async () => {
    socket?.disconnect();
    socket = null;
    await stopServer();
    try {
      db?.close();
    } catch {
      // Already closed during the simulated restart.
    }
    db = null;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('reopens HP, DM notes, and the board blueprint from disk', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakton-autosave-'));
    const dbPath = path.join(dir, 'hakton.db');
    const backupDir = path.join(dir, 'backups');

    const opened = openDatabaseWithRecovery({ filePath: dbPath, backupDir });
    db = opened.db;
    let repos = createRepositories(db);

    const map = repos.maps.createWithCampaign('Campaign', 'Drowned Sanctuary');
    repos.characters.upsert({
      id: 'char-mira',
      ownerId: 'demo-dm',
      name: 'Mira',
      classLevel: 'Ranger 4',
      sheetData: { hp: { current: 28, max: 32 }, ac: 15 },
    });
    repos.tokens.create({
      id: 'tok-1',
      mapId: map.id,
      label: 'Mira',
      x: 105,
      y: 105,
    });

    const server = await startServer({
      repos,
      port: 0,
      host: '127.0.0.1',
      autosaveDebounceMs: 10,
      autosaveMaxMs: 60,
    });

    socket = await connectRaw(server.localUrl);
    await emitWithAck(socket, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Dungeon Master',
      role: ROLES.DM,
      hostToken: server.hostSecret,
    });

    const boardSaved = waitForSaved(socket, 'board');

    const characterSave = await emitWithAck(socket, EVENTS.AUTOSAVE_COMMIT, {
      saveId: 'restart-char',
      documents: [
        {
          kind: 'character',
          scopeId: 'char-mira',
          baseRevision: 1,
          data: { sheetData: { hp: { current: 6, max: 32 }, ac: 15 } },
        },
      ],
    });
    assert.equal(characterSave.ok, true);

    const notesSave = await emitWithAck(socket, EVENTS.AUTOSAVE_COMMIT, {
      saveId: 'restart-notes',
      documents: [
        {
          kind: 'dm-record',
          scopeId: 'session-notes-salt',
          baseRevision: null,
          data: {
            category: 'session-notes',
            title: 'Session notes',
            content: { text: 'The sentinel wakes.' },
          },
        },
      ],
    });
    assert.equal(notesSave.ok, true);

    await emitWithAck(socket, EVENTS.TOKEN_MOVE, {
      id: 'tok-1',
      x: 640,
      y: 320,
      moveId: 'restart-move',
    });
    await boardSaved;

    // Simulate an abrupt quit: stop the host, flush WAL, drop the handle.
    socket.disconnect();
    socket = null;
    await stopServer();
    checkpoint(db);
    db.close();
    db = null;

    // Reopen exactly as the next app launch would.
    const reopened = openDatabaseWithRecovery({ filePath: dbPath, backupDir });
    db = reopened.db;
    repos = createRepositories(db);

    assert.equal(repos.characters.get('char-mira').sheet_data.hp.current, 6);
    assert.equal(
      repos.dmRecords.get('session-notes-salt').data.text,
      'The sentinel wakes.',
    );

    const board = repos.board.get(map.campaign_id);
    assert.ok(board, 'board blueprint was checkpointed');
    assert.equal(board.data.tokens[0].x, 640);
    assert.equal(board.data.tokens[0].y, 320);
    assert.equal(repos.tokens.get('tok-1').x, 640);
  });
});
