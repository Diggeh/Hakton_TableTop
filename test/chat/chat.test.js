import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { io } from 'socket.io-client';
import { startServer, stopServer } from '../../backend/server.js';
import { EVENTS } from '../../shared/events.js';
import { CHAT_EVENTS, MAX_TEXT_LENGTH } from '../../shared/chatEvents.js';
import { connect, disconnect } from '../../src/net/socket.js';
import { chatStore } from '../../src/store/chatStore.js';
import { sessionStore } from '../../src/store/sessionStore.js';
import {
  loadChatHistory,
  retryPublicText,
  sendPublicText,
} from '../../src/net/chat.js';

function repository() {
  const rows = new Map();
  return {
    rows,
    get: (id) => rows.get(id) || null,
    append(m) {
      if (rows.has(m.id)) throw new Error('duplicate');
      const row = {
        id: m.id,
        sender_id: m.senderId,
        sender_name: m.senderName,
        recipient_id: m.recipientId ?? null,
        type: m.type,
        payload: m.payload,
        created_at: new Date(Date.now() + rows.size).toISOString(),
      };
      rows.set(row.id, row);
      return row;
    },
    publicHistoryForSession: (id, limit) =>
      [...rows.values()]
        .filter(
          (r) =>
            r.payload.sessionId === id &&
            r.type === 'text' &&
            r.recipient_id === null,
        )
        .slice(-limit),
  };
}
const ack = (socket, event, input) =>
  new Promise((resolve, reject) =>
    socket
      .timeout(3000)
      .emit(event, input, (error, result) =>
        error ? reject(error) : resolve(result),
      ),
  );
function waitFor(check) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > 4000) {
        clearInterval(timer);
        reject(new Error('State did not settle'));
      }
    }, 10);
  });
}

describe('Delgado public text chat', () => {
  let server, repo, clients;
  async function raw(name, sessionId = 'default', identity = {}) {
    const socket = io(server.localUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(socket);
    await once(socket, 'connect');
    const response = await ack(socket, EVENTS.SESSION_JOIN, {
      displayName: name,
      sessionId,
      ...identity,
    });
    assert.equal(response.success, true);
    return { socket, welcome: response.welcome };
  }
  beforeEach(async () => {
    disconnect();
    clients = [];
    repo = repository();
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      repos: { chat: repo },
    });
  });
  afterEach(async () => {
    disconnect();
    clients.forEach((s) => s.disconnect());
    await stopServer();
  });

  it('persists public text and delivers once to sender and peers using authoritative identity', async () => {
    const a = await raw('Josh');
    const b = await raw('Mira');
    const c = await raw('Thorne');
    const received = [[], [], []];
    [a, b, c].forEach((p, i) =>
      p.socket.on(CHAT_EVENTS.MESSAGE, (m) => received[i].push(m)),
    );
    const response = await ack(a.socket, CHAT_EVENTS.SEND, {
      requestId: 'first',
      text: '  Open the gate.  ',
      senderId: 'spoof',
      senderName: 'Fake DM',
      sessionId: 'other',
    });
    assert.equal(response.success, true);
    assert.equal(repo.rows.size, 1);
    assert.equal(response.message.senderId, a.welcome.playerId);
    assert.equal(response.message.senderName, 'Josh');
    assert.equal(response.message.sessionId, 'default');
    assert.equal(response.message.text, 'Open the gate.');
    await Promise.all(
      [b, c].map((p) => ack(p.socket, CHAT_EVENTS.HISTORY, {})),
    );
    assert.deepEqual(
      received.map((ms) => ms.length),
      [1, 1, 1],
    );
    assert.deepEqual((await ack(c.socket, CHAT_EVENTS.HISTORY, {})).messages, [
      response.message,
    ]);
  });

  it('isolates live delivery and history by joined session and excludes whispers/legacy rows', async () => {
    server.sessionManager.createSession({
      id: 'other',
      name: 'Other campaign',
    });
    const a = await raw('Josh');
    const other = await raw('Other', 'other');
    const received = [];
    other.socket.on(CHAT_EVENTS.MESSAGE, (m) => received.push(m));
    repo.append({
      id: 'private',
      senderId: 'dm',
      senderName: 'DM',
      recipientId: a.welcome.playerId,
      type: 'whisper',
      payload: { text: 'secret', sessionId: 'default' },
    });
    repo.append({
      id: 'legacy',
      senderId: 'dm',
      senderName: 'DM',
      type: 'text',
      payload: { text: 'unscoped' },
    });
    await ack(a.socket, CHAT_EVENTS.SEND, {
      requestId: 'public',
      text: 'Only this table.',
    });
    const history = await ack(other.socket, CHAT_EVENTS.HISTORY, {
      sessionId: 'default',
    });
    assert.equal(history.sessionId, 'other');
    assert.equal(history.messages.length, 0);
    assert.equal(received.length, 0);
    const local = await ack(a.socket, CHAT_EVENTS.HISTORY, {});
    assert.equal(local.messages.length, 1);
    assert.equal(local.messages[0].text, 'Only this table.');
  });

  it('rejects unjoined send/history, malformed text, and private/roll payloads', async () => {
    const unjoined = io(server.localUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(unjoined);
    await once(unjoined, 'connect');
    assert.equal(
      (await ack(unjoined, CHAT_EVENTS.SEND, { requestId: 'x', text: 'x' }))
        .success,
      false,
    );
    assert.equal((await ack(unjoined, CHAT_EVENTS.HISTORY, {})).success, false);
    const a = await raw('Josh');
    for (const input of [
      null,
      [],
      { requestId: 'x', text: ' ' },
      { requestId: 'x', text: 'x'.repeat(MAX_TEXT_LENGTH + 1) },
      { requestId: 'x', text: 'secret', recipientId: 'another' },
      { requestId: 'x', text: 'roll', type: 'dice_roll' },
      { requestId: 'x', text: 'bad\u0000text' },
    ])
      assert.equal(
        (await ack(a.socket, CHAT_EVENTS.SEND, input)).success,
        false,
      );
    assert.equal(repo.rows.size, 0);
  });

  it('retries idempotently after identity restoration without duplicate broadcast or rows', async () => {
    const a = await raw('Josh');
    const observer = await raw('Observer');
    const received = [];
    observer.socket.on(CHAT_EVENTS.MESSAGE, (m) => received.push(m));
    const request = { requestId: 'retry-same-id', text: 'A single message.' };
    const first = await ack(a.socket, CHAT_EVENTS.SEND, request);
    assert.equal(
      (await ack(a.socket, CHAT_EVENTS.SEND, request)).message.id,
      first.message.id,
    );
    const left = once(observer.socket, EVENTS.SESSION_PARTICIPANT_LEFT);
    a.socket.disconnect();
    await left;
    const resumed = await raw('Josh', 'default', {
      playerId: a.welcome.playerId,
      reconnectToken: a.welcome.reconnectToken,
    });
    assert.equal(
      (await ack(resumed.socket, CHAT_EVENTS.SEND, request)).message.id,
      first.message.id,
    );
    assert.equal(
      (
        await ack(resumed.socket, CHAT_EVENTS.SEND, {
          ...request,
          text: 'Changed text',
        })
      ).success,
      false,
    );
    await ack(observer.socket, CHAT_EVENTS.HISTORY, {});
    assert.equal(repo.rows.size, 1);
    assert.equal(received.length, 1);
  });

  it('does not broadcast on persistence failure and exposes a retryable client error', async () => {
    const observer = await raw('Observer');
    const received = [];
    observer.socket.on(CHAT_EVENTS.MESSAGE, (m) => received.push(m));
    await connect({ url: server.localUrl, displayName: 'Josh' });
    await waitFor(() => chatStore.getState().historyState === 'ready');
    const append = repo.append;
    repo.append = () => {
      throw new Error('private SQL error');
    };
    const result = await sendPublicText('Try again.', 'retry-client');
    assert.equal(result.success, false);
    assert.doesNotMatch(result.error, /SQL/);
    assert.equal(chatStore.getState().messages[0].status, 'failed');
    repo.append = append;
    assert.equal((await retryPublicText('retry-client')).success, true);
    await ack(observer.socket, CHAT_EVENTS.HISTORY, {});
    assert.equal(received.length, 1);
    assert.equal(chatStore.getState().messages.length, 1);
    assert.equal(chatStore.getState().messages[0].status, 'sent');
  });

  it('loads history on welcome/reconnect, merges live events once, and resets on leave', async () => {
    const source = await raw('Mira');
    await ack(source.socket, CHAT_EVENTS.SEND, {
      requestId: 'old',
      text: 'Earlier message',
    });
    const client = await connect({ url: server.localUrl, displayName: 'Josh' });
    await waitFor(() => chatStore.getState().historyState === 'ready');
    assert.equal(chatStore.getState().messages.length, 1);
    await sendPublicText('New message', 'new');
    await loadChatHistory();
    assert.equal(chatStore.getState().messages.length, 2);
    const before = sessionStore.getState().currentUser.id;
    const left = once(source.socket, EVENTS.SESSION_PARTICIPANT_LEFT);
    client.disconnect();
    await left;
    await ack(source.socket, CHAT_EVENTS.SEND, {
      requestId: 'missed',
      text: 'While away',
    });
    client.connect();
    await waitFor(() =>
      chatStore.getState().messages.some((m) => m.text === 'While away'),
    );
    assert.equal(sessionStore.getState().currentUser.id, before);
    assert.equal(client.listeners(CHAT_EVENTS.MESSAGE).length, 1);
    disconnect();
    assert.equal(chatStore.getState().messages.length, 0);
    assert.equal(chatStore.getState().scope, null);
  });
});
