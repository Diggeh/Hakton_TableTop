/**
 * Pure freehand lasso polygon geometry helpers for multi-token selection.
 * Kept free of DOM/Konva imports so it can be unit-tested with node:test.
 */

/**
 * Ray-casting even-odd point-in-polygon test against a flat `[x0, y0, x1, y1, ...]` array.
 */
export function isPointInPolygon(point, flatPoints) {
  if (!point || !Array.isArray(flatPoints) || flatPoints.length < 6) {
    return false;
  }
  const px = Number(point.x);
  const py = Number(point.y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return false;

  const count = Math.floor(flatPoints.length / 2);
  let inside = false;

  for (let i = 0, j = count - 1; i < count; j = i++) {
    const xi = flatPoints[i * 2];
    const yi = flatPoints[i * 2 + 1];
    const xj = flatPoints[j * 2];
    const yj = flatPoints[j * 2 + 1];

    const intersects =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-12) + xi;
    if (intersects) inside = !inside;
  }

  return inside;
}

/**
 * Returns the IDs of all tokens whose centers fall inside the lasso loop.
 * Background map tiles (`isMap: true`) are excluded by default.
 */
export function selectTokensInLasso(
  tokens,
  flatPoints,
  { includeMaps = false, filterFn = null } = {},
) {
  if (!Array.isArray(flatPoints) || flatPoints.length < 6) return [];
  const list = Array.isArray(tokens)
    ? tokens
    : tokens && typeof tokens === 'object'
      ? Object.values(tokens)
      : [];

  const selected = [];
  for (const token of list) {
    if (!token || !token.id) continue;
    if (!includeMaps && token.isMap) continue;
    if (typeof filterFn === 'function' && !filterFn(token)) continue;
    if (isPointInPolygon({ x: token.x, y: token.y }, flatPoints)) {
      selected.push(token.id);
    }
  }
  return selected;
}
