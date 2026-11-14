import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { AUTOSAVE_STATES } from '../autosave/engine.js';

/** UI-facing save status. Kept separate so status churn never re-renders the board. */
export const autosaveStore = createStore((set) => ({
  state: AUTOSAVE_STATES.IDLE,
  pendingCount: 0,
  lastSavedAt: null,
  error: null,

  setStatus: ({ state, pendingCount, lastSavedAt, error }) =>
    set({
      state: state ?? AUTOSAVE_STATES.IDLE,
      pendingCount: pendingCount ?? 0,
      lastSavedAt: lastSavedAt ?? null,
      error: error ?? null,
    }),

  reset: () =>
    set({
      state: AUTOSAVE_STATES.IDLE,
      pendingCount: 0,
      lastSavedAt: null,
      error: null,
    }),
}));

export const useAutosave = (selector) => useStore(autosaveStore, selector);
