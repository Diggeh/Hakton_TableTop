import { useMemo, useState } from 'react';
import { MAX_DICE_PER_ROLL, MAX_DICE_PER_TERM } from '../../shared/dice/constants.js';
import { buildTrayFormula } from '../../shared/dice/parser.js';
import DiceTrayWell from '../dice/DiceTrayWell.jsx';
import { sessionStore, useSession } from '../store/sessionStore.js';

export { buildTrayFormula };

const TRAY_DIE_ORDER = [4, 6, 8, 10, 20, 12];
const INITIAL_COUNTS = Object.freeze({
  4: 0,
  6: 0,
  8: 0,
  10: 0,
  12: 0,
  20: 0,
  100: 0,
});

function DieSilhouetteIcon({ sides }) {
  switch (sides) {
    case 4:
      return (
        <svg viewBox="0 0 40 40" aria-hidden="true" className="die-token-svg">
          <circle cx="20" cy="20" r="19" className="die-token-ring" />
          <polygon points="20,4 36,33 4,33" className="die-token-shape" />
          <text x="20" y="26.5" className="die-token-text">4</text>
        </svg>
      );
    case 6:
      return (
        <svg viewBox="0 0 40 40" aria-hidden="true" className="die-token-svg">
          <circle cx="20" cy="20" r="19" className="die-token-ring" />
          <rect x="7" y="7" width="26" height="26" rx="4" className="die-token-shape" />
          <text x="20" y="25" className="die-token-text">6</text>
        </svg>
      );
    case 8:
      return (
        <svg viewBox="0 0 40 40" aria-hidden="true" className="die-token-svg">
          <circle cx="20" cy="20" r="19" className="die-token-ring" />
          <polygon points="20,4 36,20 20,36 4,20" className="die-token-shape" />
          <text x="20" y="25" className="die-token-text">8</text>
        </svg>
      );
    case 10:
      return (
        <svg viewBox="0 0 40 40" aria-hidden="true" className="die-token-svg">
          <circle cx="20" cy="20" r="19" className="die-token-ring" />
          <polygon points="20,4 36,19 20,36 4,19" className="die-token-shape" />
          <text x="20" y="24.5" className="die-token-text is-double">10</text>
        </svg>
      );
    case 20:
      return (
        <svg viewBox="0 0 40 40" aria-hidden="true" className="die-token-svg">
          <circle cx="20" cy="20" r="19" className="die-token-ring" />
          <polygon points="20,4 34,12 34,28 20,36 6,28 6,12" className="die-token-shape" />
          <text x="20" y="24.5" className="die-token-text is-double">20</text>
        </svg>
      );
    case 12:
      return (
        <svg viewBox="0 0 40 40" aria-hidden="true" className="die-token-svg">
          <circle cx="20" cy="20" r="19" className="die-token-ring" />
          <polygon points="20,4 36,16 30,35 10,35 4,16" className="die-token-shape" />
          <text x="20" y="25.5" className="die-token-text is-double">12</text>
        </svg>
      );
    case 100:
    default:
      return (
        <svg viewBox="0 0 40 40" aria-hidden="true" className="die-token-svg">
          <circle cx="20" cy="20" r="19" className="die-token-ring" />
          <polygon points="20,4 36,19 20,36 4,19" className="die-token-shape" />
          <text x="20" y="24" className="die-token-text is-triple">100</text>
        </svg>
      );
  }
}

/**
 * Expands the user's selected `diceCounts` + `rollMode` into the exact array of 3D physical
 * dice descriptors to display inside the top Dice Tray 3D well.
 */
export function expandSelectedTrayDice(diceCounts, rollMode = 'Normal') {
  const entries = [4, 6, 8, 10, 20, 12, 100]
    .map((sides) => [sides, Number(diceCounts?.[sides]) || 0])
    .filter(([, c]) => c > 0);

  if (entries.length === 0) return [];

  const hasD20 = entries.some(([s]) => s === 20);
  const physical = [];

  entries.forEach(([sides, rawCount], idx) => {
    const applyKeep = hasD20 ? sides === 20 : idx === 0;
    const effectiveCount =
      applyKeep && (rollMode === 'Advantage' || rollMode === 'Disadvantage')
        ? Math.max(2, rawCount)
        : rawCount;

    for (let i = 0; i < effectiveCount; i++) {
      if (sides === 100) {
        physical.push({ kind: 'd10', variant: 'd100', sides: 100 });
        physical.push({ kind: 'd10', variant: 'd10', sides: 100 });
      } else {
        const kind = `d${sides}`;
        physical.push({ kind, variant: kind, sides });
      }
    }
  });

  return physical;
}

export default function DiceTray({
  rollMode = 'Normal',
  setRollMode,
  die = 20,
  setDie,
  count = 1,
  setCount,
  modifier = 0,
  setModifier,
  visibility = 'Public',
  setVisibility,
  role,
  onPrepare,
  onRollFormula,
}) {
  const [diceCounts, setDiceCounts] = useState({ ...INITIAL_COUNTS });
  const [error, setError] = useState('');

  const activeRoll = useSession((s) => s.activeRoll);
  const settledTrayRoll = useSession((s) => s.settledTrayRoll);

  const totalPickedCount = Object.values(diceCounts).reduce((sum, n) => sum + n, 0);

  const selectedDice = useMemo(
    () => expandSelectedTrayDice(diceCounts, rollMode),
    [diceCounts, rollMode],
  );

  const formulaPreview = useMemo(
    () => buildTrayFormula({ diceCounts, die, count, modifier, rollMode }),
    [diceCounts, die, count, modifier, rollMode],
  );

  function addDie(sides) {
    setError('');
    if (totalPickedCount >= MAX_DICE_PER_ROLL) {
      setError(`Maximum ${MAX_DICE_PER_ROLL} dice per roll.`);
      return;
    }
    const nextForSides = Math.min(MAX_DICE_PER_TERM, (diceCounts[sides] || 0) + 1);
    const nextCounts = { ...diceCounts, [sides]: nextForSides };
    setDiceCounts(nextCounts);
    setDie?.(sides);
    setCount?.(nextForSides);
  }

  function removeOneDie(sides, e) {
    e.preventDefault();
    setError('');
    const current = diceCounts[sides] || 0;
    if (current <= 0) return;
    const nextCounts = { ...diceCounts, [sides]: current - 1 };
    setDiceCounts(nextCounts);
  }

  function clearTray() {
    setError('');
    setDiceCounts({ ...INITIAL_COUNTS });
    setRollMode?.('Normal');
    setModifier?.(0);
    sessionStore.getState().clearSettledTrayRoll?.();
  }

  function adjustModifier(delta) {
    const next = Math.max(-99, Math.min(99, (Number(modifier) || 0) + delta));
    setModifier?.(next);
  }

  function handleRoll() {
    setError('');
    if (!formulaPreview) return;

    if (onRollFormula) {
      const result = onRollFormula(formulaPreview, visibility);
      if (result && !result.ok) {
        setError(result.error || 'Invalid dice formula.');
        return;
      }
      // Clear staged selection so the dice launch onto the board and then pop back in on settle
      setDiceCounts({ ...INITIAL_COUNTS });
    } else if (onPrepare) {
      onPrepare();
    }
  }

  const modifierLabel =
    modifier === 0
      ? 'modifier'
      : modifier > 0
        ? `+${modifier}`
        : `${modifier}`;

  return (
    <section className="dice-tray" aria-label="Dice Tray">
      {role === 'DM' && (
        <div className="dice-tray-title-row">
          <button
            type="button"
            className={`dice-visibility-pill ${visibility === 'DM only' ? 'is-dm' : ''}`}
            title="Toggle roll visibility (Public vs DM only)"
            onClick={() =>
              setVisibility?.(visibility === 'DM only' ? 'Public' : 'DM only')
            }
          >
            {visibility === 'DM only' ? 'DM' : 'PUB'}
          </button>
        </div>
      )}

      <div className="dice-tray-shell">
        <DiceTrayWell
          selectedDice={selectedDice}
          formulaPreview={formulaPreview}
          settledRoll={settledTrayRoll}
          isBoardRolling={Boolean(activeRoll)}
          onRoll={handleRoll}
        />

        <div className="dice-options" role="group" aria-label="Polyhedral dice">
          {TRAY_DIE_ORDER.map((d) => {
            const picked = diceCounts[d] || 0;
            return (
              <button
                key={d}
                type="button"
                className={`die-token-btn ${picked > 0 ? 'is-picked' : ''}`}
                aria-label={`Add d${d}${picked > 0 ? ` (${picked} selected)` : ''}`}
                aria-pressed={picked > 0}
                title={`Left-click: add d${d} · Right-click: remove one`}
                onClick={() => addDie(d)}
                onContextMenu={(e) => removeOneDie(d, e)}
              >
                <DieSilhouetteIcon sides={d} />
                {picked > 0 && (
                  <span className="die-picked-badge" aria-hidden="true">
                    {picked}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="dice-d100-clear-row">
          <button
            type="button"
            className={`die-token-btn dice-d100-box ${(diceCounts[100] || 0) > 0 ? 'is-picked' : ''}`}
            aria-label={`Add d100${(diceCounts[100] || 0) > 0 ? ` (${diceCounts[100]} selected)` : ''}`}
            aria-pressed={(diceCounts[100] || 0) > 0}
            title="Left-click: add d100 · Right-click: remove one"
            onClick={() => addDie(100)}
            onContextMenu={(e) => removeOneDie(100, e)}
          >
            <DieSilhouetteIcon sides={100} />
            {(diceCounts[100] || 0) > 0 && (
              <span className="die-picked-badge" aria-hidden="true">
                {diceCounts[100]}
              </span>
            )}
          </button>

          <button
            type="button"
            className="dice-clear-btn"
            aria-label="Clear dice tray"
            disabled={
              totalPickedCount === 0 &&
              !settledTrayRoll &&
              modifier === 0 &&
              rollMode === 'Normal'
            }
            onClick={clearTray}
          >
            CLEAR
          </button>
        </div>

        <div className="roll-modes" role="group" aria-label="Roll mode">
          {['Advantage', 'Disadvantage'].map((mode) => {
            const active = rollMode === mode;
            return (
              <button
                key={mode}
                type="button"
                title={mode}
                aria-pressed={active}
                className={`roll-mode-pill ${active ? 'is-active' : ''}`}
                onClick={() => setRollMode?.(active ? 'Normal' : mode)}
              >
                {mode === 'Advantage' ? 'ADV' : 'DIS'}
              </button>
            );
          })}
        </div>

        <div className="dice-modifier-bar" role="group" aria-label="Roll modifier">
          <button
            type="button"
            className="dice-mod-step"
            aria-label="Decrease modifier"
            onClick={() => adjustModifier(-1)}
          >
            −
          </button>
          <button
            type="button"
            className={`dice-mod-display ${modifier !== 0 ? 'has-value' : ''}`}
            title="Click to reset modifier to 0"
            onClick={() => setModifier?.(0)}
          >
            {modifierLabel}
          </button>
          <button
            type="button"
            className="dice-mod-step"
            aria-label="Increase modifier"
            onClick={() => adjustModifier(1)}
          >
            +
          </button>
        </div>

        {error && (
          <p className="dice-tray-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
