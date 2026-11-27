import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import {
  clampScale,
  fitViewport,
  zoomAtPoint,
} from './viewport.js';

const EMPTY_SIZE = { width: 0, height: 0 };
const CANVAS_THEME_KEY = 'hakton:canvas-theme:v1';

function readCanvasTheme() {
  try {
    return localStorage.getItem(CANVAS_THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function writeCanvasTheme(theme) {
  try {
    localStorage.setItem(CANVAS_THEME_KEY, theme);
  } catch {
    // Ignore storage errors outside browser contexts
  }
}

/**
 * Viewport & interaction state for the live canvas. Lives outside React so
 * panning/zooming can drive Konva imperatively without re-rendering the tree.
 */
export const canvasStore = createStore((set, get) => {
  /** Clamp zoom scale while permitting unrestricted panning across the full-screen canvas. */
  const bound = (viewport) => ({
    x: Number.isFinite(viewport?.x) ? viewport.x : 0,
    y: Number.isFinite(viewport?.y) ? viewport.y : 0,
    scale: clampScale(viewport?.scale),
  });

  return {
    viewport: { x: 0, y: 0, scale: 1 },
    viewportSize: EMPTY_SIZE,
    mapSize: EMPTY_SIZE,
    gridVisible: true,
    snap: true,
    selectedIds: [],
    draggingIds: [],
    draggingPositions: {},
    draggingRotations: {},
    draggingTransforms: {},

    // Selection, Canvas Theme, Ruler & Fog of War / Dynamic Vision state
    canvasTheme: readCanvasTheme(), // 'dark' | 'light'
    selectTool: 'select', // 'select' | 'lasso' | 'ruler'
    rulerMode: '5e', // '5e' | 'alternating' | 'euclidean' | 'manhattan'
    rulerShareWithTable: true,
    fogTool: null, // 'rect' | 'circle' | 'polygon' | 'line' | 'wall' | 'door' | 'erase' | null
    fogShapes: [],
    walls: [],
    playerVisionPreview: false,

    setCanvasTheme: (theme) => {
      const next = theme === 'light' ? 'light' : 'dark';
      writeCanvasTheme(next);
      set({ canvasTheme: next });
    },

    toggleCanvasTheme: () =>
      set((state) => {
        const next = state.canvasTheme === 'light' ? 'dark' : 'light';
        writeCanvasTheme(next);
        return { canvasTheme: next };
      }),

    setSelectTool: (selectTool) =>
      set({
        selectTool:
          selectTool === 'lasso' || selectTool === 'ruler' ? selectTool : 'select',
        ...(selectTool === 'lasso' || selectTool === 'ruler' ? { fogTool: null } : {}),
      }),

    setRulerMode: (rulerMode) =>
      set({
        rulerMode: ['5e', 'alternating', 'euclidean', 'manhattan'].includes(rulerMode)
          ? rulerMode
          : '5e',
      }),

    setRulerShareWithTable: (shared) =>
      set({ rulerShareWithTable: Boolean(shared) }),

    setFogTool: (fogTool) =>
      set((state) => {
        const nextFogTool = state.fogTool === fogTool ? null : fogTool;
        return {
          fogTool: nextFogTool,
          ...(nextFogTool ? { selectTool: 'select' } : {}),
        };
      }),

    togglePlayerVisionPreview: () =>
      set((state) => ({
        playerVisionPreview: !state.playerVisionPreview,
      })),

    setPlayerVisionPreview: (playerVisionPreview) =>
      set({ playerVisionPreview: Boolean(playerVisionPreview) }),

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
            wallId: wall.wallId ?? null,
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

    setDraggingPosition: (id, pos) =>
      set((state) => ({
        draggingPositions: { ...state.draggingPositions, [id]: pos },
      })),

    clearDraggingPositions: () => set({ draggingPositions: {} }),

    setDraggingRotation: (id, rotation) =>
      set((state) => ({
        draggingRotations: { ...state.draggingRotations, [id]: rotation },
      })),

    clearDraggingRotation: (id) =>
      set((state) => {
        if (!(id in state.draggingRotations)) return state;
        const next = { ...state.draggingRotations };
        delete next[id];
        return { draggingRotations: next };
      }),

    clearDraggingRotations: () => set({ draggingRotations: {} }),

    setDraggingTransform: (id, transform) =>
      set((state) => ({
        draggingTransforms: { ...state.draggingTransforms, [id]: transform },
      })),

    clearDraggingTransform: (id) =>
      set((state) => {
        if (!(id in state.draggingTransforms)) return state;
        const next = { ...state.draggingTransforms };
        delete next[id];
        return { draggingTransforms: next };
      }),

    clearDraggingTransforms: () => set({ draggingTransforms: {} }),
  };
});

/** React binding. Always pass a selector. */
export const useCanvas = (selector) => useStore(canvasStore, selector);
