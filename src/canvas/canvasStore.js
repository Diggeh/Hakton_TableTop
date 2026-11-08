import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import {
  clampScale,
  clampTranslation,
  fitViewport,
  zoomAtPoint,
} from './viewport.js';

const EMPTY_SIZE = { width: 0, height: 0 };

/**
 * Viewport & interaction state for the live canvas. Lives outside React so
 * panning/zooming can drive Konva imperatively without re-rendering the tree.
 */
export const canvasStore = createStore((set, get) => {
  /** Clamp a viewport against the current (or supplied) sizes. */
  const bound = (viewport, overrides = {}) => {
    const state = get();
    const viewportSize = overrides.viewportSize ?? state.viewportSize;
    const mapSize = overrides.mapSize ?? state.mapSize;
    return clampTranslation(
      { ...viewport, scale: clampScale(viewport.scale) },
      viewportSize.width,
      viewportSize.height,
      mapSize.width,
      mapSize.height,
    );
  };

  return {
    viewport: { x: 0, y: 0, scale: 1 },
    viewportSize: EMPTY_SIZE,
    mapSize: EMPTY_SIZE,
    gridVisible: true,
    snap: true,
    selectedIds: [],
    draggingIds: [],

    setViewportSize: (viewportSize) =>
      set((state) => {
        // Preserve the map point at the centre of the view when the window resizes.
        let viewport = state.viewport;
        const previous = state.viewportSize;
        if (previous.width > 0 && previous.height > 0) {
          viewport = {
            ...viewport,
            x: viewport.x + (viewportSize.width - previous.width) / 2,
            y: viewport.y + (viewportSize.height - previous.height) / 2,
          };
        }
        return { viewportSize, viewport: bound(viewport, { viewportSize }) };
      }),

    setMapSize: (mapSize) =>
      set((state) => ({
        mapSize,
        viewport: bound(state.viewport, { mapSize }),
      })),

    setViewport: (viewport) => set({ viewport: bound(viewport) }),

    panBy: (dx, dy) =>
      set((state) => ({
        viewport: bound({
          ...state.viewport,
          x: state.viewport.x + dx,
          y: state.viewport.y + dy,
        }),
      })),

    /** Zoom by a multiplicative factor around a screen-space point. */
    zoomAt: (pointer, factor) =>
      set((state) => ({
        viewport: bound(zoomAtPoint(state.viewport, pointer, factor)),
      })),

    /** Zoom around the centre of the viewport (toolbar buttons). */
    zoomBy: (factor) => {
      const { viewportSize } = get();
      get().zoomAt(
        { x: viewportSize.width / 2, y: viewportSize.height / 2 },
        factor,
      );
    },

    fit: () => {
      const { mapSize, viewportSize } = get();
      const viewport = fitViewport(
        mapSize.width,
        mapSize.height,
        viewportSize.width,
        viewportSize.height,
      );
      set({ viewport: bound(viewport) });
    },

    toggleGrid: () => set((state) => ({ gridVisible: !state.gridVisible })),
    toggleSnap: () => set((state) => ({ snap: !state.snap })),

    selectToken: (id, additive = false) =>
      set((state) => {
        if (!id) return { selectedIds: [] };
        if (!additive) return { selectedIds: [id] };
        return {
          selectedIds: state.selectedIds.includes(id)
            ? state.selectedIds.filter((selected) => selected !== id)
            : [...state.selectedIds, id],
        };
      }),

    setSelection: (ids) =>
      set({
        selectedIds: Array.isArray(ids)
          ? Array.from(new Set(ids.filter(Boolean)))
          : [],
      }),

    clearSelection: () => set({ selectedIds: [] }),

    setDraggingIds: (ids) =>
      set({ draggingIds: Array.isArray(ids) ? ids : [] }),
  };
});

/** React binding. Always pass a selector. */
export const useCanvas = (selector) => useStore(canvasStore, selector);
