import { MAX_IMAGE_BYTES } from './chatEvents.js';

export const WHISPER_VERSION = 1;

function base64(value, bytes) {
  return (
    typeof value === 'string' &&
    value.length === Math.ceil(bytes / 3) * 4 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

export function validWhisperPublicKey(key) {
  return base64(key, 65) && key.startsWith('B');
}

export function validWhisperEnvelope(envelope, type, withImage = true) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
    return false;
  const {
    version,
    senderKey,
    recipientKey,
    salt,
    iv,
    ciphertext,
    imageIv,
    imageCiphertext,
  } = envelope;
  const validCipher = (value, max) =>
    typeof value === 'string' &&
    value.length >= 24 &&
    value.length <= max &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value);
  return (
    version === WHISPER_VERSION &&
    validWhisperPublicKey(senderKey) &&
    validWhisperPublicKey(recipientKey) &&
    base64(salt, 32) &&
    base64(iv, 12) &&
    validCipher(ciphertext, 16000) &&
    (type === 'image'
      ? base64(imageIv, 12) &&
        (!withImage ||
          validCipher(
            imageCiphertext,
            Math.ceil((MAX_IMAGE_BYTES + 16) / 3) * 4,
          ))
      : imageIv === undefined && imageCiphertext === undefined)
  );
}

export function whisperContext(message) {
  return JSON.stringify([
    'Hakton whisper',
    WHISPER_VERSION,
    message.sessionId,
    message.senderId,
    message.recipientId,
    message.requestId,
    message.type,
  ]);
}
