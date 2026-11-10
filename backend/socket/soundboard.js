import { ROLES } from '../../shared/events.js';
import {
  changeSoundboard,
  currentSoundboard,
  findSoundCue,
  initialSoundboard,
  SOUNDBOARD_EVENTS,
} from '../../shared/soundboard.js';

const START_LEAD_MS = 350;
const EFFECT_COOLDOWN_MS = 250;
const playback = new WeakMap();
const lastEffect = new WeakMap();

export function registerSoundboard(
  socket,
  { io, sessionManager, roomFor, library },
) {
  function membership() {
    const participant = sessionManager.getParticipantBySocket(socket.id);
    if (!participant?.connected || participant.socketId !== socket.id)
      return {};
    return {
      participant,
      session: sessionManager.getSession(participant.sessionId),
    };
  }

  function stateFor(session, now = Date.now()) {
    return currentSoundboard(playback.get(session) ?? initialSoundboard, now);
  }

  function broadcast(sessionId, event, data) {
    io.to(roomFor(sessionId)).emit(event, { sessionId, ...data });
  }

  socket.on(SOUNDBOARD_EVENTS.REQUEST, (_input, ack) => {
    if (typeof ack !== 'function') return;
    const { participant, session } = membership();
    if (!session) return ack({ ok: false, error: 'Join a session first.' });
    const now = Date.now();
    ack({
      ok: true,
      sessionId: session.id,
      serverTime: now,
      state: stateFor(session, now),
      cues: library?.list(session.id) ?? [],
      access: library?.issue(socket, participant) ?? null,
    });
  });

  socket.on(SOUNDBOARD_EVENTS.COMMAND, (input, ack) => {
    if (typeof ack !== 'function') return;
    const { participant, session } = membership();
    if (!session || participant.role !== ROLES.DM) {
      return ack({
        ok: false,
        error: 'Only the Dungeon Master can control session audio.',
      });
    }
    if (!input || typeof input !== 'object')
      return ack({ ok: false, error: 'Invalid soundboard command.' });
    const cue =
      findSoundCue(input.cueId) ?? library?.get(session.id, input.cueId);
    const now = Date.now();
    if (input.action === 'trigger') {
      if (cue?.kind !== 'effect')
        return ack({ ok: false, error: 'Choose a sound effect.' });
      if (now - (lastEffect.get(session) ?? -Infinity) < EFFECT_COOLDOWN_MS) {
        return ack({
          ok: false,
          error: 'Wait a moment before triggering another effect.',
        });
      }
      lastEffect.set(session, now);
      broadcast(session.id, SOUNDBOARD_EVENTS.UPDATE, {
        action: 'trigger',
        cueId: cue.id,
        startsAt: now + START_LEAD_MS,
      });
      return ack({ ok: true });
    }
    const state = changeSoundboard(
      stateFor(session, now),
      input,
      cue,
      now,
      START_LEAD_MS,
    );
    if (!state) return ack({ ok: false, error: 'Invalid soundboard command.' });
    playback.set(session, state);
    broadcast(session.id, SOUNDBOARD_EVENTS.UPDATE, {
      action: input.action,
      state,
    });
    ack({ ok: true });
  });

  socket.on(SOUNDBOARD_EVENTS.REMOVE, (id, ack) => {
    if (typeof ack !== 'function') return;
    const { participant, session } = membership();
    if (!session || participant.role !== ROLES.DM || !library) {
      return ack({
        ok: false,
        error: 'Only the Dungeon Master can remove imported audio.',
      });
    }
    if (stateFor(session).track?.cueId === id) {
      return ack({ ok: false, error: 'Stop this track before removing it.' });
    }
    try {
      if (!library.remove(session.id, id))
        return ack({ ok: false, error: 'Audio was not found.' });
      broadcast(session.id, SOUNDBOARD_EVENTS.CATALOG, {
        cues: library.list(session.id),
      });
      ack({ ok: true });
    } catch {
      ack({ ok: false, error: 'Audio could not be removed.' });
    }
  });
}
