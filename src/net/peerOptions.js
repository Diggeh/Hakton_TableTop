import { DEFAULT_PORT, PEER_PATH, VOICE_SIGNALING_MODE } from '../../shared/events.js';
import { buildInternetPeerOptions } from './networkConfig.js';

/**
 * PeerJS connection options for voice/video mesh.
 *
 * - Pure LAN / offline mode: dials the HOST's embedded PeerServer (`<host>:<port>/peerjs`)
 *   with `iceServers: []`.
 * - Internet / mixed LAN+Internet mode: dials the shared internet PeerJS signaling server
 *   (`0.peerjs.com` or custom override) with STUN/TURN ICE servers so DM and remote players
 *   can discover each other and traverse NAT.
 *
 * @param {{ socket?: any, host?: string, port?: number|string, secure?: boolean, iceServers?: RTCIceServer[], debug?: number, signalingMode?: string }} [opts]
 */
export function resolvePeerOptions({
  socket,
  host,
  port,
  secure,
  iceServers,
  debug,
  signalingMode,
} = {}) {
  let resolvedHost = host;
  let resolvedPort = port;
  let resolvedSecure = secure;

  const uri = socket?.io?.uri;
  const isWebRtcTransport = typeof uri === 'string' && /^webrtc:\/\//i.test(uri);

  if (!resolvedHost && !resolvedPort && (signalingMode === VOICE_SIGNALING_MODE.INTERNET || isWebRtcTransport)) {
    return buildInternetPeerOptions({ iceServers, debug });
  }

  if ((!resolvedHost || !resolvedPort) && typeof uri === 'string' && !isWebRtcTransport) {
    try {
      const url = new URL(uri);
      resolvedHost ||= url.hostname;
      resolvedPort ||= Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
      resolvedSecure ??= url.protocol === 'https:';
    } catch {
      // Fall through to the defaults below.
    }
  }

  return {
    host: resolvedHost || '127.0.0.1',
    port: Number(resolvedPort) || DEFAULT_PORT,
    path: PEER_PATH,
    secure: Boolean(resolvedSecure),
    debug: debug ?? 1,
    config: { iceServers: iceServers ?? [], sdpSemantics: 'unified-plan' },
  };
}
