import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../database/index.js';
import { createChatModel } from '../../database/models/chat.js';
let directory, db, file;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hakton-chat-'));
  file = path.join(directory, 'chat.db');
  db = openDatabase(file);
});
afterEach(() => {
  db?.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
it('persists text across reopen and scopes history before applying its limit', () => {
  let chat = createChatModel(db);
  chat.append({
    id: 'keep',
    senderId: 'josh',
    senderName: 'Josh',
    type: 'text',
    payload: { text: 'Persist me', sessionId: 'table-a', requestId: 'keep' },
  });
  for (let i = 0; i < 110; i++)
    chat.append({
      id: `other-${i}`,
      senderId: 'other',
      senderName: 'Other',
      type: 'text',
      payload: { text: 'Other session', sessionId: 'table-b' },
    });
  chat.append({
    id: 'secret',
    senderId: 'josh',
    senderName: 'Josh',
    recipientId: 'private',
    type: 'whisper',
    payload: { text: 'Hidden', sessionId: 'table-a' },
  });
  chat.append({
    id: 'legacy',
    senderId: 'josh',
    senderName: 'Josh',
    type: 'text',
    payload: { text: 'Legacy' },
  });
  chat.append({
    id: 'attachment',
    senderId: 'josh',
    senderName: 'Josh',
    recipientId: 'private',
    type: 'image',
    payload: {
      text: 'Private image',
      sessionId: 'table-a',
      image: 'stored-bytes',
    },
  });
  db.close();
  db = null;
  db = openDatabase(file);
  chat = createChatModel(db);
  assert.deepEqual(
    chat.publicHistoryForSession('table-a').map((m) => m.id),
    ['keep'],
  );
  assert.deepEqual(
    chat.historyForSession('table-a', 'bystander', 100).map((m) => m.id),
    ['keep'],
  );
  for (const user of ['josh', 'private']) {
    const history = chat.historyForSession('table-a', user, 100);
    assert.deepEqual(
      history.map((m) => m.id),
      ['keep', 'secret', 'attachment'],
    );
    assert.equal(history[2].payload.image, undefined);
  }
  assert.equal(chat.get('attachment').payload.image, 'stored-bytes');
  assert.equal(chat.get('keep').payload.text, 'Persist me');
  assert.equal(chat.get('missing'), null);
  assert.equal(chat.publicHistoryForSession('table-b', 10000).length, 100);
});
