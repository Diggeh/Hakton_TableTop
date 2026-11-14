import { createAutosaveEngine } from './engine.js';
import { sendAutosave } from './transport.js';
import { autosaveStore } from '../store/autosaveStore.js';
import { sessionStore } from '../store/sessionStore.js';

const QUEUE_KEY = 'hakton.autosave.queue.v1';

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function readQueue() {
  try {
    const raw = storage()?.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeQueue(queue) {
  try {
    const store = storage();
    if (!store) return;
    if (!queue) store.removeItem(QUEUE_KEY);
    else store.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Quota or private mode: keep working in memory.
  }
}

/**
 * Process-wide autosave engine. Debounced at 750 ms with a 5 s hard deadline;
 * offline edits are queued in localStorage and replayed on reconnect.
 */
export const autosave = createAutosaveEngine({
  send: sendAutosave,
  onStatus: (status) => autosaveStore.getState().setStatus(status),
  onSaved: (document) => sessionStore.getState().applySavedDocument(document),
  onConflict: (document) => sessionStore.getState().applyConflictDocument(document),
  loadQueue: readQueue,
  persistQueue: writeQueue,
  debounceMs: 750,
  maxMs: 5000,
});

// Last-chance persistence. The 5 s deadline already covers a normal window
// close; this covers a crash-free reload/quit that happens mid-keystroke.
if (typeof window !== 'undefined') {
  const suspend = () => autosave.suspend();
  window.addEventListener('pagehide', suspend);
  window.addEventListener('beforeunload', suspend);
}

export default autosave;
