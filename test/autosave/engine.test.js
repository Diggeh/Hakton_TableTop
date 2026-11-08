import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AUTOSAVE_STATES, createAutosaveEngine } from '../../src/autosave/engine.js';

/** Deterministic timer queue: no real waiting, full control over ordering. */
function createClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();

  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++sequence;
      timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    /** Advances time, firing due timers in chronological order. */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let nextId = null;
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (!next || timer.at < next.at)) {
            nextId = id;
            next = timer;
          }
        }
        if (!next) break;
        timers.delete(nextId);
        now = next.at;
        next.fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function okResponse(payload, revision = 2) {
  return {
    ok: true,
    saveId: payload.saveId,
    documents: payload.documents.map((doc) => ({
      kind: doc.kind,
      scopeId: doc.scopeId,
      revision,
      sheetData: doc.data.sheetData,
    })),
  };
}

const character = (hp, baseRevision = 1) => ({
  kind: 'character',
  scopeId: 'char-mira',
  data: { sheetData: { hp } },
  baseRevision,
});

describe('autosave engine scheduling', () => {
  it('coalesces a burst of edits into one debounced commit', async () => {
    const clock = createClock();
    const calls = [];
    const statuses = [];

    const engine = createAutosaveEngine({
      send: async (payload) => {
        calls.push(payload);
        return okResponse(payload);
      },
      onStatus: (status) => statuses.push(status.state),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      createId: () => 'save-1',
      debounceMs: 750,
      maxMs: 5000,
    });

    engine.markDirty(character(20));
    clock.advance(300);
    engine.markDirty(character(21));
    clock.advance(300);
    engine.markDirty(character(22));

    clock.advance(700);
    await settle();
    assert.equal(calls.length, 0, 'still inside the debounce window');

    clock.advance(100);
    await settle();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].documents.length, 1);
    assert.equal(calls[0].documents[0].data.sheetData.hp, 22, 'latest edit wins');
    assert.equal(calls[0].saveId, 'save-1');
    assert.equal(statuses.at(-1), AUTOSAVE_STATES.SAVED);
    assert.equal(engine.hasPending(), false);
  });

  it('flushes at the 5 s hard deadline even while edits keep arriving', async () => {
    const clock = createClock();
    const calls = [];

    const engine = createAutosaveEngine({
      send: async (payload) => {
        calls.push(payload);
        return okResponse(payload);
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      createId: () => 'save-deadline',
      debounceMs: 750,
      maxMs: 1000,
    });

    // Edits every 100 ms keep resetting the 750 ms debounce, so only the hard
    // deadline can flush. Nine edits = t=900, still before the 1000 ms deadline.
    for (let i = 0; i < 9; i += 1) {
      engine.markDirty(character(i));
      clock.advance(100);
    }
    await settle();
    assert.equal(calls.length, 0, 'continuous edits keep resetting the debounce');

    clock.advance(120);
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].documents[0].data.sheetData.hp, 8);
  });

  it('retries a failed commit with the same saveId', async () => {
    const clock = createClock();
    const calls = [];
    let online = false;

    const engine = createAutosaveEngine({
      send: async (payload) => {
        calls.push(payload);
        if (!online) return { ok: false, reason: 'offline' };
        return okResponse(payload);
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      createId: () => 'save-retry',
      debounceMs: 750,
      maxMs: 5000,
      minRetryMs: 1000,
      maxRetryMs: 30000,
    });

    engine.markDirty(character(20));
    clock.advance(750);
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(engine.getStatus().state, AUTOSAVE_STATES.OFFLINE);

    clock.advance(1000);
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].saveId, calls[0].saveId, 'retry is idempotent');

    online = true;
    clock.advance(2000);
    await settle();
    assert.equal(calls.length, 3);
    assert.equal(calls[2].saveId, 'save-retry');
    assert.equal(engine.hasPending(), false);
    assert.equal(engine.getStatus().state, AUTOSAVE_STATES.SAVED);
  });

  it('persists the offline queue and replays it on resume', async () => {
    const clock = createClock();
    let persisted = null;

    const offlineEngine = createAutosaveEngine({
      send: async () => ({ ok: false, reason: 'offline' }),
      persistQueue: (queue) => {
        persisted = queue;
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      createId: () => 'save-queued',
      debounceMs: 750,
      maxMs: 5000,
    });

    offlineEngine.markDirty(character(7));
    clock.advance(750);
    await settle();

    assert.ok(persisted, 'queue was written to storage');
    assert.equal(persisted.saveId, 'save-queued');
    assert.equal(persisted.documents[0].data.sheetData.hp, 7);

    const replayed = [];
    let rewritten;
    const onlineEngine = createAutosaveEngine({
      send: async (payload) => {
        replayed.push(payload);
        return okResponse(payload);
      },
      loadQueue: () => persisted,
      persistQueue: (queue) => {
        rewritten = queue;
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      debounceMs: 750,
      maxMs: 5000,
    });

    await onlineEngine.resume();
    await settle();

    assert.equal(replayed.length, 1);
    assert.equal(replayed[0].saveId, 'save-queued');
    assert.equal(replayed[0].documents[0].data.sheetData.hp, 7);
    assert.equal(rewritten, null, 'replayed queue is cleared');
    assert.equal(onlineEngine.hasPending(), false);
  });

  it('adopts the server copy on a revision conflict', async () => {
    const clock = createClock();
    const conflicts = [];

    const engine = createAutosaveEngine({
      send: async (payload) => ({
        ok: false,
        reason: 'conflict',
        saveId: payload.saveId,
        documents: [
          {
            kind: 'character',
            scopeId: 'char-mira',
            conflict: true,
            current: { id: 'char-mira', revision: 9, sheetData: { hp: { current: 30 } } },
          },
        ],
      }),
      onConflict: (document) => conflicts.push(document),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      createId: () => 'save-conflict',
      debounceMs: 750,
      maxMs: 5000,
    });

    engine.markDirty(character(1));
    clock.advance(750);
    await settle();

    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].current.revision, 9);
    assert.equal(engine.hasPending(), false, 'local edit is dropped');
  });

  it('keeps edits typed during an in-flight save and advances their baseRevision', async () => {
    const clock = createClock();
    const calls = [];
    let resolveFirst;
    const firstResponse = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    const engine = createAutosaveEngine({
      send: async (payload) => {
        calls.push(payload);
        if (calls.length === 1) return firstResponse;
        return okResponse(payload, 3);
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      createId: () => 'save-inflight',
      debounceMs: 750,
      maxMs: 5000,
    });

    engine.markDirty(character(10, 1));
    clock.advance(750);
    await settle();
    assert.equal(calls.length, 1);

    engine.markDirty(character(11));
    clock.advance(750);
    await settle();
    resolveFirst(okResponse(calls[0], 2));
    await settle();
    await settle();

    assert.equal(calls.length, 2, 'in-flight edit triggers a second commit');
    assert.equal(calls[1].documents[0].data.sheetData.hp, 11);
    assert.equal(calls[1].documents[0].baseRevision, 2, 'follow-up uses the new revision');
    assert.equal(engine.hasPending(), false);
  });
});
