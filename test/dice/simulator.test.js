import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DIE_KINDS, getPolyhedron } from '../../src/dice/geometry/polyhedra.js';
import { quatRotate } from '../../src/dice/math.js';
import { DIE_RADIUS, FLOATS_PER_DIE, PHYSICS, simulateThrow } from '../../src/dice/physics/DiceSimulator.js';

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HALF_WIDTH = 11;
const HALF_HEIGHT = 7;

function finalQuaternion(sim, i) {
  const o = (sim.frameCount - 1) * sim.dieCount * FLOATS_PER_DIE + i * FLOATS_PER_DIE;
  return { p: [...sim.frames.slice(o, o + 3)], q: [...sim.frames.slice(o + 3, o + 7)] };
}

describe('dice physics pre-simulation', () => {
  for (const kind of DIE_KINDS) {
    it(`${kind}: the rolled number ends up facing the camera for every target value`, () => {
      const poly = getPolyhedron(kind);
      const random = mulberry32(1234 + kind.length);
      let unsettled = 0;
      let cocked = 0;
      let throws = 0;

      for (let value = 1; value <= poly.valueCount; value++) {
        for (let rep = 0; rep < 3; rep++) {
          const sim = simulateThrow({
            dice: [{ kind, targetValue: value }],
            halfWidth: HALF_WIDTH,
            halfHeight: HALF_HEIGHT,
            random,
          });
          throws++;
          if (!sim.settled) unsettled++;

          const { q } = finalQuaternion(sim, 0);
          const facing = quatRotate(q, poly.resultDirs[value])[2];
          assert.ok(facing > 0.85, `${kind} target ${value}: facing ${facing.toFixed(3)} is not toward the camera`);
          if (facing < PHYSICS.minAlignment) cocked++;

          // And it is the *only* value facing the camera (no other face is closer to +Z).
          for (let other = 1; other <= poly.valueCount; other++) {
            if (other === value) continue;
            assert.ok(quatRotate(q, poly.resultDirs[other])[2] <= facing + 1e-6);
          }
        }
      }
      assert.ok(unsettled / throws < 0.05, `${kind}: ${unsettled}/${throws} throws never settled`);
      assert.ok(cocked / throws < 0.1, `${kind}: ${cocked}/${throws} dice finished cocked`);
    });
  }

  it('settles within the allotted time and stays inside the window and above the floor', () => {
    const random = mulberry32(99);
    for (let rep = 0; rep < 10; rep++) {
      const dice = DIE_KINDS.map((kind) => ({ kind, targetValue: 1 }));
      const sim = simulateThrow({ dice, halfWidth: HALF_WIDTH, halfHeight: HALF_HEIGHT, random });
      assert.ok(sim.frameCount <= PHYSICS.maxSteps + 1);
      for (let f = 0; f < sim.frameCount; f++) {
        for (let i = 0; i < dice.length; i++) {
          const o = f * dice.length * FLOATS_PER_DIE + i * FLOATS_PER_DIE;
          const [x, y, z] = [sim.frames[o], sim.frames[o + 1], sim.frames[o + 2]];
          assert.ok(Math.abs(x) <= HALF_WIDTH + 0.2, `x ${x} escaped`);
          assert.ok(Math.abs(y) <= HALF_HEIGHT + 0.2, `y ${y} escaped`);
          assert.ok(z > -0.05, `z ${z} sank through the floor`);
          assert.ok(z <= PHYSICS.ceilingZ + 0.5, `z ${z} left through the ceiling`);
        }
      }
      // On the final frame every settled die rests at or above its polyhedron inradius.
      for (let i = 0; i < dice.length; i++) {
        const { p } = finalQuaternion(sim, i);
        const poly = getPolyhedron(dice[i].kind);
        const inradius = Math.min(...poly.faces.map((face) => face.normal.reduce((s, n, k) => s + n * face.centroid[k], 0)));
        assert.ok(p[2] >= inradius * DIE_RADIUS[dice[i].kind] - 0.06, `final z ${p[2]} below resting height`);
      }
    }
  });

  it('handles a large handful of mixed dice quickly and keeps every outcome aligned', () => {
    const random = mulberry32(2024);
    const dice = Array.from({ length: 24 }, (_, i) => {
      const kind = DIE_KINDS[i % DIE_KINDS.length];
      const poly = getPolyhedron(kind);
      return { kind, targetValue: 1 + Math.floor(random() * poly.valueCount) };
    });
    const started = performance.now();
    const sim = simulateThrow({ dice, halfWidth: HALF_WIDTH, halfHeight: HALF_HEIGHT, random });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 4000, `simulation took ${elapsed.toFixed(0)}ms`);
    dice.forEach((d, i) => {
      const { q } = finalQuaternion(sim, i);
      const poly = getPolyhedron(d.kind);
      const facing = quatRotate(q, poly.resultDirs[d.targetValue])[2];
      // Dice can legitimately rest on one another in a pile, so only require "upward-ish".
      assert.ok(facing > 0.5, `die ${i} (${d.kind} -> ${d.targetValue}) facing ${facing.toFixed(2)}`);
    });
  });
});
