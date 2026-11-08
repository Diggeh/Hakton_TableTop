import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  clampTokenPosition,
  clampTranslation,
  fitViewport,
  mapToScreen,
  screenToMap,
  snapPoint,
  snapToCell,
  visibleBounds,
  zoomAtPoint,
} from '../../src/canvas/viewport.js';

describe('viewport math', () => {
  it('clamps zoom scales to the supported range', () => {
    assert.equal(clampScale(0.001), MIN_SCALE);
    assert.equal(clampScale(99), MAX_SCALE);
    assert.equal(clampScale(1.5), 1.5);
    assert.equal(clampScale(Number.NaN), MIN_SCALE);
  });

  it('zooms around the pointer without moving the map point under it', () => {
    const viewport = { x: 40, y: -20, scale: 1 };
    const pointer = { x: 250, y: 180 };
    const before = screenToMap(viewport, pointer);
    const next = zoomAtPoint(viewport, pointer, 2);

    assert.equal(next.scale, 2);
    const after = screenToMap(next, pointer);
    assert.ok(Math.abs(before.x - after.x) < 1e-9);
    assert.ok(Math.abs(before.y - after.y) < 1e-9);
  });

  it('fits a map inside the viewport and centres it', () => {
    const viewport = fitViewport(1000, 500, 800, 600);
    assert.ok(viewport.scale > 0);
    assert.ok(1000 * viewport.scale <= 800);
    assert.ok(500 * viewport.scale <= 600);
    assert.ok(Math.abs(1000 * viewport.scale + viewport.x * 2 - 800) < 1e-9);
    assert.ok(Math.abs(500 * viewport.scale + viewport.y * 2 - 600) < 1e-9);
  });

  it('handles empty dimensions without producing NaN', () => {
    assert.deepEqual(fitViewport(0, 0, 800, 600), { x: 0, y: 0, scale: 1 });
  });

  it('keeps at least a margin of the map on screen', () => {
    const viewport = clampTranslation(
      { x: 1000, y: -5000, scale: 1 },
      800,
      600,
      1000,
      500,
      96,
    );
    assert.equal(viewport.x, 800 - 96);
    assert.equal(viewport.y, 96 - 500);
  });

  it('snaps to cell centres rather than grid intersections', () => {
    assert.equal(snapToCell(0, 70), 35);
    assert.equal(snapToCell(69, 70), 35);
    assert.equal(snapToCell(70, 70), 105);
    assert.equal(snapToCell(139, 70), 105);
    assert.equal(snapToCell(140, 70), 175);
    assert.deepEqual(snapPoint({ x: 74, y: 139 }, 70), { x: 105, y: 105 });
  });

  it('clamps token centres inside the playable map', () => {
    assert.deepEqual(clampTokenPosition({ x: -50, y: 5000 }, 700, 700, 70), {
      x: 35,
      y: 665,
    });
  });

  it('computes the visible map rectangle and inverse transforms', () => {
    const viewport = { x: -100, y: -50, scale: 2 };
    assert.deepEqual(visibleBounds(viewport, 800, 600), {
      x0: 50,
      y0: 25,
      x1: 450,
      y1: 325,
    });
    const screen = mapToScreen(viewport, { x: 50, y: 25 });
    assert.deepEqual(screen, { x: 0, y: 0 });
    assert.deepEqual(screenToMap(viewport, screen), { x: 50, y: 25 });
  });
});
