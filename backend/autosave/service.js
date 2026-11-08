import { buildBoardSnapshot } from './boardSnapshot.js';

/**
 * Server-side board checkpoint scheduler.
 *
 * Token/map mutations persist immediately through their own handlers; this
 * service debounces the derived recovery blueprint so a burst of drags costs a
 * single snapshot. A hard deadline guarantees a write within `maxMs` even if
 * mutations never stop.
 *
 * @param {{
 *   repos: ReturnType<typeof import('../../database/repositories.js').createRepositories>,
 *   onSaved?: (document: object) => void,
 *   debounceMs?: number,
 *   maxMs?: number,
 *   now?: () => number,
 *   logger?: Console,
 * }} opts
 */
export function createAutosaveService({
  repos,
  onSaved = () => {},
  debounceMs = 500,
  maxMs = 5000,
  now = () => Date.now(),
  logger = console,
} = {}) {
  /** @type {Map<string|number, { updatedBy: string|null, firstAt: number, debounce: any, deadline: any }>} */
  const pending = new Map();
  let stopped = false;

  function clearEntryTimers(entry) {
    if (entry?.debounce) clearTimeout(entry.debounce);
    if (entry?.deadline) clearTimeout(entry.deadline);
    if (entry) {
      entry.debounce = null;
      entry.deadline = null;
    }
  }

  function schedule(campaignId, entry) {
    if (stopped) return;
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
      entry.debounce = null;
      flushCampaign(campaignId);
    }, debounceMs);
    entry.debounce.unref?.();

    if (!entry.deadline) {
      const elapsed = now() - entry.firstAt;
      const remaining = Math.max(0, maxMs - elapsed);
      entry.deadline = setTimeout(() => {
        entry.deadline = null;
        flushCampaign(campaignId);
      }, remaining);
      entry.deadline.unref?.();
    }
  }

  /**
   * Marks a campaign's blueprint dirty. Safe to call after every token/map
   * mutation.
   * @param {number|string|null|undefined} campaignId
   * @param {string|null} [updatedBy]
   */
  function markBoardDirty(campaignId, updatedBy = null) {
    if (campaignId === null || campaignId === undefined) return null;
    const key = campaignId;
    let entry = pending.get(key);
    if (!entry) {
      entry = { updatedBy, firstAt: now(), debounce: null, deadline: null };
      pending.set(key, entry);
    }
    if (updatedBy) entry.updatedBy = updatedBy;
    schedule(key, entry);
    return entry;
  }

  /**
   * Writes one campaign snapshot immediately.
   * @returns {object|null} the saved board document, or null when nothing was pending.
   */
  function flushCampaign(campaignId) {
    const entry = pending.get(campaignId);
    if (!entry) return null;

    clearEntryTimers(entry);
    pending.delete(campaignId);

    if (!repos?.board?.save || !repos?.maps) return null;

    try {
      const snapshot = buildBoardSnapshot(repos, campaignId);
      const saved = repos.board.save(campaignId, snapshot, entry.updatedBy ?? null);
      if (saved) {
        try {
          onSaved(saved);
        } catch (error) {
          logger?.warn?.('[hakton] board autosave listener failed:', error?.message ?? error);
        }
      }
      return saved;
    } catch (error) {
      logger?.warn?.('[hakton] board autosave failed:', error?.message ?? error);
      return null;
    }
  }

  /** Flushes every pending campaign (called on shutdown). */
  function flushAll() {
    const results = [];
    for (const campaignId of [...pending.keys()]) {
      const saved = flushCampaign(campaignId);
      if (saved) results.push(saved);
    }
    return results;
  }

  function stop() {
    stopped = true;
    for (const entry of pending.values()) clearEntryTimers(entry);
    pending.clear();
  }

  function hasPending(campaignId) {
    return campaignId === undefined ? pending.size > 0 : pending.has(campaignId);
  }

  return { markBoardDirty, flushCampaign, flushAll, stop, hasPending };
}
