/**
 * Wire contract shared by renderer and backend. Pure constants and
 * runtime-agnostic helpers only: no Node, Electron, or DOM imports allowed in /shared.
 */
export const DEFAULT_PORT = 3001;
export const PEER_PATH = '/peerjs';
export const DEFAULT_SESSION_ID = 'default';
export const DEFAULT_SESSION_NAME = 'Hakton Tabletop Session';

export const MAX_DISPLAY_NAME_LENGTH = 32;
export const MAX_SESSION_ID_LENGTH = 64;

export const EVENTS = Object.freeze({
  // Built-in socket.io lifecycle is used for connect/disconnect/connect_error.

  // Server Lifecycle
  SERVER_STATUS: 'server:status',
  SERVER_SHUTDOWN: 'server:shutdown',

  // Session Lifecycle & Player Identification
  SESSION_JOIN: 'session:join',
  SESSION_LEAVE: 'session:leave',
  SESSION_WELCOME: 'session:welcome',
  SESSION_PARTICIPANT_JOINED: 'session:participant:joined',
  SESSION_PARTICIPANT_LEFT: 'session:participant:left',
  SESSION_PARTICIPANTS_UPDATE: 'session:participants:update',
  SESSION_ERROR: 'session:error',

  // Board & Game State (existing contracts)
  SESSION_STATE: 'session:state',
  SESSION_PEERS: 'session:peers',
  TOKEN_MOVE: 'token:move',
  TOKEN_MOVED: 'token:moved',

  // 3D Dice Rolling & Chat Log Sync
  DICE_ROLL: 'dice:roll',
  DICE_ROLLED: 'dice:rolled',
});

export const CONNECTION_STATUS = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  FAILED: 'failed',
});

export const ROLES = Object.freeze({
  DM: 'dm',
  PLAYER: 'player',
});

export const SERVER_STATE = Object.freeze({
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
});

/**
 * Error codes returned in session acknowledgments and error events.
 */
export const ERROR_CODES = Object.freeze({
  INVALID_PAYLOAD: 'E_INVALID_PAYLOAD',
  INVALID_SESSION: 'E_INVALID_SESSION',
  INVALID_DISPLAY_NAME: 'E_INVALID_DISPLAY_NAME',
  DUPLICATE_SESSION_MEMBER: 'E_DUPLICATE_SESSION_MEMBER',
  DUPLICATE_PLAYER_IDENTITY: 'E_DUPLICATE_PLAYER_IDENTITY',
  UNAUTHORIZED_ROLE: 'E_UNAUTHORIZED_ROLE',
  UNAUTHORIZED_IDENTITY: 'E_UNAUTHORIZED_IDENTITY',
  SESSION_NOT_FOUND: 'E_SESSION_NOT_FOUND',
  SERVER_SHUTTING_DOWN: 'E_SERVER_SHUTTING_DOWN',
});
