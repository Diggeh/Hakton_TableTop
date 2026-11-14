import * as CANNON from 'cannon-es';
import { getPolyhedron, symmetryRotation, topValue } from '../geometry/polyhedra.js';
import { quatMultiply, randomQuaternion } from '../math.js';

/**
 * Headless cannon-es pre-simulation of a dice throw.
 *
 * The whole throw is simulated up front (a few ms) and recorded frame by frame; the Three.js
 * stage then just replays the recording. That keeps the animation identical to the physics
 * result regardless of display refresh rate or dropped frames, and lets us guarantee the
 * pre-determined outcome (see `symmetryRotation`).
 *
 * Coordinate frame: the floor is z = 0 with the camera above looking down -Z.
 * +X is screen right and +Y is screen up. Units are arbitrary "world units".
 */

export const PHYSICS = Object.freeze({
  fixedStep: 1 / 60,
  gravity: -90,
  maxSteps: 60 * 7,
  /** Shortest recording so a throw never ends before it visibly starts. */
  minSteps: 30,
  ceilingZ: 14,
  /** Wall inset (world units) so dice never clip the very edge of the window. */
  wallInset: 0.15,
  die: { friction: 0.28, restitution: 0.42 },
  dieDie: { friction: 0.25, restitution: 0.38 },
  linearDamping: 0.14,
  angularDamping: 0.2,
  sleepSpeedLimit: 0.8,
  sleepTimeLimit: 0.3,
  /** Reject throws where a die is cocked on an edge or leaning (alignment below this). */
  minAlignment: 0.97,
  maxAttempts: 6,
});

/** Circumradius in world units per shape. d6 uses a cube with this circumradius. */
export const DIE_RADIUS = Object.freeze({
  d4: 0.78,
  d6: 0.66,
  d8: 0.72,
  d10: 0.74,
  d12: 0.78,
  d20: 0.84,
});

export const FLOATS_PER_DIE = 7; // px, py, pz, qx, qy, qz, qw

const hullCache = new Map();

function buildShape(kind) {
  const radius = DIE_RADIUS[kind];
  if (kind === 'd6') {
    const half = radius / Math.sqrt(3);
    return new CANNON.Box(new CANNON.Vec3(half, half, half));
  }
  if (!hullCache.has(kind)) {
    const poly = getPolyhedron(kind);
    hullCache.set(kind, {
      vertices: poly.vertices.map((v) => [v[0] * radius, v[1] * radius, v[2] * radius]),
      faces: poly.faces.map((f) => f.indices),
    });
  }
  const { vertices, faces } = hullCache.get(kind);
  return new CANNON.ConvexPolyhedron({
    vertices: vertices.map((v) => new CANNON.Vec3(...v)),
    faces: faces.map((f) => [...f]),
  });
}

function addBounds(world, wallMaterial, halfWidth, halfHeight) {
  const planes = [
    { axis: [0, 0, 1], angle: 0, position: [0, 0, 0] }, // floor, normal +Z
    { axis: [0, 1, 0], angle: Math.PI / 2, position: [-halfWidth, 0, 0] }, // left wall, normal +X
    { axis: [0, 1, 0], angle: -Math.PI / 2, position: [halfWidth, 0, 0] }, // right wall, normal -X
    { axis: [1, 0, 0], angle: -Math.PI / 2, position: [0, -halfHeight, 0] }, // bottom wall, normal +Y
    { axis: [1, 0, 0], angle: Math.PI / 2, position: [0, halfHeight, 0] }, // top wall, normal -Y
    { axis: [1, 0, 0], angle: Math.PI, position: [0, 0, PHYSICS.ceilingZ] }, // ceiling, normal -Z
  ];
  for (const { axis, angle, position } of planes) {
    const body = new CANNON.Body({ mass: 0, material: wallMaterial, shape: new CANNON.Plane() });
    body.quaternion.setFromAxisAngle(new CANNON.Vec3(...axis), angle);
    body.position.set(...position);
    world.addBody(body);
  }
}

/**
 * Spawns the dice on one side of the window and throws them across it.
 * Dice are staggered in a loose grid perpendicular to the throw so none start overlapping.
 */
function launchDice(bodies, descriptors, { halfWidth, halfHeight, random }) {
  const angle = random() * Math.PI * 2;
  const dir = [Math.cos(angle), Math.sin(angle)];
  const side = [-dir[1], dir[0]];
  const spacing = 1.9;
  const perRow = Math.max(1, Math.min(6, Math.floor((2 * Math.min(halfWidth, halfHeight)) / spacing)));
  const reach = 0.78; // how far toward the edge the throw starts

  bodies.forEach((body, i) => {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, descriptors.length - row * perRow);
    const col = i % perRow;
    const lateral = (col - (inRow - 1) / 2) * spacing + (random() - 0.5) * 0.5;
    const back = row * spacing + (random() - 0.5) * 0.5;

    let px = -dir[0] * halfWidth * reach + side[0] * lateral - dir[0] * back;
    let py = -dir[1] * halfHeight * reach + side[1] * lateral - dir[1] * back;
    const margin = DIE_RADIUS[descriptors[i].kind] + 0.4;
    px = Math.max(-halfWidth + margin, Math.min(halfWidth - margin, px));
    py = Math.max(-halfHeight + margin, Math.min(halfHeight - margin, py));

    body.position.set(px, py, 3.2 + random() * 3);
    const q = randomQuaternion(random);
    body.quaternion.set(q[0], q[1], q[2], q[3]);

    const speed = 24 + random() * 20;
    const aim = (random() - 0.5) * 0.55;
    const cos = Math.cos(aim);
    const sin = Math.sin(aim);
    body.velocity.set(
      (dir[0] * cos - dir[1] * sin) * speed,
      (dir[0] * sin + dir[1] * cos) * speed,
      -2 - random() * 6,
    );
    body.angularVelocity.set(
      (random() - 0.5) * 36,
      (random() - 0.5) * 36,
      (random() - 0.5) * 36,
    );
  });
}

/** One full throw. Returns raw recorded frames plus the face each die really landed on. */
function runThrow(descriptors, bounds, random) {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, 0, PHYSICS.gravity) });
  world.allowSleep = true;
  world.solver.iterations = 14;

  const dieMaterial = new CANNON.Material('die');
  const wallMaterial = new CANNON.Material('tray');
  world.addContactMaterial(new CANNON.ContactMaterial(dieMaterial, wallMaterial, PHYSICS.die));
  world.addContactMaterial(new CANNON.ContactMaterial(dieMaterial, dieMaterial, PHYSICS.dieDie));

  addBounds(world, wallMaterial, bounds.halfWidth - PHYSICS.wallInset, bounds.halfHeight - PHYSICS.wallInset);

  const bodies = descriptors.map((d) => {
    const body = new CANNON.Body({
      mass: 1,
      material: dieMaterial,
      shape: buildShape(d.kind),
      linearDamping: PHYSICS.linearDamping,
      angularDamping: PHYSICS.angularDamping,
      allowSleep: true,
      sleepSpeedLimit: PHYSICS.sleepSpeedLimit,
      sleepTimeLimit: PHYSICS.sleepTimeLimit,
    });
    world.addBody(body);
    return body;
  });

  launchDice(bodies, descriptors, { ...bounds, random });

  const stride = bodies.length * FLOATS_PER_DIE;
  const frames = new Float32Array((PHYSICS.maxSteps + 1) * stride);
  let frameCount = 0;
  const record = () => {
    let o = frameCount * stride;
    for (const b of bodies) {
      frames[o++] = Math.max(-bounds.halfWidth, Math.min(bounds.halfWidth, b.position.x));
      frames[o++] = Math.max(-bounds.halfHeight, Math.min(bounds.halfHeight, b.position.y));
      frames[o++] = Math.max(0.18, Math.min(PHYSICS.ceilingZ, b.position.z));
      frames[o++] = b.quaternion.x;
      frames[o++] = b.quaternion.y;
      frames[o++] = b.quaternion.z;
      frames[o++] = b.quaternion.w;
    }
    frameCount++;
  };

  record();
  let settled = false;
  for (let step = 1; step <= PHYSICS.maxSteps; step++) {
    world.step(PHYSICS.fixedStep);
    record();
    if (step >= PHYSICS.minSteps && bodies.every((b) => b.sleepState === CANNON.Body.SLEEPING)) {
      settled = true;
      break;
    }
  }

  const landed = bodies.map((b, i) => {
    const q = [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w];
    return { ...topValue(descriptors[i].kind, q), body: b };
  });
  const minAlignment = Math.min(...landed.map((l) => l.alignment));
  return { frames, frameCount, stride, settled, landed, minAlignment };
}

/**
 * Pre-simulates a throw and bakes the pre-determined outcome into the recording.
 *
 * @param {{
 *   dice: { kind: string, targetValue: number }[],
 *   halfWidth: number,
 *   halfHeight: number,
 *   random?: () => number,
 * }} input
 * @returns {{
 *   frames: Float32Array,
 *   frameCount: number,
 *   dieCount: number,
 *   stepDt: number,
 *   settled: boolean,
 *   attempts: number,
 *   minAlignment: number,
 *   dice: { kind: string, targetValue: number, landedValue: number, alignment: number }[],
 * }}
 */
export function simulateThrow({ dice, halfWidth, halfHeight, random = Math.random }) {
  if (!dice.length) throw new Error('simulateThrow needs at least one die.');
  const bounds = { halfWidth, halfHeight };

  let best = null;
  let attempts = 0;
  for (; attempts < PHYSICS.maxAttempts; ) {
    attempts++;
    const run = runThrow(dice, bounds, random);
    const score = (run.settled ? 10 : 0) + run.minAlignment;
    if (!best || score > best.score) best = { run, score };
    if (run.settled && run.minAlignment >= PHYSICS.minAlignment) break;
  }
  const { run } = best;

  // Turn each mesh by the exact symmetry that puts its rolled number where the physics
  // left the top face. The collision hull is untouched, so the recording stays physical.
  const offsets = dice.map((d, i) => symmetryRotation(d.kind, d.targetValue, run.landed[i].value));
  const { frames, frameCount, stride } = run;
  for (let f = 0; f < frameCount; f++) {
    for (let i = 0; i < dice.length; i++) {
      const o = f * stride + i * FLOATS_PER_DIE + 3;
      const q = quatMultiply([frames[o], frames[o + 1], frames[o + 2], frames[o + 3]], offsets[i]);
      frames[o] = q[0];
      frames[o + 1] = q[1];
      frames[o + 2] = q[2];
      frames[o + 3] = q[3];
    }
  }

  return {
    frames: frames.slice(0, frameCount * stride),
    frameCount,
    dieCount: dice.length,
    stepDt: PHYSICS.fixedStep,
    settled: run.settled,
    attempts,
    minAlignment: run.minAlignment,
    dice: dice.map((d, i) => ({
      kind: d.kind,
      targetValue: d.targetValue,
      landedValue: run.landed[i].value,
      alignment: run.landed[i].alignment,
    })),
  };
}
