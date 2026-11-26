import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isPointInPolygon, selectTokensInLasso } from '../../src/canvas/lasso.js';

describe('lasso multi-select geometry', () => {
  it('detects points strictly inside vs outside a polygon', () => {
    const square = [0, 0, 100, 0, 100, 100, 0, 100];
    assert.equal(isPointInPolygon({ x: 50, y: 50 }, square), true);
    assert.equal(isPointInPolygon({ x: 150, y: 50 }, square), false);
    assert.equal(isPointInPolygon({ x: -10, y: 50 }, square), false);
  });

  it('selects enclosed tokens while excluding background maps and respecting filterFn', () => {
    const lassoPoly = [20, 20, 180, 20, 180, 180, 20, 180];
    const tokens = [
      { id: 'bg-map', isMap: true, x: 100, y: 100, ownerId: 'dm-1' },
      { id: 'hero-1', isMap: false, x: 80, y: 90, ownerId: 'p1', locked: false },
      { id: 'hero-2', isMap: false, x: 120, y: 140, ownerId: 'p2', locked: false },
      { id: 'far-away', isMap: false, x: 350, y: 350, ownerId: 'p1', locked: false },
    ];

    const dmSelection = selectTokensInLasso(tokens, lassoPoly);
    assert.deepEqual(dmSelection, ['hero-1', 'hero-2']);

    const playerSelection = selectTokensInLasso(tokens, lassoPoly, {
      filterFn: (t) => !t.locked && t.ownerId === 'p1',
    });
    assert.deepEqual(playerSelection, ['hero-1']);
  });
});
