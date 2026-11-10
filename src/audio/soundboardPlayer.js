import { findSoundCue, trackPosition } from '../../shared/soundboard.js';

const SAMPLE_RATE = 22050;
const wave = (hz, t) => Math.sin(2 * Math.PI * hz * t);
const beat = (t, interval) => t % interval;

function renderCue(cue, samples) {
  let seed = 2039;
  let slowNoise = 0;
  let fastNoise = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = i / SAMPLE_RATE;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = seed / 2147483648 - 1;
    slowNoise += 0.018 * (noise - slowNoise);
    fastNoise += 0.075 * (noise - fastNoise);
    const edge = Math.min(1, t / 0.06, (cue.seconds - t) / 0.06);
    let sample;
    switch (cue.id) {
      case 'coastal-wind':
        sample =
          (slowNoise * 2 + fastNoise * 0.25) *
          (0.32 + 0.12 * wave(1 / 6, t) + 0.08 * wave(1 / 4, t));
        break;
      case 'sanctuary':
        sample =
          (0.12 * wave(110, t) +
            0.09 * wave(164.833333, t) +
            0.05 * wave(220, t) +
            0.035 * wave(261.666667, t)) *
          (0.6 + 0.32 * wave(1 / 6, t) + 0.08 * wave(1 / 4, t));
        break;
      case 'battle-drums': {
        const kick = beat(t, 1);
        const tom = beat(t + 0.25, 0.5);
        sample =
          0.42 *
            wave(50, kick + 0.02 * (1 - Math.exp(-26 * kick))) *
            Math.exp(-12 * kick) +
          0.22 * (wave(95, tom) + fastNoise * 1.4) * Math.exp(-24 * tom) +
          0.045 * wave(55, t);
        break;
      }
      case 'bell':
        sample =
          0.32 * wave(440, t) * Math.exp(-1.8 * t) +
          0.16 * wave(1047, t) * Math.exp(-3.4 * t) +
          0.08 * wave(1590, t) * Math.exp(-5 * t);
        break;
      case 'thunder':
        sample =
          (slowNoise * 2.4 + 0.24 * wave(39, t)) *
          (Math.exp(-1.15 * t) + 0.42 * Math.exp(-5 * (t - 0.7) ** 2));
        break;
    }
    samples[i] = edge * sample;
  }
}

function wavUrl(samples) {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  function text(offset, value) {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  }
  text(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(
      44 + i * 2,
      Math.max(-1, Math.min(1, samples[i])) * 32767,
      true,
    );
  }
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

function resetAudio(audio) {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
}

export function createSoundboardPlayer({ onError, onStarted }) {
  const urls = new Map();
  const effects = new Set();
  let background = null;
  let volume = 0.6;

  function sourceUrl(id, resolveCustom) {
    const cue = findSoundCue(id);
    if (!cue) return resolveCustom(id);
    if (!urls.has(id)) {
      const samples = new Float32Array(cue.seconds * SAMPLE_RATE);
      renderCue(cue, samples);
      urls.set(id, wavUrl(samples));
    }
    return urls.get(id);
  }

  function cancel(entry) {
    entry.schedule?.abort();
    resetAudio(entry.audio);
  }

  function stopTrack() {
    if (background) cancel(background);
    background = null;
  }

  function schedule(entry, track, clock, onEnd) {
    entry.schedule?.abort();
    const controller = new AbortController();
    entry.schedule = controller;
    const { signal } = controller;
    const { audio } = entry;
    let timer;
    let alignOnPlay = true;
    const fail = (error) => {
      if (!signal.aborted) {
        onError(error);
        onEnd?.();
      }
    };
    audio.loop = track.loop;
    audio.addEventListener(
      'error',
      () => fail(new Error('Audio could not be loaded.')),
      { signal },
    );
    audio.addEventListener('ended', () => onEnd?.(), { signal });
    if (!track.playing) {
      audio.pause();
      return;
    }
    function position() {
      const offset = trackPosition(track, clock()) / 1000;
      return track.loop && audio.duration > 0
        ? offset % audio.duration
        : offset;
    }
    function start() {
      if (signal.aborted) return;
      const delay = track.startsAt - clock();
      if (delay > 10) {
        timer = setTimeout(start, delay);
        return;
      }
      const offset = position();
      if (
        !track.loop &&
        offset >= Math.min(audio.duration, track.durationMs / 1000)
      ) {
        onEnd?.();
        return;
      }
      if (Math.abs(audio.currentTime - offset) > 0.04)
        audio.currentTime = offset;
      void audio.play().then(() => {
        if (!signal.aborted) onStarted();
      }, fail);
    }
    audio.addEventListener(
      'waiting',
      () => {
        alignOnPlay = true;
      },
      { signal },
    );
    audio.addEventListener(
      'playing',
      () => {
        if (!alignOnPlay) return;
        alignOnPlay = false;
        const offset = position();
        if (
          offset < audio.duration &&
          Math.abs(audio.currentTime - offset) > 0.25
        )
          audio.currentTime = offset;
      },
      { signal },
    );
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    if (audio.readyState >= 1) start();
    else
      audio.addEventListener('loadedmetadata', start, { once: true, signal });
  }

  function makeEntry(url) {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.volume = volume;
    audio.src = url;
    return { audio, url };
  }

  function endEffect(entry) {
    if (effects.delete(entry)) cancel(entry);
  }

  return {
    async enable() {
      const url = wavUrl(new Float32Array(2205));
      const audio = new Audio(url);
      try {
        await audio.play();
      } finally {
        resetAudio(audio);
        URL.revokeObjectURL(url);
      }
    },
    setTrack(track, clock, resolveCustom) {
      if (!track) return stopTrack();
      const url = sourceUrl(track.cueId, resolveCustom);
      if (!url) return stopTrack();
      if (background?.url !== url) {
        stopTrack();
        background = makeEntry(url);
      }
      schedule(background, track, clock);
    },
    effect(cue, startsAt, clock, resolveCustom) {
      const url = sourceUrl(cue.id, resolveCustom);
      if (!url || clock() >= startsAt + cue.seconds * 1000) return;
      if (effects.size >= 8) endEffect(effects.values().next().value);
      const entry = makeEntry(url);
      effects.add(entry);
      schedule(
        entry,
        {
          startsAt,
          positionMs: 0,
          playing: true,
          loop: false,
          durationMs: cue.seconds * 1000,
        },
        clock,
        () => endEffect(entry),
      );
    },
    setVolume(value) {
      volume = value;
      if (background) background.audio.volume = value;
      for (const entry of effects) entry.audio.volume = value;
    },
    stop() {
      stopTrack();
      for (const entry of effects) endEffect(entry);
    },
    close() {
      this.stop();
      for (const url of urls.values()) URL.revokeObjectURL(url);
    },
  };
}

export function readAudioDuration(url) {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    function finish(seconds) {
      clearTimeout(timer);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      resetAudio(audio);
      if (Number.isFinite(seconds) && seconds > 0) resolve(seconds);
      else reject(new Error('This audio file could not be read.'));
    }
    const timer = setTimeout(finish, 8000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => finish(audio.duration);
    audio.onerror = () => finish();
    audio.src = url;
  });
}
