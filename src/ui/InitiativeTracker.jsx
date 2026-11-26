import { sortInitiativeEntries } from '../../shared/combat.js';
import { canvasStore, useCanvas } from '../canvas/canvasStore.js';
import { useSession } from '../store/sessionStore.js';
import { IconButton } from './Primitives.jsx';

/**
 * Pure Initiative Tracker popup listing combatants sorted Highest -> Lowest
 * (alphabetical tie-breaker). Displays initiative order only, with no HP values.
 */
export default function InitiativeTracker({ onClose }) {
  const tokens = useSession((s) => s.tokens);
  const selectedIds = useCanvas((s) => s.selectedIds);
  const entries = sortInitiativeEntries(tokens);

  return (
    <aside
      className="floating-popup initiative-window"
      aria-label="Initiative tracker"
    >
      <header>
        <h2>Initiative Tracker</h2>
        <IconButton label="Close initiative tracker" onClick={onClose}>
          ×
        </IconButton>
      </header>
      <div className="initiative-list" role="list">
        {entries.map((token) => {
          const isSelected = selectedIds.includes(token.id);
          return (
            <button
              key={token.id}
              type="button"
              role="listitem"
              className={`initiative-row${isSelected ? ' is-selected' : ''}`}
              title={`Select ${token.label} on canvas`}
              onClick={() => canvasStore.getState().selectToken(token.id, false)}
            >
              <span className="initiative-score">{token.combat.initiative}</span>
              <span
                className="initiative-swatch"
                style={{ background: token.color || '#adfcf9' }}
                aria-hidden="true"
              />
              <span className="initiative-name">{token.label}</span>
            </button>
          );
        })}
        {entries.length === 0 && (
          <p className="initiative-empty">
            No combatants yet. Select a token, click the Sword icon, and enter an
            initiative roll.
          </p>
        )}
      </div>
    </aside>
  );
}
