import { AUTOSAVE_KINDS, EVENTS, ROLES } from '../../shared/events.js';
import { characterToWire, dmRecordToWire } from './wire.js';

const MAX_DOCUMENTS = 20;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_SAVE_ID_LENGTH = 128;
const RATE_LIMIT_COMMITS = 10;
const RATE_LIMIT_WINDOW_MS = 5000;

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function validDocument(doc) {
  if (!isPlainObject(doc)) return false;
  if (doc.kind !== AUTOSAVE_KINDS.CHARACTER && doc.kind !== AUTOSAVE_KINDS.DM_RECORD) {
    return false;
  }
  if (typeof doc.scopeId !== 'string' || !doc.scopeId || doc.scopeId.length > 128) {
    return false;
  }
  if (
    doc.baseRevision !== null &&
    doc.baseRevision !== undefined &&
    !Number.isInteger(doc.baseRevision)
  ) {
    return false;
  }
  if (!isPlainObject(doc.data)) return false;
  try {
    return JSON.stringify(doc.data).length <= MAX_DOCUMENT_BYTES;
  } catch {
    return false;
  }
}

function emitToSockets(io, sessionId, predicate, payload) {
  if (!sessionId) return;
  for (const peer of io.sockets.sockets.values()) {
    if (peer.data?.sessionId !== sessionId) continue;
    if (predicate(peer)) peer.emit(EVENTS.AUTOSAVE_SAVED, payload);
  }
}

/**
 * Registers `autosave:commit` for one socket.
 *
 * The server owns validation, permissions, and conflict detection. A client
 * can only propose document contents; it cannot choose where they are stored.
 *
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {{
 *   repos: ReturnType<typeof import('../../database/repositories.js').createRepositories>,
 *   sessionManager?: object,
 *   autosave?: object,
 * }} deps
 */
export function registerAutosaveHandlers(io, socket, { repos } = {}) {
  let windowStartedAt = 0;
  let windowCount = 0;

  const rateLimited = () => {
    const now = Date.now();
    if (now - windowStartedAt > RATE_LIMIT_WINDOW_MS) {
      windowStartedAt = now;
      windowCount = 0;
    }
    windowCount += 1;
    return windowCount > RATE_LIMIT_COMMITS;
  };

  const isDM = () => socket.data?.role === ROLES.DM;
  const playerId = () => socket.data?.playerId ?? null;
  const isJoined = () => Boolean(socket.data?.playerId && socket.data?.sessionId);

  function saveCharacterDocument(doc, savedDocs) {
    const existing = repos.characters?.get?.(doc.scopeId) ?? null;
    const dm = isDM();
    const ownerId = playerId();

    if (!existing) {
      if (!dm) return { kind: doc.kind, scopeId: doc.scopeId, error: 'forbidden' };
      const result = repos.characters.saveWithRevision({
        id: doc.scopeId,
        ownerId: ownerId ?? 'unassigned',
        name: typeof doc.data.name === 'string' ? doc.data.name : doc.scopeId,
        classLevel: doc.data.classLevel ?? null,
        sheetData: doc.data.sheetData ?? {},
        inventoryData: doc.data.inventoryData ?? {},
        baseRevision: null,
      });
      if (result.conflict) {
        return { kind: doc.kind, scopeId: doc.scopeId, conflict: true, current: null };
      }
      const wire = {
        kind: doc.kind,
        scopeId: doc.scopeId,
        ...characterToWire(result.character),
      };
      savedDocs.push(wire);
      return wire;
    }

    if (!dm && existing.owner_id !== ownerId) {
      return { kind: doc.kind, scopeId: doc.scopeId, error: 'forbidden' };
    }

    const result = repos.characters.saveWithRevision({
      id: doc.scopeId,
      ownerId: existing.owner_id,
      name: typeof doc.data.name === 'string' ? doc.data.name : existing.name,
      classLevel: doc.data.classLevel ?? existing.class_level,
      sheetData: doc.data.sheetData ?? existing.sheet_data,
      inventoryData: doc.data.inventoryData ?? existing.inventory_data,
      baseRevision: doc.baseRevision ?? null,
    });

    if (result.conflict) {
      return {
        kind: doc.kind,
        scopeId: doc.scopeId,
        conflict: true,
        current: characterToWire(result.current),
      };
    }
    const wire = {
      kind: doc.kind,
      scopeId: doc.scopeId,
      ...characterToWire(result.character),
    };
    savedDocs.push(wire);
    return wire;
  }

  function saveDmRecordDocument(doc, savedDocs) {
    if (!isDM()) return { kind: doc.kind, scopeId: doc.scopeId, error: 'forbidden' };
    if (!repos.dmRecords?.saveWithRevision) {
      return { kind: doc.kind, scopeId: doc.scopeId, error: 'storage_unavailable' };
    }

    const existing = repos.dmRecords.get(doc.scopeId);
    const result = repos.dmRecords.saveWithRevision({
      id: doc.scopeId,
      category: doc.data.category ?? existing?.category ?? 'session-notes',
      title: doc.data.title ?? existing?.title ?? 'Session notes',
      data: doc.data.content ?? existing?.data ?? {},
      baseRevision: doc.baseRevision ?? null,
    });

    if (result.conflict) {
      return {
        kind: doc.kind,
        scopeId: doc.scopeId,
        conflict: true,
        current: dmRecordToWire(result.current),
      };
    }
    const wire = {
      kind: doc.kind,
      scopeId: doc.scopeId,
      ...dmRecordToWire(result.record),
    };
    savedDocs.push(wire);
    return wire;
  }

  function broadcastSavedDocument(savedDoc, saveId) {
    const payload = {
      saveId,
      savedBy: playerId(),
      savedAt: new Date().toISOString(),
      documents: [savedDoc],
    };

    if (savedDoc.kind === AUTOSAVE_KINDS.DM_RECORD) {
      emitToSockets(io, socket.data.sessionId, (peer) => peer.data?.role === ROLES.DM, payload);
      return;
    }

    const ownerId = savedDoc.ownerId ?? null;
    emitToSockets(
      io,
      socket.data.sessionId,
      (peer) =>
        peer.data?.role === ROLES.DM ||
        (ownerId !== null && peer.data?.playerId === ownerId),
      payload,
    );
  }

  socket.on(EVENTS.AUTOSAVE_COMMIT, (payload = {}, maybeAck) => {
    const ack = typeof maybeAck === 'function' ? maybeAck : null;
    const respond = (response) => {
      if (ack) ack(response);
      else socket.emit(EVENTS.AUTOSAVE_ERROR, response);
    };

    if (!isJoined()) {
      respond({ ok: false, reason: 'not_joined' });
      return;
    }

    if (rateLimited()) {
      respond({ ok: false, reason: 'rate_limited' });
      return;
    }

    const saveId = payload?.saveId;
    if (typeof saveId !== 'string' || !saveId || saveId.length > MAX_SAVE_ID_LENGTH) {
      respond({ ok: false, reason: 'invalid_payload' });
      return;
    }

    const documents = payload?.documents;
    if (!Array.isArray(documents) || documents.length === 0 || documents.length > MAX_DOCUMENTS) {
      respond({ ok: false, reason: 'invalid_payload' });
      return;
    }

    if (!documents.every(validDocument)) {
      respond({ ok: false, saveId, reason: 'invalid_payload' });
      return;
    }

    // Replay protection: a retried commit returns the original verdict.
    try {
      const cached = repos.autosaveReceipts?.get?.(saveId);
      if (cached) {
        if (ack) ack(cached);
        return;
      }
    } catch {
      // A broken receipt table must not block saving.
    }

    let sawConflict = false;
    let sawForbidden = false;
    let sawStorageError = false;
    /** @type {object[]} */
    const results = [];
    /** @type {object[]} */
    const savedDocs = [];

    for (const doc of documents) {
      try {
        if (doc.kind === AUTOSAVE_KINDS.CHARACTER) {
          if (!repos.characters?.saveWithRevision) {
            sawStorageError = true;
            results.push({ kind: doc.kind, scopeId: doc.scopeId, error: 'storage_unavailable' });
            continue;
          }
          const outcome = saveCharacterDocument(doc, savedDocs);
          if (outcome.conflict) sawConflict = true;
          if (outcome.error === 'forbidden') sawForbidden = true;
          if (outcome.error === 'storage_unavailable') sawStorageError = true;
          results.push(outcome);
        } else {
          const outcome = saveDmRecordDocument(doc, savedDocs);
          if (outcome.conflict) sawConflict = true;
          if (outcome.error === 'forbidden') sawForbidden = true;
          if (outcome.error === 'storage_unavailable') sawStorageError = true;
          results.push(outcome);
        }
      } catch {
        sawStorageError = true;
        results.push({ kind: doc.kind, scopeId: doc.scopeId, error: 'storage_error' });
      }
    }

    let reason = null;
    if (sawStorageError) reason = 'storage_error';
    else if (sawConflict) reason = 'conflict';
    else if (sawForbidden) reason = 'forbidden';

    const response = {
      ok: reason === null,
      saveId,
      savedAt: new Date().toISOString(),
      documents: results,
      ...(reason ? { reason } : {}),
    };

    try {
      repos.autosaveReceipts?.save?.(saveId, response);
    } catch {
      // Receipts are an optimization, not a correctness requirement.
    }

    for (const savedDoc of savedDocs) {
      try {
        broadcastSavedDocument(savedDoc, saveId);
      } catch {
        // Broadcasting is best-effort; the ack already carries the result.
      }
    }

    if (ack) ack(response);
  });
}
