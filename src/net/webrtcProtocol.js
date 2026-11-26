/**
 * Pure-JS framing, chunking, and asset-path sanitization for the PeerJS DataChannel tunnel.
 * Works identically in Electron renderer, browser, and `node:test`.
 */

export const PROTOCOL_VERSION = 1;
export const MAX_CHUNK_CHARS = 32 * 1024;
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_PENDING_CHUNKS = 2048;
const STALE_ASSEMBLY_MS = 30_000;

/**
 * Validates and normalizes a relative asset/audio path allowed over the WebRTC proxy.
 * Only `/assets/...` and `/soundboard/audio/...` paths are permitted; traversal and
 * external URLs are rejected.
 *
 * @param {unknown} rawPath
 * @returns {string | null}
 */
export function sanitizeProxyAssetPath(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  if (/[\x00-\x1F\x7F\\]/.test(trimmed)) return null;
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;

  let parsed;
  try {
    parsed = new URL(trimmed, 'http://hakton.local');
  } catch {
    return null;
  }

  if (parsed.origin !== 'http://hakton.local') return null;
  const pathname = parsed.pathname;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decodedPath.includes('..') || decodedPath.includes('\\')) return null;

  const allowed =
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/soundboard/audio/');
  if (!allowed) return null;

  return `${pathname}${parsed.search}`;
}

/**
 * Encodes a uint8 array into base64 in 8 KiB chunks so large buffers never overflow JS argument limits.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function uint8ToBase64(bytes) {
  if (!bytes || bytes.length === 0) return '';
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  const step = 8192;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/**
 * Decodes a base64 string into a Uint8Array.
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function base64ToUint8(base64) {
  if (!base64) return new Uint8Array(0);
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(base64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encodes a protocol message into one or more SCTP-safe JSON strings.
 *
 * @param {object} message
 * @param {() => string} nextChunkId
 * @returns {string[]}
 */
export function encodeFrames(message, nextChunkId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) {
  const serialized = JSON.stringify(message);
  if (serialized.length <= MAX_CHUNK_CHARS) {
    return [serialized];
  }
  const total = Math.ceil(serialized.length / MAX_CHUNK_CHARS);
  if (total > MAX_PENDING_CHUNKS) {
    throw new Error('Payload exceeds maximum WebRTC frame chunk limit.');
  }
  const id = String(nextChunkId());
  const frames = new Array(total);
  for (let seq = 0; seq < total; seq += 1) {
    const slice = serialized.slice(seq * MAX_CHUNK_CHARS, (seq + 1) * MAX_CHUNK_CHARS);
    frames[seq] = JSON.stringify({
      __haktonChunk: PROTOCOL_VERSION,
      id,
      seq,
      total,
      data: slice,
    });
  }
  return frames;
}

/**
 * Creates a stateful receiver that parses single frames and reassembles chunked frames.
 *
 * @param {(message: object) => void} onMessage
 */
export function createFrameAssembler(onMessage) {
  const inflight = new Map();

  function pruneStale(now) {
    for (const [id, entry] of inflight.entries()) {
      if (now - entry.updatedAt > STALE_ASSEMBLY_MS) {
        inflight.delete(id);
      }
    }
  }

  function clear() {
    inflight.clear();
  }

  function push(raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
    } else if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      try {
        const view =
          raw instanceof ArrayBuffer
            ? new Uint8Array(raw)
            : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        const text = new TextDecoder().decode(view);
        parsed = JSON.parse(text);
      } catch {
        return;
      }
    }

    if (!parsed || typeof parsed !== 'object') return;

    if (parsed.__haktonChunk) {
      const { id, seq, total, data } = parsed;
      if (
        typeof id !== 'string' ||
        !id ||
        !Number.isInteger(seq) ||
        !Number.isInteger(total) ||
        total < 1 ||
        total > MAX_PENDING_CHUNKS ||
        seq < 0 ||
        seq >= total ||
        typeof data !== 'string'
      ) {
        return;
      }

      const now = Date.now();
      pruneStale(now);

      let entry = inflight.get(id);
      if (!entry) {
        entry = { total, received: 0, parts: new Array(total), updatedAt: now };
        inflight.set(id, entry);
      }
      if (entry.total !== total) {
        inflight.delete(id);
        return;
      }
      if (entry.parts[seq] === undefined) {
        entry.received += 1;
      }
      entry.parts[seq] = data;
      entry.updatedAt = now;

      if (entry.received === total) {
        inflight.delete(id);
        try {
          const full = JSON.parse(entry.parts.join(''));
          if (full && typeof full === 'object') {
            onMessage(full);
          }
        } catch {
          // Ignore malformed reassembled payload
        }
      }
      return;
    }

    onMessage(parsed);
  }

  return { push, clear };
}
