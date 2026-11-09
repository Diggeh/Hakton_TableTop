import { DEFAULT_PORT, PEER_PATH } from '../../shared/events.js';

/**
 * PeerJS connection options pointing at the HOST's embedded PeerServer (`<host>:<port>/peerjs`),
 * never the public PeerJS cloud. Host/port come from the live Socket.io target so remote players
 * dial the DM's LAN address instead of their own loopback.
 *
 * ICE servers default to none: Hakton is zero-cloud, and LAN/VPN host candidates are enough. Pass
 * `iceServers` explicitly (e.g. a self-hosted TURN) for players behind NAT across the internet.
 *
 * Kept dependency-free so a bundler-less harness page can import it.
 *
 * @param {{ socket?: any, host?: string, port?: number|string, secure?: boolean, iceServers?: RTCIceServer[], debug?: number }} [opts]
 */
export function resolvePeerOptions({ socket, host, port, secure, iceServers, debug } = {}) {
  let resolvedHost = host;
  let resolvedPort = port;
  let resolvedSecure = secure;

  const uri = socket?.io?.uri;
  if ((!resolvedHost || !resolvedPort) && typeof uri === 'string') {
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
