import { DEFAULT_PORT } from './events.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CHAR_MAP = new Map();
for (let i = 0; i < ALPHABET.length; i += 1) {
  CHAR_MAP.set(ALPHABET[i], BigInt(i));
}
// Crockford visual ambiguity aliases
CHAR_MAP.set('I', 1n);
CHAR_MAP.set('L', 1n);
CHAR_MAP.set('O', 0n);

function parseIpv4Octets(ip) {
  if (typeof ip !== 'string') return null;
  const trimmed = ip.trim();
  if (trimmed === 'localhost') return [127, 0, 0, 1];
  const parts = trimmed.split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function encodeBase32Bits(valueBigInt, charCount) {
  let v = valueBigInt;
  const chars = new Array(charCount);
  for (let i = charCount - 1; i >= 0; i -= 1) {
    chars[i] = ALPHABET[Number(v & 31n)];
    v >>= 5n;
  }
  return chars.join('');
}

function decodeBase32Bits(str) {
  let v = 0n;
  for (let i = 0; i < str.length; i += 1) {
    const digit = CHAR_MAP.get(str[i]);
    if (digit === undefined) {
      throw new Error(`Invalid character "${str[i]}" in room code.`);
    }
    v = (v << 5n) | digit;
  }
  return v;
}

/**
 * Encodes a local IPv4 address and port into a human-friendly Crockford Base32 room code.
 * Uses 8 characters (XXXX-XXXX) when port is in [DEFAULT_PORT..DEFAULT_PORT+254],
 * or 10 characters (XXXXX-XXXXX) for arbitrary 16-bit ports.
 *
 * @param {string} ip
 * @param {number} [port=DEFAULT_PORT]
 * @returns {string}
 */
export function encodeRoomCode(ip = '127.0.0.1', port = DEFAULT_PORT) {
  const octets = parseIpv4Octets(ip) ?? [127, 0, 0, 1];
  const p = Number(port) || DEFAULT_PORT;
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error('Invalid port number.');
  }

  const offset = p - DEFAULT_PORT;
  if (offset >= 0 && offset <= 254) {
    let bits = 0n;
    for (const b of [...octets, offset]) {
      bits = (bits << 8n) | BigInt(b);
    }
    const raw = encodeBase32Bits(bits, 8);
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
  }

  let bits = 0n;
  const bytes = [...octets, (p >> 8) & 0xff, p & 0xff];
  for (const b of bytes) {
    bits = (bits << 8n) | BigInt(b);
  }
  // 48 bits padded with 2 trailing zero bits = 50 bits = 10 Base32 chars
  const raw = encodeBase32Bits(bits << 2n, 10);
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
}

/**
 * Generates an Internet (WebRTC) Room Code (e.g. "NET-7H9K-42M1") derived from a seed or session ID.
 *
 * @param {string} [seed]
 * @returns {string}
 */
export function encodeInternetCode(seed = '') {
  const source = String(seed || Date.now().toString(36)).toUpperCase();
  let hash = 2166136261n;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= BigInt(source.charCodeAt(i));
    hash = (hash * 16777619n) & 0xffffffffn;
  }
  const short = encodeBase32Bits(hash & 0xfffffn, 4);
  return `NET-${short}`;
}

/**
 * Decodes a Room Code (LAN Base32, Internet WebRTC code, or direct host:port)
 * into connection instructions.
 *
 * @param {string} input
 * @returns {{ mode: 'lan' | 'webrtc', hostUrl: string, ip?: string, port?: number, peerId?: string, code?: string }}
 */
export function decodeRoomCode(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Enter a valid room code.');
  }

  const trimmed = input.trim();

  // Direct URL or host:port fallback (e.g. "192.168.1.10:3001", "localhost:3001", "http://...")
  if (
    trimmed.includes('.') ||
    trimmed.includes(':') ||
    /^localhost$/i.test(trimmed)
  ) {
    const hasScheme = /^https?:\/\//i.test(trimmed);
    let url;
    try {
      url = new URL(hasScheme ? trimmed : `http://${trimmed}`);
    } catch {
      throw new Error('Enter a valid room code or host address.');
    }
    if (url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
      throw new Error('Enter a valid room code or host address.');
    }
    if (!hasScheme && !url.port && !/:80$/.test(trimmed)) {
      url.port = String(DEFAULT_PORT);
    }
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    return {
      mode: 'lan',
      ip: url.hostname,
      port,
      hostUrl: url.origin,
      code: trimmed.toUpperCase(),
    };
  }

  const upper = trimmed.toUpperCase().replace(/\s+/g, '');

  // Internet WebRTC Room Code (e.g. "NET-XXXX" or "HK-XXXX")
  if (upper.startsWith('NET-') || upper.startsWith('HK-')) {
    const cleanPayload = upper.replace(/^(NET-|HK-)/, '').replace(/-/g, '');
    if (cleanPayload.length < 4 || cleanPayload.length > 12) {
      throw new Error('Invalid Internet room code.');
    }
    for (let i = 0; i < cleanPayload.length; i += 1) {
      if (!CHAR_MAP.has(cleanPayload[i])) {
        throw new Error(`Invalid character "${cleanPayload[i]}" in room code.`);
      }
    }
    const normalizedCode = `NET-${cleanPayload}`;
    const peerId = `hakton-net-${cleanPayload.toLowerCase()}`;
    return {
      mode: 'webrtc',
      code: normalizedCode,
      peerId,
      hostUrl: `webrtc://${peerId}`,
    };
  }

  // LAN Base32 Code (with optional "LAN-" prefix)
  const withoutPrefix = upper.startsWith('LAN-') ? upper.slice(4) : upper;
  const clean = withoutPrefix.replace(/-/g, '');

  if (clean.length === 8) {
    const bits = decodeBase32Bits(clean);
    const bytes = [];
    let tmp = bits;
    for (let i = 0; i < 5; i += 1) {
      bytes.unshift(Number(tmp & 0xffn));
      tmp >>= 8n;
    }
    const [a, b, c, d, offset] = bytes;
    const ip = `${a}.${b}.${c}.${d}`;
    const port = DEFAULT_PORT + offset;
    return {
      mode: 'lan',
      ip,
      port,
      hostUrl: `http://${ip}:${port}`,
      code: `${clean.slice(0, 4)}-${clean.slice(4, 8)}`,
    };
  }

  if (clean.length === 10) {
    const bits = decodeBase32Bits(clean) >> 2n;
    const bytes = [];
    let tmp = bits;
    for (let i = 0; i < 6; i += 1) {
      bytes.unshift(Number(tmp & 0xffn));
      tmp >>= 8n;
    }
    const [a, b, c, d, hi, lo] = bytes;
    const ip = `${a}.${b}.${c}.${d}`;
    const port = (hi << 8) | lo;
    if (port < 1 || port > 65535) {
      throw new Error('Room code decoded to an invalid port.');
    }
    return {
      mode: 'lan',
      ip,
      port,
      hostUrl: `http://${ip}:${port}`,
      code: `${clean.slice(0, 5)}-${clean.slice(5, 10)}`,
    };
  }

  throw new Error('Room code must be an 8-character LAN code (e.g. 7H9K-42M1) or Internet code (e.g. NET-8Y2P).');
}
