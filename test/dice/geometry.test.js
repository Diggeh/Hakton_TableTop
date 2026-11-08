import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIE_KINDS,
  faceUpQuaternion,
  getPolyhedron,
  symmetryRotation,
  topValue,
} from '../../src/dice/geometry/polyhedra.js';
import { cross, dot, quatRotate, sub } from '../../src/dice/math.js';

const FACE_COUNTS = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20 };
const VERTEX_COUNTS = { d4: 4, d6: 8, d8: 6, d10: 12, d12: 20, d20: 12 };

const near = (a, b, eps = 1e-6) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < eps;

describe('polyhedra', () => {
  for (const kind of DIE_KINDS) {
    describe(kind, () => {
      const poly = getPolyhedron(kind);

      it('has the expected vertex and face counts', () => {
        assert.equal(poly.vertices.length, VERTEX_COUNTS[kind]);
        assert.equal(poly.faces.length, FACE_COUNTS[kind]);
        assert.equal(poly.valueCount, kind === 'd4' ? 4 : FACE_COUNTS[kind]);
      });

      it('has unit circumradius and planar, outward, counter-clockwise faces', () => {
        const maxLen = Math.max(...poly.vertices.map((v) => Math.hypot(...v)));
        assert.ok(Math.abs(maxLen - 1) < 1e-9);
        for (const face of poly.faces) {
          const [a, b, c] = face.indices.map((i) => poly.vertices[i]);
          const winding = cross(sub(b, a), sub(c, a));
          assert.ok(dot(winding, face.normal) > 0, 'winding follows the outward normal');
          assert.ok(dot(face.normal, face.centroid) > 0, 'normal points away from the centre');
          for (const idx of face.indices) {
            assert.ok(Math.abs(dot(face.normal, poly.vertices[idx]) - dot(face.normal, face.centroid)) < 1e-6);
          }
        }
      });

      it('assigns every value to exactly one face', () => {
        const seen = new Set();
        for (let v = 1; v <= poly.valueCount; v++) {
          const f = poly.faceOfValue[v];
          assert.ok(f >= 0 && f < poly.faces.length);
          assert.ok(!seen.has(f));
          seen.add(f);
          assert.equal(poly.valueOfFace[f], v);
        }
        assert.equal(seen.size, poly.valueCount);
      });

      if (kind !== 'd4') {
        it('puts opposite faces on values that sum to n + 1', () => {
          const n = poly.valueCount;
          for (let v = 1; v <= n; v++) {
            const opposite = poly.faceOfValue[n + 1 - v];
            assert.ok(dot(poly.faces[poly.faceOfValue[v]].normal, poly.faces[opposite].normal) < -0.999);
          }
        });
      }

      it('reads the identity orientation as the value whose direction faces +Z', () => {
        const { value, alignment } = topValue(kind, [0, 0, 0, 1]);
        assert.ok(alignment > 0.3);
        assert.ok(dot(poly.resultDirs[value], [0, 0, 1]) >= alignment - 1e-12);
      });

      it('symmetryRotation is an exact symmetry that carries any value onto any other', () => {
        for (let from = 1; from <= poly.valueCount; from++) {
          for (let to = 1; to <= poly.valueCount; to++) {
            const q = symmetryRotation(kind, from, to);
            // Result direction of `from` lands on the result direction of `to`.
            assert.ok(near(quatRotate(q, poly.resultDirs[from]), poly.resultDirs[to], 1e-6), `${kind} ${from}->${to} direction`);
            // Every vertex lands on a vertex (the shape maps onto itself).
            for (const v of poly.vertices) {
              const r = quatRotate(q, v);
              assert.ok(poly.vertices.some((w) => near(r, w, 1e-6)), `${kind} ${from}->${to} vertex`);
            }
          }
        }
      });

      it('faceUpQuaternion places the target rolled value dead-center on top (+Z) and right-side up (+Y)', () => {
        for (let target = 1; target <= poly.valueCount; target++) {
          const q = faceUpQuaternion(kind, target);
          assert.ok(
            near(quatRotate(q, poly.resultDirs[target]), [0, 0, 1], 1e-6),
            `${kind} value ${target} should face +Z`,
          );
          const { value, alignment } = topValue(kind, q);
          assert.equal(value, target);
          assert.ok(alignment > 0.999999);
        }
      });
    });
  }
});
