/**
 * Durable client identity.
 *
 * The raw reconnect token is the only credential a player holds, so it lives
 * here in `localStorage` (never in the database on the client side). The host
 * stores only a SHA-256 digest, so a stolen database cannot be replayed.
 */
const KEY = 'hakton.identity.v1';

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {{
 *   playerId: string,
 *   reconnectToken: string,
 *   displayName?: string,
 *   role?: string,
 *   sessionId?: string,
 *   savedAt?: string,
 * }} Identity
 */

/** @returns {Identity | null} */
export function loadIdentity() {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.playerId || !parsed?.reconnectToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** @param {Identity | null} identity */
export function saveIdentity(identity) {
  try {
    const store = storage();
    if (!store) return null;
    if (!identity?.playerId || !identity?.reconnectToken) {
      store.removeItem(KEY);
      return null;
    }
    const safe = {
      playerId: identity.playerId,
      reconnectToken: identity.reconnectToken,
      displayName: identity.displayName,
      role: identity.role,
      sessionId: identity.sessionId,
      savedAt: new Date().toISOString(),
    };
    store.setItem(KEY, JSON.stringify(safe));
    return safe;
  } catch {
    // Private mode or quota: identity just won't survive an app restart.
    return null;
  }
}

export function clearIdentity() {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Ignore.
  }
}

/** True when two identities point at the same participant. */
export function sameIdentity(a, b) {
  return Boolean(a?.playerId && b?.playerId && a.playerId === b.playerId);
}
