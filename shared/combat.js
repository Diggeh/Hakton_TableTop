/**
 * Pure combat, initiative sorting, and role-based HP visibility helpers.
 * Runtime-agnostic: safe for both Node backend and React/Zustand renderer.
 */

function parseOptionalInt(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeOwnerRole(role) {
  if (role === 'dm' || role === 'DM') return 'dm';
  if (role === 'player' || role === 'Player') return 'player';
  return null;
}

export function sanitizeCombat(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const maxHp = parseOptionalInt(raw.maxHp, 1, 99999);
  const hp = parseOptionalInt(raw.hp, 0, 99999);
  return {
    enabled: Boolean(raw.enabled),
    initiative: parseOptionalInt(raw.initiative, -99, 999),
    hp,
    maxHp,
  };
}

export function resolveTokenOwnerRole(token, participants = []) {
  const direct = normalizeOwnerRole(token?.ownerRole ?? token?.owner_role);
  if (direct) return direct;
  const ownerId = token?.ownerId ?? token?.owner_id ?? null;
  if (ownerId && Array.isArray(participants)) {
    const match = participants.find((p) => p?.id === ownerId);
    const matchedRole = normalizeOwnerRole(match?.role);
    if (matchedRole) return matchedRole;
  }
  return null;
}

/**
 * Ownership visibility rule:
 * - DM-owned or unassigned tokens: HP is visible ONLY to the DM.
 * - Player-owned tokens: HP is visible ONLY to the owner and other Players (hidden from DM).
 */
export function canViewTokenHp(token, viewerRole, participants = []) {
  const role = normalizeOwnerRole(viewerRole) || 'player';
  const ownerRole = resolveTokenOwnerRole(token, participants);
  if (ownerRole === 'player') {
    return role === 'player';
  }
  return role === 'dm';
}

export function stripHiddenCombatFields(token, viewerRole, participants = []) {
  if (!token || !token.combat) return token;
  if (canViewTokenHp(token, viewerRole, participants)) {
    return {
      ...token,
      combat: {
        ...token.combat,
        hpHidden: false,
      },
    };
  }
  return {
    ...token,
    combat: {
      ...token.combat,
      hp: null,
      maxHp: null,
      hpHidden: true,
    },
  };
}

/**
 * Sort active combatants from highest initiative to lowest, breaking ties
 * alphabetically by label (then id). Tokens without a numeric initiative are excluded.
 */
export function sortInitiativeEntries(tokens) {
  const list = Array.isArray(tokens)
    ? tokens
    : tokens && typeof tokens === 'object'
      ? Object.values(tokens)
      : [];

  return list
    .filter(
      (token) =>
        token &&
        !token.isMap &&
        Boolean(token.combat?.enabled) &&
        token.combat?.initiative !== null &&
        token.combat?.initiative !== undefined &&
        Number.isFinite(Number(token.combat.initiative)),
    )
    .sort((a, b) => {
      const diff = Number(b.combat.initiative) - Number(a.combat.initiative);
      if (diff !== 0) return diff;
      const labelCmp = String(a.label || '').localeCompare(
        String(b.label || ''),
        undefined,
        { sensitivity: 'base' },
      );
      if (labelCmp !== 0) return labelCmp;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
}
