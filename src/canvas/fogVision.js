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
 * Projects point `p` onto segment `a -> b` and returns the snapped point,
 * the parameter `t` along the segment [0, 1], and the distance.
 */
export function projectPointOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return {
      x: a.x,
      y: a.y,
      t: 0,
      distance: Math.hypot(p.x - a.x, p.y - a.y),
    };
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return {
    x: projX,
    y: projY,
    t,
    distance: Math.hypot(p.x - projX, p.y - projY),
  };
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
 * Generates perimeter wall segments from placed fog shapes (rectangles, polygons, circles, and lines).
 * This makes the boundaries of any created fog shape an automatic barrier and door-mountable surface.
 */
export function getFogShapeWalls(fogShapes = []) {
  if (!Array.isArray(fogShapes) || fogShapes.length === 0) return [];
  const walls = [];

  for (const shape of fogShapes) {
    if (!shape) continue;

    if (shape.type === 'rect') {
      const rx = Math.min(shape.x, shape.x + shape.width);
      const ry = Math.min(shape.y, shape.y + shape.height);
      const rw = Math.abs(shape.width);
      const rh = Math.abs(shape.height);
      if (rw > 4 && rh > 4) {
        const p1 = { x: rx, y: ry };
        const p2 = { x: rx + rw, y: ry };
        const p3 = { x: rx + rw, y: ry + rh };
        const p4 = { x: rx, y: ry + rh };
        walls.push(
          { id: `${shape.id}_w0`, p1, p2, isDoor: false, isOpen: false, isAutoWall: true, shapeId: shape.id },
          { id: `${shape.id}_w1`, p1: p2, p2: p3, isDoor: false, isOpen: false, isAutoWall: true, shapeId: shape.id },
          { id: `${shape.id}_w2`, p1: p3, p2: p4, isDoor: false, isOpen: false, isAutoWall: true, shapeId: shape.id },
          { id: `${shape.id}_w3`, p1: p4, p2: p1, isDoor: false, isOpen: false, isAutoWall: true, shapeId: shape.id },
        );
      }
    } else if (shape.type === 'polygon' && Array.isArray(shape.points) && shape.points.length >= 6) {
      const pts = shape.points;
      const count = Math.floor(pts.length / 2);
      for (let i = 0; i < count; i++) {
        const nextIdx = (i + 1) % count;
        const p1 = { x: pts[i * 2], y: pts[i * 2 + 1] };
        const p2 = { x: pts[nextIdx * 2], y: pts[nextIdx * 2 + 1] };
        if (Math.hypot(p2.x - p1.x, p2.y - p1.y) > 2) {
          walls.push({
            id: `${shape.id}_w${i}`,
            p1,
            p2,
            isDoor: false,
            isOpen: false,
            isAutoWall: true,
            shapeId: shape.id,
          });
        }
      }
    } else if (shape.type === 'circle' && shape.radius > 4) {
      // Approximate circle perimeter with 24 polygonal segments for smooth barrier collision
      const segs = 24;
      const step = (Math.PI * 2) / segs;
      for (let i = 0; i < segs; i++) {
        const a1 = i * step;
        const a2 = (i + 1) * step;
        const p1 = {
          x: shape.x + Math.cos(a1) * shape.radius,
          y: shape.y + Math.sin(a1) * shape.radius,
        };
        const p2 = {
          x: shape.x + Math.cos(a2) * shape.radius,
          y: shape.y + Math.sin(a2) * shape.radius,
        };
        walls.push({
          id: `${shape.id}_w${i}`,
          p1,
          p2,
          isDoor: false,
          isOpen: false,
          isAutoWall: true,
          shapeId: shape.id,
        });
      }
    }
  }

  return walls;
}

/**
 * Splits wall segments wherever open doors overlap them, carving real doorway gaps
 * for both physical movement and light/vision rays while keeping adjacent wall sections intact.
 */
export function subtractOpenDoorsFromWalls(walls = [], openDoors = []) {
  if (!Array.isArray(walls) || walls.length === 0) return [];
  if (!Array.isArray(openDoors) || openDoors.length === 0) return walls;

  const result = [];

  for (const wall of walls) {
    if (!wall?.p1 || !wall?.p2) continue;
    const dx = wall.p2.x - wall.p1.x;
    const dy = wall.p2.y - wall.p1.y;
    const wallLen = Math.hypot(dx, dy);
    if (wallLen < 1) continue;

    const gaps = [];
    for (const door of openDoors) {
      if (!door?.isDoor || !door.isOpen || !door.p1 || !door.p2) continue;
      const proj1 = projectPointOnSegment(door.p1, wall.p1, wall.p2);
      const proj2 = projectPointOnSegment(door.p2, wall.p1, wall.p2);
      const matchesById = Boolean(door.wallId && door.wallId === wall.id);
      const matchesCollinear = proj1.distance <= 12 && proj2.distance <= 12;
      if (!matchesById && !matchesCollinear) continue;

      const tStart = Math.max(0, Math.min(1, Math.min(proj1.t, proj2.t)));
      const tEnd = Math.max(0, Math.min(1, Math.max(proj1.t, proj2.t)));
      if (tEnd - tStart > 1e-4) {
        gaps.push([tStart, tEnd]);
      }
    }

    if (gaps.length === 0) {
      result.push(wall);
      continue;
    }

    gaps.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [start, end] of gaps) {
      if (merged.length === 0 || start > merged[merged.length - 1][1] + 1e-6) {
        merged.push([start, end]);
      } else {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], end);
      }
    }

    let cursor = 0;
    let segIdx = 0;
    const lerpPt = (t) => ({
      x: wall.p1.x + dx * t,
      y: wall.p1.y + dy * t,
    });

    for (const [gStart, gEnd] of merged) {
      if ((gStart - cursor) * wallLen >= 2) {
        result.push({
          ...wall,
          id: `${wall.id}_seg${segIdx++}`,
          p1: lerpPt(cursor),
          p2: lerpPt(gStart),
        });
      }
      cursor = Math.max(cursor, gEnd);
    }

    if ((1 - cursor) * wallLen >= 2) {
      result.push({
        ...wall,
        id: `${wall.id}_seg${segIdx++}`,
        p1: lerpPt(cursor),
        p2: wall.p2,
      });
    }
  }

  return result;
}

/**
 * Combines explicit walls and doors with auto-generated perimeter walls from fog shapes.
 * Open doors geometrically carve passages through collinear walls and fog boundaries.
 */
export function getAllCollisionWalls(explicitWalls = [], fogShapes = []) {
  const list = Array.isArray(explicitWalls) ? explicitWalls : [];
  const openDoors = list.filter((w) => w && w.isDoor && w.isOpen);
  const closedDoors = list.filter((w) => w && w.isDoor && !w.isOpen);
  const explicitSolidWalls = list.filter((w) => w && !w.isDoor);
  const autoWalls = getFogShapeWalls(fogShapes);

  const carvedExplicit = subtractOpenDoorsFromWalls(explicitSolidWalls, openDoors);
  const carvedAuto = subtractOpenDoorsFromWalls(autoWalls, openDoors);
  return [...closedDoors, ...carvedExplicit, ...carvedAuto];
}

/**
 * Finds the nearest wall segment to a given point within `maxDistance`.
 * Used for mounting doors directly onto walls.
 */
export function findNearestWallSegment(point, allWalls = [], maxDistance = 28) {
  let closest = null;
  let minD = maxDistance;

  for (const wall of allWalls) {
    if (!wall || !wall.p1 || !wall.p2) continue;
    const proj = projectPointOnSegment(point, wall.p1, wall.p2);
    if (proj.distance < minD) {
      minD = proj.distance;
      const angle = Math.atan2(wall.p2.y - wall.p1.y, wall.p2.x - wall.p1.x);
      closest = {
        wall,
        point: { x: proj.x, y: proj.y },
        t: proj.t,
        distance: proj.distance,
        angle,
      };
    }
  }

  return closest;
}

/**
 * Detects whether a freehand brush stroke forms an enclosed contour, either because
 * its end is close to its beginning or because it self-intersects.
 * Returns `{ isClosed: boolean, points?: number[] }`.
 */
export function detectClosedLoop(rawPoints, snapDist = 40) {
  if (!Array.isArray(rawPoints) || rawPoints.length < 6) {
    return { isClosed: false };
  }

  const count = Math.floor(rawPoints.length / 2);
  const first = { x: rawPoints[0], y: rawPoints[1] };
  const last = { x: rawPoints[(count - 1) * 2], y: rawPoints[(count - 1) * 2 + 1] };

  // 1. Direct start-to-end loop closure
  if (Math.hypot(last.x - first.x, last.y - first.y) <= snapDist && count >= 3) {
    return {
      isClosed: true,
      points: [...rawPoints],
    };
  }

  // 2. Check for self-intersection with earlier segments
  if (count >= 5) {
    const lastSegA = { x: rawPoints[(count - 2) * 2], y: rawPoints[(count - 2) * 2 + 1] };
    const lastSegB = last;

    for (let i = 0; i < count - 3; i++) {
      const segA = { x: rawPoints[i * 2], y: rawPoints[i * 2 + 1] };
      const segB = { x: rawPoints[(i + 1) * 2], y: rawPoints[(i + 1) * 2 + 1] };
      const hit = segmentsIntersect(lastSegA, lastSegB, segA, segB);
      if (hit.intersects && hit.point) {
        // Extract the loop from intersection point through subsequent vertices back to intersection
        const loop = [hit.point.x, hit.point.y];
        for (let j = i + 1; j < count - 1; j++) {
          loop.push(rawPoints[j * 2], rawPoints[j * 2 + 1]);
        }
        loop.push(hit.point.x, hit.point.y);
        return {
          isClosed: true,
          points: loop,
        };
      }
    }
  }

  return { isClosed: false };
}

/**
 * Prevents token movement from passing through any active wall or closed door.
 * Instead of resetting all the way back to startPos, it treats the barrier as a solid
 * physical obstruction and halts the token right at the collision boundary.
 *
 * @param {{ x: number, y: number }} startPos
 * @param {{ x: number, y: number }} targetPos
 * @param {Array<{ id?: string, p1: { x: number, y: number }, p2: { x: number, y: number }, isDoor?: boolean, isOpen?: boolean }>} walls
 * @param {number|{ buffer?: number }} [options] Buffer distance in pixels from the wall surface.
 */
export function resolveTokenMoveWithWalls(startPos, targetPos, walls = [], options = {}) {
  const buffer = typeof options === 'number' ? options : (options.buffer ?? 4);

  if (!Array.isArray(walls) || walls.length === 0) {
    return { blocked: false, position: targetPos };
  }
  const dx = targetPos.x - startPos.x;
  const dy = targetPos.y - startPos.y;
  const totalDist = Math.hypot(dx, dy);

  if (totalDist < 0.01) {
    return { blocked: false, position: targetPos };
  }

  let earliestHit = null;

  for (const wall of walls) {
    if (!isBlockingWall(wall)) continue;
    const hit = segmentsIntersect(startPos, targetPos, wall.p1, wall.p2);
    if (hit.intersects && hit.t !== undefined) {
      if (!earliestHit || hit.t < earliestHit.t) {
        earliestHit = {
          wall,
          t: hit.t,
          point: hit.point,
        };
      }
    }
  }

  if (earliestHit && earliestHit.point) {
    const ux = dx / totalDist;
    const uy = dy / totalDist;
    const hitDist = totalDist * earliestHit.t;
    // Halt right in front of the wall by the buffer amount
    const stopDist = Math.max(0, hitDist - buffer);
    let stoppedPos = {
      x: startPos.x + ux * stopDist,
      y: startPos.y + uy * stopDist,
    };

    // Smooth tangential wall slide when pressed flush against a wall
    if (stopDist <= 0.5 && earliestHit.wall?.p1 && earliestHit.wall?.p2) {
      const wx = earliestHit.wall.p2.x - earliestHit.wall.p1.x;
      const wy = earliestHit.wall.p2.y - earliestHit.wall.p1.y;
      const wLen = Math.hypot(wx, wy);
      if (wLen > 1e-3) {
        const tx = wx / wLen;
        const ty = wy / wLen;
        const slideDist = dx * tx + dy * ty;
        if (Math.abs(slideDist) > 0.5) {
          const candidateSlide = {
            x: startPos.x + tx * slideDist,
            y: startPos.y + ty * slideDist,
          };
          const slideBlocked = walls.some(
            (w) =>
              isBlockingWall(w) &&
              segmentsIntersect(startPos, candidateSlide, w.p1, w.p2).intersects,
          );
          if (!slideBlocked) {
            stoppedPos = candidateSlide;
          }
        }
      }
    }

    return {
      blocked: true,
      wallId: earliestHit.wall.id ?? null,
      position: stoppedPos,
    };
  }

  return { blocked: false, position: targetPos };
}

/**
 * Computes a 2D visibility polygon from `origin` occluded by active `walls` within `bounds`.
 * Open doors are ignored so vision extends through open doorways.
 *
 * @param {{ x: number, y: number }} origin
 * @param {Array<object>} walls
 * @param {{ x?: number, y?: number, width?: number, height?: number }} bounds
 * @param {{ maxDistance?: number, arc?: { angle?: number, rotation?: number } }} [options]
 */
export function computeVisibilityPolygon(
  origin,
  walls = [],
  boundsOrOptions = { width: 1400, height: 980 },
  maybeOptions = {},
) {
  let bounds;
  let options;
  if (
    boundsOrOptions &&
    (boundsOrOptions.maxDistance !== undefined ||
      boundsOrOptions.arc !== undefined)
  ) {
    options = boundsOrOptions;
    bounds = { x: 0, y: 0, width: 1400, height: 980 };
  } else {
    bounds = boundsOrOptions || { width: 1400, height: 980 };
    options = maybeOptions || {};
  }

  const minX = bounds.x ?? 0;
  const minY = bounds.y ?? 0;
  const maxX = minX + (bounds.width || 1400);
  const maxY = minY + (bounds.height || 980);

  const maxDist = Number.isFinite(options.maxDistance) && options.maxDistance > 0
    ? options.maxDistance
    : Math.hypot(maxX - minX, maxY - minY);

  const hasArc = Boolean(options.arc && Number.isFinite(options.arc.angle) && options.arc.angle < 360);
  const arcAngle = hasArc ? (options.arc.angle * Math.PI) / 180 : Math.PI * 2;
  const arcRot = hasArc ? ((options.arc.rotation || 0) * Math.PI) / 180 : 0;
  const minArc = arcRot - arcAngle / 2;
  const maxArc = arcRot + arcAngle / 2;

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

  function inArc(angle) {
    if (!hasArc) return true;
    let diff = angle - arcRot;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return Math.abs(diff) <= arcAngle / 2 + 1e-4;
  }

  const rawAngles = [];

  // Radial samples for smooth circular perimeter
  const radialSteps = hasArc ? Math.max(8, Math.round((arcAngle / (Math.PI * 2)) * 32)) : 32;
  const startRadial = hasArc ? minArc : -Math.PI;
  const stepSize = arcAngle / radialSteps;
  for (let i = 0; i <= radialSteps; i++) {
    rawAngles.push(startRadial + i * stepSize);
  }

  // Wall vertex ray angles
  for (const seg of segments) {
    for (const pt of [seg.p1, seg.p2]) {
      const angle = Math.atan2(pt.y - origin.y, pt.x - origin.x);
      for (const offset of [-EPSILON, 0, EPSILON]) {
        const a = angle + offset;
        if (inArc(a)) rawAngles.push(a);
      }
    }
  }

  if (hasArc) {
    rawAngles.push(minArc, maxArc);
  }

  const intersects = [];
  for (const angle of rawAngles) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);

    let closestParam = maxDist;
    let hitX = origin.x + dx * maxDist;
    let hitY = origin.y + dy * maxDist;

    for (const seg of segments) {
      const hit = intersectRaySegment(origin, dx, dy, seg.p1, seg.p2);
      if (!hit) continue;
      if (hit.param >= 0 && hit.param < closestParam) {
        closestParam = hit.param;
        hitX = hit.x;
        hitY = hit.y;
      }
    }

    // Normalizing angle for sorting relative to arcRot
    let sortAngle = angle - arcRot;
    while (sortAngle > Math.PI) sortAngle -= Math.PI * 2;
    while (sortAngle < -Math.PI) sortAngle += Math.PI * 2;

    intersects.push({
      x: hitX,
      y: hitY,
      sortAngle,
    });
  }

  intersects.sort((a, b) => a.sortAngle - b.sortAngle);

  const poly = intersects.map(({ x, y }) => ({ x, y }));
  if (hasArc) {
    // For directional cone, apex is the token origin
    return [{ x: origin.x, y: origin.y }, ...poly];
  }
  return poly;
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

/**
 * Returns true if a given point lies inside any active fog shape.
 *
 * @param {{ x: number, y: number }} point
 * @param {Array<object>} fogShapes
 */
export function isPointInAnyFog(point, fogShapes = []) {
  if (!point || !Array.isArray(fogShapes) || fogShapes.length === 0) return false;
  return fogShapes.some((shape) => isPointInFogShape(point, shape));
}
