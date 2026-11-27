/**
 * Genshin-stamina-inspired circular HP progress ring with cyan Temporary HP overlay
 * for the token "In Combat" panel.
 */
export default function HpRing({
  hp,
  maxHp,
  tempHp = 0,
  size = 58,
  strokeWidth = 6,
}) {
  const hasHp = hp !== null && hp !== undefined && Number.isFinite(Number(hp));
  const hasMax =
    maxHp !== null &&
    maxHp !== undefined &&
    Number.isFinite(Number(maxHp)) &&
    Number(maxHp) > 0;
  const numericHp = hasHp ? Math.max(0, Number(hp)) : 0;
  const numericTemp =
    tempHp !== null && tempHp !== undefined && Number.isFinite(Number(tempHp))
      ? Math.max(0, Number(tempHp))
      : 0;
  const numericMax = hasMax ? Number(maxHp) : hasHp && numericHp > 0 ? numericHp : 1;
  const ratio = hasHp ? Math.min(1, Math.max(0, numericHp / numericMax)) : 0;
  const hasTemp = numericTemp > 0;
  const tempRatio = hasTemp ? Math.min(1, numericTemp / numericMax) : 0;

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - ratio);
  const tempDashOffset = circumference * (1 - tempRatio);

  let ringColor = '#6be39b';
  if (ratio <= 0.25) ringColor = '#ef6f6c';
  else if (ratio <= 0.5) ringColor = '#f0b854';

  const displayTotal = hasHp ? numericHp + numericTemp : numericTemp > 0 ? numericTemp : null;

  return (
    <div
      className="hp-ring"
      style={{ width: size, height: size }}
      role="img"
      aria-label={
        hasHp
          ? `HP ${numericHp}${hasMax ? ` of ${numericMax}` : ''}${
              hasTemp ? ` (+${numericTemp} Temporary HP)` : ''
            }`
          : 'HP not set'
      }
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          className="hp-ring-track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
        />
        <circle
          className="hp-ring-arc"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          stroke={ringColor}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        {hasTemp && (
          <circle
            className="hp-ring-temp-arc"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            strokeWidth={Math.max(3, strokeWidth - 1)}
            stroke="#4ce6ff"
            strokeDasharray={circumference}
            strokeDashoffset={tempDashOffset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <span className={`hp-ring-value${hasTemp ? ' has-temp' : ''}`}>
        {displayTotal !== null ? displayTotal : '—'}
      </span>
    </div>
  );
}
