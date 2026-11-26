/**
 * Layout math and persistence helpers for the docked VideoCallStrip and Pop-Out window.
 * Headless-safe for Electron renderer and Node tests alike.
 */

export const VIDEO_LAYOUT_STORAGE_KEY = 'hakton.videoStripLayout.v1';

export const MIN_TILE_WIDTH = 112;
export const MAX_TILE_WIDTH = 340;
export const DEFAULT_TILE_WIDTH = 156;
export const TILE_ASPECT_RATIO = 0.64;
export const TILE_WIDTH_STEP = 28;
export const LAYOUT_MODES = Object.freeze(['row', 'column', 'grid']);

function getStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function clampTileWidth(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_TILE_WIDTH;
  return Math.round(Math.max(MIN_TILE_WIDTH, Math.min(MAX_TILE_WIDTH, num)));
}

export function tileHeightForWidth(tileWidth) {
  return Math.round(clampTileWidth(tileWidth) * TILE_ASPECT_RATIO);
}

export function normalizeVideoStripLayout(raw = {}) {
  const mode = LAYOUT_MODES.includes(raw?.layoutMode) ? raw.layoutMode : 'row';
  const x = typeof raw?.x === 'number' && Number.isFinite(raw.x) ? Math.round(raw.x) : null;
  const y = typeof raw?.y === 'number' && Number.isFinite(raw.y) ? Math.round(raw.y) : null;
  return {
    tileWidth: clampTileWidth(raw?.tileWidth),
    layoutMode: mode,
    x: x !== null && y !== null ? x : null,
    y: x !== null && y !== null ? y : null,
  };
}

export function loadVideoStripLayout() {
  try {
    const raw = getStorage()?.getItem(VIDEO_LAYOUT_STORAGE_KEY);
    if (!raw) return normalizeVideoStripLayout();
    return normalizeVideoStripLayout(JSON.parse(raw));
  } catch {
    return normalizeVideoStripLayout();
  }
}

export function saveVideoStripLayout(patch = {}) {
  const prev = loadVideoStripLayout();
  const next = normalizeVideoStripLayout({ ...prev, ...patch });
  try {
    getStorage()?.setItem(VIDEO_LAYOUT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage quota or private mode errors
  }
  return next;
}

export function clampStripPosition({
  x,
  y,
  panelWidth,
  panelHeight,
  containerWidth,
  containerHeight,
  margin = 12,
}) {
  const maxX = Math.max(margin, containerWidth - panelWidth - margin);
  const maxY = Math.max(margin, containerHeight - panelHeight - margin);
  return {
    x: Math.round(Math.max(margin, Math.min(maxX, x))),
    y: Math.round(Math.max(margin, Math.min(maxY, y))),
  };
}

export function computePopoutGridCols(tileCount, width, height) {
  const count = Math.max(1, Number(tileCount) || 1);
  const wide = width >= Math.max(420, height * 1.15);
  if (count === 1) return 1;
  if (count === 2) return wide ? 2 : 1;
  if (count <= 4) return 2;
  if (count <= 6) return wide ? 3 : 2;
  return wide ? 4 : 2;
}

export function nextLayoutMode(current) {
  const idx = LAYOUT_MODES.indexOf(current);
  return LAYOUT_MODES[(idx + 1) % LAYOUT_MODES.length];
}
