import { Circle, Group, Line, Rect } from 'react-konva';
import { useSession } from '../store/sessionStore.js';
import { canvasStore, useCanvas } from './canvasStore.js';
import {
  computeVisibilityPolygon,
  isPointInFogShape,
} from './fogVision.js';

function renderFogShapeNode(shape, props) {
  if (shape.type === 'rect') {
    const x = Math.min(shape.x, shape.x + shape.width);
    const y = Math.min(shape.y, shape.y + shape.height);
    const width = Math.abs(shape.width);
    const height = Math.abs(shape.height);
    return (
      <Rect
        key={shape.id}
        x={x}
        y={y}
        width={width}
        height={height}
        {...props}
      />
    );
  }
  if (shape.type === 'circle') {
    return (
      <Circle
        key={shape.id}
        x={shape.x}
        y={shape.y}
        radius={Math.abs(shape.radius || 0)}
        {...props}
      />
    );
  }
  if (shape.type === 'polygon' && Array.isArray(shape.points)) {
    return (
      <Line
        key={shape.id}
        points={shape.points}
        closed
        {...props}
      />
    );
  }
  if (shape.type === 'line' && Array.isArray(shape.points)) {
    return (
      <Line
        key={shape.id}
        points={shape.points}
        stroke={props.fill}
        strokeWidth={shape.strokeWidth || 44}
        lineCap="round"
        lineJoin="round"
        listening={props.listening}
        onClick={props.onClick}
      />
    );
  }
  return null;
}

export default function FogLayer({
  map,
  role,
  draftShape = null,
  polygonDraft = [],
}) {
  const fogShapes = useCanvas((s) => s.fogShapes);
  const walls = useCanvas((s) => s.walls);
  const fogTool = useCanvas((s) => s.fogTool);
  const tokensMap = useSession((s) => s.tokens);
  const currentUser = useSession((s) => s.currentUser);

  const isDM = role === 'DM';
  const mapWidth = map?.width || 1400;
  const mapHeight = map?.height || 980;
  const bounds = { x: 0, y: 0, width: mapWidth, height: mapHeight };

  const tokens = Object.values(tokensMap || {});
  // Player vision sources: tokens owned by the player, or all tokens on the board if none explicitly owned
  const ownedTokens = tokens.filter(
    (t) => currentUser?.id && t.ownerId === currentUser.id,
  );
  const visionTokens = ownedTokens.length > 0 ? ownedTokens : tokens;

  // Compute visibility polygons for tokens that are inside at least one placed fog area
  const activeVisibilityPolygons = [];
  if (fogShapes.length > 0) {
    for (const token of visionTokens) {
      const inAnyFog = fogShapes.some((shape) =>
        isPointInFogShape({ x: token.x, y: token.y }, shape),
      );
      if (inAnyFog) {
        const poly = computeVisibilityPolygon(
          { x: token.x, y: token.y },
          walls,
          bounds,
        );
        if (poly.length >= 3) {
          activeVisibilityPolygons.push({
            tokenId: token.id,
            points: poly.flatMap((p) => [p.x, p.y]),
          });
        }
      }
    }
  }

  return (
    <Group>
      {/* Placed Fog Shapes */}
      <Group>
        {fogShapes.map((shape) =>
          renderFogShapeNode(shape, {
            fill: isDM ? 'rgba(10, 18, 26, 0.52)' : '#000000',
            stroke: isDM ? 'rgba(130, 211, 196, 0.45)' : undefined,
            strokeWidth: isDM ? 1.5 : 0,
            dash: isDM ? [6, 4] : undefined,
            listening: isDM && fogTool === 'erase',
            onClick: (e) => {
              if (!isDM || fogTool !== 'erase') return;
              e.cancelBubble = true;
              canvasStore.getState().removeFogShape(shape.id);
            },
          }),
        )}

        {/* Carve out dynamic 2D line-of-sight vision for players (and show outline for DM) */}
        {!isDM &&
          activeVisibilityPolygons.map((vis) => (
            <Line
              key={`vis-${vis.tokenId}`}
              points={vis.points}
              closed
              fill="#000000"
              globalCompositeOperation="destination-out"
              listening={false}
            />
          ))}
      </Group>

      {/* DM-only visibility preview outlines */}
      {isDM &&
        activeVisibilityPolygons.map((vis) => (
          <Line
            key={`dm-vis-${vis.tokenId}`}
            points={vis.points}
            closed
            fill="rgba(173, 252, 249, 0.08)"
            stroke="rgba(173, 252, 249, 0.45)"
            strokeWidth={1.5}
            dash={[4, 4]}
            listening={false}
          />
        ))}

      {/* Walls & Interactive Doors */}
      {walls.map((wall) => {
        const midX = (wall.p1.x + wall.p2.x) / 2;
        const midY = (wall.p1.y + wall.p2.y) / 2;
        const isDoor = Boolean(wall.isDoor);
        const isOpen = Boolean(wall.isOpen);

        // Players only see closed doors/walls if they are within view or DM sees all
        if (!isDM && !isDoor) return null;

        const strokeColor = isDoor
          ? isOpen
            ? '#6be39b'
            : '#f0a854'
          : '#56b9d8';

        return (
          <Group
            key={wall.id}
            listening={isDM}
            onClick={(e) => {
              if (!isDM) return;
              e.cancelBubble = true;
              if (fogTool === 'erase') {
                canvasStore.getState().removeWall(wall.id);
              } else if (isDoor) {
                canvasStore.getState().toggleDoor(wall.id);
              }
            }}
          >
            <Line
              points={[wall.p1.x, wall.p1.y, wall.p2.x, wall.p2.y]}
              stroke={strokeColor}
              strokeWidth={isDoor ? 6 : 4}
              dash={isDoor && isOpen ? [6, 5] : undefined}
              lineCap="round"
              hitStrokeWidth={16}
            />
            {isDoor && (
              <Rect
                x={midX - 9}
                y={midY - 9}
                width={18}
                height={18}
                cornerRadius={3}
                fill={isOpen ? '#173828' : '#3a2612'}
                stroke={strokeColor}
                strokeWidth={2}
              />
            )}
          </Group>
        );
      })}

      {/* Live Draft Shape while DM is drawing */}
      {isDM && draftShape && (
        <Group listening={false}>
          {(draftShape.type === 'wall' || draftShape.type === 'door') ? (
            <Line
              points={[
                draftShape.p1.x,
                draftShape.p1.y,
                draftShape.p2.x,
                draftShape.p2.y,
              ]}
              stroke={draftShape.type === 'door' ? '#f0a854' : '#56b9d8'}
              strokeWidth={5}
              dash={[6, 4]}
            />
          ) : (
            renderFogShapeNode(draftShape, {
              fill: 'rgba(12, 24, 34, 0.38)',
              stroke: '#adfcf9',
              strokeWidth: 2,
              dash: [6, 4],
              listening: false,
            })
          )}
        </Group>
      )}

      {/* Polygon Draft Points */}
      {isDM && polygonDraft.length >= 2 && (
        <Line
          points={polygonDraft}
          stroke="#adfcf9"
          strokeWidth={2}
          dash={[5, 4]}
          listening={false}
        />
      )}
    </Group>
  );
}
