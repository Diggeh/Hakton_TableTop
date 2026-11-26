/**
 * Pure timestamp parsing and chronological timeline merging for chat messages
 * and dice roll cards. Runtime-agnostic so it can be unit-tested with node:test.
 */

/**
 * Parses ISO-8601 strings, SQLite `YYYY-MM-DD HH:MM:SS` UTC timestamps, or
 * numeric epoch ms into milliseconds since epoch.
 */
export function parseTimestampMs(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value !== 'string') return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;

  let normalized = trimmed;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)) {
    normalized = `${trimmed.replace(' ', 'T')}Z`;
  } else if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)
  ) {
    normalized = `${trimmed}Z`;
  }

  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Combines chat messages and dice rolls into a single chronologically sorted
 * timeline (oldest first, newest at the bottom).
 */
export function mergeChatTimeline(messages = [], rolls = []) {
  const entries = [];

  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    entries.push({
      kind: 'message',
      id: `msg:${m.id}`,
      ts: parseTimestampMs(m.createdAt ?? m.created_at),
      item: m,
    });
  }

  for (const r of Array.isArray(rolls) ? rolls : []) {
    if (!r) continue;
    entries.push({
      kind: 'roll',
      id: `roll:${r.id || r.clientRollId}`,
      ts: parseTimestampMs(r.createdAt ?? r.created_at),
      item: r,
    });
  }

  entries.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    return String(a.id).localeCompare(String(b.id));
  });

  return entries;
}
