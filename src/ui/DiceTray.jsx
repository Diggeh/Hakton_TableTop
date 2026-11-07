export default function DiceTray({
  rollMode,
  setRollMode,
  die,
  setDie,
  count,
  setCount,
  modifier,
  setModifier,
  visibility,
  setVisibility,
  role,
  onPrepare,
}) {
  return (
    <section className="dice-tray">
      <h2>Dice tray</h2>
      <div className="dice-well" aria-label="Prepared dice">
        {count}d{die}
        {modifier ? `${modifier > 0 ? '+' : ''}${modifier}` : ''}
      </div>
      <div className="dice-options">
        {[4, 6, 8, 10, 12, 20, 100].map((d) => (
          <button key={d} aria-pressed={die === d} onClick={() => setDie(d)}>
            d{d}
          </button>
        ))}
      </div>
      <div className="roll-modes">
        {['Advantage', 'Disadvantage'].map((mode) => (
          <button
            key={mode}
            title={mode}
            aria-pressed={rollMode === mode}
            onClick={() => setRollMode(rollMode === mode ? 'Normal' : mode)}
          >
            {mode === 'Advantage' ? 'ADV' : 'DIS'}
          </button>
        ))}
      </div>
      <div className="dice-fields">
        <label>
          Count
          <input
            type="number"
            min="1"
            max="20"
            value={count}
            onChange={(e) =>
              setCount(Math.max(1, Math.min(20, Number(e.target.value))))
            }
          />
        </label>
        <label>
          Modifier
          <input
            type="number"
            min="-99"
            max="99"
            value={modifier}
            onChange={(e) =>
              setModifier(Math.max(-99, Math.min(99, Number(e.target.value))))
            }
          />
        </label>
      </div>
      <select
        aria-label="Roll visibility"
        value={visibility}
        onChange={(e) => setVisibility(e.target.value)}
      >
        <option>Public</option>
        {role === 'DM' && <option>DM only</option>}
      </select>
      <button className="dice-submit" onClick={onPrepare}>
        Prepare roll
      </button>
    </section>
  );
}
