import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TILE_WIDTH,
  MAX_TILE_WIDTH,
  MIN_TILE_WIDTH,
  clampStripPosition,
  computePopoutGridCols,
  loadVideoStripLayout,
  nextLayoutMode,
  normalizeVideoStripLayout,
  saveVideoStripLayout,
  tileHeightForWidth,
} from '../../src/ui/videoLayout.js';
import { createVoiceStore } from '../../src/store/voiceStore.js';

describe('VideoCallStrip layout & pop-out helpers (src/ui/videoLayout.js)', () => {
  it('normalizes tile sizes, layout modes, and paired coordinates cleanly', () => {
    const defaults = normalizeVideoStripLayout({});
    assert.deepEqual(defaults, {
      tileWidth: DEFAULT_TILE_WIDTH,
      layoutMode: 'row',
      x: null,
      y: null,
    });

    const clampedLow = normalizeVideoStripLayout({
      tileWidth: 20,
      layoutMode: 'grid',
      x: 42.6,
      y: null,
    });
    assert.deepEqual(clampedLow, {
      tileWidth: MIN_TILE_WIDTH,
      layoutMode: 'grid',
      x: null,
      y: null,
    });

    const clampedHigh = normalizeVideoStripLayout({
      tileWidth: 900,
      layoutMode: 'column',
      x: 120.4,
      y: 80.7,
    });
    assert.deepEqual(clampedHigh, {
      tileWidth: MAX_TILE_WIDTH,
      layoutMode: 'column',
      x: 120,
      y: 81,
    });

    assert.equal(tileHeightForWidth(200), 128);
  });

  it('clamps docked strip coordinates inside the board viewport bounds', () => {
    assert.deepEqual(
      clampStripPosition({
        x: -40,
        y: 900,
        panelWidth: 220,
        panelHeight: 160,
        containerWidth: 1000,
        containerHeight: 700,
      }),
      { x: 12, y: 528 },
    );

    assert.deepEqual(
      clampStripPosition({
        x: 950,
        y: 50,
        panelWidth: 220,
        panelHeight: 160,
        containerWidth: 1000,
        containerHeight: 700,
      }),
      { x: 768, y: 50 },
    );
  });

  it('computes Discord-style responsive grid column counts and cycles layout modes', () => {
    assert.equal(computePopoutGridCols(1, 600, 400), 1);
    assert.equal(computePopoutGridCols(2, 600, 400), 2);
    assert.equal(computePopoutGridCols(2, 300, 500), 1);
    assert.equal(computePopoutGridCols(4, 600, 400), 2);
    assert.equal(computePopoutGridCols(6, 700, 400), 3);
    assert.equal(computePopoutGridCols(8, 800, 450), 4);

    assert.equal(nextLayoutMode('row'), 'column');
    assert.equal(nextLayoutMode('column'), 'grid');
    assert.equal(nextLayoutMode('grid'), 'row');
  });

  it('is headless-safe when localStorage is absent in Node tests', () => {
    assert.deepEqual(loadVideoStripLayout(), {
      tileWidth: DEFAULT_TILE_WIDTH,
      layoutMode: 'row',
      x: null,
      y: null,
    });
    const saved = saveVideoStripLayout({ tileWidth: 220, layoutMode: 'grid' });
    assert.equal(saved.tileWidth, 220);
    assert.equal(saved.layoutMode, 'grid');
  });

  it('tracks popoutOpen state in voiceStore and resets it when leaving a call', () => {
    const store = createVoiceStore({ audioInputId: '', videoInputId: '' });
    assert.equal(store.getState().popoutOpen, false);
    store.getState().setPopoutOpen(true);
    assert.equal(store.getState().popoutOpen, true);
    store.getState().resetMesh();
    assert.equal(store.getState().popoutOpen, false);
  });
});
