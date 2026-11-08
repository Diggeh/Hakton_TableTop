import { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE } from '../../shared/chatEvents.js';

export const MAX_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024;

// Chromium may include an ICC profile. Retain only the encoded frame.
function stripWebPMetadata(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size + (size % 2);
    if (end > bytes.length) break;
    if (String.fromCharCode(...bytes.subarray(offset, offset + 4)) === 'VP8 ') {
      const frame = new Uint8Array(12 + end - offset);
      frame.set(bytes.subarray(0, 12));
      frame.set(bytes.subarray(offset, end), 12);
      new DataView(frame.buffer).setUint32(4, frame.length - 8, true);
      return frame;
    }
    offset = end;
  }
  throw new Error('The image encoder did not produce a WebP frame.');
}

export async function prepareChatImage(file) {
  if (file.size > MAX_SOURCE_IMAGE_BYTES)
    throw new Error('Choose an image under 10 MB.');
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const tag = String.fromCharCode(...header);
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every(
    (value, i) => header[i] === value,
  );
  const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
  const webp = tag.startsWith('RIFF') && tag.slice(8) === 'WEBP';
  if (!png && !jpeg && !webp)
    throw new Error('Choose a PNG, JPEG, or WebP image.');

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('This image could not be opened.');
  });
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Image processing is unavailable.');
    const fit = Math.min(
      1,
      MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    for (const scale of [fit, fit * 0.75, fit * 0.5]) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.8, 0.6]) {
        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, 'image/webp', quality),
        );
        if (!blob || blob.type !== 'image/webp' || blob.size > MAX_IMAGE_BYTES)
          continue;
        const bytes = stripWebPMetadata(await blob.arrayBuffer());
        // Encode in chunks to stay within JavaScript's argument limit.
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        return btoa(binary);
      }
    }
    throw new Error(
      'This image could not be compressed. Choose a smaller image.',
    );
  } finally {
    bitmap.close();
  }
}
