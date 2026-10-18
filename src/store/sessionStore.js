import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

/**
 * Vanilla Zustand store: lives outside the React tree so the network layer
 * (and later, canvas tools) can read/write it without components mounted.
 */
export const sessionStore = createStore((set) => ({
  connection: 'disconnected', // 'disconnected' | 'connecting' | 'connected'
  map: null,
  tokens: {}, // id -> { id, label, x, y }

  setConnection: (connection) => set({ connection }),
  applySnapshot: ({ map, tokens }) =>
    set({ map, tokens: Object.fromEntries(tokens.map((t) => [t.id, t])) }),
  moveToken: (id, x, y) =>
    set((s) => (s.tokens[id] ? { tokens: { ...s.tokens, [id]: { ...s.tokens[id], x, y } } } : s)),
}));

/** React binding. Always pass a selector to avoid whole-store re-renders. */
export const useSession = (selector) => useStore(sessionStore, selector);
