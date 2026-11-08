import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerSocketRouter } from '../../backend/socket/router.js';
import {
  DEFAULT_SESSION_ID,
  ERROR_CODES,
  EVENTS,
  ROLES,
} from '../../shared/events.js';
import { DICE_MESSAGE_TYPE, DICE_VISIBILITY } from '../../shared/dice/constants.js';
import { rollFormula } from '../../shared/dice/roller.js';

/**
 * Lightweight in-memory mock of Socket.IO Server + Sockets + SQLite chat repo
 * so router security, room scoping, and SQLite contract can be verified in-process.
 */
function createTestHarness() {
  const sockets = new Map();
  const rooms = new Map(); // room -> Set<socket>
  const rows = [];

  const chatRepo = {
    append(m) {
      const row = {
        id: m.id,
        sender_id: m.senderId,
        sender_name: m.senderName,
        recipient_id: m.recipientId ?? null,
        type: m.type,
        payload: JSON.parse(JSON.stringify(m.payload ?? {})),
        created_at: new Date().toISOString(),
      };
      rows.push(row);
      return row;
    },
    historyFor(userId) {
      return rows.filter(
        (r) =>
          r.recipient_id === null ||
          r.recipient_id === userId ||
          r.sender_id === userId,
      );
    },
  };

  const io = new EventEmitter();
  io.sockets = { sockets };
  io.to = (room) => ({
    emit(event, payload) {
      for (const s of rooms.get(room) || []) {
        s.inbox.emit(event, payload);
      }
    },
  });

  const hostSecret = 'test-host-secret-token';
  const sessionManager = registerSocketRouter(
    io,
    { chat: chatRepo },
    { hostSecret },
  );

  let nextId = 1;
  function connectSocket() {
    const id = `sock_${nextId++}`;
    const handlers = new EventEmitter();
    const inbox = new EventEmitter();
    const socket = {
      id,
      data: {},
      inbox,
      on: (ev, fn) => handlers.on(ev, fn),
      removeAllListeners: (ev) => handlers.removeAllListeners(ev),
      emit: (ev, payload) => inbox.emit(ev, payload),
      join: (room) => {
        if (!rooms.has(room)) rooms.set(room, new Set());
        rooms.get(room).add(socket);
      },
      leave: (room) => {
        rooms.get(room)?.delete(socket);
      },
      to: (room) => ({
        emit(ev, payload) {
          for (const peer of rooms.get(room) || []) {
            if (peer.id !== id) peer.inbox.emit(ev, payload);
          }
        },
      }),
      sendClientEvent(ev, payload) {
        return new Promise((resolve) => {
          handlers.emit(ev, payload, resolve);
        });
      },
    };
    sockets.set(id, socket);
    io.emit('connection', socket);
    return socket;
  }

  return { connectSocket, chatRepo, rows, hostSecret, sessionManager };
}

describe('Socket Router: dice:roll validation, SQLite chat_messages logging & DM secret roll isolation', () => {
  it('persists public rolls to chat_messages and broadcasts dice:rolled to all session members', async () => {
    const { connectSocket, chatRepo, hostSecret } = createTestHarness();
    const dm = connectSocket();
    const mira = connectSocket();

    const dmJoin = await dm.sendClientEvent(EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Dungeon Master',
      role: ROLES.DM,
      hostToken: hostSecret,
    });
    const miraJoin = await mira.sendClientEvent(EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Mira',
      role: ROLES.PLAYER,
    });
    assert.equal(dmJoin.success, true);
    assert.equal(miraJoin.success, true);

    const dmInbox = [];
    const miraInbox = [];
    dm.inbox.on(EVENTS.DICE_ROLLED, (msg) => dmInbox.push(msg));
    mira.inbox.on(EVENTS.DICE_ROLLED, (msg) => miraInbox.push(msg));

    const rolled = rollFormula('/r 2d20kh1+5 # Longsword');
    assert.equal(rolled.ok, true);

    const ack = await mira.sendClientEvent(EVENTS.DICE_ROLL, rolled.roll);
    assert.equal(ack.success, true);
    assert.equal(ack.roll.type, DICE_MESSAGE_TYPE);
    assert.equal(ack.roll.sender_name, 'Mira');
    assert.equal(ack.roll.recipient_id, null);
    assert.equal(ack.roll.payload.total, rolled.roll.total);

    assert.equal(dmInbox.length, 1);
    assert.equal(miraInbox.length, 1);
    assert.equal(dmInbox[0].payload.total, rolled.roll.total);

    // Public roll is visible in both DM and Player chat history
    assert.equal(chatRepo.historyFor(dmJoin.welcome.playerId).length, 1);
    assert.equal(chatRepo.historyFor(miraJoin.welcome.playerId).length, 1);
  });

  it('isolates secret DM rolls (/gmroll and DM-only) so players never receive the socket event or DB row', async () => {
    const { connectSocket, chatRepo, hostSecret } = createTestHarness();
    const dm = connectSocket();
    const mira = connectSocket();
    const thorne = connectSocket();

    const dmJoin = await dm.sendClientEvent(EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Dungeon Master',
      role: ROLES.DM,
      hostToken: hostSecret,
    });
    const miraJoin = await mira.sendClientEvent(EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Mira',
      role: ROLES.PLAYER,
    });
    const thorneJoin = await thorne.sendClientEvent(EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Thorne',
      role: ROLES.PLAYER,
    });

    const dmReceived = [];
    const miraReceived = [];
    const thorneReceived = [];
    dm.inbox.on(EVENTS.DICE_ROLLED, (m) => dmReceived.push(m));
    mira.inbox.on(EVENTS.DICE_ROLLED, (m) => miraReceived.push(m));
    thorne.inbox.on(EVENTS.DICE_ROLLED, (m) => thorneReceived.push(m));

    // Case 1: DM rolls a secret roll
    const dmSecret = rollFormula('/gmroll 1d20+9 # Ambush Stealth');
    assert.equal(dmSecret.roll.visibility, DICE_VISIBILITY.DM);
    const ack1 = await dm.sendClientEvent(EVENTS.DICE_ROLL, dmSecret.roll);
    assert.equal(ack1.success, true);

    assert.equal(dmReceived.length, 1);
    assert.equal(miraReceived.length, 0, 'Mira must not receive DM secret roll');
    assert.equal(thorneReceived.length, 0, 'Thorne must not receive DM secret roll');
    assert.equal(chatRepo.historyFor(miraJoin.welcome.playerId).length, 0);
    assert.equal(chatRepo.historyFor(thorneJoin.welcome.playerId).length, 0);
    assert.equal(chatRepo.historyFor(dmJoin.welcome.playerId).length, 1);

    // Case 2: Mira rolls a /gmroll to the DM -> only Mira and the DM receive it, Thorne does not
    const playerGmRoll = rollFormula('/gmroll 1d20+4 # Death Save');
    const ack2 = await mira.sendClientEvent(EVENTS.DICE_ROLL, playerGmRoll.roll);
    assert.equal(ack2.success, true);

    assert.equal(dmReceived.length, 2, 'DM receives player /gmroll');
    assert.equal(miraReceived.length, 1, 'Roller receives own /gmroll confirmation');
    assert.equal(thorneReceived.length, 0, 'Other players must not receive /gmroll');
    assert.equal(chatRepo.historyFor(thorneJoin.welcome.playerId).length, 0);
  });

  it('rejects tampered totals or out-of-bounds dice values with E_INVALID_PAYLOAD', async () => {
    const { connectSocket } = createTestHarness();
    const mira = connectSocket();
    await mira.sendClientEvent(EVENTS.SESSION_JOIN, {
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Mira',
      role: ROLES.PLAYER,
    });

    const tampered = {
      clientRollId: 'cheat_1',
      formula: '1d20+5',
      visibility: 'public',
      dice: [{ termIndex: 0, sides: 20, sign: 1, value: 25, kept: true }],
      modifier: 5,
      total: 30,
    };
    const ack = await mira.sendClientEvent(EVENTS.DICE_ROLL, tampered);
    assert.equal(ack.success, false);
    assert.equal(ack.code, ERROR_CODES.INVALID_PAYLOAD);
  });
});
