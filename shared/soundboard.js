export const SOUNDBOARD_EVENTS = {
  REQUEST: 'soundboard:request',
  COMMAND: 'soundboard:command',
  UPDATE: 'soundboard:update',
  CATALOG: 'soundboard:catalog',
  REMOVE: 'soundboard:remove',
};

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 7200;
export const AUDIO_PATH = '/soundboard/audio';

export const SOUND_CUES = [
  { id: 'coastal-wind', name: 'Coastal wind', kind: 'loop', seconds: 12 },
  { id: 'sanctuary', name: 'Sanctuary ambience', kind: 'loop', seconds: 12 },
  { id: 'battle-drums', name: 'Battle drums', kind: 'loop', seconds: 8 },
  { id: 'bell', name: 'Warning bell', kind: 'effect', seconds: 3 },
  { id: 'thunder', name: 'Thunder', kind: 'effect', seconds: 4 },
];

export function findSoundCue(id) {
  return SOUND_CUES.find((cue) => cue.id === id);
}

export const initialSoundboard = { track: null, volume: 100 };

export function trackPosition(track, now) {
  const elapsed =
    track.positionMs + (track.playing ? Math.max(0, now - track.startsAt) : 0);
  return track.loop
    ? elapsed % track.durationMs
    : Math.min(elapsed, track.durationMs);
}

export function currentSoundboard(state, now) {
  const { track } = state;
  return track?.playing &&
    !track.loop &&
    trackPosition(track, now) >= track.durationMs
    ? { ...state, track: null }
    : state;
}

export function changeSoundboard(state, input, cue, now, lead = 0) {
  const { track } = state;
  switch (input.action) {
    case 'play':
      if (cue?.kind !== 'loop') return null;
      return {
        ...state,
        track: {
          cueId: cue.id,
          positionMs: 0,
          durationMs: cue.seconds * 1000,
          startsAt: now + lead,
          playing: true,
          loop: true,
        },
      };
    case 'stop':
      return { ...state, track: null };
    case 'pause':
      if (!track?.playing) return null;
      return {
        ...state,
        track: {
          ...track,
          positionMs: trackPosition(track, now),
          playing: false,
        },
      };
    case 'resume':
      if (!track || track.playing) return null;
      return {
        ...state,
        track: { ...track, startsAt: now + lead, playing: true },
      };
    case 'loop':
      if (!track || typeof input.value !== 'boolean') return null;
      return {
        ...state,
        track: {
          ...track,
          loop: input.value,
          positionMs: trackPosition(track, now),
          startsAt: Math.max(now, track.startsAt),
        },
      };
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
