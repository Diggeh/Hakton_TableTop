import { Stage, Layer, Line, Group, Circle, Text } from 'react-konva';
import { useSession } from '@/store/sessionStore.js';
import { emitTokenMove } from '@/net/socket.js';

const COLORS = { navy: '#091540', cerulean: '#3A7CA5', aqua: '#ADFCF9', white: '#FFFFFF' };

function GridLines({ width, height, size }) {
  const lines = [];
  for (let x = 0; x <= width; x += size)
    lines.push(<Line key={`v${x}`} points={[x, 0, x, height]} stroke={COLORS.cerulean} strokeWidth={1} opacity={0.35} />);
  for (let y = 0; y <= height; y += size)
    lines.push(<Line key={`h${y}`} points={[0, y, width, y]} stroke={COLORS.cerulean} strokeWidth={1} opacity={0.35} />);
  return lines;
}

export default function MapStage({ width, height }) {
  const map = useSession((s) => s.map);
  const tokens = useSession((s) => s.tokens);
  const grid = map?.gridSize ?? 70;

  return (
    <Stage width={width} height={height}>
      <Layer listening={false}>
        {map && <GridLines width={map.width} height={map.height} size={grid} />}
      </Layer>
      <Layer>
        {Object.values(tokens).map((t) => (
          <Group
            key={t.id}
            x={t.x}
            y={t.y}
            draggable
            onDragEnd={(e) => {
              // Snap to the nearest grid intersection, then sync.
              const x = Math.round(e.target.x() / grid) * grid;
              const y = Math.round(e.target.y() / grid) * grid;
              e.target.position({ x, y });
              emitTokenMove(t.id, x, y);
            }}
          >
            <Circle radius={grid / 2 - 6} fill={COLORS.aqua} stroke={COLORS.white} strokeWidth={2} />
            <Text
              text={t.label}
              fill={COLORS.navy}
              fontStyle="bold"
              width={grid}
              offsetX={grid / 2}
              offsetY={7}
              align="center"
            />
          </Group>
        ))}
      </Layer>
    </Stage>
  );
}
