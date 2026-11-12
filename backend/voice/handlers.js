import { EVENTS } from '../../shared/events.js';

/**
 * Voice mesh signaling. The host is ONLY a phone book: it stores each participant's PeerJS id and
 * tells the room who showed up or left. Audio flows client-to-client over WebRTC and never touches
 * this process (PeerJS' own /peerjs endpoint only brokers SDP/ICE for the handshake).
 *
 * Wire contract
 *   client -> host  `voice:join`   { peerId }            ack { success, peerId, peers[] | code, error }
 *   client -> host  `voice:leave`  {}                    ack { success }
 *   host -> others  `player_joined` { peerId, playerId, displayName, role, sessionId }
 *   host -> room    `player_left`   { peerId, playerId, displayName, sessionId }
 *   host -> room    `session:peers` [{ peerId, playerId, displayName, role }]  (authoritative roster)
 */

/** Broadcasts that a voice slot was released. No-op when the participant never held a peer id. */
export function announceVoicePeerLeft(
  io,
  { sessionManager, roomFor },
  { session, participant, previousPeerId },
) {
  if (!previousPeerId || !session || !participant) return;
  const room = roomFor(session.id);
  io.to(room).emit(EVENTS.VOICE_PEER_LEFT, {
    peerId: previousPeerId,
    playerId: participant.id,
    displayName: participant.displayName,
    sessionId: session.id,
  });
  io.to(room).emit(EVENTS.SESSION_PEERS, sessionManager.getVoicePeers(session.id));
}

function ackFrom(first, second) {
  if (typeof first === 'function') return first;
  if (typeof second === 'function') return second;
  return null;
}

/**
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {{ sessionManager: import('../session/sessionManager.js').SessionManager, roomFor: (id: string) => string }} deps
 */
export function registerVoiceHandlers(io, socket, { sessionManager, roomFor }) {
  socket.on(EVENTS.VOICE_JOIN, (rawPayload, maybeAck) => {
    const ack = ackFrom(rawPayload, maybeAck);
    const payload =
      rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
        ? rawPayload
        : {};

    const result = sessionManager.registerVoicePeer({
      socketId: socket.id,
      peerId: payload.peerId,
    });

    if (!result.success) {
      // Reported through the ack only: SESSION_ERROR feeds the global session status line.
      ack?.({ success: false, code: result.code, error: result.error });
      return;
    }

    const { session, participant, peers } = result;
    const room = roomFor(session.id);
    const others = peers.filter((p) => p.peerId !== participant.peerId);

    if (result.changed) {
      // The participant swapped peer ids (e.g. a renderer reload): retire the stale one first.
      if (result.previousPeerId) {
        announceVoicePeerLeft(
          io,
          { sessionManager, roomFor },
          { session, participant, previousPeerId: result.previousPeerId },
        );
      }

      // Existing clients dial the newcomer; the newcomer only answers (prevents WebRTC glare).
      socket.to(room).emit(EVENTS.VOICE_PEER_JOINED, {
        peerId: participant.peerId,
        playerId: participant.id,
        displayName: participant.displayName,
        role: participant.role,
        sessionId: session.id,
      });
      io.to(room).emit(EVENTS.SESSION_PEERS, peers);
      io.to(room).emit(
        EVENTS.SESSION_PARTICIPANTS_UPDATE,
        sessionManager.getSanitizedParticipants(session.id),
      );
    }

    ack?.({ success: true, peerId: participant.peerId, peers: others });
  });

  socket.on(EVENTS.VOICE_LEAVE, (rawPayload, maybeAck) => {
    const ack = ackFrom(rawPayload, maybeAck);
    const released = sessionManager.unregisterVoicePeer(socket.id);
    if (released) {
      announceVoicePeerLeft(io, { sessionManager, roomFor }, released);
      io.to(roomFor(released.session.id)).emit(
        EVENTS.SESSION_PARTICIPANTS_UPDATE,
        sessionManager.getSanitizedParticipants(released.session.id),
      );
    }
    ack?.({ success: true });
  });
}
