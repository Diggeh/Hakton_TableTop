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

/** Normalize a wire character (camelCase) or raw SQLite row (snake_case). */
export function normalizeCharacter(character) {
  if (!character?.id) return null;
  return {
    id: character.id,
    ownerId: character.ownerId ?? character.owner_id ?? null,
    name: character.name ?? 'Unnamed',
    classLevel: character.classLevel ?? character.class_level ?? null,
    sheetData: character.sheetData ?? character.sheet_data ?? {},
    inventoryData: character.inventoryData ?? character.inventory_data ?? {},
    revision: Number.isInteger(character.revision) ? character.revision : null,
    updatedAt: character.updatedAt ?? character.updated_at ?? null,
  };
}

/** Normalize a wire DM record or raw SQLite row. */
export function normalizeDmRecord(record) {
  if (!record?.id) return null;
  return {
    id: record.id,
    category: record.category ?? 'session-notes',
    title: record.title ?? 'Session notes',
    data: record.data ?? {},
    revision: Number.isInteger(record.revision) ? record.revision : null,
    updatedAt: record.updatedAt ?? record.updated_at ?? null,
  };
}

const toRecordMap = (items, normalize) =>
  Object.fromEntries(
    (Array.isArray(items) ? items : [])
      .map(normalize)
      .filter(Boolean)
      .map((item) => [item.id, item]),
  );

/**
 * Pure reducer for a confirmed autosave document. Used both by the local save
 * ack and by peer broadcasts, so the merge rules live in exactly one place.
 * @returns {object} the partial state to merge (or the original state object).
 */
function mergeSavedDocument(state, document) {
  if (!document?.kind) return state;

  if (document.kind === 'character') {
    const id = document.id ?? document.scopeId;
    const merged = normalizeCharacter({ ...(state.characters[id] ?? {}), ...document, id });
    if (!merged) return state;
    return { characters: { ...state.characters, [id]: merged } };
  }

  if (document.kind === 'dm-record') {
    const id = document.id ?? document.scopeId;
    const merged = normalizeDmRecord({ ...(state.dmRecords[id] ?? {}), ...document, id });
    if (!merged) return state;
    return { dmRecords: { ...state.dmRecords, [id]: merged } };
  }

  if (document.kind === 'board' && state.board) {
    if (`campaign:${state.board.campaignId}` !== document.scopeId) return state;
    return {
      board: {
        ...state.board,
        revision: document.revision ?? state.board.revision,
        updatedAt: document.updatedAt ?? state.board.updatedAt,
      },
    };
  }

  return state;
}

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
 * (and canvas tools and asset catalogs) can read/write it without components mounted.
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
  maps: [], // all maps in the active campaign
  tokens: {}, // id -> { id, label, x, y, ownerId, locked, color }
  board: null, // { campaignId, revision, data, updatedAt } | null
  lastMoveLatencyMs: null,

  // Autosaved documents
  characters: {}, // id -> normalized character
  dmRecords: {}, // id -> normalized DM record

  // Selected catalog asset references for tabletop integration (map background & token placement)
  selectedMapAsset: null, // { id, name, url, width, height, format, mimeType } | null
  selectedTokenAsset: null, // { id, name, url, width, height, format, mimeType } | null

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
  setMap: (map) => set({ map: map ?? null }),

  applySnapshot: (snapshot = {}) =>
    set((state) => {
      const next = {
        map: snapshot.map ?? null,
        tokens: Array.isArray(snapshot.tokens)
          ? Object.fromEntries(
              snapshot.tokens
                .map(normalizeToken)
                .filter(Boolean)
                .map((token) => [token.id, token]),
            )
          : {},
      };
      if (Array.isArray(snapshot.maps)) next.maps = snapshot.maps;
      if (snapshot.board !== undefined) next.board = snapshot.board ?? null;
      if (Array.isArray(snapshot.characters)) {
        next.characters = toRecordMap(snapshot.characters, normalizeCharacter);
      }
      if (Array.isArray(snapshot.dmRecords)) {
        next.dmRecords = toRecordMap(snapshot.dmRecords, normalizeDmRecord);
      }
      return next;
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

  // Autosaved document actions -------------------------------------------------
  setCharacters: (characters) =>
    set({ characters: toRecordMap(characters, normalizeCharacter) }),

  upsertCharacter: (character) =>
    set((state) => {
      const normalized = normalizeCharacter(character);
      if (!normalized) return state;
      return { characters: { ...state.characters, [normalized.id]: normalized } };
    }),

  /** Local-first edit. Nested `sheetData.hp`/`inventoryData` are merged, not replaced. */
  patchCharacter: (id, patch = {}) =>
    set((state) => {
      const existing = state.characters[id];
      if (!existing) return state;

      const next = { ...existing, ...patch };
      if (patch.sheetData) {
        next.sheetData = { ...existing.sheetData, ...patch.sheetData };
        if (patch.sheetData.hp) {
          next.sheetData.hp = { ...(existing.sheetData?.hp ?? {}), ...patch.sheetData.hp };
        }
      }
      if (patch.inventoryData) {
        next.inventoryData = { ...existing.inventoryData, ...patch.inventoryData };
      }
      return { characters: { ...state.characters, [id]: next } };
    }),

  upsertDmRecord: (record) =>
    set((state) => {
      const normalized = normalizeDmRecord(record);
      if (!normalized) return state;
      return { dmRecords: { ...state.dmRecords, [normalized.id]: normalized } };
    }),

  patchDmRecord: (id, patch = {}) =>
    set((state) => {
      const existing = state.dmRecords[id];
      if (!existing) return state;
      return {
        dmRecords: {
          ...state.dmRecords,
          [id]: { ...existing, ...patch, data: { ...existing.data, ...(patch.data ?? {}) } },
        },
      };
    }),

  /** Applies a confirmed autosave result (own save or a peer broadcast). */
  applySavedDocument: (document) => set((state) => mergeSavedDocument(state, document)),

  /** A revision conflict: the server copy wins and the local edit is dropped. */
  applyConflictDocument: (document) =>
    set((state) => {
      if (!document?.current) return state;
      if (document.kind === 'character') {
        const normalized = normalizeCharacter(document.current);
        if (!normalized) return state;
        return { characters: { ...state.characters, [normalized.id]: normalized } };
      }
      if (document.kind === 'dm-record') {
        const normalized = normalizeDmRecord(document.current);
        if (!normalized) return state;
        return { dmRecords: { ...state.dmRecords, [normalized.id]: normalized } };
      }
      return state;
    }),

  applyAutosaveSaved: (payload = {}) =>
    set((state) => {
      let next = state;
      for (const document of payload.documents ?? []) {
        next = mergeSavedDocument(next, document);
      }
      return next;
    }),

  // Asset Catalog selection actions
  setSelectedMapAsset: (asset) =>
    set({
      selectedMapAsset: asset
        ? {
            id: asset.id,
            name: asset.name,
            url: asset.url,
            width: asset.width,
            height: asset.height,
            format: asset.format,
            mimeType: asset.mimeType,
          }
        : null,
    }),

  setSelectedTokenAsset: (asset) =>
    set({
      selectedTokenAsset: asset
        ? {
            id: asset.id,
            name: asset.name,
            url: asset.url,
            width: asset.width,
            height: asset.height,
            format: asset.format,
            mimeType: asset.mimeType,
          }
        : null,
    }),

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
