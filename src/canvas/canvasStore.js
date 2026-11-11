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

    // Fog of War & Dynamic Vision state (starts empty — never auto-placed on maps)
    fogTool: null, // 'rect' | 'circle' | 'polygon' | 'line' | 'wall' | 'door' | 'erase' | null
    fogShapes: [],
    walls: [],

    setFogTool: (fogTool) =>
      set((state) => ({
        fogTool: state.fogTool === fogTool ? null : fogTool,
      })),

    addFogShape: (shape) =>
      set((state) => ({
        fogShapes: [
          ...state.fogShapes,
          {
            id: shape.id || `fog_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            ...shape,
          },
        ],
      })),

    removeFogShape: (id) =>
      set((state) => ({
        fogShapes: state.fogShapes.filter((s) => s.id !== id),
      })),

    addWall: (wall) =>
      set((state) => ({
        walls: [
          ...state.walls,
          {
            id: wall.id || `wall_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            isDoor: Boolean(wall.isDoor),
            isOpen: Boolean(wall.isOpen),
            p1: wall.p1,
            p2: wall.p2,
          },
        ],
      })),

    removeWall: (id) =>
      set((state) => ({
        walls: state.walls.filter((w) => w.id !== id),
      })),

    toggleDoor: (id) =>
      set((state) => ({
        walls: state.walls.map((w) =>
          w.id === id && w.isDoor ? { ...w, isOpen: !w.isOpen } : w,
        ),
      })),

    clearFog: () => set({ fogShapes: [], walls: [] }),

    setFogState: ({ fogShapes, walls } = {}) =>
      set((state) => ({
        fogShapes: Array.isArray(fogShapes) ? fogShapes : state.fogShapes,
        walls: Array.isArray(walls) ? walls : state.walls,
      })),

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
