import * as THREE from 'three';
import { getPolyhedron } from './polyhedra.js';
import { DIE_RADIUS } from '../physics/DiceSimulator.js';

/**
 * Shared Three.js geometry + texture-atlas cache for all polyhedral dice
 * (d4, d6, d8, d10, d12, d20, and d100 tens).
 *
 * Every die kind uses ONE BufferGeometry and ONE CanvasTexture atlas so each die in flight
 * is a single draw call, and geometries/materials are allocated once and reused across rolls.
 */

const THEME = Object.freeze({
  faceFill: '#0b1938',
  faceInner: '#11254d',
  edgeStroke: '#3a7ca5',
  edgeGlow: '#adfcf9',
  numberInk: '#eef5fa',
  critHighlight: '#adfcf9',
});

const TILE_SIZE = 256;
const ATLAS_COLS = 5;

const geometryCache = new Map();
const materialCache = new Map();

function formatFaceLabel(variant, value) {
  if (variant === 'd100') {
    return value === 10 ? '00' : `${value * 10}`;
  }
  if (variant === 'd10') {
    return value === 10 ? '0' : `${value}`;
  }
  return `${value}`;
}

function drawPolygonBorder(ctx, cx, cy, radius, localPoints) {
  if (!localPoints || localPoints.length < 3) return;

  ctx.save();
  // Outer polygon fill
  ctx.beginPath();
  localPoints.forEach(([x, y], i) => {
    const px = cx + x * radius;
    const py = cy - y * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fillStyle = THEME.faceInner;
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = THEME.edgeStroke;
  ctx.stroke();

  // Subtle inner bevel line
  ctx.beginPath();
  localPoints.forEach(([x, y], i) => {
    const px = cx + x * radius * 0.86;
    const py = cy - y * radius * 0.86;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(173, 252, 249, 0.32)';
  ctx.stroke();
  ctx.restore();
}

function drawFaceTile(ctx, variant, poly, faceIndex, col, row) {
  const x0 = col * TILE_SIZE;
  const y0 = row * TILE_SIZE;
  const cx = x0 + TILE_SIZE / 2;
  const cy = y0 + TILE_SIZE / 2;
  const padRadius = TILE_SIZE * 0.43;

  ctx.fillStyle = THEME.faceFill;
  ctx.fillRect(x0, y0, TILE_SIZE, TILE_SIZE);

  const face = poly.faces[faceIndex];
  drawPolygonBorder(ctx, cx, cy, padRadius, face.localPoints);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (poly.kind === 'd4') {
    // On a d4, each corner vertex i has value (i + 1). Render each vertex number near its corner
    // AND softly in the centre so the upward peak reads unmistakably from top-down camera.
    face.indices.forEach((vertexIndex, cornerIdx) => {
      const cornerVal = vertexIndex + 1;
      const [lx, ly] = face.localPoints[cornerIdx];
      const tx = cx + lx * padRadius * 0.52;
      const ty = cy - ly * padRadius * 0.52;
      const angle = Math.atan2(lx, ly);

      ctx.save();
      ctx.translate(tx, ty);
      ctx.rotate(angle);
      ctx.font = '700 42px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = THEME.critHighlight;
      ctx.shadowColor = 'rgba(9, 21, 64, 0.9)';
      ctx.shadowBlur = 6;
      ctx.fillText(String(cornerVal), 0, 0);
      ctx.restore();
    });
  } else {
    const rawValue = poly.valueOfFace[faceIndex];
    const label = formatFaceLabel(variant, rawValue);
    const isMax = rawValue === poly.valueCount;
    const fontSize = Math.round(
      TILE_SIZE * Math.min(0.38, Math.max(0.22, face.inradiusRatio * 0.58)),
    );

    ctx.font = `700 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = isMax ? THEME.critHighlight : THEME.numberInk;
    ctx.shadowColor = 'rgba(9, 21, 64, 0.95)';
    ctx.shadowBlur = 8;
    ctx.fillText(label, cx, cy);

    // Disambiguate 6 and 9 with an underline bar
    if (label === '6' || label === '9') {
      const metricWidth = fontSize * 0.48;
      const barY = cy + fontSize * 0.44;
      ctx.beginPath();
      ctx.moveTo(cx - metricWidth / 2, barY);
      ctx.lineTo(cx + metricWidth / 2, barY);
      ctx.lineWidth = Math.max(3, fontSize * 0.08);
      ctx.strokeStyle = isMax ? THEME.critHighlight : THEME.numberInk;
      ctx.stroke();
    }
  }

  ctx.restore();
}

function createAtlasTexture(variant, poly) {
  const rows = Math.ceil(poly.faces.length / ATLAS_COLS);
  const width = ATLAS_COLS * TILE_SIZE;
  const height = rows * TILE_SIZE;

  if (typeof document === 'undefined') {
    const tex = new THREE.Texture();
    return { texture: tex, cols: ATLAS_COLS, rows };
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = THEME.faceFill;
  ctx.fillRect(0, 0, width, height);

  for (let f = 0; f < poly.faces.length; f++) {
    const col = f % ATLAS_COLS;
    const row = Math.floor(f / ATLAS_COLS);
    drawFaceTile(ctx, variant, poly, f, col, row);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return { texture, cols: ATLAS_COLS, rows };
}

/**
 * Builds (or returns cached) Three.js BufferGeometry for a polyhedral die kind.
 * @param {'d4'|'d6'|'d8'|'d10'|'d12'|'d20'} kind
 */
export function getDieGeometry(kind) {
  if (geometryCache.has(kind)) return geometryCache.get(kind);

  const poly = getPolyhedron(kind);
  const radius = DIE_RADIUS[kind];
  const rows = Math.ceil(poly.faces.length / ATLAS_COLS);
  const padRadiusRatio = 0.43;

  const positions = [];
  const normals = [];
  const uvs = [];

  poly.faces.forEach((face, faceIndex) => {
    const col = faceIndex % ATLAS_COLS;
    const row = Math.floor(faceIndex / ATLAS_COLS);
    const uCenter = (col + 0.5) / ATLAS_COLS;
    // Canvas y=0 is top, WebGL UV v=1 is top
    const vCenter = 1 - (row + 0.5) / rows;
    const uScale = padRadiusRatio / ATLAS_COLS;
    const vScale = padRadiusRatio / rows;

    const [nx, ny, nz] = face.normal;
    // Fan triangulation from vertex 0 of the face
    for (let i = 1; i < face.indices.length - 1; i++) {
      const tri = [0, i, i + 1];
      for (const corner of tri) {
        const vIdx = face.indices[corner];
        const [vx, vy, vz] = poly.vertices[vIdx];
        positions.push(vx * radius, vy * radius, vz * radius);
        normals.push(nx, ny, nz);

        const [lx, ly] = face.localPoints[corner];
        uvs.push(uCenter + lx * uScale, vCenter + ly * vScale);
      }
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();

  geometryCache.set(kind, geometry);
  return geometry;
}

/**
 * Returns (or builds) the shared material for a die variant (`d4`..`d20` or `d100` tens).
 * @param {'d4'|'d6'|'d8'|'d10'|'d12'|'d20'|'d100'} variant
 */
export function getDieMaterial(variant) {
  if (materialCache.has(variant)) return materialCache.get(variant);

  const kind = variant === 'd100' ? 'd10' : variant;
  const poly = getPolyhedron(kind);
  const { texture } = createAtlasTexture(variant, poly);

  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.35,
    metalness: 0.15,
    flatShading: true,
    transparent: true,
    opacity: 1,
  });

  materialCache.set(variant, material);
  return material;
}

/**
 * Creates a Three.js Mesh for a physical die. Clones only the lightweight material reference
 * when independent per-roll opacity fading is needed, while sharing the underlying GPU texture
 * and BufferGeometry.
 *
 * @param {'d4'|'d6'|'d8'|'d10'|'d12'|'d20'|'d100'} variant
 */
export function createDieMesh(variant) {
  const kind = variant === 'd100' ? 'd10' : variant;
  const geometry = getDieGeometry(kind);
  const baseMaterial = getDieMaterial(variant);
  const mesh = new THREE.Mesh(geometry, baseMaterial);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/**
 * Expands high-level die results (including `sides: 100`) into physical 3D dice descriptors
 * that `simulateThrow` and `DiceScene` can spawn.
 *
 * A `d100` expands into two physical `d10` meshes: a `d100` tens die (`00`..`90`) and a
 * `d10` units die (`0`..`9`), whose face indices (`1..10`) reconstruct the exact `1..100` roll.
 *
 * @param {import('../../../shared/dice/roller.js').DieResult[]} diceResults
 * @returns {{ kind: string, variant: string, targetValue: number, displayValue: string, kept: boolean, dieIndex: number }[]}
 */
export function expandPhysicalDice(diceResults) {
  const physical = [];

  diceResults.forEach((die, dieIndex) => {
    if (die.sides === 100) {
      // 100 -> tens=00 (face 10), units=0 (face 10).
      // 1..99 -> tens = floor(v / 10), units = v % 10 (where 0 -> face 10).
      const tensDigit = die.value === 100 ? 0 : Math.floor(die.value / 10);
      const unitsDigit = die.value === 100 ? 0 : die.value % 10;
      const tensFace = tensDigit === 0 ? 10 : tensDigit;
      const unitsFace = unitsDigit === 0 ? 10 : unitsDigit;

      physical.push({
        kind: 'd10',
        variant: 'd100',
        targetValue: tensFace,
        displayValue: tensDigit === 0 ? '00' : `${tensDigit * 10}`,
        kept: die.kept,
        dieIndex,
      });
      physical.push({
        kind: 'd10',
        variant: 'd10',
        targetValue: unitsFace,
        displayValue: `${unitsDigit}`,
        kept: die.kept,
        dieIndex,
      });
    } else {
      const kind = `d${die.sides}`;
      physical.push({
        kind,
        variant: kind,
        targetValue: die.value,
        displayValue: `${die.value}`,
        kept: die.kept,
        dieIndex,
      });
    }
  });

  return physical;
}
