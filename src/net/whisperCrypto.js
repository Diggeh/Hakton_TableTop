import { MAX_IMAGE_BYTES, MAX_TEXT_LENGTH } from '../../shared/chatEvents.js';
import {
  validWhisperEnvelope,
  validWhisperPublicKey,
  WHISPER_VERSION,
  whisperContext,
} from '../../shared/whisperEncryption.js';
import { readWhisperKey, saveWhisperKey } from './whisperKeys.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function encodeBase64(bytes) {
  let text = '';
  const array = new Uint8Array(bytes);
  for (let start = 0; start < array.length; start += 8192) {
    text += String.fromCharCode(...array.subarray(start, start + 8192));
  }
  return btoa(text);
}

export function decodeBase64(value) {
  const bytes = Uint8Array.from(atob(value), (character) =>
    character.charCodeAt(0),
  );
  if (encodeBase64(bytes) !== value)
    throw new Error('Invalid encrypted message encoding.');
  return bytes;
}

export async function createWhisperIdentity() {
  // IndexedDB can persist CryptoKeys without exporting the private scalar.
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  return {
    privateKey: pair.privateKey,
    publicKey: encodeBase64(
      await crypto.subtle.exportKey('raw', pair.publicKey),
    ),
  };
}

export async function whisperIdentity(scope) {
  const id = 'identity:' + scope;
  const existing = await readWhisperKey(id);
  return existing ?? saveWhisperKey(id, await createWhisperIdentity(), true);
}

export async function whisperSafetyCode(ownId, ownKey, peerId, peerKey) {
  const identities = [
    [ownId, ownKey],
    [peerId, peerKey],
  ].sort(([a], [b]) => a.localeCompare(b));
  const hash = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(
      JSON.stringify(['Hakton whisper verification', ...identities]),
    ),
  );
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .match(/.{4}/g)
    .join(' ');
}

export async function verifiedWhisperKey(scope, peerId) {
  return readWhisperKey('trusted:' + JSON.stringify([scope, peerId]));
}

export async function trustWhisperKey(scope, peerId, publicKey) {
  if (!validWhisperPublicKey(publicKey))
    throw new Error('Invalid whisper key.');
  await crypto.subtle.importKey(
    'raw',
    decodeBase64(publicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  await saveWhisperKey('trusted:' + JSON.stringify([scope, peerId]), publicKey);
}

async function contentKey(identity, peerKey, envelope, context) {
  const publicKey = await crypto.subtle.importKey(
    'raw',
    decodeBase64(peerKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const secret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    identity.privateKey,
    256,
  );
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: decodeBase64(envelope.salt),
      info: encoder.encode(context),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function parameters(iv, context, part) {
  return {
    name: 'AES-GCM',
    iv: decodeBase64(iv),
    additionalData: encoder.encode(JSON.stringify([context, part])),
    tagLength: 128,
  };
}

export async function encryptWhisper(identity, recipientKey, message) {
  const envelope = {
    version: WHISPER_VERSION,
    senderKey: identity.publicKey,
    recipientKey,
    salt: encodeBase64(crypto.getRandomValues(new Uint8Array(32))),
    iv: encodeBase64(crypto.getRandomValues(new Uint8Array(12))),
  };
  const context = whisperContext(message);
  const key = await contentKey(identity, recipientKey, envelope, context);
  envelope.ciphertext = encodeBase64(
    await crypto.subtle.encrypt(
      parameters(envelope.iv, context, 'text'),
      key,
      encoder.encode(message.text),
    ),
  );
  if (message.type === 'image') {
    const bytes = decodeBase64(message.image);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image is too large.');
    envelope.imageIv = encodeBase64(crypto.getRandomValues(new Uint8Array(12)));
    envelope.imageCiphertext = encodeBase64(
      await crypto.subtle.encrypt(
        parameters(envelope.imageIv, context, 'image'),
        key,
        bytes,
      ),
    );
  }
  return envelope;
}

export async function decryptWhisper(
  identity,
  peerKey,
  ownId,
  message,
  encryptedImage,
) {
  const envelope = message.encrypted;
  if (
    !validWhisperEnvelope(envelope, message.type, false) ||
    (message.senderId !== ownId && message.recipientId !== ownId)
  )
    throw new Error('Invalid encrypted whisper.');
  const sender = message.senderId === ownId;
  if (
    (sender ? envelope.senderKey : envelope.recipientKey) !==
      identity.publicKey ||
    (sender ? envelope.recipientKey : envelope.senderKey) !== peerKey
  ) {
    throw new Error('Whisper identity does not match the verified keys.');
  }
  const context = whisperContext(message);
  const key = await contentKey(identity, peerKey, envelope, context);
  if (encryptedImage !== undefined) {
    if (
      message.type !== 'image' ||
      typeof encryptedImage !== 'string' ||
      encryptedImage.length > Math.ceil((MAX_IMAGE_BYTES + 16) / 3) * 4
    )
      throw new Error('Invalid encrypted image.');
    const bytes = new Uint8Array(
      await crypto.subtle.decrypt(
        parameters(envelope.imageIv, context, 'image'),
        key,
        decodeBase64(encryptedImage),
      ),
    );
    const header = String.fromCharCode(...bytes.subarray(0, 12));
    if (
      bytes.length > MAX_IMAGE_BYTES ||
      !header.startsWith('RIFF') ||
      header.slice(8, 12) !== 'WEBP'
    )
      throw new Error('Invalid whisper image.');
    return encodeBase64(bytes);
  }
  const text = decoder.decode(
    await crypto.subtle.decrypt(
      parameters(envelope.iv, context, 'text'),
      key,
      decodeBase64(envelope.ciphertext),
    ),
  );
  if (text.length > MAX_TEXT_LENGTH) throw new Error('Invalid whisper text.');
  return text;
}
