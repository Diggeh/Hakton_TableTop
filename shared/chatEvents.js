export const CHAT_EVENTS = Object.freeze({
  SEND: 'chat:send',
  MESSAGE: 'chat:message',
  HISTORY: 'chat:history',
  IMAGE: 'chat:image',
});
export const MAX_TEXT_LENGTH = 2000;
export const MAX_IMAGE_BYTES = 256 * 1024;
export const MAX_IMAGE_EDGE = 1280;
export const HISTORY_LIMIT = 100;
export const CHAT_ACK_TIMEOUT = 8000;
