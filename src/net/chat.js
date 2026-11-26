import {
  CHAT_ACK_TIMEOUT,
  CHAT_EVENTS,
  MAX_TEXT_LENGTH,
  MAX_IMAGE_BYTES,
} from '../../shared/chatEvents.js';
import { chatStore } from '../store/chatStore.js';
import { sessionStore } from '../store/sessionStore.js';
import { validWhisperEnvelope } from '../../shared/whisperEncryption.js';
import { whisperScope } from './whisperKeys.js';
import {
  decryptWhisper,
  encryptWhisper,
  trustWhisperKey,
  verifiedWhisperKey,
  whisperIdentity,
  whisperSafetyCode,
} from './whisperCrypto.js';

let activeSocket = null;
let unbind = null;
let needsHistory = true;
let historyRequest = null;
let keyRegistration = null;
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
    (message.encrypted
      ? Boolean(message.recipientId) &&
        validWhisperEnvelope(message.encrypted, message.type, false)
      : typeof message.text === 'string') &&
    typeof message.senderName === 'string' &&
    typeof message.createdAt === 'string'
  );
}

async function localWhisperIdentity(socket, state) {
  const scope = whisperScope(socket, state);
  if (keyRegistration?.scope === scope) return keyRegistration.promise;
  const pending = { scope, promise: null };
  pending.promise = (async () => {
    const identity = await whisperIdentity(scope);
    if (
      socket !== activeSocket ||
      scopeFor(state) !== scopeFor(sessionStore.getState())
    ) {
      throw new Error('Session changed while preparing whisper keys.');
    }
    const response = await request(
      socket,
      CHAT_EVENTS.KEY_PUBLISH,
      identity.publicKey,
    );
    if (!response.success)
      throw new Error(
        response.error || 'Whisper keys could not be registered.',
      );
    return { scope, identity };
  })().catch((error) => {
    if (keyRegistration === pending) keyRegistration = null;
    throw error;
  });
  keyRegistration = pending;
  return pending.promise;
}

export async function inspectWhisperSecurity(peerId) {
  const socket = activeSocket;
  const state = sessionStore.getState();
  if (!socket?.connected || !canSend(state))
    throw new Error('Connect to the session first.');
  if (
    !state.participants.some(
      (p) => p.id === peerId && p.id !== state.currentUser.id,
    )
  ) {
    throw new Error('Select another participant.');
  }
  const { scope, identity } = await localWhisperIdentity(socket, state);
  const response = await request(socket, CHAT_EVENTS.KEY_GET, peerId);
  if (
    socket !== activeSocket ||
    scopeFor(state) !== scopeFor(sessionStore.getState())
  )
    throw new Error('Session changed.');
  if (!response.success)
    throw new Error(response.error || 'Whisper keys are unavailable.');
  const trusted = await verifiedWhisperKey(scope, peerId);
  const code = await whisperSafetyCode(
    state.currentUser.id,
    identity.publicKey,
    peerId,
    response.publicKey,
  );
  return {
    scope,
    peerId,
    publicKey: response.publicKey,
    code,
    verified: trusted === response.publicKey,
    changed: Boolean(trusted && trusted !== response.publicKey),
  };
}

export async function verifyWhisperSecurity(security) {
  const current = await inspectWhisperSecurity(security.peerId);
  if (
    current.scope !== security.scope ||
    current.publicKey !== security.publicKey
  ) {
    throw new Error(
      'The whisper key changed. Compare the new code before verifying.',
    );
  }
  await trustWhisperKey(current.scope, current.peerId, current.publicKey);
  await loadChatHistory();
  return { ...current, verified: true, changed: false };
}

async function readableMessage(message, socket, state) {
  if (!message.encrypted)
    return { ...message, legacyPrivate: Boolean(message.recipientId) };
  try {
    const scope = whisperScope(socket, state);
    const identity = await whisperIdentity(scope);
    const peerId =
      message.senderId === state.currentUser.id
        ? message.recipientId
        : message.senderId;
    const peerKey = await verifiedWhisperKey(scope, peerId);
    if (!peerKey)
      return {
        ...message,
        text: '',
        encryptionError:
          'Verify this participant’s security code to read this whisper.',
      };
    const text = await decryptWhisper(
      identity,
      peerKey,
      state.currentUser.id,
      message,
    );
    return { ...message, text };
  } catch {
    return {
      ...message,
      text: '',
      encryptionError:
        'This whisper could not be authenticated or decrypted on this device.',
    };
  }
}

async function acceptMessages(messages, socket, state) {
  const scope = scopeFor(state);
  const readable = await Promise.all(
    messages
      .filter((m) => validMessage(m, state))
      .map((m) => readableMessage(m, socket, state)),
  );
  if (
    socket === activeSocket &&
    scopeFor(sessionStore.getState()) === scope &&
    chatStore.getState().scope === scope
  )
    chatStore.getState().accept(readable);
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
    .then(async (response) => {
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
        await acceptMessages(response.messages, socket, state);
        if (socket === activeSocket && chatStore.getState().scope === scope)
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
      void acceptMessages([message], socket, state);
  };
  const disconnected = () => {
    needsHistory = true;
    historyRequest = null;
    keyRegistration = null;
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
      void localWhisperIdentity(socket, state).catch(() => {
        // Public chat remains available when device key storage cannot open.
      });
    }
  });
  unbind = () => {
    socket.off(CHAT_EVENTS.MESSAGE, receive);
    socket.off('disconnect', disconnected);
    unsubscribe();
    activeSocket = null;
    historyRequest = null;
    keyRegistration = null;
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
  let payload = { text: text.trim(), type, recipientId, image };
  let encrypted;
  if (recipientId !== null) {
    try {
      const security = await inspectWhisperSecurity(recipientId);
      if (!security.verified)
        throw new Error(
          security.changed
            ? 'The whisper key changed. Open Verified keys and check the code again.'
            : 'Compare and verify the whisper security code before sending.',
        );
      const { identity } = await localWhisperIdentity(socket, state);
      encrypted =
        draft.encrypted ??
        (await encryptWhisper(identity, security.publicKey, {
          ...payload,
          requestId,
          sessionId: state.session.id,
          senderId: state.currentUser.id,
        }));
      payload = { type, recipientId, encrypted };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'Whisper could not be encrypted.',
      };
    }
    if (
      socket !== activeSocket ||
      scopeFor(sessionStore.getState()) !== scope
    ) {
      return { success: false, error: 'Session changed.' };
    }
  }
  chatStore.getState().pending({
    ...payload,
    text: text.trim(),
    image,
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
    await acceptMessages([response.message], socket, state);
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
  const message = chatStore.getState().messages.find((m) => m.id === id);
  if (
    result.success &&
    message?.encrypted &&
    socket === activeSocket &&
    scopeFor(sessionStore.getState()) === scopeFor(state)
  ) {
    const scope = whisperScope(socket, state);
    const identity = await whisperIdentity(scope);
    const peerId =
      message.senderId === state.currentUser.id
        ? message.recipientId
        : message.senderId;
    const trusted = await verifiedWhisperKey(scope, peerId);
    if (!trusted) throw new Error('Verify the whisper security code first.');
    if (typeof result.encryptedImage !== 'string')
      throw new Error('Encrypted image unavailable.');
    const image = await decryptWhisper(
      identity,
      trusted,
      state.currentUser.id,
      message,
      result.encryptedImage,
    );
    if (
      socket !== activeSocket ||
      scopeFor(sessionStore.getState()) !== scopeFor(state)
    )
      throw new Error('Session changed.');
    return image;
  }
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
