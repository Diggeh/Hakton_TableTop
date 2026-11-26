import { sessionStore } from '../store/sessionStore.js';
import { voiceStore } from '../store/voiceStore.js';
import { resolvePeerOptions } from './peerOptions.js';
import { getSocket, registerDisconnectHook } from './socket.js';
import { VoiceMeshManager } from './voiceMesh.js';

export { resolvePeerOptions } from './peerOptions.js';
export { VoiceMeshManager, VOICE_SINK_ID } from './voiceMesh.js';

/** @type {VoiceMeshManager | null} */
let manager = null;

/** Loads PeerJS lazily so non-voice code paths (and node:test) never pay for it. */
export async function defaultCreatePeer(options, requestedId) {
  const { Peer } = await import('peerjs');
  return requestedId ? new Peer(requestedId, options) : new Peer(options);
}

/**
 * Low-level helper kept from the original scaffold: opens a PeerJS peer on the host PeerServer.
 * Prefer {@link joinVoiceMesh}, which also does signaling and dialing.
 */
export async function createVoicePeer(options = {}) {
  const socket = getSocket();
  let { port } = options;
  if (!socket && !port && typeof window !== 'undefined' && window.hakton?.getServerInfo) {
    ({ port } = await window.hakton.getServerInfo());
  }
  return defaultCreatePeer(resolvePeerOptions({ socket, ...options, port }));
}

/** The active manager, if the user has joined (or tried to join) voice. */
export function getVoiceManager() {
  return manager;
}

/**
 * Join the P2P voice mesh over the existing Socket.io session.
 * Requires `connect()` + a successful `session:join` first (the host rejects anonymous sockets).
 *
 * @param {{ peerId?: string, audio?: object, label?: string, quiet?: boolean, peer?: object }} [options]
 */
export async function joinVoiceMesh(options = {}) {
  const socket = getSocket();
  if (!socket?.connected) {
    return {
      success: false,
      code: 'E_NOT_CONNECTED',
      error: 'Connect to a session before joining voice.',
    };
  }

  // A reconnect to another host creates a new socket; the old manager is bound to a dead one.
  if (manager && manager.socket !== socket) {
    manager.leave({ notifyHost: false });
    manager = null;
  }

  const sessionState = sessionStore.getState();
  const signalingMode =
    sessionState.internetBridge?.status === 'ready'
      ? 'internet'
      : sessionState.voiceSignalingMode;

  manager ??= new VoiceMeshManager({
    socket,
    createPeer: defaultCreatePeer,
    peerOptions: resolvePeerOptions({ socket, signalingMode, ...(options.peer ?? {}) }),
    store: voiceStore,
    label: options.label ?? 'voice',
    logger: options.quiet ? null : undefined,
  });

  return manager.join({ peerId: options.peerId, audio: options.audio });
}

/** Leave the voice mesh (keeps the Socket.io session unless called during disconnect). */
export function leaveVoiceMesh(options) {
  manager?.leave(options);
}

registerDisconnectHook(() => leaveVoiceMesh({ notifyHost: false }));

export function setAudioMuted(muted) {
  return manager?.setAudioMuted(muted) ?? false;
}

export function toggleAudioMuted() {
  const current = voiceStore.getState().localAudioMuted;
  return setAudioMuted(!current);
}

export function setDeafened(deafened) {
  return manager?.setDeafened(deafened) ?? false;
}

export function toggleDeafened() {
  const current = voiceStore.getState().localDeafened;
  return setDeafened(!current);
}

export function setCameraEnabled(enabled, constraints) {
  return manager?.setCameraEnabled(enabled, constraints) ?? Promise.resolve({ ok: false, enabled: false });
}

export function toggleCamera(constraints) {
  const current = voiceStore.getState().localVideoEnabled;
  return setCameraEnabled(!current, constraints);
}

/**
 * Headless diagnostics until the voice UI exists. From the renderer DevTools console:
 *   await __haktonVoice.join()      // after connecting to a session
 *   await __haktonVoice.stats()     // per-peer inbound/outbound audio bytes
 *   __haktonVoice.logs()            // structured signaling + WebRTC transition log
 */
if (typeof window !== 'undefined') {
  window.__haktonVoice = {
    join: joinVoiceMesh,
    leave: leaveVoiceMesh,
    setAudioMuted,
    toggleAudioMuted,
    setDeafened,
    toggleDeafened,
    setCameraEnabled,
    toggleCamera,
    manager: getVoiceManager,
    stats: () => manager?.getStats() ?? Promise.resolve({}),
    logs: () => voiceStore.getState().connectionLogs,
    store: voiceStore,
  };
}
