import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { CONNECTION_STATUS, ROLES } from '../../shared/events.js';

/** Normalize a wire token (camelCase) or raw SQLite row (snake_case). */
function normalizeToken(token) {
  if (!token) return null;
  return {
    id: token.id,
    mapId: token.mapId ?? token.map_id ?? null,
    label: token.label,
    x: token.x,
    y: token.y,
    ownerId: token.ownerId ?? token.owner_id ?? null,
    locked: Boolean(token.locked),
    color: token.color ?? null,
  };
}

/**
 * Vanilla Zustand store: lives outside the React tree so the network layer
 * (and canvas tools) can read/write it without components mounted.
 */
export const sessionStore = createStore((set) => ({
  // Networking & Session state
  connection: CONNECTION_STATUS.DISCONNECTED,
  connectionError: null,
  serverInfo: null,
  session: null,
  currentUser: null,
  participants: [],

  // Board state (existing)
  map: null,
  tokens: {}, // id -> { id, label, x, y, ownerId, locked, color }
  lastMoveLatencyMs: null,

  setConnection: (connection, connectionError = null) =>
    set({ connection, connectionError }),

  setServerInfo: (serverInfo) =>
    set({
      serverInfo: serverInfo
        ? {
            running: Boolean(serverInfo.running),
            url: serverInfo.url ?? null,
            port: serverInfo.port ?? null,
            sessionId: serverInfo.sessionId ?? null,
            lanIps: Array.isArray(serverInfo.lanIps) ? serverInfo.lanIps : [],
            lanUrls: Array.isArray(serverInfo.lanUrls) ? serverInfo.lanUrls : [],
          }
        : null,
    }),

  setSession: (session) => set({ session }),

  setCurrentUser: (currentUser) => set({ currentUser }),

  applyWelcome: (welcome, { isHost = false } = {}) => {
    if (!welcome || typeof welcome !== 'object') return;
    set({
      connection: CONNECTION_STATUS.CONNECTED,
      connectionError: null,
      session: {
        id: welcome.sessionId,
        name: welcome.sessionName ?? welcome.serverStatus?.sessionName ?? welcome.sessionId,
        serverStatus: welcome.serverStatus ?? null,
      },
      currentUser: {
        id: welcome.playerId,
        displayName: welcome.displayName,
        role: welcome.role,
        reconnectToken: welcome.reconnectToken,
        isHost: Boolean(isHost || welcome.role === ROLES.DM),
      },
      participants: Array.isArray(welcome.participants) ? welcome.participants : [],
    });
  },

  setParticipants: (participants) =>
    set({ participants: Array.isArray(participants) ? participants : [] }),

  upsertParticipant: (participant) =>
    set((state) => {
      if (!participant?.id) return state;
      const exists = state.participants.some((p) => p.id === participant.id);
      const next = exists
        ? state.participants.map((p) => (p.id === participant.id ? { ...p, ...participant } : p))
        : [...state.participants, participant];
      return { participants: next };
    }),

  markParticipantLeft: (participant) =>
    set((state) => {
      if (!participant?.id) return state;
      const next = state.participants.map((p) =>
        p.id === participant.id ? { ...p, ...participant, connected: false } : p,
      );
      return { participants: next };
    }),

  removeParticipant: (playerId) =>
    set((state) => ({
      participants: state.participants.filter((p) => p.id !== playerId),
    })),

  resetSession: () =>
    set({
      session: null,
      currentUser: null,
      participants: [],
      connectionError: null,
    }),

  // Board actions (existing)
  setMap: (map) => set({ map: map ?? null }),

  applySnapshot: ({ map, tokens } = {}) =>
    set({
      map: map ?? null,
      tokens: Array.isArray(tokens)
        ? Object.fromEntries(
            tokens
              .map(normalizeToken)
              .filter(Boolean)
              .map((token) => [token.id, token]),
          )
        : {},
    }),

  upsertToken: (token) =>
    set((state) => {
      const normalized = normalizeToken(token);
      if (!normalized) return state;
      return {
        tokens: { ...state.tokens, [normalized.id]: normalized },
      };
    }),

  removeToken: (id) =>
    set((state) => {
      if (!state.tokens[id]) return state;
      const next = { ...state.tokens };
      delete next[id];
      return { tokens: next };
    }),

  moveToken: (id, x, y) =>
    set((s) =>
      s.tokens[id] ? { tokens: { ...s.tokens, [id]: { ...s.tokens[id], x, y } } } : s,
    ),

  setMoveLatency: (lastMoveLatencyMs) =>
    set({ lastMoveLatencyMs: Number.isFinite(lastMoveLatencyMs) ? lastMoveLatencyMs : null }),
}));

/** React binding. Always pass a selector to avoid whole-store re-renders. */
export const useSession = (selector) => useStore(sessionStore, selector);
