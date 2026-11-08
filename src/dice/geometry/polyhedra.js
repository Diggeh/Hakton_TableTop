import {
  add,
  cross,
  dot,
  normalize,
  quatRotate,
  rotationBetweenFrames,
  scale,
  sub,
} from '../math.js';

/**
 * Pure polyhedron data for the six physical die shapes (d100 reuses the d10 shape).
 * Faces are derived from a convex hull of the vertex set, so geometry, physics hulls,
 * texture layout and result alignment all come from one source of truth.
 *
 * Conventions: unit circumradius, centred on the origin, faces wound counter-clockwise
 * when viewed from outside (matches both Three.js and cannon-es).
 */

export const DIE_KINDS = Object.freeze(['d4', 'd6', 'd8', 'd10', 'd12', 'd20']);

const PHI = (1 + Math.sqrt(5)) / 2;
const EPS = 1e-6;

function rawVertices(kind) {
  switch (kind) {
    case 'd4':
      return [
        [1, 1, 1],
        [-1, -1, 1],
        [-1, 1, -1],
        [1, -1, -1],
      ];
    case 'd6': {
      const v = [];
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) v.push([x, y, z]);
      return v;
    }
    case 'd8':
      return [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ];
    case 'd10': {
      // Pentagonal trapezohedron. h makes each kite exactly planar: h = tan^2(18 deg).
      const h = (1 - Math.cos(Math.PI / 5)) / (1 + Math.cos(Math.PI / 5));
      const v = [
        [0, 0, 1],
        [0, 0, -1],
      ];
      for (let i = 0; i < 10; i++) {
        const a = (i * Math.PI) / 5;
        v.push([Math.cos(a), Math.sin(a), i % 2 === 0 ? h : -h]);
      }
      return v;
    }
    case 'd12': {
      const v = [];
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) v.push([x, y, z]);
      const a = 1 / PHI;
      for (const s of [-1, 1]) {
        for (const t of [-1, 1]) {
          v.push([0, s * a, t * PHI]);
          v.push([s * a, t * PHI, 0]);
          v.push([t * PHI, 0, s * a]);
        }
      }
      return v;
    }
    case 'd20': {
      const v = [];
      for (const s of [-1, 1]) {
        for (const t of [-1, 1]) {
          v.push([0, s, t * PHI]);
          v.push([s, t * PHI, 0]);
          v.push([t * PHI, 0, s]);
        }
      }
      return v;
    }
    default:
      throw new Error(`Unknown die kind "${kind}"`);
  }
}

/** Faces of the convex hull: every plane through 3 vertices with all vertices on one side. */
function hullFaces(vertices) {
  const seen = new Map();
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        let normal = cross(sub(vertices[j], vertices[i]), sub(vertices[k], vertices[i]));
        const len = Math.hypot(normal[0], normal[1], normal[2]);
        if (len < EPS) continue;
        normal = scale(normal, 1 / len);
        let d = dot(normal, vertices[i]);
        if (d < 0) {
          normal = scale(normal, -1);
          d = -d;
        }
        const onPlane = [];
        let outside = false;
        for (let m = 0; m < n; m++) {
          const s = dot(normal, vertices[m]) - d;
          if (s > EPS) {
            outside = true;
            break;
          }
          if (Math.abs(s) <= EPS) onPlane.push(m);
        }
        if (outside) continue;
        const key = onPlane.join(',');
        if (seen.has(key)) continue;

        // Order the polygon counter-clockwise as seen from outside.
        let centroid = [0, 0, 0];
        for (const m of onPlane) centroid = add(centroid, vertices[m]);
        centroid = scale(centroid, 1 / onPlane.length);
        const u = normalize(sub(vertices[onPlane[0]], centroid));
        const w = cross(normal, u);
        const indices = [...onPlane].sort((a, b) => {
          const da = sub(vertices[a], centroid);
          const db = sub(vertices[b], centroid);
          return Math.atan2(dot(da, w), dot(da, u)) - Math.atan2(dot(db, w), dot(db, u));
        });
        seen.set(key, { indices, normal, centroid });
      }
    }
  }
  return [...seen.values()];
}

/**
 * Reference vertex that defines a face's "up" in its local frame. Regular polygons are
 * rotation-symmetric so any vertex works; kites (d10) use their apex so the frame is unique.
 */
function referenceVertex(kind, indices, vertices) {
  if (kind !== 'd10') return indices[0];
  return indices.reduce((best, idx) =>
    Math.abs(vertices[idx][2]) > Math.abs(vertices[best][2]) ? idx : best,
  );
}

/** Assigns face values so opposite faces sum to n + 1 (d4: value k sits at vertex k - 1). */
function assignValues(kind, faces, vertexCount) {
  const n = kind === 'd4' ? 4 : faces.length;
  const faceOfValue = new Array(n + 1).fill(-1);

  if (kind === 'd4') {
    faces.forEach((face, f) => {
      const missing = [...Array(vertexCount).keys()].find((v) => !face.indices.includes(v));
      faceOfValue[missing + 1] = f;
    });
    return faceOfValue;
  }

  const assigned = new Set();
  let low = 1;
  faces.forEach((face, f) => {
    if (assigned.has(f)) return;
    const opposite = faces.findIndex(
      (other, o) => o !== f && dot(other.normal, face.normal) < -1 + 1e-4,
    );
    if (opposite < 0) throw new Error(`${kind}: face ${f} has no opposite face`);
    faceOfValue[low] = f;
    faceOfValue[n + 1 - low] = opposite;
    assigned.add(f);
    assigned.add(opposite);
    low++;
  });
  return faceOfValue;
}

const cache = new Map();

/**
 * @typedef {{
 *   indices: number[],
 *   normal: number[],
 *   centroid: number[],
 *   frame: number[][],
 *   localPoints: number[][],
 *   inradiusRatio: number,
 * }} PolyFace
 * @typedef {{
 *   kind: string,
 *   valueCount: number,
 *   vertices: number[][],
 *   faces: PolyFace[],
 *   faceOfValue: number[],
 *   valueOfFace: number[],
 *   resultDirs: number[][],
 * }} Polyhedron
 */

/** @returns {Polyhedron} */
export function getPolyhedron(kind) {
  if (cache.has(kind)) return cache.get(kind);

  const raw = rawVertices(kind);
  const maxLen = Math.max(...raw.map((v) => Math.hypot(v[0], v[1], v[2])));
  const vertices = raw.map((v) => scale(v, 1 / maxLen));

  const faces = hullFaces(vertices).map((face) => {
    const ref = referenceVertex(kind, face.indices, vertices);
    const up = normalize(sub(vertices[ref], face.centroid));
    const right = cross(up, face.normal);
    const local = face.indices.map((idx) => {
      const d = sub(vertices[idx], face.centroid);
      return [dot(d, right), dot(d, up)];
    });
    const circumradius = Math.max(...local.map((p) => Math.hypot(p[0], p[1])));
    // Inradius: the nearest edge to the centroid.
    let inradius = Infinity;
    for (let i = 0; i < local.length; i++) {
      const a = local[i];
      const b = local[(i + 1) % local.length];
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const dist = Math.abs(a[0] * ey - a[1] * ex) / Math.hypot(ex, ey);
      inradius = Math.min(inradius, dist);
    }
    return {
      indices: face.indices,
      normal: face.normal,
      centroid: face.centroid,
      frame: [right, up, face.normal],
      localPoints: local.map((p) => [p[0] / circumradius, p[1] / circumradius]),
      inradiusRatio: inradius / circumradius,
    };
  });

  const valueCount = kind === 'd4' ? 4 : faces.length;
  const faceOfValue = assignValues(kind, faces, vertices.length);
  const valueOfFace = new Array(faces.length).fill(0);
  for (let v = 1; v <= valueCount; v++) valueOfFace[faceOfValue[v]] = v;

  // Direction that must point at the camera for value v to read as rolled.
  // Flat-faced dice read their top face; a d4 reads the vertex pointing up, which is the
  // inverse of the face lying on the table.
  const resultDirs = [null];
  for (let v = 1; v <= valueCount; v++) {
    const normal = faces[faceOfValue[v]].normal;
    resultDirs.push(kind === 'd4' ? scale(normal, -1) : normal);
  }

  const poly = { kind, valueCount, vertices, faces, faceOfValue, valueOfFace, resultDirs };
  cache.set(kind, poly);
  return poly;
}

/** Value (1..n) whose result direction is closest to world +Z for a body orientation. */
export function topValue(kind, quaternion) {
  const poly = getPolyhedron(kind);
  let best = 1;
  let bestDot = -Infinity;
  for (let v = 1; v <= poly.valueCount; v++) {
    const d = quatRotate(quaternion, poly.resultDirs[v])[2];
    if (d > bestDot) {
      bestDot = d;
      best = v;
    }
  }
  return { value: best, alignment: bestDot };
}

/**
 * Rotation that is an exact symmetry of the polyhedron and carries the face showing
 * `fromValue` onto the face showing `toValue`.
 *
 * This is how a pre-determined result is guaranteed without touching the physics: the
 * simulation lands on whichever face it lands on (`toValue`), and the visible mesh is turned
 * by this symmetry so that the face *labelled* `fromValue` (the rolled number) ends up there.
 * Because it maps the shape onto itself, the mesh still matches the collision hull exactly.
 *
 * @returns {number[]} quaternion [x, y, z, w]
 */
export function symmetryRotation(kind, fromValue, toValue) {
  const poly = getPolyhedron(kind);
  const from = poly.faces[poly.faceOfValue[fromValue]];
  const to = poly.faces[poly.faceOfValue[toValue]];
  return rotationBetweenFrames(from.frame, to.frame);
}

const WORLD_FRAME = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/**
 * Returns the quaternion `[x, y, z, w]` that rotates a die of `kind` so that the face
 * (or vertex peak on `d4`) for `targetValue` points directly toward the camera (`+Z`)
 * and is oriented right-side up (`+Y`).
 *
 * @param {'d4'|'d6'|'d8'|'d10'|'d12'|'d20'} kind
 * @param {number} targetValue
 * @returns {number[]} quaternion `[x, y, z, w]`
 */
export function faceUpQuaternion(kind, targetValue) {
  const poly = getPolyhedron(kind);
  const clamped = Math.max(1, Math.min(poly.valueCount, Number(targetValue) || 1));
  const face = poly.faces[poly.faceOfValue[clamped]];

  const fromFrame =
    kind === 'd4'
      ? [
          scale(face.frame[0], -1),
          face.frame[1],
          scale(face.frame[2], -1),
        ]
      : face.frame;

  return rotationBetweenFrames(fromFrame, WORLD_FRAME);
}
