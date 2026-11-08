import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../../backend/session/sessionManager.js';
import { DEFAULT_SESSION_ID, ERROR_CODES, ROLES } from '../../shared/events.js';

describe('Session & Player Identification Manager (backend/session/sessionManager.js)', () => {
  const HOST_SECRET = 'test-host-secret-token-for-dm-verification-123456';
  /** @type {SessionManager} */
  let manager;

  beforeEach(() => {
    manager = new SessionManager({
      hostSecret: HOST_SECRET,
      defaultSessionId: DEFAULT_SESSION_ID,
      defaultSessionName: 'Curse of Strahd',
    });
  });

  it('assigns a unique playerId, role, and reconnectToken on valid player join', () => {
    const res = manager.joinSession({
      socketId: 'sock-1',
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Aria',
    });

    assert.equal(res.success, true);
    assert.equal(res.isReconnection, false);
    assert.ok(res.participant.id.startsWith('p_'));
    assert.equal(res.participant.displayName, 'Aria');
    assert.equal(res.participant.role, ROLES.PLAYER);
    assert.equal(typeof res.participant.reconnectToken, 'string');
    assert.ok(res.participant.reconnectToken.length >= 32);

    // Public participants list must NEVER expose reconnectToken
    const sanitized = manager.getSanitizedParticipants(DEFAULT_SESSION_ID);
    assert.equal(sanitized.length, 1);
    assert.equal(sanitized[0].id, res.participant.id);
    assert.equal(sanitized[0].displayName, 'Aria');
    assert.equal('reconnectToken' in sanitized[0], false);
  });

  it('grants DM role only when valid hostToken is supplied and rejects unauthorized DM requests', () => {
    // Unauthorized attempt by regular player claiming DM role
    const unauthorized = manager.joinSession({
      socketId: 'sock-hacker',
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'FakeDM',
      role: ROLES.DM,
    });
    assert.equal(unauthorized.success, false);
    assert.equal(unauthorized.code, ERROR_CODES.UNAUTHORIZED_ROLE);

    // Wrong hostToken attempt
    const wrongSecret = manager.joinSession({
      socketId: 'sock-hacker',
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'FakeDM',
      role: ROLES.DM,
      hostToken: 'wrong-secret',
    });
    assert.equal(wrongSecret.success, false);
    assert.equal(wrongSecret.code, ERROR_CODES.UNAUTHORIZED_ROLE);

    // Valid hostToken grants DM role
    const dmJoin = manager.joinSession({
      socketId: 'sock-dm',
      sessionId: DEFAULT_SESSION_ID,
      displayName: 'Dungeon Master',
      role: ROLES.DM,
      hostToken: HOST_SECRET,
    });
    assert.equal(dmJoin.success, true);
    assert.equal(dmJoin.participant.role, ROLES.DM);
  });

  it('rejects invalid or nonexistent sessions', () => {
    const nonexistent = manager.joinSession({
      socketId: 'sock-1',
      sessionId: 'unknown-room-42',
      displayName: 'Aria',
    });
    assert.equal(nonexistent.success, false);
    assert.equal(nonexistent.code, ERROR_CODES.SESSION_NOT_FOUND);

    const malformed = manager.joinSession({
      socketId: 'sock-1',
      sessionId: 'invalid session id with spaces!',
      displayName: 'Aria',
    });
    assert.equal(malformed.success, false);
    assert.equal(malformed.code, ERROR_CODES.INVALID_SESSION);
  });

  it('validates displayName and rejects empty, oversized, or control-char names', () => {
    for (const badName of ['', '   ', null, 123, 'a'.repeat(40), 'Bad\x00Name']) {
      const res = manager.joinSession({
        socketId: 'sock-1',
        displayName: badName,
      });
      assert.equal(res.success, false);
      assert.equal(res.code, ERROR_CODES.INVALID_DISPLAY_NAME);
    }
  });

  it('prevents duplicate session membership from the same socket and duplicate active player names', () => {
    const first = manager.joinSession({
      socketId: 'sock-1',
      displayName: 'Aria',
    });
    assert.equal(first.success, true);

    // Duplicate join from same active socket
    const duplicateSocket = manager.joinSession({
      socketId: 'sock-1',
      displayName: 'Aria',
    });
    assert.equal(duplicateSocket.success, false);
    assert.equal(duplicateSocket.code, ERROR_CODES.DUPLICATE_SESSION_MEMBER);

    // Different socket trying to use the same active displayName (case-insensitive)
    const duplicateName = manager.joinSession({
      socketId: 'sock-2',
      displayName: 'aria',
    });
    assert.equal(duplicateName.success, false);
    assert.equal(duplicateName.code, ERROR_CODES.DUPLICATE_PLAYER_IDENTITY);
  });

  it('restores player identity safely across reconnections and prevents impersonation', () => {
    const initial = manager.joinSession({
      socketId: 'sock-aria-1',
      displayName: 'Aria',
    });
    assert.equal(initial.success, true);
    const { playerId, reconnectToken } = initial.welcome;

    // Simulate disconnect
    const disc = manager.handleDisconnect('sock-aria-1');
    assert.ok(disc);
    assert.equal(disc.participant.connected, false);

    // Impersonation attempt: another client supplies playerId without valid reconnectToken
    const impersonate = manager.joinSession({
      socketId: 'sock-attacker',
      displayName: 'Aria',
      playerId,
      reconnectToken: 'forged-token',
    });
    assert.equal(impersonate.success, false);
    assert.equal(impersonate.code, ERROR_CODES.UNAUTHORIZED_IDENTITY);

    // Legitimate reconnection with valid reconnectToken on a new socket.id
    const restored = manager.joinSession({
      socketId: 'sock-aria-2',
      displayName: 'Aria',
      playerId,
      reconnectToken,
    });
    assert.equal(restored.success, true);
    assert.equal(restored.isReconnection, true);
    assert.equal(restored.welcome.playerId, playerId);
    assert.equal(restored.participant.socketId, 'sock-aria-2');
    assert.equal(restored.participant.connected, true);

    // Attempting to escalate role to DM during reconnect without hostToken is rejected
    manager.handleDisconnect('sock-aria-2');
    const escalate = manager.joinSession({
      socketId: 'sock-aria-3',
      displayName: 'Aria',
      role: ROLES.DM,
      playerId,
      reconnectToken,
    });
    assert.equal(escalate.success, false);
    assert.equal(escalate.code, ERROR_CODES.UNAUTHORIZED_ROLE);
  });
});
