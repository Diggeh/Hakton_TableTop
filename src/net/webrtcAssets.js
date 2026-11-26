import { base64ToUint8, sanitizeProxyAssetPath } from './webrtcProtocol.js';

const blobCache = new Map();
const inflightRequests = new Map();

export function isWebRtcUrl(url) {
  return typeof url === 'string' && /^webrtc:\/\//i.test(url.trim());
}

/**
 * Extracts `/assets/...` or `/soundboard/audio/...` from a `webrtc://peerId/path` URL.
 * @param {string} url
 * @returns {string | null}
 */
export function extractWebRtcAssetPath(url) {
  if (!isWebRtcUrl(url)) return null;
  const withoutScheme = url.trim().replace(/^webrtc:\/\/[^/]+/i, '');
  return sanitizeProxyAssetPath(withoutScheme);
}

/**
 * Fetches an asset over the active WebRTC DataChannel and caches a local `blob:` URL.
 * Deduplicates concurrent requests for the same path.
 *
 * @param {string} url
 * @param {import('./webrtcClientAdapter.js').WebRtcSocketAdapter | null} socket
 * @returns {Promise<string | null>}
 */
export async function resolveWebRtcAssetBlobUrl(url, socket) {
  const path = extractWebRtcAssetPath(url);
  if (!path) return null;

  if (blobCache.has(path)) {
    return blobCache.get(path);
  }
  if (inflightRequests.has(path)) {
    return inflightRequests.get(path);
  }
  if (!socket || typeof socket.requestAsset !== 'function') {
    return null;
  }

  const promise = socket
    .requestAsset(path)
    .then(({ mimeType, base64 }) => {
      const bytes = base64ToUint8(base64 || '');
      const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });
      const blobUrl = URL.createObjectURL(blob);
      blobCache.set(path, blobUrl);
      return blobUrl;
    })
    .finally(() => {
      inflightRequests.delete(path);
    });

  inflightRequests.set(path, promise);
  return promise;
}

export function getCachedWebRtcAssetUrl(url) {
  const path = extractWebRtcAssetPath(url);
  return path ? blobCache.get(path) ?? null : null;
}

export function clearWebRtcAssetCache() {
  for (const blobUrl of blobCache.values()) {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {
      // Ignore revoke errors
    }
  }
  blobCache.clear();
  inflightRequests.clear();
}
