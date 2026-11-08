/**
 * Pure viewport math for the tabletop canvas.
 *
 * All token/grid coordinates are in "map space". The viewport converts them to
 * screen space with: screen = map * scale + offset.
 *
 * Kept free of DOM/Konva imports so it can be unit-tested with node:test.
 */

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;

/** Clamp a number to an inclusive range. */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** Clamp a zoom scale to the canvas limits. */
export function clampScale(scale) {
  if (!Number.isFinite(scale) || scale <= 0) return MIN_SCALE;
  return clamp(scale, MIN_SCALE, MAX_SCALE);
}

/**
 * Zoom around a fixed screen point so the map position under the pointer
 * stays put.
 *
 * @param {{ x: number, y: number, scale: number }} viewport
 * @param {{ x: number, y: number }} pointer screen-space point
 * @param {number} factor multiplicative zoom factor (>1 zooms in)
 */
export function zoomAtPoint(viewport, pointer, factor) {
  const scale = clampScale(viewport.scale * factor);
  const ratio = scale / viewport.scale;
  return {
    x: pointer.x - (pointer.x - viewport.x) * ratio,
    y: pointer.y - (pointer.y - viewport.y) * ratio,
    scale,
  };
}

/**
 * Compute a centered viewport that fits the whole map inside the viewport.
 *
 * @param {number} mapWidth
 * @param {number} mapHeight
 * @param {number} viewWidth
 * @param {number} viewHeight
 * @param {number} [padding] fraction of available space the map should occupy
 */
export function fitViewport(mapWidth, mapHeight, viewWidth, viewHeight, padding = 0.92) {
  if (
    !Number.isFinite(mapWidth) ||
    !Number.isFinite(mapHeight) ||
    !Number.isFinite(viewWidth) ||
    !Number.isFinite(viewHeight) ||
    mapWidth <= 0 ||
    mapHeight <= 0 ||
    viewWidth <= 0 ||
    viewHeight <= 0
  ) {
    return { x: 0, y: 0, scale: 1 };
  }

  const scale = clampScale(Math.min(viewWidth / mapWidth, viewHeight / mapHeight) * padding);
  return {
    x: (viewWidth - mapWidth * scale) / 2,
    y: (viewHeight - mapHeight * scale) / 2,
    scale,
  };
}

/**
 * Keep at least `margin` screen pixels of the map visible on every axis.
 * When the map is smaller than the viewport this still allows centering.
 *
 * @param {{ x: number, y: number, scale: number }} viewport
 * @param {number} viewWidth
 * @param {number} viewHeight
 * @param {number} mapWidth
 * @param {number} mapHeight
 * @param {number} [margin]
 */
export function clampTranslation(
  viewport,
  viewWidth,
  viewHeight,
  mapWidth,
  mapHeight,
  margin = 96,
) {
  if (
    !Number.isFinite(viewWidth) ||
    !Number.isFinite(viewHeight) ||
    !Number.isFinite(mapWidth) ||
    !Number.isFinite(mapHeight) ||
    viewWidth <= 0 ||
    viewHeight <= 0 ||
    mapWidth <= 0 ||
    mapHeight <= 0
  ) {
    return viewport;
  }

  const scaledWidth = mapWidth * viewport.scale;
  const scaledHeight = mapHeight * viewport.scale;

  return {
    ...viewport,
    x: clamp(viewport.x, margin - scaledWidth, viewWidth - margin),
    y: clamp(viewport.y, margin - scaledHeight, viewHeight - margin),
  };
}

/** Convert a screen-space point to map-space. */
export function screenToMap(viewport, point) {
  return {
    x: (point.x - viewport.x) / viewport.scale,
    y: (point.y - viewport.y) / viewport.scale,
  };
}

/** Convert a map-space point to screen-space. */
export function mapToScreen(viewport, point) {
  return {
    x: point.x * viewport.scale + viewport.x,
    y: point.y * viewport.scale + viewport.y,
  };
}

/** The map-space rectangle currently visible in the viewport. */
export function visibleBounds(viewport, viewWidth, viewHeight) {
  if (!Number.isFinite(viewWidth) || !Number.isFinite(viewHeight)) {
    return { x0: 0, y0: 0, x1: 0, y1: 0 };
  }
  return {
    x0: -viewport.x / viewport.scale,
    y0: -viewport.y / viewport.scale,
    x1: (viewWidth - viewport.x) / viewport.scale,
    y1: (viewHeight - viewport.y) / viewport.scale,
  };
}

/**
 * Snap a coordinate to the center of the grid cell containing it.
 * Grid lines live at multiples of `grid`, so a 70px cell centre is 35, 105…
 */
export function snapToCell(value, grid) {
  if (!Number.isFinite(value) || !Number.isFinite(grid) || grid <= 0) return value;
  return Math.floor(value / grid) * grid + grid / 2;
}

/** Snap a point to its containing cell centre. */
export function snapPoint(point, grid) {
  return {
    x: snapToCell(point.x, grid),
    y: snapToCell(point.y, grid),
  };
}

/**
 * Keep a token centre inside the playable map area. Tokens occupy one cell, so
 * their centre can never leave the inner half-cell band.
 */
export function clampTokenPosition(point, mapWidth, mapHeight, grid) {
  const safeGrid = Number.isFinite(grid) && grid > 0 ? grid : 1;
  const half = safeGrid / 2;
  const minX = Math.min(half, mapWidth / 2);
  const minY = Math.min(half, mapHeight / 2);
  return {
    x: clamp(point.x, minX, Math.max(minX, mapWidth - half)),
    y: clamp(point.y, minY, Math.max(minY, mapHeight - half)),
  };
}
