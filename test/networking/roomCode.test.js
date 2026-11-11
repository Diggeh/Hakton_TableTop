import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeRoomCode,
  encodeInternetCode,
  encodeRoomCode,
} from '../../shared/roomCode.js';

describe('Dual LAN & WebRTC Room Code System (shared/roomCode.js)', () => {
  it('round-trips LAN IPv4 and default port 3001 into an 8-char code (XXXX-XXXX)', () => {
    const code = encodeRoomCode('192.168.1.42', 3001);
    assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    const decoded = decodeRoomCode(code);
    assert.equal(decoded.mode, 'lan');
    assert.equal(decoded.ip, '192.168.1.42');
    assert.equal(decoded.port, 3001);
    assert.equal(decoded.hostUrl, 'http://192.168.1.42:3001');
  });

  it('round-trips arbitrary non-default ports losslessly', () => {
    const code = encodeRoomCode('10.0.0.15', 54321);
    assert.match(code, /^[0-9A-Z]{5}-[0-9A-Z]{5}$/);

    const decoded = decodeRoomCode(code);
    assert.equal(decoded.mode, 'lan');
    assert.equal(decoded.ip, '10.0.0.15');
    assert.equal(decoded.port, 54321);
    assert.equal(decoded.hostUrl, 'http://10.0.0.15:54321');
  });

  it('accepts LAN- prefix, lowercase input, and whitespace', () => {
    const code = encodeRoomCode('192.168.0.105', 3001);
    const decoded = decodeRoomCode(`  lan-${code.toLowerCase()}  `);
    assert.equal(decoded.mode, 'lan');
    assert.equal(decoded.ip, '192.168.0.105');
    assert.equal(decoded.port, 3001);
  });

  it('encodes and decodes Internet WebRTC room codes (NET-XXXX)', () => {
    const netCode = encodeInternetCode('session-salt:192.168.1.42:3001');
    assert.match(netCode, /^NET-[0-9A-Z]{4}$/);

    const decoded = decodeRoomCode(netCode.toLowerCase());
    assert.equal(decoded.mode, 'webrtc');
    assert.equal(decoded.code, netCode);
    assert.ok(decoded.peerId.startsWith('hakton-net-'));
    assert.equal(decoded.hostUrl, `webrtc://${decoded.peerId}`);
  });

  it('supports direct host:port addresses as a fallback', () => {
    const decoded = decodeRoomCode('192.168.1.10:3001');
    assert.equal(decoded.mode, 'lan');
    assert.equal(decoded.ip, '192.168.1.10');
    assert.equal(decoded.port, 3001);
    assert.equal(decoded.hostUrl, 'http://192.168.1.10:3001');
  });

  it('rejects malformed room codes with a clear error message', () => {
    assert.throws(() => decodeRoomCode(''), /valid room code/i);
    assert.throws(() => decodeRoomCode('ABC'), /room code/i);
  });
});
