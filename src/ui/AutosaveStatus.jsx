import { AUTOSAVE_STATES } from '../autosave/engine.js';
import { useAutosave } from '../store/autosaveStore.js';

const LABELS = {
  [AUTOSAVE_STATES.IDLE]: 'Ready',
  [AUTOSAVE_STATES.DIRTY]: 'Unsaved changes',
  [AUTOSAVE_STATES.SAVING]: 'Saving…',
  [AUTOSAVE_STATES.SAVED]: 'Saved',
  [AUTOSAVE_STATES.ERROR]: 'Save failed — retrying',
  [AUTOSAVE_STATES.OFFLINE]: 'Offline — edits queued',
};

function timeLabel(timestamp) {
  if (!timestamp) return '';
  try {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/**
 * Live autosave indicator. Purely informational: there is no save button and
 * never a prompt. `aria-live` announces transitions for screen readers.
 */
export default function AutosaveStatus() {
  const state = useAutosave((s) => s.state);
  const pendingCount = useAutosave((s) => s.pendingCount);
  const lastSavedAt = useAutosave((s) => s.lastSavedAt);

  const label = LABELS[state] ?? LABELS[AUTOSAVE_STATES.IDLE];
  const savedAt = state === AUTOSAVE_STATES.SAVED ? timeLabel(lastSavedAt) : '';

  return (
    <span
      className={`autosave-status autosave-${state}`}
      role="status"
      aria-live="polite"
      title={
        pendingCount > 0
          ? `${pendingCount} document${pendingCount === 1 ? '' : 's'} waiting to save`
          : 'Changes save automatically'
      }
    >
      <span className="autosave-dot" aria-hidden="true" />
      {label}
      {savedAt ? <small> · {savedAt}</small> : null}
    </span>
  );
}
