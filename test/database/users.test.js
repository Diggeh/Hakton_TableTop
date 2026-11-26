import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../database/index.js';
import { createRepositories } from '../../database/repositories.js';
import { SessionManager } from '../../backend/session/sessionManager.js';

describe('User accounts & session identity linking (database/models/users.js)', () => {
  let db;
  let repos;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repos = createRepositories(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('starts with zero accounts on a fresh device database', () => {
    assert.equal(repos.users.count(), 0);
    assert.equal(repos.users.hasAny(), false);
    assert.equal(repos.users.first(), null);
  });

  it('creates a user account with salted scrypt password hash and authenticates', () => {
    const created = repos.users.create({
      username: 'Aerow',
      password: 'secretPassword123',
    });

    assert.ok(created.id.startsWith('u_'));
    assert.equal(created.username, 'Aerow');
    assert.equal('password_hash' in created, false, 'never exposes raw hash');
    assert.equal('salt' in created, false, 'never exposes salt');
    assert.equal(repos.users.hasAny(), true);
    assert.equal(repos.users.count(), 1);

    // Raw DB row has salted hash, not plaintext password
    const rawRow = db.prepare('SELECT * FROM users WHERE id = ?').get(created.id);
    assert.notEqual(rawRow.password_hash, 'secretPassword123');
    assert.ok(rawRow.salt.length >= 16);

    // Authenticate with valid credentials (case-insensitive username)
    const authOk = repos.users.authenticate({
      username: 'aerow',
      password: 'secretPassword123',
    });
    assert.ok(authOk);
    assert.equal(authOk.id, created.id);
    assert.equal(authOk.username, 'Aerow');

    // Reject wrong password
    const authBad = repos.users.authenticate({
      username: 'Aerow',
      password: 'wrongPassword',
    });
    assert.equal(authBad, null);
  });

  it('enforces unique usernames and password length validation', () => {
    repos.users.create({ username: 'Mira', password: 'password1' });

    assert.throws(
      () => repos.users.create({ username: 'mira', password: 'password2' }),
      /already exists/i,
    );

    assert.throws(
      () => repos.users.create({ username: 'Thorne', password: '123' }),
      /at least 4 characters/i,
    );
  });

  it('links characters, inventory, chat messages, and session participant to userId', () => {
    const user = repos.users.create({
      username: 'Thorne',
      password: 'shieldWall99',
    });

    const manager = new SessionManager({ persistence: repos.sessions });
    const joinRes = manager.joinSession({
      socketId: 'sock-player-1',
      displayName: user.username,
      userId: user.id,
    });

    assert.equal(joinRes.success, true);
    assert.equal(joinRes.participant.id, user.id);
    assert.equal(joinRes.welcome.playerId, user.id);

    // Character & inventory linked to user.id
    const char = repos.characters.upsert({
      id: 'char-thorne',
      ownerId: user.id,
      name: 'Thorne',
      sheetData: { hp: { current: 24, max: 24 } },
      inventoryData: { items: ['Longsword', 'Shield'] },
    });
    assert.equal(char.owner_id, user.id);
    assert.equal(repos.characters.byOwner(user.id).length, 1);

    // Chat log linked to user.id
    const msg = repos.chat.append({
      type: 'text',
      senderId: user.id,
      senderName: user.username,
      payload: { text: 'I ready my shield!' },
    });
    assert.equal(msg.sender_id, user.id);
  });
});
