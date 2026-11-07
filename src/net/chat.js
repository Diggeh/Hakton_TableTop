import {
  CHAT_ACK_TIMEOUT,
  CHAT_EVENTS,
  MAX_TEXT_LENGTH,
  MAX_IMAGE_BYTES,
} from '../../shared/chatEvents.js';
import { chatStore } from '../store/chatStore.js';
import { sessionStore } from '../store/sessionStore.js';

let activeSocket = null;
let unbind = null;
let needsHistory = true;
let historyRequest = null;
const scopeFor = (state) =>
  state.currentUser?.id && state.session?.id
    ? `${state.session.id}:${state.currentUser.id}`
    : null;
const canSend = (state) => state.connection === 'connected' && scopeFor(state);
function request(socket, event, payload) {
  return new Promise((resolve) => {
    socket.timeout(CHAT_ACK_TIMEOUT).emit(event, payload, (error, response) =>
      resolve(
        error
          ? {
              success: false,
              error: 'Host did not confirm the request. Please retry.',
            }
          : response || { success: false, error: 'Invalid host response.' },
      ),
    );
  });
}
function validMessage(message, state) {
  return (
    message?.sessionId === state.session?.id &&
    ['text', 'whisper', 'image'].includes(message.type) &&
    (message.recipientId == null ||
      message.senderId === state.currentUser?.id ||
      message.recipientId === state.currentUser?.id) &&
    typeof message.id === 'string' &&
    typeof message.text === 'string' &&
    typeof message.senderName === 'string' &&
    typeof message.createdAt === 'string'
  );
}
export function loadChatHistory() {
  const socket = activeSocket;
  const state = sessionStore.getState();
  const scope = scopeFor(state);
  if (!socket?.connected || !canSend(state))
    return Promise.resolve({ success: false, error: 'Join a session first.' });
  if (historyRequest?.scope === scope) return historyRequest.promise;
  chatStore.getState().setHistoryState('loading');
  const pending = { scope, promise: null };
  pending.promise = request(socket, CHAT_EVENTS.HISTORY, {})
    .then((response) => {
      if (
        socket !== activeSocket ||
        chatStore.getState().scope !== scope ||
        historyRequest !== pending
      )
        return response;
      if (
        response.success &&
        response.sessionId === state.session.id &&
        Array.isArray(response.messages)
      ) {
        chatStore
          .getState()
          .accept(response.messages.filter((m) => validMessage(m, state)));
        chatStore.getState().setHistoryState('ready');
      } else
        chatStore
          .getState()
          .setHistoryState('failed', response.error || 'Invalid chat history.');
      return response;
    })
    .finally(() => {
      if (historyRequest === pending) historyRequest = null;
    });
  historyRequest = pending;
  return pending.promise;
}

/** Uses the existing transport. Does not create a socket or change session logic. */
export function bindChat(socket) {
  unbind?.();
  activeSocket = socket;
  needsHistory = true;
  const receive = (message) => {
    const state = sessionStore.getState();
    if (canSend(state) && validMessage(message, state))
      chatStore.getState().accept([message]);
  };
  const disconnected = () => {
    needsHistory = true;
    historyRequest = null;
    chatStore.getState().failPending();
  };
  socket.on(CHAT_EVENTS.MESSAGE, receive);
  socket.on('disconnect', disconnected);
  const unsubscribe = sessionStore.subscribe((state, previous) => {
    const scope = scopeFor(state);
    if (!scope) {
      chatStore.getState().reset();
      needsHistory = true;
      return;
    }
    const changedScope = scope !== chatStore.getState().scope;
    chatStore.getState().activateScope(scope);
    if (
      state.connection === 'connected' &&
      (changedScope ||
        (needsHistory && state.currentUser !== previous.currentUser))
    ) {
      needsHistory = false;
      void loadChatHistory();
    }
  });
  unbind = () => {
    socket.off(CHAT_EVENTS.MESSAGE, receive);
    socket.off('disconnect', disconnected);
    unsubscribe();
    activeSocket = null;
    historyRequest = null;
    chatStore.getState().reset();
  };
}
export function unbindChat() {
  unbind?.();
  unbind = null;
}

export function sendPublicText(text, requestId) {
  return sendChatMessage({ text, type: 'text' }, requestId);
}

export async function sendChatMessage(draft, requestId = crypto.randomUUID()) {
  const state = sessionStore.getState();
  const socket = activeSocket;
  if (!socket?.connected || !canSend(state))
    return { success: false, error: 'Connect to a session before sending.' };
  const { text, type, recipientId = null, recipientName, image } = draft;
  if (
    typeof text !== 'string' ||
    text.length > MAX_TEXT_LENGTH ||
    (!text.trim() && type !== 'image')
  )
    return { success: false, error: `Use 1–${MAX_TEXT_LENGTH} characters.` };
  const scope = scopeFor(state);
  const payload = { text: text.trim(), type, recipientId, image };
  chatStore.getState().pending({
    ...payload,
    id: `pending:${requestId}`,
    requestId,
    sessionId: state.session.id,
    senderId: state.currentUser.id,
    senderName: state.currentUser.displayName,
    recipientName,
    createdAt: new Date().toISOString(),
  });
  const response = await request(socket, CHAT_EVENTS.SEND, {
    ...payload,
    requestId,
  });
  if (socket !== activeSocket || chatStore.getState().scope !== scope)
    return response;
  if (response.success && validMessage(response.message, state)) {
    chatStore.getState().accept([response.message]);
    return response;
  }
  const error = response.error || 'Message could not be sent.';
  chatStore.getState().fail(requestId, error);
  return { success: false, error };
}

export function retryChatMessage(requestId) {
  const message = chatStore
    .getState()
    .messages.find((m) => m.requestId === requestId && m.status === 'failed');
  return message
    ? sendChatMessage(message, requestId)
    : Promise.resolve({ success: false });
}

export async function fetchChatImage(id) {
  const socket = activeSocket;
  const state = sessionStore.getState();
  if (!socket?.connected || !canSend(state))
    throw new Error('Reconnect to load the image.');
  const result = await request(socket, CHAT_EVENTS.IMAGE, id);
  if (
    socket !== activeSocket ||
    scopeFor(sessionStore.getState()) !== scopeFor(state) ||
    !result.success ||
    typeof result.image !== 'string' ||
    result.image.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
  ) {
    throw new Error(result.error || 'Image unavailable.');
  }
  return result.image;
}

export { retryChatMessage as retryPublicText };
