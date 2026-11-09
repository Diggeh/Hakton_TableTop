import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

/** Lifecycle of the local voice mesh endpoint. */
export const VOICE_STATUS = Object.freeze({
  DISCONNECTED: 'disconnected',
  ACQUIRING_MEDIA: 'acquiring_media',
  SIGNALING: 'signaling',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
});

const MAX_LOG_ENTRIES = 300;

const initialMesh = () => ({
  status: VOICE_STATUS.DISCONNECTED,
  error: null,
  peerId: null,
  localStreamActive: false,
  /** peerId -> { peerId, playerId, displayName, direction, connectionState, iceConnectionState, streamActive, connectedAt } */
  peers: {},
  /** Authoritative `session:peers` roster from the host (includes this client). */
  roster: [],
});

/**
 * Vanilla Zustand store: lives outside the React tree (like sessionStore/chatStore) so the WebRTC
 * layer can write high-frequency connection state without rendering anything. A future voice UI
 * only needs to subscribe; no component is required for the mesh to function.
 */
export const createVoiceStore = () =>
  createStore((set) => ({
  ...initialMesh(),
  /** Bounded structured log of signaling + WebRTC transitions (also asserted by tests). */
  connectionLogs: [],

  setStatus: (status, error = null) => set({ status, error }),
  setPeerId: (peerId) => set({ peerId }),
  setLocalStreamActive: (localStreamActive) => set({ localStreamActive }),
  setRoster: (roster) => set({ roster: Array.isArray(roster) ? roster : [] }),

  upsertPeer: (peerId, patch = {}) =>
    set((state) => ({
      peers: {
        ...state.peers,
        [peerId]: {
          peerId,
          playerId: null,
          displayName: null,
          direction: null,
          connectionState: 'new',
          iceConnectionState: 'new',
          streamActive: false,
          connectedAt: null,
          ...state.peers[peerId],
          ...patch,
        },
      },
    })),

  removePeer: (peerId) =>
    set((state) => {
      if (!state.peers[peerId]) return state;
      const peers = { ...state.peers };
      delete peers[peerId];
      return { peers };
    }),

  appendLog: (entry) =>
    set((state) => ({
      connectionLogs: [...state.connectionLogs, entry].slice(-MAX_LOG_ENTRIES),
    })),

  clearLogs: () => set({ connectionLogs: [] }),

  /** Clears mesh state but keeps logs so a failed session can still be diagnosed. */
  resetMesh: () => set({ ...initialMesh() }),
  }));

/** Process-wide singleton used by the app. Tests build isolated stores with `createVoiceStore()`. */
export const voiceStore = createVoiceStore();

/** React binding for the future voice UI. Always pass a selector. */
export const useVoice = (selector) => useStore(voiceStore, selector);
