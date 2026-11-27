import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_EFFECT_SECONDS,
  changeSoundboard,
  currentSoundboard,
  findSoundCue,
  initialSoundboard,
  isValidCueIcon,
} from '../../shared/soundboard.js';

describe('Pocket Bard dual-layer soundboard state', () => {
  it('layers one Music loop and one Ambience loop simultaneously with independent pause, loop, and stop', () => {
    const now = 1000;
    const wind = findSoundCue('coastal-wind');
    const drums = findSoundCue('battle-drums');

    let state = changeSoundboard(initialSoundboard, { action: 'play', layer: 'ambience' }, wind, now, 0);
    assert.equal(state.ambience.cueId, 'coastal-wind');
    assert.equal(state.music, null);
    assert.equal(state.track.cueId, 'coastal-wind');

    // Starting a Music track leaves Ambience playing simultaneously
    state = changeSoundboard(state, { action: 'play', layer: 'music' }, drums, now + 500, 0);
    assert.equal(state.ambience.cueId, 'coastal-wind');
    assert.equal(state.ambience.playing, true);
    assert.equal(state.music.cueId, 'battle-drums');
    assert.equal(state.music.playing, true);

    // Pausing only Music keeps Ambience playing
    state = changeSoundboard(state, { action: 'pause', layer: 'music' }, undefined, now + 1000, 0);
    assert.equal(state.music.playing, false);
    assert.equal(state.ambience.playing, true);

    // Stopping only Music clears Music and promotes Ambience to primary track
    state = changeSoundboard(state, { action: 'stop', layer: 'music' }, undefined, now + 1200, 0);
    assert.equal(state.music, null);
    assert.equal(state.ambience.cueId, 'coastal-wind');
    assert.equal(state.track.cueId, 'coastal-wind');
  });

  it('expires finished non-looping layers cleanly while preserving the other active layer', () => {
    const now = 2000;
    const lute = findSoundCue('hearthfire');
    const sanctuary = findSoundCue('sanctuary');

    let state = changeSoundboard(initialSoundboard, { action: 'play', layer: 'music' }, lute, now, 0);
    state = changeSoundboard(state, { action: 'play', layer: 'ambience' }, sanctuary, now, 0);
    state = changeSoundboard(
      state,
      { action: 'loop', layer: 'music', value: false },
      undefined,
      now + 1000,
      0,
    );

    const afterEnd = currentSoundboard(state, now + lute.seconds * 1000 + 50);
    assert.equal(afterEnd.music, null);
    assert.equal(afterEnd.ambience.cueId, 'sanctuary');
    assert.equal(afterEnd.track.cueId, 'sanctuary');
  });

  it('validates preset soundboard icon keys and raster custom image data URLs while rejecting unsafe inputs', () => {
    assert.equal(isValidCueIcon(null), true);
    assert.equal(isValidCueIcon('sword'), true);
    assert.equal(isValidCueIcon('forest'), true);
    assert.equal(isValidCueIcon('data:image/png;base64,iVBORw0KGgo='), true);
    assert.equal(isValidCueIcon('data:image/webp;base64,UklGRhYAAABXRUJQ'), true);

    assert.equal(isValidCueIcon('unknown-icon'), false);
    assert.equal(isValidCueIcon('data:image/svg+xml;base64,PHN2Zz4='), false);
    assert.equal(isValidCueIcon('javascript:alert(1)'), false);
    assert.equal(isValidCueIcon('data:image/png;base64,' + 'A'.repeat(70000)), false);
  });

  it('tracks independent music, ambience, and master volumes and enforces 15s max SFX duration', () => {
    assert.equal(MAX_EFFECT_SECONDS, 15);
    assert.equal(initialSoundboard.volume, 100);
    assert.equal(initialSoundboard.musicVolume, 100);
    assert.equal(initialSoundboard.ambienceVolume, 100);

    let state = changeSoundboard(
      initialSoundboard,
      { action: 'volume', layer: 'music', value: 42 },
      undefined,
      1000,
      0,
    );
    assert.equal(state.musicVolume, 42);
    assert.equal(state.ambienceVolume, 100);
    assert.equal(state.volume, 100);

    state = changeSoundboard(
      state,
      { action: 'volume', layer: 'ambience', value: 73 },
      undefined,
      1001,
      0,
    );
    assert.equal(state.musicVolume, 42);
    assert.equal(state.ambienceVolume, 73);
    assert.equal(state.volume, 100);

    state = changeSoundboard(
      state,
      { action: 'volume', value: 80 },
      undefined,
      1002,
      0,
    );
    assert.equal(state.volume, 80);
    assert.equal(state.musicVolume, 42);
    assert.equal(state.ambienceVolume, 73);
  });
});
