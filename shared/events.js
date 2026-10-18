/**
 * Wire contract shared by renderer and backend. Pure constants only:
 * no Node, Electron, or DOM imports allowed in /shared.
 */
export const DEFAULT_PORT = 3001;
export const PEER_PATH = '/peerjs';

export const EVENTS = Object.freeze({
  // Built-in socket.io lifecycle is used for connect/disconnect.
  SESSION_JOIN: 'session:join',
  SESSION_STATE: 'session:state',
  SESSION_PEERS: 'session:peers',
  TOKEN_MOVE: 'token:move',
  TOKEN_MOVED: 'token:moved',
});
