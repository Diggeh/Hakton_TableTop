import { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE } from '../../shared/chatEvents.js';

// Accept a single lossy WebP keyframe. Reject extended containers, metadata and animation.
export function validateChatImage(encoded) {
  if (
    typeof encoded !== 'string' ||
    encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
  )
    return false;
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.length < 31 ||
    bytes.length > MAX_IMAGE_BYTES ||
    bytes.toString('base64') !== encoded ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.toString('ascii', 8, 16) !== 'WEBPVP8 '
  )
    return false;
  const chunkSize = bytes.readUInt32LE(16);
  if (
    chunkSize < 11 ||
    20 + chunkSize + (chunkSize % 2) !== bytes.length ||
    (bytes[20] & 1) !== 0 ||
    bytes.readUIntBE(23, 3) !== 0x9d012a
  )
    return false;
  const width = bytes.readUInt16LE(26) & 0x3fff;
  const height = bytes.readUInt16LE(28) & 0x3fff;
  return (
    width > 0 &&
    height > 0 &&
    width <= MAX_IMAGE_EDGE &&
    height <= MAX_IMAGE_EDGE
  );
}
