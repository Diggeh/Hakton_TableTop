/**
 * PeerJS signaling & ICE/TURN configuration for Internet Play.
 *
 * Defaults to the free public PeerJS cloud (`0.peerjs.com`) and public STUN servers,
 * with optional overrides via Vite env (`VITE_HAKTON_PEER_*` / `VITE_HAKTON_TURN_*`)
 * or user-saved settings in `localStorage`.
 */

export const NETWORK_CONFIG_STORAGE_KEY = 'hakton.networkConfig.v1';

export const DEFAULT_STUN_SERVERS = Object.freeze([
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]);

function readEnv(key) {
  try {
    return import.meta?.env?.[key] ?? '';
  } catch {
    return '';
  }
}

function getStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function getDefaultNetworkConfig() {
  const envPort = Number(readEnv('VITE_HAKTON_PEER_PORT'));
  const envSecure = String(readEnv('VITE_HAKTON_PEER_SECURE') || '').toLowerCase();
  return {
    signalingHost: String(readEnv('VITE_HAKTON_PEER_HOST') || '').trim(),
    signalingPort: Number.isInteger(envPort) && envPort > 0 ? String(envPort) : '',
    signalingPath: String(readEnv('VITE_HAKTON_PEER_PATH') || '').trim(),
    signalingSecure: envSecure ? envSecure !== 'false' && envSecure !== '0' : true,
    turnUrl: String(readEnv('VITE_HAKTON_TURN_URL') || '').trim(),
    turnUsername: String(readEnv('VITE_HAKTON_TURN_USERNAME') || '').trim(),
    turnCredential: String(readEnv('VITE_HAKTON_TURN_CREDENTIAL') || '').trim(),
  };
}

export function normalizeNetworkConfig(raw = {}) {
  const defaults = getDefaultNetworkConfig();
  const str = (val, fallback) => (typeof val === 'string' ? val.trim() : fallback);
  const portRaw = raw.signalingPort ?? defaults.signalingPort;
  const portNum = Number(portRaw);
  const signalingPort =
    portRaw !== '' && Number.isInteger(portNum) && portNum > 0 && portNum <= 65535
      ? String(portNum)
      : '';

  return {
    signalingHost: str(raw.signalingHost, defaults.signalingHost),
    signalingPort,
    signalingPath: str(raw.signalingPath, defaults.signalingPath),
    signalingSecure:
      typeof raw.signalingSecure === 'boolean' ? raw.signalingSecure : defaults.signalingSecure,
    turnUrl: str(raw.turnUrl, defaults.turnUrl),
    turnUsername: str(raw.turnUsername, defaults.turnUsername),
    turnCredential: str(raw.turnCredential, defaults.turnCredential),
  };
}

export function loadNetworkConfig() {
  const defaults = getDefaultNetworkConfig();
  try {
    const raw = getStorage()?.getItem(NETWORK_CONFIG_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return normalizeNetworkConfig({ ...defaults, ...(parsed && typeof parsed === 'object' ? parsed : {}) });
  } catch {
    return defaults;
  }
}

export function saveNetworkConfig(config = {}) {
  const normalized = normalizeNetworkConfig(config);
  try {
    getStorage()?.setItem(NETWORK_CONFIG_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore storage quota / private mode failures
  }
  return normalized;
}

export function resetNetworkConfig() {
  try {
    getStorage()?.removeItem(NETWORK_CONFIG_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
  return getDefaultNetworkConfig();
}

export function buildIceServers({ iceServers, config } = {}) {
  if (Array.isArray(iceServers) && iceServers.length > 0) {
    return iceServers;
  }
  const cfg = config ?? loadNetworkConfig();
  const servers = DEFAULT_STUN_SERVERS.map((entry) => ({ ...entry }));
  if (cfg.turnUrl) {
    const turn = { urls: cfg.turnUrl };
    if (cfg.turnUsername) turn.username = cfg.turnUsername;
    if (cfg.turnCredential) turn.credential = cfg.turnCredential;
    servers.push(turn);
  }
  return servers;
}

/**
 * Builds PeerJS `Peer` constructor options for Internet Play & mixed-mode voice/video.
 *
 * @param {{ iceServers?: RTCIceServer[], debug?: number, config?: object }} [opts]
 */
export function buildInternetPeerOptions({ iceServers, debug, config } = {}) {
  const cfg = config ?? loadNetworkConfig();
  const options = {
    debug: debug ?? 1,
    config: {
      iceServers: buildIceServers({ iceServers, config: cfg }),
      sdpSemantics: 'unified-plan',
    },
  };

  if (cfg.signalingHost) {
    options.host = cfg.signalingHost;
    if (cfg.signalingPort) {
      options.port = Number(cfg.signalingPort);
    } else {
      options.port = cfg.signalingSecure ? 443 : 80;
    }
    options.path = cfg.signalingPath || '/';
    options.secure = Boolean(cfg.signalingSecure);
  }

  return options;
}
