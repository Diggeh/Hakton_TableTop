import { createHash } from 'node:crypto';
import {
  CHAT_EVENTS,
  HISTORY_LIMIT,
  MAX_TEXT_LENGTH,
} from '../../shared/chatEvents.js';
import { validateChatImage } from './image.js';

const supportedTypes = new Set(['text', 'whisper', 'image']);

function messageForWire(row) {
  return {
    id: row.id,
    requestId: row.payload.requestId,
    sessionId: row.payload.sessionId,
    senderId: row.sender_id,
    senderName: row.sender_name,
    recipientId: row.recipient_id,
    recipientName: row.payload.recipientName,
    type: row.type,
    text: row.payload.text,
    createdAt: row.created_at,
  };
}

function canRead(row, participant) {
  return (
    row?.payload?.sessionId === participant.sessionId &&
    supportedTypes.has(row.type) &&
    (row.recipient_id === null ||
      row.recipient_id === participant.id ||
      row.sender_id === participant.id)
  );
}

function parseMessage(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof input.requestId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(input.requestId)
  )
    return null;
  const type = input.type === undefined ? 'text' : input.type;
  const recipientId = input.recipientId ?? null;
  if (
    !supportedTypes.has(type) ||
    (recipientId !== null &&
      (typeof recipientId !== 'string' ||
        !recipientId ||
        recipientId.length > 80)) ||
    (type === 'text' && recipientId !== null) ||
    (type === 'whisper' && recipientId === null)
  )
    return null;
  const text = input.text === undefined && type === 'image' ? '' : input.text;
  if (
    typeof text !== 'string' ||
    text.length > MAX_TEXT_LENGTH ||
    /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text) ||
    (type !== 'image' && (!text.trim() || input.image !== undefined)) ||
    (type === 'image' && !validateChatImage(input.image))
  )
    return null;
  return { type, recipientId, text: text.trim(), image: input.image };
}

export function registerChatHandlers(
  io,
  socket,
  { repository, sessionManager, roomFor },
) {
  function ready(ack) {
    const participant = sessionManager.getParticipantBySocket(socket.id);
    if (!participant?.connected || participant.socketId !== socket.id) {
      ack({ success: false, error: 'Join a session before using chat.' });
      return null;
    }
    if (
      !repository?.append ||
      !repository?.get ||
      !repository?.historyForSession
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
    const draft = parseMessage(input);
    if (!draft) {
      ack({ success: false, error: 'Invalid chat message or image.' });
      return;
    }
    const { type, recipientId, text, image } = draft;
    const recipient = sessionManager
      .getSession(participant.sessionId)
      ?.participants.get(recipientId);
    if (
      recipientId !== null &&
      (!recipient || recipientId === participant.id)
    ) {
      ack({
        success: false,
        error: 'Select another participant in this session.',
      });
      return;
    }
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
          !canRead(existing, participant) ||
          existing.sender_id !== participant.id ||
          existing.recipient_id !== recipientId ||
          existing.type !== type ||
          existing.payload.text !== text ||
          existing.payload.image !== image
        ) {
          ack({
            success: false,
            error: 'This message request was already used.',
          });
          return;
        }
        ack({ success: true, message: messageForWire(existing) });
        return;
      }
      const saved = repository.append({
        id,
        senderId: participant.id,
        senderName: participant.displayName,
        recipientId,
        type,
        payload: {
          sessionId: participant.sessionId,
          requestId: input.requestId,
          text,
          image,
          recipientName: recipient?.displayName,
        },
      });
      const message = messageForWire(saved);
      if (recipientId === null) {
        io.to(roomFor(participant.sessionId)).emit(
          CHAT_EVENTS.MESSAGE,
          message,
        );
      } else if (recipient.connected && recipient.socketId) {
        io.sockets.sockets
          .get(recipient.socketId)
          ?.emit(CHAT_EVENTS.MESSAGE, message);
      }
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
      const rows = repository.historyForSession(
        participant.sessionId,
        participant.id,
        HISTORY_LIMIT,
      );
      const messages = rows
        .filter((row) => canRead(row, participant))
        .map(messageForWire);
      ack({ success: true, sessionId: participant.sessionId, messages });
    } catch {
      ack({
        success: false,
        error: 'Chat history could not be loaded. Please retry.',
      });
    }
  });

  socket.on(CHAT_EVENTS.IMAGE, (id, ack) => {
    if (typeof ack !== 'function') return;
    const participant = ready(ack);
    if (!participant) return;
    try {
      const row =
        typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)
          ? repository.get(id)
          : null;
      if (row?.type === 'image' && canRead(row, participant)) {
        ack({ success: true, image: row.payload.image });
        return;
      }
    } catch {
      // Use the same response for unavailable and unauthorized images.
    }
    ack({ success: false, error: 'Image unavailable.' });
  });
}
