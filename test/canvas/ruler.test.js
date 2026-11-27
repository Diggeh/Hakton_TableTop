import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RULER_MODES,
  measurePolylineDistance,
  sanitizeRulerPayload,
} from '../../shared/ruler.js';

describe('Owlbear-style ruler distance modes & payload sanitization', () => {
  it('computes 5e Chebyshev, alternating 5/10/5/10, Euclidean, and Manhattan distances across waypoints', () => {
    const grid = 64;
    // 2 diagonal cells (128, 128) -> 2 squares diag in 5e = 10 ft, alternating 5+10 = 15 ft
    const diag = [
      { x: 0, y: 0 },
      { x: grid * 2, y: grid * 2 },
    ];
    assert.equal(
      measurePolylineDistance(diag, grid, { mode: RULER_MODES.CHEBYSHEV }).totalFeet,
      10,
    );
    assert.equal(
      measurePolylineDistance(diag, grid, { mode: RULER_MODES.ALTERNATING }).totalFeet,
      15,
    );
    assert.equal(
      measurePolylineDistance(diag, grid, { mode: RULER_MODES.MANHATTAN }).totalFeet,
      20,
    );
    assert.equal(
      Math.round(
        measurePolylineDistance(diag, grid, { mode: RULER_MODES.EUCLIDEAN }).totalFeet,
      ),
      14,
    );

    // Multi-waypoint alternating carry: two separate 1-diagonal segments = 5 + 10 = 15 ft
    const multiWaypoint = [
      { x: 0, y: 0 },
      { x: grid, y: grid },
      { x: grid * 2, y: grid * 2 },
    ];
    const altResult = measurePolylineDistance(multiWaypoint, grid, {
      mode: RULER_MODES.ALTERNATING,
    });
    assert.equal(altResult.totalFeet, 15);
    assert.equal(altResult.segments.length, 2);
  });

  it('sanitizes ruler payloads and rejects invalid or single-point lines', () => {
    assert.equal(sanitizeRulerPayload({ points: [{ x: 0, y: 0 }] }), null);
    const clean = sanitizeRulerPayload({
      points: [
        { x: 10.44, y: 20.66 },
        { x: 74, y: 84 },
      ],
      mode: 'invalid-mode',
      feetPerCell: 5,
      color: '#adfcf9',
      shared: false,
    });
    assert.equal(clean.points.length, 2);
    assert.deepEqual(clean.points[0], { x: 10.4, y: 20.7 });
    assert.equal(clean.mode, RULER_MODES.CHEBYSHEV);
    assert.equal(clean.feetPerCell, 5);
    assert.equal(clean.color, '#adfcf9');
    assert.equal(clean.shared, false);
  });
});
