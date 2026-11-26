import assert from 'node:assert/strict';
import { before, it } from 'node:test';
import {
  createWhisperIdentity,
  decryptWhisper,
  encryptWhisper,
  whisperSafetyCode,
} from '../../src/net/whisperCrypto.js';
import { validWhisperEnvelope } from '../../shared/whisperEncryption.js';

let alice, bob, host, message, encrypted;
before(async () => {
  [alice, bob, host] = await Promise.all(
    Array.from({ length: 3 }, () => createWhisperIdentity()),
  );
  message = {
    sessionId: 'table',
    senderId: 'alice',
    recipientId: 'bob',
    requestId: 'message-1',
    type: 'whisper',
    text: 'Hidden from the host',
  };
  encrypted = await encryptWhisper(alice, bob.publicKey, message);
});

it('uses a non-exportable device private key and a matching verification code on both devices', async () => {
  await assert.rejects(crypto.subtle.exportKey('jwk', alice.privateKey));
  assert.equal(
    await whisperSafetyCode('alice', alice.publicKey, 'bob', bob.publicKey),
    await whisperSafetyCode('bob', bob.publicKey, 'alice', alice.publicKey),
  );
  assert.notEqual(
    await whisperSafetyCode('alice', alice.publicKey, 'bob', bob.publicKey),
    await whisperSafetyCode('alice', alice.publicKey, 'bob', host.publicKey),
  );
});

it('decrypts at either endpoint and refuses another device, including the host', async () => {
  const wire = { ...message, text: undefined, encrypted };
  assert.equal(validWhisperEnvelope(encrypted, 'whisper'), true);
  assert.equal(
    await decryptWhisper(bob, alice.publicKey, 'bob', wire),
    message.text,
  );
  assert.equal(
    await decryptWhisper(alice, bob.publicKey, 'alice', wire),
    message.text,
  );
  await assert.rejects(decryptWhisper(host, alice.publicKey, 'bob', wire));
  await assert.rejects(decryptWhisper(host, alice.publicKey, 'host', wire));
  await assert.rejects(decryptWhisper(bob, host.publicKey, 'bob', wire));
});

it('rejects tampering and moving ciphertext to a different request, session, sender, or recipient', async () => {
  for (const part of ['ciphertext', 'iv', 'salt']) {
    const value = encrypted[part];
    const altered = {
      ...encrypted,
      [part]: (value[0] === 'A' ? 'B' : 'A') + value.slice(1),
    };
    await assert.rejects(
      decryptWhisper(bob, alice.publicKey, 'bob', {
        ...message,
        encrypted: altered,
      }),
    );
  }
  for (const field of [
    'requestId',
    'sessionId',
    'senderId',
    'recipientId',
    'type',
  ]) {
    await assert.rejects(
      decryptWhisper(bob, alice.publicKey, 'bob', {
        ...message,
        [field]: 'changed',
        encrypted,
      }),
    );
  }
});

it('uses fresh encryption material for each message and authenticates images separately', async () => {
  const another = await encryptWhisper(alice, bob.publicKey, message);
  assert.notEqual(another.salt, encrypted.salt);
  assert.notEqual(another.iv, encrypted.iv);
  const image =
    'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoEAAQAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=';
  const picture = { ...message, type: 'image', image, text: '' };
  const envelope = await encryptWhisper(alice, bob.publicKey, picture);
  const wire = { ...picture, image: undefined, encrypted: envelope };
  assert.equal(await decryptWhisper(bob, alice.publicKey, 'bob', wire), '');
  assert.equal(
    await decryptWhisper(
      bob,
      alice.publicKey,
      'bob',
      wire,
      envelope.imageCiphertext,
    ),
    image,
  );
  await assert.rejects(
    decryptWhisper(bob, alice.publicKey, 'bob', wire, envelope.ciphertext),
  );
});
