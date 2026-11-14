export const AUTOSAVE_STATES = Object.freeze({
  IDLE: 'idle',
  DIRTY: 'dirty',
  SAVING: 'saving',
  SAVED: 'saved',
  ERROR: 'error',
  OFFLINE: 'offline',
});

const keyFor = (kind, scopeId) => `${kind}:${scopeId}`;

const defaultCreateId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `save-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Transport-agnostic autosave scheduler.
 *
 * Guarantees:
 *  - edits are coalesced per document and flushed 750 ms after the last edit;
 *  - a hard deadline flushes within 5 s of the first unflushed edit;
 *  - retries reuse the same `saveId`, so the server can dedupe them;
 *  - failed/offline edits are persisted through the injected queue adapter.
 *
 * Timers and the clock are injectable so tests never wait for real seconds.
 *
 * @param {{
 *   send: (payload: object) => Promise<object>,
 *   onStatus?: (status: object) => void,
 *   onSaved?: (document: object) => void,
 *   onConflict?: (document: object) => void,
 *   loadQueue?: () => object|null,
 *   persistQueue?: (queue: object|null) => void,
 *   debounceMs?: number,
 *   maxMs?: number,
 *   minRetryMs?: number,
 *   maxRetryMs?: number,
 *   setTimeout?: (fn: Function, ms: number) => any,
 *   clearTimeout?: (handle: any) => void,
 *   now?: () => number,
 *   createId?: () => string,
 * }} opts
 */
export function createAutosaveEngine({
  send,
  onStatus = () => {},
  onSaved = () => {},
  onConflict = () => {},
  loadQueue = () => null,
  persistQueue = () => {},
  debounceMs = 750,
  maxMs = 5000,
  minRetryMs = 1000,
  maxRetryMs = 30000,
  setTimeout: setT = (fn, ms) => setTimeout(fn, ms),
  clearTimeout: clearT = (handle) => clearTimeout(handle),
  now = () => Date.now(),
  createId = defaultCreateId,
} = {}) {
  if (typeof send !== 'function') throw new TypeError('autosave engine requires a send function');

  /** @type {Map<string, { kind: string, scopeId: string, data: object, baseRevision: number|null }>} */
  const documents = new Map();

  let debounceTimer = null;
  let deadlineTimer = null;
  let retryTimer = null;
  let inFlight = null;
  let flushAgain = false;
  let retryDelay = minRetryMs;
  let currentSaveId = null;
  let loaded = false;
  let destroyed = false;

  let state = AUTOSAVE_STATES.IDLE;
  let lastSavedAt = null;
  let lastError = null;

  function statusPayload() {
    return {
      state,
      pendingCount: documents.size,
      lastSavedAt,
      error: lastError,
    };
  }

  function emitState(nextState, error = null) {
    state = nextState;
    lastError = error;
    try {
      onStatus(statusPayload());
    } catch {
      // Status listeners must never break saving.
    }
  }

  function clearTimer(handle) {
    if (handle) clearT(handle);
    return null;
  }

  function clearFlushTimers() {
    debounceTimer = clearTimer(debounceTimer);
    deadlineTimer = clearTimer(deadlineTimer);
  }

  function clearRetryTimer() {
    retryTimer = clearTimer(retryTimer);
  }

  function serializeQueue() {
    if (documents.size === 0) return null;
    return {
      saveId: currentSaveId,
      documents: [...documents.values()].map((doc) => ({
        kind: doc.kind,
        scopeId: doc.scopeId,
        data: doc.data,
        baseRevision: doc.baseRevision ?? null,
      })),
    };
  }

  function persist() {
    try {
      persistQueue(serializeQueue());
    } catch {
      // Storage may be unavailable (private mode, quota). Saving still works online.
    }
  }

  function scheduleRetry() {
    if (destroyed) return;
    clearRetryTimer();
    const delay = retryDelay;
    retryTimer = setT(() => {
      retryTimer = null;
      flush();
    }, delay);
    retryTimer?.unref?.();
    retryDelay = Math.min(Math.max(retryDelay * 2, minRetryMs), maxRetryMs);
  }

  function armTimers() {
    if (destroyed) return;

    if (debounceTimer) clearT(debounceTimer);
    debounceTimer = setT(() => {
      debounceTimer = null;
      flush();
    }, debounceMs);
    debounceTimer?.unref?.();

    if (!deadlineTimer) {
      const elapsed = 0;
      deadlineTimer = setT(() => {
        deadlineTimer = null;
        flush();
      }, Math.max(0, maxMs - elapsed));
      deadlineTimer?.unref?.();
    }
  }

  /**
   * Marks a document dirty. Repeated calls for the same `kind:scopeId` replace
   * the pending payload instead of queueing a second write.
   *
   * @param {{ kind: string, scopeId: string, data: object, baseRevision?: number|null }} doc
   */
  function markDirty(doc) {
    if (!doc?.kind || !doc?.scopeId) throw new TypeError('autosave document requires kind and scopeId');
    const key = keyFor(doc.kind, doc.scopeId);
    const previous = documents.get(key);

    documents.set(key, {
      kind: doc.kind,
      scopeId: doc.scopeId,
      data: doc.data ?? {},
      baseRevision:
        doc.baseRevision !== undefined
          ? doc.baseRevision
          : previous?.baseRevision ?? null,
    });

    clearRetryTimer();
    emitState(AUTOSAVE_STATES.DIRTY);
    armTimers();
  }

  function handleFailure(reason, error = null) {
    persist();
    if (reason === 'offline' || reason === 'timeout' || reason === 'no_response' || reason === 'disconnected') {
      emitState(AUTOSAVE_STATES.OFFLINE, error);
    } else {
      emitState(AUTOSAVE_STATES.ERROR, error || reason);
    }
    scheduleRetry();
  }

  function handleResponse(response, batch) {
    if (!response || typeof response !== 'object') {
      handleFailure('no_response');
      return;
    }
    if (
      response.ok === false &&
      (response.reason === 'offline' ||
        response.reason === 'timeout' ||
        response.reason === 'no_response' ||
        response.reason === 'rate_limited' ||
        response.reason === 'storage_error')
    ) {
      handleFailure(response.reason, response.reason);
      return;
    }

    const remoteByKey = new Map();
    for (const remote of response.documents ?? []) {
      if (!remote?.kind || !remote?.scopeId) continue;
      remoteByKey.set(keyFor(remote.kind, remote.scopeId), remote);
    }

    let hardError = null;

    for (const item of batch) {
      const remote = remoteByKey.get(item.key);
      if (!remote) continue;

      if (remote.conflict) {
        documents.delete(item.key);
        try {
          onConflict(remote);
        } catch {
          // UI conflict handling is best-effort.
        }
        continue;
      }

      if (remote.error) {
        if (remote.error === 'forbidden' || remote.error === 'storage_unavailable') {
          hardError = remote.error;
        }
        continue;
      }

      try {
        onSaved(remote);
      } catch {
        // Best-effort UI update.
      }

      const entry = documents.get(item.key);
      if (!entry) continue;

      // Edits that arrived while this save was in flight stay dirty; their
      // baseRevision advances so the follow-up commit does not self-conflict.
      if (JSON.stringify(entry.data) === item.sentSnapshot) {
        documents.delete(item.key);
      } else {
        documents.set(item.key, {
          ...entry,
          baseRevision: remote.revision ?? entry.baseRevision,
        });
      }
    }

    currentSaveId = null;
    clearRetryTimer();
    retryDelay = minRetryMs;

    if (response.ok === false && response.reason === 'conflict' && documents.size === 0) {
      // Conflicts are resolved by adopting the server copy.
    }

    if (hardError && documents.size > 0) {
      persist();
      emitState(AUTOSAVE_STATES.ERROR, hardError);
      return;
    }

    if (documents.size > 0) {
      persist();
      emitState(AUTOSAVE_STATES.DIRTY);
      armTimers();
      return;
    }

    lastSavedAt = now();
    persist();
    emitState(AUTOSAVE_STATES.SAVED);
  }

  /**
   * Flushes every dirty document as one batched commit.
   * @returns {Promise<void>}
   */
  function flush() {
    clearFlushTimers();

    if (inFlight) {
      flushAgain = true;
      return inFlight;
    }
    if (documents.size === 0) {
      emitState(lastSavedAt ? AUTOSAVE_STATES.SAVED : AUTOSAVE_STATES.IDLE);
      return Promise.resolve();
    }

    if (!currentSaveId) currentSaveId = createId();

    const batch = [...documents.entries()].map(([key, doc]) => ({
      key,
      kind: doc.kind,
      scopeId: doc.scopeId,
      data: doc.data,
      baseRevision: doc.baseRevision ?? null,
      sentSnapshot: JSON.stringify(doc.data),
    }));

    const payload = {
      saveId: currentSaveId,
      documents: batch.map(({ key, sentSnapshot, ...doc }) => doc),
    };

    emitState(AUTOSAVE_STATES.SAVING);

    // Invoke the transport synchronously so a flush triggered just before a
    // disconnect/quit still gets its frame onto the socket.
    let sending;
    try {
      sending = send(payload);
    } catch (error) {
      sending = Promise.reject(error);
    }

    inFlight = Promise.resolve(sending)
      .then((response) => handleResponse(response, batch))
      .catch((error) => handleFailure('offline', error?.message ?? 'network error'))
      .finally(() => {
        inFlight = null;
        if (flushAgain) {
          flushAgain = false;
          if (documents.size > 0) flush();
        }
      });

    return inFlight;
  }

  /**
   * Restores a persisted offline queue (if any) and immediately flushes it.
   * Called on connect/welcome.
   */
  function resume() {
    if (destroyed) return Promise.resolve();

    if (!loaded) {
      loaded = true;
      try {
        const queued = loadQueue();
        if (queued && Array.isArray(queued.documents)) {
          if (typeof queued.saveId === 'string' && queued.saveId) {
            currentSaveId = queued.saveId;
          }
          for (const doc of queued.documents) {
            if (!doc?.kind || !doc?.scopeId) continue;
            documents.set(keyFor(doc.kind, doc.scopeId), {
              kind: doc.kind,
              scopeId: doc.scopeId,
              data: doc.data ?? {},
              baseRevision: doc.baseRevision ?? null,
            });
          }
        }
      } catch {
        // Ignore a malformed queue.
      }
    }

    clearRetryTimer();
    retryDelay = minRetryMs;

    if (documents.size === 0) return Promise.resolve();

    emitState(AUTOSAVE_STATES.DIRTY);
    return flush();
  }

  /** Persists the queue immediately; used on disconnect and before unload. */
  function suspend() {
    persist();
    if (documents.size > 0) emitState(AUTOSAVE_STATES.OFFLINE);
    return statusPayload();
  }

  /** Drops all pending edits (explicit leave: they belong to the old session). */
  function discard() {
    documents.clear();
    currentSaveId = null;
    clearFlushTimers();
    clearRetryTimer();
    retryDelay = minRetryMs;
    loaded = true;
    persist();
    emitState(AUTOSAVE_STATES.IDLE);
    return statusPayload();
  }

  /** Forces an immediate flush (e.g. user pressed "Retry now"). */
  function retryNow() {
    clearRetryTimer();
    retryDelay = minRetryMs;
    return flush();
  }

  function destroy() {
    destroyed = true;
    clearFlushTimers();
    clearRetryTimer();
  }

  return {
    markDirty,
    flush,
    resume,
    suspend,
    discard,
    retryNow,
    destroy,
    persist,
    getStatus: statusPayload,
    hasPending: () => documents.size > 0,
    pendingCount: () => documents.size,
  };
}
