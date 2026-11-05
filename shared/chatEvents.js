// Public text only. Whispers, image ingestion, and dice events are separate work.
export const CHAT_EVENTS = Object.freeze({
  SEND: 'chat:send',
  MESSAGE: 'chat:message',
  HISTORY: 'chat:history',
});
export const MAX_TEXT_LENGTH = 2000;
export const HISTORY_LIMIT = 100;
export const CHAT_ACK_TIMEOUT = 8000;
