import { createHash } from 'node:crypto';
import {
  CHAT_EVENTS,
  HISTORY_LIMIT,
  MAX_TEXT_LENGTH,
} from '../../shared/chatEvents.js';

function publicMessage(row) {
  return {
    id: row.id,
    requestId: row.payload.requestId,
    sessionId: row.payload.sessionId,
    senderId: row.sender_id,
    senderName: row.sender_name,
    type: 'text',
    text: row.payload.text,
    createdAt: row.created_at,
  };
}

/** Register against the existing authenticated session registry and injected chat DAL. */
export function registerChatHandlers(
  io,
  socket,
  { repository, sessionManager, roomFor },
) {
  function actor() {
    const participant = sessionManager.getParticipantBySocket(socket.id);
    return participant?.connected && participant.socketId === socket.id
      ? participant
      : null;
  }
  function ready(ack) {
    const participant = actor();
    if (!participant) {
      ack({ success: false, error: 'Join a session before using chat.' });
      return null;
    }
    if (
      !repository?.append ||
      !repository?.get ||
      !repository?.publicHistoryForSession
    ) {
      ack({ success: false, error: 'Chat storage is unavailable.' });
      return null;
    }
    return participant;
  }
  socket.on(CHAT_EVENTS.SEND, (input, ack) => {
    if (typeof ack !== 'function') return;
    const participant = ready(ack);
    if (!participant) return;
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      typeof input.requestId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(input.requestId) ||
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      input.text.length > MAX_TEXT_LENGTH ||
      /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(input.text) ||
      input.recipientId != null ||
      (input.type !== undefined && input.type !== 'text')
    ) {
      ack({
        success: false,
        error: `Send public text of 1–${MAX_TEXT_LENGTH} characters.`,
      });
      return;
    }
    const text = input.text.trim();
    // Stable across retries/reconnections; clients cannot pick another sender's row ID.
    const id = createHash('sha256')
      .update(
        JSON.stringify([
          participant.sessionId,
          participant.id,
          input.requestId,
        ]),
      )
      .digest('hex');
    try {
      const existing = repository.get(id);
      if (existing) {
        if (
          existing.payload?.sessionId !== participant.sessionId ||
          existing.sender_id !== participant.id ||
          existing.recipient_id !== null ||
          existing.type !== 'text' ||
          existing.payload.text !== text
        ) {
          ack({
            success: false,
            error: 'This message request was already used.',
          });
          return;
        }
        ack({ success: true, message: publicMessage(existing) });
        return;
      }
      const saved = repository.append({
        id,
        senderId: participant.id,
        senderName: participant.displayName,
        recipientId: null,
        type: 'text',
        payload: {
          sessionId: participant.sessionId,
          requestId: input.requestId,
          text,
        },
      });
      const message = publicMessage(saved);
      // Persistence succeeds before anyone sees an accepted message.
      io.to(roomFor(participant.sessionId)).emit(CHAT_EVENTS.MESSAGE, message);
      ack({ success: true, message });
    } catch {
      ack({
        success: false,
        error: 'Message could not be saved. Please retry.',
      });
    }
  });
  socket.on(CHAT_EVENTS.HISTORY, (_input, ack) => {
    if (typeof ack !== 'function') return;
    const participant = ready(ack);
    if (!participant) return;
    try {
      const rows = repository.publicHistoryForSession(
        participant.sessionId,
        HISTORY_LIMIT,
      );
      const messages = rows
        .filter(
          (row) =>
            row.type === 'text' &&
            row.recipient_id === null &&
            row.payload?.sessionId === participant.sessionId,
        )
        .map(publicMessage);
      ack({ success: true, sessionId: participant.sessionId, messages });
    } catch {
      ack({
        success: false,
        error: 'Chat history could not be loaded. Please retry.',
      });
    }
  });
}
