import { Circle, Group, Layer, Line, Rect, Text } from 'react-konva';
import { DEFAULT_GRID_SIZE } from '../../shared/events.js';
import { measurePolylineDistance } from '../../shared/ruler.js';
import { useSession } from '../store/sessionStore.js';
import { useCanvas } from './canvasStore.js';

function SingleRulerGraphic({
  points,
  gridSize,
  mode,
  feetPerCell = 5,
  color = '#adfcf9',
  labelPrefix = '',
  viewportScale = 1,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const invScale = 1 / (viewportScale || 1);
  const flatPoints = points.flatMap((pt) => [pt.x, pt.y]);
  const { totalFeet } = measurePolylineDistance(points, gridSize, {
    mode,
    feetPerCell,
  });
  const end = points[points.length - 1];
  const caption = labelPrefix ? `${labelPrefix} · ${totalFeet} ft` : `${totalFeet} ft`;
  const pillW = Math.max(54, caption.length * 7.2 + 16);
  const pillH = 22;

  return (
    <Group listening={false}>
      <Line
        points={flatPoints}
        stroke="rgba(6, 15, 22, 0.78)"
        strokeWidth={5 * invScale}
        lineCap="round"
        lineJoin="round"
      />
      <Line
        points={flatPoints}
        stroke={color}
        strokeWidth={2.5 * invScale}
        dash={[8 * invScale, 5 * invScale]}
        lineCap="round"
        lineJoin="round"
      />
      {points.map((pt, idx) => (
        <Circle
          key={idx}
          x={pt.x}
          y={pt.y}
          radius={(idx === 0 || idx === points.length - 1 ? 5 : 4) * invScale}
          fill={idx === 0 ? color : '#0b1829'}
          stroke={color}
          strokeWidth={2 * invScale}
        />
      ))}
      <Group x={end.x + 12 * invScale} y={end.y - 26 * invScale} scaleX={invScale} scaleY={invScale}>
        <Rect
          width={pillW}
          height={pillH}
          rx={11}
          fill="rgba(10, 22, 32, 0.94)"
          stroke={color}
          strokeWidth={1.5}
          shadowColor="#020a12"
          shadowBlur={8}
          shadowOpacity={0.65}
        />
        <Text
          text={caption}
          x={0}
          y={4}
          width={pillW}
          align="center"
          fontSize={12}
          fontStyle="bold"
          fill="#eefcf9"
        />
      </Group>
    </Group>
  );
}

/**
 * Ephemeral Konva overlay drawing local & peer tactical measurement lines.
 */
export default function RulerLayer({ localPoints, gridSize = DEFAULT_GRID_SIZE, mode = '5e' }) {
  const remoteRulers = useSession((state) => state.remoteRulers);
  const viewportScale = useCanvas((state) => state.viewport.scale);
  const remotes = Object.values(remoteRulers || {});
  if (!localPoints && remotes.length === 0) return null;

  return (
    <Layer listening={false}>
      {remotes.map((r) => (
        <SingleRulerGraphic
          key={r.senderId}
          points={r.points}
          gridSize={gridSize}
          mode={r.mode || '5e'}
          feetPerCell={r.feetPerCell || 5}
          color={r.color || '#ffd57a'}
          labelPrefix={r.senderName || 'Player'}
          viewportScale={viewportScale}
        />
      ))}
      {localPoints && (
        <SingleRulerGraphic
          points={localPoints}
          gridSize={gridSize}
          mode={mode}
          feetPerCell={5}
          color="#adfcf9"
          viewportScale={viewportScale}
        />
      )}
    </Layer>
  );
}
