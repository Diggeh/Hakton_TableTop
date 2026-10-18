import { Peer } from 'peerjs';
import { PEER_PATH } from '@shared/events.js';

/**
 * WebRTC voice scaffold. Signals through the embedded PeerJS server
 * (host:port/peerjs), not the public PeerJS cloud. Call logic arrives in a later sprint.
 */
export async function createVoicePeer() {
  const { port } = await window.hakton.getServerInfo();
  return new Peer({ host: '127.0.0.1', port, path: PEER_PATH, secure: false });
}
