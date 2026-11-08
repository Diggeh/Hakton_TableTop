import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { io as createClient } from 'socket.io-client';
import { startServer, stopServer } from '../../backend/server.js';
import { openDatabase } from '../../database/index.js';
import { createRepositories } from '../../database/repositories.js';
import { DEFAULT_SESSION_ID, EVENTS, ROLES } from '../../shared/events.js';

function waitForEvent(socket, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);
    function handler(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once(event, handler);
  });
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function connectRaw(url) {
  return new Promise((resolve, reject) => {
    const socket = createClient(url, { transports: ['websocket'], reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

const characterDocument = (overrides = {}) => ({
  kind: 'character',
  scopeId: 'char-mira',
  baseRevision: 1,
  data: { sheetData: { hp: { current: 20, max: 32 }, ac: 15 } },
  ...overrides,
});

describe('autosave:commit server pipeline', () => {
  let db;
  let repos;
  let map;
  let server;
  let dm;
  let player;
  let dmId;
  let playerId;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    repos = createRepositories(db);
    map = repos.maps.createWithCampaign('Campaign', 'Drowned Sanctuary');

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
      color: '#adfcf9',
    });

    server = await startServer({
      repos,
      port: 0,
      host: '127.0.0.1',
      autosaveDebounceMs: 10,
      autosaveMaxMs: 60,
    });

    dm = await connectRaw(server.localUrl);
    player = await connectRaw(server.localUrl);

    const dmJoin = await emitWithAck(dm, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Dungeon Master',
      role: ROLES.DM,
      hostToken: server.hostSecret,
    });
    const playerJoin = await emitWithAck(player, EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Aria',
    });

    dmId = dmJoin.welcome.playerId;
    playerId = playerJoin.welcome.playerId;
  });

  afterEach(async () => {
    dm?.disconnect();
    player?.disconnect();
    await stopServer();
    db?.close();
  });

  it('persists a DM character edit, acking the new revision and broadcasting it', async () => {
    const savedOnDm = waitForEvent(dm, EVENTS.AUTOSAVE_SAVED);

    const ack = await emitWithAck(dm, EVENTS.AUTOSAVE_COMMIT, {
      saveId: 'save-char-1',
      documents: [characterDocument()],
    });

    assert.equal(ack.ok, true);
    assert.equal(ack.documents[0].revision, 2);
    assert.equal(ack.documents[0].sheetData.hp.current, 20);
    assert.equal(repos.characters.get('char-mira').sheet_data.hp.current, 20);

    const broadcast = await savedOnDm;
    assert.equal(broadcast.documents[0].kind, 'character');
    assert.equal(broadcast.documents[0].scopeId, 'char-mira');
  });

  it('rejects a player editing a DM-owned sheet but allows their own', async () => {
    repos.characters.upsert({
      id: 'char-aria',
      ownerId: playerId,
      name: 'Aria',
      sheetData: { hp: { current: 18, max: 18 } },
    });

    const forbidden = await emitWithAck(player, EVENTS.AUTOSAVE_COMMIT, {
      saveId: 'save-forbidden',
      documents: [characterDocument()],
    });
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.reason, 'forbidden');
    assert.equal(repos.characters.get('char-mira').sheet_data.hp.current, 28);

    const allowed = await emitWithAck(player, EVENTS.AUTOSAVE_COMMIT, {
      saveId: 'save-own',
      documents: [
        {
          kind: 'character',
          scopeId: 'char-aria',
          baseRevision: 1,
          data: { sheetData: { hp: { current: 11, max: 18 } } },
        },
      ],
    });
    assert.equal(allowed.ok, true);
    assert.equal(repos.characters.get('char-aria').sheet_data.hp.current, 11);
  });

  it('returns the current document on a revision conflict without overwriting it', async () => {
    await emitWithAck(dm, EVENTS.AUTOSAVE_COMMIT, {
      saveId: 'save-newer',
      documents: [characterDocument({ baseRevision: 1 })],
    });

    const stale = await emitWithAck(dm, EVENTS.AUTOSAVE_COMMIT, {
      saveId: 'save-stale',
      documents: [
        characterDocument({
          baseRevision: 1,
          data: { sheetData: { hp: { current: 1, max: 32 } } },
        }),
      ],
    });

    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'conflict');
    assert.equal(stale.documents[0].conflict, true);
    assert.equal(stale.documents[0].current.revision, 2);
    assert.equal(stale.documents[0].current.sheetData.hp.current, 20);
    assert.equal(repos.characters.get('char-mira').sheet_data.hp.current, 20);
  });

  it('treats a repeated saveId as idempotent', async () => {
    const first = await emitWithAck(dm, EVENTS.AUTOSAVE_COMMIT, {
      saveId: 'save-idempotent',
      documents: [characterDocument()],
    });
    assert.equal(first.ok, true);

    const retry = await emitWithAck(dm, EVENTS.AUTOSAVE_COMMIT, {
      saveId: 'save-idempotent',
      documents: [
        characterDocument({
          data: { sheetData: { hp: { current: 2, max: 32 } } },
        }),
      ],
    });

    assert.deepEqual(retry, first);
    assert.equal(
      repos.characters.get('char-mira').sheet_data.hp.current,
      20,
      'retry must not apply a second edit',
    );
  });

  it('persists DM records for the DM and refuses players', async () => {
    const forbidden = await emitWithAck(player, EVENTS.AUTOSAVE_COMMIT, {
      saveId: 'save-dm-forbidden',
      documents: [
        {
          kind: 'dm-record',
          scopeId: 'dm-notes-1',
          baseRevision: null,
          data: { category: 'session-notes', title: 'Session notes', content: { text: 'hi' } },
        },
      ],
    });
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.reason, 'forbidden');

    const saved = await emitWithAck(dm, EVENTS.AUTOSAVE_COMMIT, {
      saveId: 'save-dm-1',
      documents: [
        {
          kind: 'dm-record',
          scopeId: 'dm-notes-1',
          baseRevision: null,
          data: {
            category: 'session-notes',
            title: 'Session notes',
            content: { text: 'The sentinel wakes when the tide returns.' },
          },
        },
      ],
    });

    assert.equal(saved.ok, true);
    assert.equal(saved.documents[0].revision, 1);
    assert.equal(
      repos.dmRecords.get('dm-notes-1').data.text,
      'The sentinel wakes when the tide returns.',
    );
  });

  it('writes a server-built board blueprint after a token move', async () => {
    const boardSaved = waitForEvent(dm, EVENTS.AUTOSAVE_SAVED, 4000);

    const move = await emitWithAck(player, EVENTS.TOKEN_MOVE, {
      id: 'tok-1',
      x: 315,
      y: 245,
      moveId: 'm-1',
    });
    assert.equal(move.ok, true);

    const broadcast = await boardSaved;
    const boardDoc = broadcast.documents.find((doc) => doc.kind === 'board');
    assert.ok(boardDoc, 'expected a board checkpoint broadcast');
    assert.equal(boardDoc.scopeId, `campaign:${map.campaign_id}`);

    const stored = repos.board.get(map.campaign_id);
    assert.ok(stored, 'board document was written');
    assert.equal(stored.data.activeMapId, map.id);
    assert.equal(stored.data.tokens[0].x, 315);
    assert.equal(stored.data.tokens[0].y, 245);
    assert.equal(stored.data.campaignId, map.campaign_id);
    assert.deepEqual(stored.data.tokenOrder, ['tok-1']);
  });
});
