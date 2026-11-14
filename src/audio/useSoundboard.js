import { useEffect, useRef, useState } from 'react';
import { CONNECTION_STATUS, EVENTS } from '../../shared/events.js';
import {
  AUDIO_PATH,
  changeSoundboard,
  currentSoundboard,
  findSoundCue,
  initialSoundboard,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  SOUNDBOARD_EVENTS,
} from '../../shared/soundboard.js';
import { getSocket, resolveAssetUrl } from '../net/socket.js';
import { useSession } from '../store/sessionStore.js';
import {
  createSoundboardPlayer,
  readAudioDuration,
} from './soundboardPlayer.js';

const TIMEOUT_MS = 4000;

export function useSoundboard(preview) {
  const connected = useSession(
    (state) => state.connection === CONNECTION_STATUS.CONNECTED,
  );
  const sessionId = useSession((state) => state.session?.id);
  const userId = useSession((state) => state.currentUser?.id);
  const [enabled, setEnabled] = useState(false);
  const [volume, setVolume] = useState(60);
  const [state, setState] = useState(initialSoundboard);
  const [cues, setCues] = useState([]);
  const [access, setAccess] = useState(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const playback = useRef(null);
  const audible = useRef(true);
  const personalVolume = useRef(60);
  const current = useRef(initialSoundboard);
  const catalog = useRef([]);
  const accessToken = useRef(null);
  const previewFiles = useRef(new Map());
  const upload = useRef(null);
  const serverOffset = useRef(null);
  const generation = useRef(0);
  const endTimer = useRef(null);

  const clock = () =>
    performance.now() + (preview ? 0 : (serverOffset.current ?? 0));
  const lookup = (id) =>
    findSoundCue(id) ?? catalog.current.find((cue) => cue.id === id);
  const urlFor = (id) => {
    if (preview) return previewFiles.current.get(id);
    if (!accessToken.current) return null;
    return resolveAssetUrl(
      AUDIO_PATH +
        '/' +
        encodeURIComponent(id) +
        '?access=' +
        encodeURIComponent(accessToken.current),
    );
  };

  function updateCatalog(items) {
    catalog.current = items;
    setCues(items);
  }

  function getPlayer() {
    playback.current ??= createSoundboardPlayer({
      onStarted: () => setEnabled(true),
      onError(failure) {
        if (failure.name === 'NotAllowedError') {
          audible.current = false;
          setEnabled(false);
          setError('Enable audio to listen on this device.');
        } else setError('This cue could not play.');
      },
    });
    playback.current.setVolume(
      (personalVolume.current * current.current.volume) / 10000,
    );
    return playback.current;
  }

  function apply(next, force = false) {
    const prior = current.current;
    const updated = currentSoundboard(next, clock());
    current.current = updated;
    setState(updated);
    playback.current?.setVolume(
      (personalVolume.current * updated.volume) / 10000,
    );
    if (!force && updated.track === prior.track) return;
    clearTimeout(endTimer.current);
    const { track } = updated;
    if (!track) playback.current?.setTrack(null, clock, urlFor);
    else if (audible.current) getPlayer().setTrack(track, clock, urlFor);
    if (track?.playing && !track.loop) {
      const finishAt = track.startsAt + track.durationMs - track.positionMs;
      endTimer.current = setTimeout(
        () => {
          if (current.current.track === track)
            apply({ ...current.current, track: null });
        },
        Math.max(0, finishAt - clock()),
      );
    }
  }

  function trigger(cueId, startsAt) {
    const cue = lookup(cueId);
    if (cue && audible.current)
      getPlayer().effect(cue, startsAt, clock, urlFor);
  }

  useEffect(() => {
    const socket = !preview && connected && userId ? getSocket() : null;
    let active = true;
    let requestId = 0;

    function refresh() {
      const id = ++requestId;
      const start = performance.now();
      socket
        .timeout(TIMEOUT_MS)
        .emit(SOUNDBOARD_EVENTS.REQUEST, {}, (err, result) => {
          if (!active || id !== requestId) return;
          if (err || !result?.ok || result.sessionId !== sessionId) {
            setReady(false);
            setError('Session audio is unavailable.');
            return;
          }
          serverOffset.current =
            result.serverTime - (start + performance.now()) / 2;
          accessToken.current = result.access;
          setAccess(result.access);
          updateCatalog(result.cues);
          setReady(true);
          setError('');
          apply(result.state, true);
        });
    }

    const receive = (update) => {
      if (update?.sessionId !== sessionId || serverOffset.current === null)
        return;
      if (update.action === 'trigger') trigger(update.cueId, update.startsAt);
      else if (
        update.action === 'volume' &&
        update.state.track?.cueId === current.current.track?.cueId
      ) {
        apply({ ...update.state, track: current.current.track });
      } else apply(update.state);
    };
    const receiveCatalog = (update) => {
      if (update?.sessionId === sessionId) updateCatalog(update.cues);
    };

    if (socket) {
      socket.on(SOUNDBOARD_EVENTS.UPDATE, receive);
      socket.on(SOUNDBOARD_EVENTS.CATALOG, receiveCatalog);
      socket.on(EVENTS.SESSION_WELCOME, refresh);
      refresh();
    }
    return () => {
      active = false;
      generation.current++;
      socket?.off(SOUNDBOARD_EVENTS.UPDATE, receive);
      socket?.off(SOUNDBOARD_EVENTS.CATALOG, receiveCatalog);
      socket?.off(EVENTS.SESSION_WELCOME, refresh);
      clearTimeout(endTimer.current);
      playback.current?.stop();
      upload.current?.abort();
      upload.current = null;
      for (const url of previewFiles.current.values()) URL.revokeObjectURL(url);
      previewFiles.current.clear();
      serverOffset.current = null;
      accessToken.current = null;
      current.current = initialSoundboard;
      setState(initialSoundboard);
      updateCatalog([]);
      setAccess(null);
      setImporting(false);
      setReady(false);
      setError('');
    };
  }, [preview, connected, sessionId, userId]);

  useEffect(
    () => () => {
      playback.current?.close();
      playback.current = null;
    },
    [],
  );

  async function enable() {
    setError('');
    const scope = generation.current;
    try {
      await getPlayer().enable();
      if (scope !== generation.current) return false;
      audible.current = true;
      setEnabled(true);
      apply(current.current, true);
      return true;
    } catch {
      if (scope === generation.current)
        setError('Audio could not start on this device.');
      return false;
    }
  }

  function send(event, payload) {
    const socket = getSocket();
    if (!socket?.connected || !ready) return;
    const scope = generation.current;
    socket.timeout(TIMEOUT_MS).emit(event, payload, (err, result) => {
      if (scope === generation.current && (err || !result?.ok)) {
        setError(result?.error || 'The host did not confirm the change.');
      }
    });
  }

  async function command(action, cueId, value) {
    setError('');
    const scope = generation.current;
    if (['play', 'resume', 'trigger'].includes(action) && !enabled)
      await enable();
    if (scope !== generation.current) return;
    if (!preview)
      return send(SOUNDBOARD_EVENTS.COMMAND, { action, cueId, value });
    if (action === 'trigger') return trigger(cueId, clock());
    const next = changeSoundboard(
      current.current,
      { action, value },
      lookup(cueId),
      clock(),
    );
    if (next) apply(next);
  }

  async function importAudio(file, kind) {
    if (!file || upload.current || (!preview && !accessToken.current)) return;
    setError('');
    if (
      !/\.(mp3|wav|ogg|oga|opus|flac)$/i.test(file.name) ||
      file.size > MAX_AUDIO_BYTES
    ) {
      setError('Choose an MP3, WAV, Ogg, or FLAC file up to 25 MiB.');
      return;
    }
    const scope = generation.current;
    const controller = new AbortController();
    upload.current = controller;
    setImporting(true);
    const url = URL.createObjectURL(file);
    try {
      const seconds = await readAudioDuration(url);
      if (scope !== generation.current) return;
      if (seconds > MAX_AUDIO_SECONDS)
        throw new Error('Audio must be two hours or shorter.');
      const name =
        file.name
          .replace(/\.[^.]+$/, '')
          .trim()
          .slice(0, 80) || 'Imported audio';
      if (preview) {
        if (catalog.current.length >= 64)
          throw new Error('The preview audio library is full.');
        const id = 'custom-' + crypto.randomUUID();
        previewFiles.current.set(id, url);
        updateCatalog([...catalog.current, { id, name, kind, seconds }]);
        return;
      }
      const params = new URLSearchParams({
        name,
        kind,
        seconds: String(seconds),
      });
      const response = await fetch(resolveAssetUrl(AUDIO_PATH + '?' + params), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + accessToken.current,
          'Content-Type': 'application/octet-stream',
        },
        body: file,
        signal: controller.signal,
      });
      const result = await response.json();
      if (!result.ok)
        throw new Error(result.error || 'Audio could not be imported.');
    } catch (failure) {
      if (scope === generation.current) setError(failure.message);
    } finally {
      if (!preview || ![...previewFiles.current.values()].includes(url))
        URL.revokeObjectURL(url);
      if (upload.current === controller) {
        upload.current = null;
        setImporting(false);
      }
    }
  }

  function removeAudio(id) {
    setError('');
    if (!preview) return send(SOUNDBOARD_EVENTS.REMOVE, id);
    if (current.current.track?.cueId === id) return;
    const url = previewFiles.current.get(id);
    if (url) URL.revokeObjectURL(url);
    previewFiles.current.delete(id);
    updateCatalog(catalog.current.filter((cue) => cue.id !== id));
  }

  return {
    enabled,
    volume,
    state,
    cues,
    error,
    importing,
    command,
    enable,
    importAudio,
    removeAudio,
    canImport: preview || Boolean(access),
    ready: preview || ready,
    changeVolume(value) {
      personalVolume.current = value;
      setVolume(value);
      playback.current?.setVolume((value * current.current.volume) / 10000);
    },
  };
}
