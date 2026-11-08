import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { CONNECTION_STATUS, ROLES } from '../../shared/events.js';

/**
 * Normalizes either a server `chat_messages` row (`{ id, sender_name, payload, created_at }`)
 * or a local `RollResult` into a uniform roll log entry.
 */
export function normalizeRollEntry(entry, fallbackName = 'Adventurer') {
  if (!entry || typeof entry !== 'object') return null;
  const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : entry;
  const clientRollId = payload.clientRollId || entry.clientRollId || entry.id;
  if (!clientRollId) return null;

  const createdAt = entry.created_at || entry.createdAt || new Date().toISOString();
  const dateObj = new Date(createdAt);
  const time = Number.isNaN(dateObj.getTime())
    ? new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return {
    id: entry.id || `roll_${clientRollId}`,
    clientRollId,
    senderId: entry.sender_id ?? entry.senderId ?? 'local',
    senderName: entry.sender_name ?? entry.senderName ?? fallbackName,
    recipientId: entry.recipient_id ?? entry.recipientId ?? null,
    formula: payload.formula,
    visibility: payload.visibility || 'public',
    label: payload.label ?? null,
    dice: Array.isArray(payload.dice) ? payload.dice : [],
    modifier: Number(payload.modifier) || 0,
    total: Number(payload.total) || 0,
    createdAt,
    time,
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
  tokens: {}, // id -> { id, label, x, y }

  // 3D Dice Rolling state (client-sided 3D simulation + synchronized roll log)
  activeRoll: null, // Currently tumbling 3D roll on this client
  settledTrayRoll: null, // Roll result that popped into the Dice Tray after settling
  rollHistory: [], // Ordered list of normalized roll entries (local + remote)

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
  applySnapshot: ({ map, tokens } = {}) =>
    set({
      map: map ?? null,
      tokens: Array.isArray(tokens)
        ? Object.fromEntries(tokens.map((t) => [t.id, t]))
        : {},
    }),

  moveToken: (id, x, y) =>
    set((s) =>
      s.tokens[id] ? { tokens: { ...s.tokens, [id]: { ...s.tokens[id], x, y } } } : s,
    ),

  // Dice Rolling actions
  startLocalRoll: (roll, senderName = 'Adventurer') =>
    set({
      activeRoll: {
        ...roll,
        senderName,
        startedAt: Date.now(),
      },
    }),

  settleRollIntoTray: (roll) =>
    set((state) => ({
      settledTrayRoll: {
        ...(roll || state.activeRoll),
        settledAt: Date.now(),
      },
    })),

  clearActiveRoll: () => set({ activeRoll: null }),

  clearSettledTrayRoll: () => set({ settledTrayRoll: null }),

  appendRollRecord: (rawRecord, fallbackName) =>
    set((state) => {
      const normalized = normalizeRollEntry(
        rawRecord,
        fallbackName || state.currentUser?.displayName || 'Adventurer',
      );
      if (!normalized) return state;
      const existingIndex = state.rollHistory.findIndex(
        (r) => r.clientRollId === normalized.clientRollId || r.id === normalized.id,
      );
      if (existingIndex >= 0) {
        const updated = [...state.rollHistory];
        updated[existingIndex] = { ...updated[existingIndex], ...normalized };
        return { rollHistory: updated };
      }
      return { rollHistory: [...state.rollHistory, normalized] };
    }),
}));

/** React binding. Always pass a selector to avoid whole-store re-renders. */
export const useSession = (selector) => useStore(sessionStore, selector);
