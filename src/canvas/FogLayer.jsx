import { Circle, Group, Line, Rect } from 'react-konva';
import { canvasStore, useCanvas } from './canvasStore.js';
import { useSession } from '../store/sessionStore.js';
import {
  computeVisibilityPolygon,
  findNearestWallSegment,
  getAllCollisionWalls,
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
  mouseMapPos = null,
  onFinishPolygon = null,
}) {
  const fogShapes = useCanvas((s) => s.fogShapes);
  const walls = useCanvas((s) => s.walls);
  const fogTool = useCanvas((s) => s.fogTool);
  const playerVisionPreview = useCanvas((s) => s.playerVisionPreview);
  const tokens = useSession((s) => s.tokens);

  const isDM = role === 'DM' || role === 'dm';
  const isEffectiveDM = isDM && !playerVisionPreview;

  // Compute all walls (including auto-perimeter walls from fog shapes)
  const allWalls = getAllCollisionWalls(walls, fogShapes);

  // Door ghost preview snapped to wall
  const doorGhost =
    isEffectiveDM && fogTool === 'door' && mouseMapPos
      ? findNearestWallSegment(mouseMapPos, allWalls, 28)
      : null;

  // Active tokens with Light / Vision enabled
  const lightTokens = Object.values(tokens || {}).filter(
    (t) => t?.light?.enabled,
  );

  return (
    <Group>
      {/* Placed Fog Shapes with Real-Time Light Vision Cancellation */}
      <Group>
        {/* Base Fog Shapes (Translucent for DM, Pitch-Black for Players) */}
        {fogShapes.map((shape) =>
          renderFogShapeNode(shape, {
            fill: isEffectiveDM ? 'rgba(10, 18, 26, 0.60)' : '#000000',
            stroke: isEffectiveDM ? 'rgba(130, 211, 196, 0.45)' : undefined,
            strokeWidth: isEffectiveDM ? 1.5 : 0,
            dash: isEffectiveDM ? [6, 4] : undefined,
            listening: isEffectiveDM && fogTool === 'erase',
            onClick: (e) => {
              if (!isEffectiveDM || fogTool !== 'erase') return;
              e.cancelBubble = true;
              canvasStore.getState().removeFogShape(shape.id);
            },
          }),
        )}

        {/* Light Cutouts (destination-out cancels fog where tokens emit light) */}
        {lightTokens.map((token) => {
          const origin = { x: token.x, y: token.y };
          const rangeFt = Number(token.light?.range) || 30;
          const maxDistance = (rangeFt / 5) * (map?.gridSize || 70);
          const arc =
            token.light?.type === 'vision'
              ? {
                  angle: Number(token.light.angle) || 90,
                  rotation: Number(token.light.rotation) || 0,
                }
              : null;
          const poly = computeVisibilityPolygon(origin, allWalls, {
            maxDistance,
            arc,
          });
          if (!poly || poly.length < 3) return null;
          const flatPoints = poly.flatMap((p) => [p.x, p.y]);

          return (
            <Line
              key={`light-cutout-${token.id}`}
              points={flatPoints}
              closed
              fill="#000000"
              globalCompositeOperation="destination-out"
              listening={false}
            />
          );
        })}
      </Group>

      {/* Light aura / directional boundaries for visual feedback */}
      {lightTokens.map((token) => {
        const origin = { x: token.x, y: token.y };
        const rangeFt = Number(token.light?.range) || 30;
        const maxDistance = (rangeFt / 5) * (map?.gridSize || 70);
        const arc =
          token.light?.type === 'vision'
            ? {
                angle: Number(token.light.angle) || 90,
                rotation: Number(token.light.rotation) || 0,
              }
            : null;
        const poly = computeVisibilityPolygon(origin, allWalls, {
          maxDistance,
          arc,
        });
        if (!poly || poly.length < 3) return null;
        const flatPoints = poly.flatMap((p) => [p.x, p.y]);

        return (
          <Group key={`light-aura-${token.id}`} listening={false}>
            {isEffectiveDM && (
              <Line
                points={flatPoints}
                closed
                stroke="rgba(255, 215, 120, 0.45)"
                strokeWidth={1.5}
                dash={[5, 4]}
              />
            )}
            <Circle
              x={token.x}
              y={token.y}
              radius={Math.max(6, (map?.gridSize || 70) * 0.18)}
              fill="rgba(255, 230, 150, 0.25)"
              stroke="#ffd57a"
              strokeWidth={1.5}
            />
          </Group>
        );
      })}

      {/* Walls & Interactive Doors */}
      {walls.map((wall) => {
        const midX = (wall.p1.x + wall.p2.x) / 2;
        const midY = (wall.p1.y + wall.p2.y) / 2;
        const isDoor = Boolean(wall.isDoor);
        const isOpen = Boolean(wall.isOpen);

        // In Player view (or preview mode), hide non-doors
        if (!isEffectiveDM && !isDoor) return null;

        const strokeColor = isDoor
          ? isOpen
            ? '#6be39b'
            : '#f0a854'
          : '#56b9d8';

        return (
          <Group
            key={wall.id}
            listening={isEffectiveDM || isDoor}
            onClick={(e) => {
              e.cancelBubble = true;
              if (isEffectiveDM && fogTool === 'erase') {
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

      {/* Door placement ghost preview snapped onto nearest wall */}
      {doorGhost && (
        <Group
          x={doorGhost.point.x}
          y={doorGhost.point.y}
          rotation={(doorGhost.angle * 180) / Math.PI}
          listening={false}
        >
          <Line
            points={[-28, 0, 28, 0]}
            stroke="#f0a854"
            strokeWidth={6}
            dash={[4, 4]}
          />
          <Rect
            x={-9}
            y={-9}
            width={18}
            height={18}
            cornerRadius={3}
            fill="rgba(240, 168, 84, 0.45)"
            stroke="#f0a854"
            strokeWidth={2}
          />
        </Group>
      )}

      {/* Live Draft Shape while DM is drawing */}
      {isEffectiveDM && draftShape && (
        <Group listening={false}>
          {draftShape.type === 'wall' ? (
            <Line
              points={[
                draftShape.p1.x,
                draftShape.p1.y,
                draftShape.p2.x,
                draftShape.p2.y,
              ]}
              stroke="#56b9d8"
              strokeWidth={5}
              dash={[6, 4]}
            />
          ) : draftShape.type === 'door' ? (
            <Group listening={false}>
              <Line
                points={[
                  draftShape.p1.x,
                  draftShape.p1.y,
                  draftShape.p2.x,
                  draftShape.p2.y,
                ]}
                stroke="#f0a854"
                strokeWidth={6}
                lineCap="round"
              />
              <Circle
                x={draftShape.p1.x}
                y={draftShape.p1.y}
                radius={6}
                fill="#f0a854"
                stroke="#ffffff"
                strokeWidth={2}
              />
              <Circle
                x={draftShape.p2.x}
                y={draftShape.p2.y}
                radius={6}
                fill="#f0a854"
                stroke="#ffffff"
                strokeWidth={2}
              />
              <Rect
                x={(draftShape.p1.x + draftShape.p2.x) / 2 - 9}
                y={(draftShape.p1.y + draftShape.p2.y) / 2 - 9}
                width={18}
                height={18}
                cornerRadius={3}
                fill="#3a2612"
                stroke="#f0a854"
                strokeWidth={2}
              />
            </Group>
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

      {/* Custom Polygon Draft Segments */}
      {isEffectiveDM && polygonDraft.length >= 2 && (
        <Group>
          {/* Committed edges of draft */}
          <Line
            points={polygonDraft}
            stroke="#adfcf9"
            strokeWidth={2}
            dash={[5, 4]}
            listening={false}
          />

          {/* Rubber-band live line from last vertex to cursor */}
          {mouseMapPos && (
            <Line
              points={[
                polygonDraft[polygonDraft.length - 2],
                polygonDraft[polygonDraft.length - 1],
                mouseMapPos.x,
                mouseMapPos.y,
              ]}
              stroke="rgba(173, 252, 249, 0.75)"
              strokeWidth={1.5}
              dash={[3, 3]}
              listening={false}
            />
          )}

          {/* Hovering Finish Handle over starting vertex */}
          {polygonDraft.length >= 6 && (
            <Group
              x={polygonDraft[0]}
              y={polygonDraft[1]}
              onClick={(e) => {
                e.cancelBubble = true;
                onFinishPolygon?.();
              }}
              onTouchStart={(e) => {
                e.cancelBubble = true;
                onFinishPolygon?.();
              }}
            >
              <Circle
                radius={13}
                fill="#1b473f"
                stroke="#adfcf9"
                strokeWidth={2}
                shadowColor="#000000"
                shadowBlur={8}
              />
              <Circle radius={4} fill="#adfcf9" />
            </Group>
          )}
        </Group>
      )}
    </Group>
  );
}
