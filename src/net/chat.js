import {
  CHAT_ACK_TIMEOUT,
  CHAT_EVENTS,
  MAX_TEXT_LENGTH,
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
    socket
      .timeout(CHAT_ACK_TIMEOUT)
      .emit(event, payload, (error, response) =>
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
function validPublic(message, sessionId) {
  return (
    message?.sessionId === sessionId &&
    message.type === 'text' &&
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
          .accept(
            response.messages.filter((m) => validPublic(m, state.session.id)),
          );
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
    if (canSend(state) && validPublic(message, state.session.id))
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

export async function sendPublicText(text, requestId = crypto.randomUUID()) {
  const state = sessionStore.getState();
  const socket = activeSocket;
  if (!socket?.connected || !canSend(state))
    return { success: false, error: 'Connect to a session before sending.' };
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH)
    return { success: false, error: `Use 1–${MAX_TEXT_LENGTH} characters.` };
  const scope = scopeFor(state);
  chatStore
    .getState()
    .pending({
      id: `pending:${requestId}`,
      requestId,
      sessionId: state.session.id,
      senderId: state.currentUser.id,
      senderName: state.currentUser.displayName,
      text: text.trim(),
      createdAt: new Date().toISOString(),
      type: 'text',
    });
  const response = await request(socket, CHAT_EVENTS.SEND, { text, requestId });
  if (socket !== activeSocket || chatStore.getState().scope !== scope)
    return response;
  if (response.success && validPublic(response.message, state.session.id))
    chatStore.getState().accept([response.message]);
  else
    chatStore
      .getState()
      .fail(requestId, response.error || 'Message could not be sent.');
  return response;
}
export function retryPublicText(requestId) {
  const message = chatStore
    .getState()
    .messages.find((m) => m.requestId === requestId && m.status === 'failed');
  return message
    ? sendPublicText(message.text, requestId)
    : Promise.resolve({ success: false });
}
