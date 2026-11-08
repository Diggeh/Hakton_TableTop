import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

/**
 * Vanilla Zustand store: lives outside the React tree so the network layer
 * (and later, canvas tools and asset catalogs) can read/write it without components mounted.
 */
export const sessionStore = createStore((set) => ({
  connection: 'disconnected', // 'disconnected' | 'connecting' | 'connected'
  map: null,
  tokens: {}, // id -> { id, label, x, y }

  // Selected catalog asset references for tabletop integration (map background & token placement)
  selectedMapAsset: null, // { id, name, url, width, height, format, mimeType } | null
  selectedTokenAsset: null, // { id, name, url, width, height, format, mimeType } | null

  setConnection: (connection) => set({ connection }),
  applySnapshot: ({ map, tokens }) =>
    set({ map, tokens: Object.fromEntries(tokens.map((t) => [t.id, t])) }),
  moveToken: (id, x, y) =>
    set((s) => (s.tokens[id] ? { tokens: { ...s.tokens, [id]: { ...s.tokens[id], x, y } } } : s)),

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
}));

/** React binding. Always pass a selector to avoid whole-store re-renders. */
export const useSession = (selector) => useStore(sessionStore, selector);
