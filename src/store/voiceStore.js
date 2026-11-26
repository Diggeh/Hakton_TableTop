import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { loadMediaDevicePrefs, normalizeDeviceId } from '../net/mediaDevices.js';

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
  notice: null,
  peerId: null,
  localStreamActive: false,
  localStream: null,
  localStreamRevision: 0,
  localAudioMuted: false,
  localDeafened: false,
  localVideoEnabled: false,
  localSpeaking: false,
  listenOnly: false,
  popoutOpen: false,
  /** peerId -> { peerId, playerId, displayName, direction, connectionState, iceConnectionState, streamActive, hasVideo, muted, deafened, speaking, stream, streamRevision, connectedAt } */
  peers: {},
  /** Authoritative `session:peers` roster from the host (includes this client). */
  roster: [],
});

/**
 * Vanilla Zustand store: lives outside the React tree (like sessionStore/chatStore) so the WebRTC
 * layer can write high-frequency connection state without rendering anything. A future voice UI
 * only needs to subscribe; no component is required for the mesh to function.
 */
export const createVoiceStore = (initialPrefs = loadMediaDevicePrefs()) =>
  createStore((set) => ({
  ...initialMesh(),
  /** Bounded structured log of signaling + WebRTC transitions (also asserted by tests). */
  connectionLogs: [],
  /** Input devices & persisted device selections (survive call resetMesh). */
  audioInputs: [],
  videoInputs: [],
  selectedAudioInputId: normalizeDeviceId(initialPrefs?.audioInputId),
  selectedVideoInputId: normalizeDeviceId(initialPrefs?.videoInputId),

  setMediaDevices: ({ audioInputs, videoInputs } = {}) =>
    set((state) => ({
      audioInputs: Array.isArray(audioInputs) ? audioInputs : state.audioInputs,
      videoInputs: Array.isArray(videoInputs) ? videoInputs : state.videoInputs,
    })),
  setSelectedAudioInputId: (deviceId) =>
    set({ selectedAudioInputId: normalizeDeviceId(deviceId) }),
  setSelectedVideoInputId: (deviceId) =>
    set({ selectedVideoInputId: normalizeDeviceId(deviceId) }),

  setStatus: (status, error = null) => set({ status, error }),
  setNotice: (notice) => set({ notice: notice ?? null }),
  setPeerId: (peerId) => set({ peerId }),
  setLocalStreamActive: (localStreamActive) => set({ localStreamActive }),
  setLocalStream: (localStream) => set({ localStream: localStream ?? null }),
  bumpLocalStreamRevision: () =>
    set((state) => ({ localStreamRevision: state.localStreamRevision + 1 })),
  setLocalAudioMuted: (localAudioMuted) => set({ localAudioMuted: Boolean(localAudioMuted) }),
  setLocalDeafened: (localDeafened) => set({ localDeafened: Boolean(localDeafened) }),
  setLocalVideoEnabled: (localVideoEnabled) => set({ localVideoEnabled: Boolean(localVideoEnabled) }),
  setLocalSpeaking: (localSpeaking) => set({ localSpeaking: Boolean(localSpeaking) }),
  setListenOnly: (listenOnly) => set({ listenOnly: Boolean(listenOnly) }),
  setPopoutOpen: (popoutOpen) => set({ popoutOpen: Boolean(popoutOpen) }),
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
          hasVideo: false,
          muted: false,
          deafened: false,
          speaking: false,
          stream: null,
          streamRevision: 0,
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
