import { io } from 'socket.io-client';
import { EVENTS } from '@shared/events.js';
import { sessionStore } from '@/store/sessionStore.js';

let socket = null;

/** Connects to the embedded backend (or a remote host URL) and binds events to the store. */
export async function connect(url) {
  if (socket) return socket;
  const { setConnection, applySnapshot, moveToken } = sessionStore.getState();

  const target = url ?? (await window.hakton.getServerInfo()).url;
  setConnection('connecting');
  socket = io(target, { transports: ['websocket'] });

  socket.on('connect', () => {
    setConnection('connected');
    socket.emit(EVENTS.SESSION_JOIN);
  });
  socket.on('disconnect', () => setConnection('disconnected'));
  socket.on(EVENTS.SESSION_STATE, applySnapshot);
  socket.on(EVENTS.TOKEN_MOVED, ({ id, x, y }) => moveToken(id, x, y));
  return socket;
}

/** Optimistic local update + broadcast. */
export function emitTokenMove(id, x, y) {
  sessionStore.getState().moveToken(id, x, y);
  socket?.emit(EVENTS.TOKEN_MOVE, { id, x, y });
}
