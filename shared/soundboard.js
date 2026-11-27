export const SOUNDBOARD_EVENTS = {
  REQUEST: 'soundboard:request',
  COMMAND: 'soundboard:command',
  UPDATE: 'soundboard:update',
  CATALOG: 'soundboard:catalog',
  REMOVE: 'soundboard:remove',
  ICON: 'soundboard:icon',
};

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 7200;
export const AUDIO_PATH = '/soundboard/audio';
export const MAX_CUE_ICON_LENGTH = 65536;

export const SOUND_ICON_OPTIONS = [
  { id: 'waveform', label: 'Waveform' },
  { id: 'lute', label: 'Lute / Music' },
  { id: 'drum', label: 'Drums' },
  { id: 'horn', label: 'War Horn' },
  { id: 'wind', label: 'Wind' },
  { id: 'rain', label: 'Rain' },
  { id: 'waves', label: 'Ocean' },
  { id: 'forest', label: 'Forest' },
  { id: 'torch', label: 'Campfire' },
  { id: 'sanctuary', label: 'Sanctuary' },
  { id: 'door', label: 'Door' },
  { id: 'sword', label: 'Combat' },
  { id: 'bell', label: 'Bell' },
  { id: 'bolt', label: 'Thunder' },
  { id: 'sparkles', label: 'Magic' },
  { id: 'skull', label: 'Danger' },
  { id: 'coins', label: 'Tavern / Coins' },
  { id: 'heart', label: 'Rest' },
];

const SOUND_ICON_SET = new Set(SOUND_ICON_OPTIONS.map((o) => o.id));
const RASTER_DATA_URL_RE =
  /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/i;

export function isValidCueIcon(icon) {
  if (icon === null) return true;
  if (typeof icon !== 'string' || !icon || icon.length > MAX_CUE_ICON_LENGTH) {
    return false;
  }
  return SOUND_ICON_SET.has(icon) || RASTER_DATA_URL_RE.test(icon);
}

export const SOUND_CUES = [
  { id: 'coastal-wind', name: 'Coastal wind', kind: 'loop', layer: 'ambience', seconds: 12 },
  { id: 'sanctuary', name: 'Sanctuary ambience', kind: 'loop', layer: 'ambience', seconds: 12 },
  { id: 'hearthfire', name: 'Hearthfire lute', kind: 'loop', layer: 'music', seconds: 12 },
  { id: 'battle-drums', name: 'Battle drums', kind: 'loop', layer: 'music', seconds: 8 },
  { id: 'bell', name: 'Warning bell', kind: 'effect', seconds: 3 },
  { id: 'thunder', name: 'Thunder', kind: 'effect', seconds: 4 },
];

export function findSoundCue(id) {
  return SOUND_CUES.find((cue) => cue.id === id);
}

export function cueLayer(cue) {
  return cue?.layer === 'music' ? 'music' : 'ambience';
}

export const initialSoundboard = {
  track: null,
  music: null,
  ambience: null,
  volume: 100,
};

export function trackPosition(track, now) {
  const elapsed =
    track.positionMs + (track.playing ? Math.max(0, now - track.startsAt) : 0);
  return track.loop
    ? elapsed % track.durationMs
    : Math.min(elapsed, track.durationMs);
}

function expireTrack(track, now) {
  if (!track) return null;
  return track.playing && !track.loop && trackPosition(track, now) >= track.durationMs
    ? null
    : track;
}

function resolvePrimaryTrack(music, ambience, previousTrack) {
  if (music && previousTrack?.cueId === music.cueId) return music;
  if (ambience && previousTrack?.cueId === ambience.cueId) return ambience;
  return music ?? ambience ?? null;
}

export function currentSoundboard(state, now) {
  const curMusic = state?.music ?? (state?.track && !state?.ambience ? state.track : null);
  const curAmbience = state?.ambience ?? null;
  const nextMusic = expireTrack(curMusic, now);
  const nextAmbience = expireTrack(curAmbience, now);
  const nextTrack = resolvePrimaryTrack(nextMusic, nextAmbience, state?.track);
  if (
    nextMusic === (state?.music ?? null) &&
    nextAmbience === (state?.ambience ?? null) &&
    nextTrack === (state?.track ?? null)
  ) {
    return state;
  }
  return {
    ...state,
    music: nextMusic,
    ambience: nextAmbience,
    track: nextTrack,
  };
}

function resolveTargetLayers(state, input) {
  if (input.layer === 'music' || input.layer === 'ambience') {
    return [input.layer];
  }
  if (input.cueId) {
    if (state.music?.cueId === input.cueId) return ['music'];
    if (state.ambience?.cueId === input.cueId) return ['ambience'];
  }
  return ['music', 'ambience'];
}

function mutateTrack(track, action, value, now, lead) {
  if (!track) return null;
  if (action === 'pause') {
    if (!track.playing) return track;
    return {
      ...track,
      positionMs: trackPosition(track, now),
      playing: false,
    };
  }
  if (action === 'resume') {
    if (track.playing) return track;
    return {
      ...track,
      startsAt: now + lead,
      playing: true,
    };
  }
  if (action === 'loop') {
    return {
      ...track,
      loop: value,
      positionMs: trackPosition(track, now),
      startsAt: Math.max(now, track.startsAt),
    };
  }
  return track;
}

export function changeSoundboard(state, input, cue, now, lead = 0) {
  const baseMusic = state.music ?? null;
  const baseAmbience = state.ambience ?? null;

  switch (input.action) {
    case 'play': {
      if (cue?.kind !== 'loop') return null;
      const layer =
        input.layer === 'music' || input.layer === 'ambience'
          ? input.layer
          : cueLayer(cue);
      const nextSlot = {
        cueId: cue.id,
        layer,
        positionMs: 0,
        durationMs: cue.seconds * 1000,
        startsAt: now + lead,
        playing: true,
        loop: true,
      };
      const music = layer === 'music' ? nextSlot : baseMusic;
      const ambience = layer === 'ambience' ? nextSlot : baseAmbience;
      return {
        ...state,
        music,
        ambience,
        track: nextSlot,
      };
    }
    case 'stop': {
      const targets = resolveTargetLayers(state, input);
      const music = targets.includes('music') ? null : baseMusic;
      const ambience = targets.includes('ambience') ? null : baseAmbience;
      return {
        ...state,
        music,
        ambience,
        track: resolvePrimaryTrack(music, ambience, state.track),
      };
    }
    case 'pause': {
      const targets = resolveTargetLayers(state, input);
      const canPauseMusic = targets.includes('music') && baseMusic?.playing;
      const canPauseAmbience = targets.includes('ambience') && baseAmbience?.playing;
      if (!canPauseMusic && !canPauseAmbience) return null;
      const music = canPauseMusic
        ? mutateTrack(baseMusic, 'pause', undefined, now, lead)
        : baseMusic;
      const ambience = canPauseAmbience
        ? mutateTrack(baseAmbience, 'pause', undefined, now, lead)
        : baseAmbience;
      return {
        ...state,
        music,
        ambience,
        track: resolvePrimaryTrack(music, ambience, state.track),
      };
    }
    case 'resume': {
      const targets = resolveTargetLayers(state, input);
      const canResumeMusic = targets.includes('music') && baseMusic && !baseMusic.playing;
      const canResumeAmbience =
        targets.includes('ambience') && baseAmbience && !baseAmbience.playing;
      if (!canResumeMusic && !canResumeAmbience) return null;
      const music = canResumeMusic
        ? mutateTrack(baseMusic, 'resume', undefined, now, lead)
        : baseMusic;
      const ambience = canResumeAmbience
        ? mutateTrack(baseAmbience, 'resume', undefined, now, lead)
        : baseAmbience;
      return {
        ...state,
        music,
        ambience,
        track: resolvePrimaryTrack(music, ambience, state.track),
      };
    }
    case 'loop': {
      if (typeof input.value !== 'boolean') return null;
      const targets = resolveTargetLayers(state, input);
      const hasMusic = targets.includes('music') && Boolean(baseMusic);
      const hasAmbience = targets.includes('ambience') && Boolean(baseAmbience);
      if (!hasMusic && !hasAmbience) return null;
      const music = hasMusic
        ? mutateTrack(baseMusic, 'loop', input.value, now, lead)
        : baseMusic;
      const ambience = hasAmbience
        ? mutateTrack(baseAmbience, 'loop', input.value, now, lead)
        : baseAmbience;
      return {
        ...state,
        music,
        ambience,
        track: resolvePrimaryTrack(music, ambience, state.track),
      };
    }
    case 'volume':
      if (
        !Number.isInteger(input.value) ||
        input.value < 0 ||
        input.value > 100
      )
        return null;
      return { ...state, volume: input.value };
    default:
      return null;
  }
}
