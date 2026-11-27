/**
 * Owlbear-Rodeo-inspired tactical distance measurement helpers and payload sanitization.
 * Runtime-agnostic (safe for both Node socket router and React/Konva renderer).
 */

export const RULER_MODES = Object.freeze({
  CHEBYSHEV: '5e',
  ALTERNATING: 'alternating',
  EUCLIDEAN: 'euclidean',
  MANHATTAN: 'manhattan',
});

const VALID_MODES = new Set(Object.values(RULER_MODES));
const MAX_WAYPOINTS = 24;

/**
 * Computes square-grid & Euclidean distances along a polyline of map-space points.
 * - '5e' (Chebyshev): max(dx, dy) in cells (diagonals = 1 cell = feetPerCell).
 * - 'alternating' (5/10/5/10): every 2nd diagonal across the whole path costs +1 extra cell.
 * - 'euclidean': true geometric straight-line length in feet (rounded to nearest int / 0.5).
 * - 'manhattan': |dx| + |dy| in cells.
 */
export function measurePolylineDistance(
  points = [],
  gridSize = 35,
  { mode = RULER_MODES.CHEBYSHEV, feetPerCell = 5 } = {},
) {
  const safeGrid = Number.isFinite(Number(gridSize)) && Number(gridSize) > 0 ? Number(gridSize) : 35;
  const scaleFeet = Number.isFinite(Number(feetPerCell)) && Number(feetPerCell) > 0 ? Number(feetPerCell) : 5;
  const activeMode = VALID_MODES.has(mode) ? mode : RULER_MODES.CHEBYSHEV;

  if (!Array.isArray(points) || points.length < 2) {
    return { totalFeet: 0, totalCells: 0, segments: [] };
  }

  let totalCells = 0;
  let totalFeet = 0;
  let diagonalParity = 0;
  const segments = [];

  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const dxPx = Math.abs(Number(b.x) - Number(a.x));
    const dyPx = Math.abs(Number(b.y) - Number(a.y));
    const dxCells = dxPx / safeGrid;
    const dyCells = dyPx / safeGrid;

    let segCells = 0;
    if (activeMode === RULER_MODES.EUCLIDEAN) {
      segCells = Math.hypot(dxCells, dyCells);
      const segFeet = Math.round(segCells * scaleFeet);
      totalCells += segCells;
      totalFeet += segFeet;
      segments.push({
        from: a,
        to: b,
        midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        cells: segCells,
        feet: segFeet,
      });
      continue;
    }

    const qx = Math.round(dxCells);
    const qy = Math.round(dyCells);

    if (activeMode === RULER_MODES.MANHATTAN) {
      segCells = qx + qy;
    } else if (activeMode === RULER_MODES.ALTERNATING) {
      const diag = Math.min(qx, qy);
      const straight = Math.abs(qx - qy);
      const extraDiagonals = Math.floor((diagonalParity + diag) / 2);
      diagonalParity = (diagonalParity + diag) % 2;
      segCells = straight + diag + extraDiagonals;
    } else {
      // '5e' Chebyshev chessboard distance
      segCells = Math.max(qx, qy);
    }

    const segFeet = Math.round(segCells * scaleFeet);
    totalCells += segCells;
    totalFeet += segFeet;
    segments.push({
      from: a,
      to: b,
      midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      cells: segCells,
      feet: segFeet,
    });
  }

  return { totalFeet, totalCells, segments };
}

export function sanitizeRulerPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (!Array.isArray(payload.points) || payload.points.length < 2) return null;

  const points = [];
  for (const pt of payload.points.slice(0, MAX_WAYPOINTS)) {
    const x = Number(pt?.x);
    const y = Number(pt?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    points.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
  }
  if (points.length < 2) return null;

  const mode = VALID_MODES.has(payload.mode) ? payload.mode : RULER_MODES.CHEBYSHEV;
  const rawFeet = Number(payload.feetPerCell);
  const feetPerCell = Number.isFinite(rawFeet) && rawFeet > 0 && rawFeet <= 1000 ? rawFeet : 5;
  const color =
    typeof payload.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(payload.color.trim())
      ? payload.color.trim()
      : '#adfcf9';

  return {
    points,
    mode,
    feetPerCell,
    color,
    shared: payload.shared !== false,
  };
}
