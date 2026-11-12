const EPSILON = 1e-4;

/**
 * Shortest distance from point `p` to segment `a -> b`.
 * @param {{ x: number, y: number }} p
 * @param {{ x: number, y: number }} a
 * @param {{ x: number, y: number }} b
 */
export function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

/**
 * Checks if finite line segment `a1 -> a2` intersects finite line segment `b1 -> b2`.
 * @returns {{ intersects: boolean, point?: { x: number, y: number }, t?: number, u?: number }}
 */
export function segmentsIntersect(a1, a2, b1, b2) {
  const rX = a2.x - a1.x;
  const rY = a2.y - a1.y;
  const sX = b2.x - b1.x;
  const sY = b2.y - b1.y;

  const denom = rX * sY - rY * sX;
  if (Math.abs(denom) < 1e-9) {
    return { intersects: false };
  }

  const qpX = b1.x - a1.x;
  const qpY = b1.y - a1.y;
  const t = (qpX * sY - qpY * sX) / denom;
  const u = (qpX * rY - qpY * rX) / denom;

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return {
      intersects: true,
      t,
      u,
      point: {
        x: a1.x + t * rX,
        y: a1.y + t * rY,
      },
    };
  }
  return { intersects: false };
}

/**
 * Intersects a ray starting at `origin` with direction `(dx, dy)` against segment `p1 -> p2`.
 * Returns `{ x, y, param }` where `param` is ray distance multiplier, or `null`.
 */
export function intersectRaySegment(origin, dx, dy, p1, p2) {
  const sX = p2.x - p1.x;
  const sY = p2.y - p1.y;

  const denom = dx * sY - dy * sX;
  if (Math.abs(denom) < 1e-9) return null;

  const qpX = p1.x - origin.x;
  const qpY = p1.y - origin.y;

  const t1 = (qpX * sY - qpY * sX) / denom;
  const t2 = (qpX * dy - qpY * dx) / denom;

  if (t1 >= 0 && t2 >= -1e-6 && t2 <= 1 + 1e-6) {
    return {
      x: origin.x + t1 * dx,
      y: origin.y + t1 * dy,
      param: t1,
    };
  }
  return null;
}

/**
 * Returns true when a wall segment blocks movement and vision (solid wall or closed door).
 */
export function isBlockingWall(wall) {
  if (!wall || !wall.p1 || !wall.p2) return false;
  if (wall.isDoor && wall.isOpen) return false;
  return true;
}

/**
 * Prevents token movement from passing through any active wall or closed door.
 * If the path `startPos -> targetPos` crosses a blocking wall, returns `{ blocked: true, position: startPos }`.
 *
 * @param {{ x: number, y: number }} startPos
 * @param {{ x: number, y: number }} targetPos
 * @param {Array<{ id?: string, p1: { x: number, y: number }, p2: { x: number, y: number }, isDoor?: boolean, isOpen?: boolean }>} walls
 */
export function resolveTokenMoveWithWalls(startPos, targetPos, walls = []) {
  if (!Array.isArray(walls) || walls.length === 0) {
    return { blocked: false, position: targetPos };
  }
  if (
    Math.abs(startPos.x - targetPos.x) < 0.01 &&
    Math.abs(startPos.y - targetPos.y) < 0.01
  ) {
    return { blocked: false, position: targetPos };
  }

  for (const wall of walls) {
    if (!isBlockingWall(wall)) continue;
    const hit = segmentsIntersect(startPos, targetPos, wall.p1, wall.p2);
    if (hit.intersects) {
      return {
        blocked: true,
        wallId: wall.id ?? null,
        position: { x: startPos.x, y: startPos.y },
      };
    }
  }

  return { blocked: false, position: targetPos };
}

/**
 * Computes a 2D visibility polygon from `origin` occluded by active `walls` within `bounds`.
 * Open doors are ignored so vision extends through open doorways.
 *
 * @param {{ x: number, y: number }} origin
 * @param {Array<{ p1: { x: number, y: number }, p2: { x: number, y: number }, isDoor?: boolean, isOpen?: boolean }>} walls
 * @param {{ x?: number, y?: number, width: number, height: number }} bounds
 * @returns {Array<{ x: number, y: number }>}
 */
export function computeVisibilityPolygon(origin, walls = [], bounds = { width: 1400, height: 980 }) {
  const minX = bounds.x ?? 0;
  const minY = bounds.y ?? 0;
  const maxX = minX + (bounds.width || 1400);
  const maxY = minY + (bounds.height || 980);

  const segments = [
    { p1: { x: minX, y: minY }, p2: { x: maxX, y: minY } },
    { p1: { x: maxX, y: minY }, p2: { x: maxX, y: maxY } },
    { p1: { x: maxX, y: maxY }, p2: { x: minX, y: maxY } },
    { p1: { x: minX, y: maxY }, p2: { x: minX, y: minY } },
  ];

  for (const wall of walls) {
    if (isBlockingWall(wall)) {
      segments.push({ p1: wall.p1, p2: wall.p2 });
    }
  }

  const angles = [];
  for (const seg of segments) {
    for (const pt of [seg.p1, seg.p2]) {
      const angle = Math.atan2(pt.y - origin.y, pt.x - origin.x);
      angles.push(angle - EPSILON, angle, angle + EPSILON);
    }
  }

  const intersects = [];
  for (const angle of angles) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);

    let closest = null;
    for (const seg of segments) {
      const hit = intersectRaySegment(origin, dx, dy, seg.p1, seg.p2);
      if (!hit) continue;
      if (!closest || hit.param < closest.param) {
        closest = hit;
      }
    }
    if (closest) {
      intersects.push({
        x: closest.x,
        y: closest.y,
        angle,
      });
    }
  }

  intersects.sort((a, b) => a.angle - b.angle);
  return intersects.map(({ x, y }) => ({ x, y }));
}

/**
 * Checks whether a point `{ x, y }` lies inside a placed fog shape.
 * Supports `rect`, `circle`, `polygon`, and `line`.
 */
export function isPointInFogShape(point, shape) {
  if (!point || !shape) return false;
  const { x, y } = point;

  if (shape.type === 'rect') {
    const rx = Math.min(shape.x, shape.x + shape.width);
    const ry = Math.min(shape.y, shape.y + shape.height);
    const rw = Math.abs(shape.width);
    const rh = Math.abs(shape.height);
    return x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
  }

  if (shape.type === 'circle') {
    return Math.hypot(x - shape.x, y - shape.y) <= Math.abs(shape.radius || 0);
  }

  if (shape.type === 'polygon' && Array.isArray(shape.points) && shape.points.length >= 6) {
    const pts = shape.points;
    let inside = false;
    const n = Math.floor(pts.length / 2);
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = pts[i * 2];
      const yi = pts[i * 2 + 1];
      const xj = pts[j * 2];
      const yj = pts[j * 2 + 1];
      const intersect =
        yi > y !== yj > y &&
        x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  if (shape.type === 'line' && Array.isArray(shape.points) && shape.points.length >= 4) {
    const pts = shape.points;
    const halfWidth = (shape.strokeWidth || 36) / 2;
    for (let i = 0; i <= pts.length - 4; i += 2) {
      const a = { x: pts[i], y: pts[i + 1] };
      const b = { x: pts[i + 2], y: pts[i + 3] };
      if (distanceToSegment(point, a, b) <= halfWidth) return true;
    }
    return false;
  }

  return false;
}
