import { Circle, Group, Line, Rect } from 'react-konva';
import { DEFAULT_GRID_SIZE } from '../../shared/events.js';
import { canvasStore, useCanvas } from './canvasStore.js';
import { visibleBounds } from './viewport.js';
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
  const draggingPositions = useCanvas((s) => s.draggingPositions);
  const draggingRotations = useCanvas((s) => s.draggingRotations);
  const viewport = useCanvas((s) => s.viewport);
  const viewportSize = useCanvas((s) => s.viewportSize);
  const tokens = useSession((s) => s.tokens);

  const isDM = role === 'DM' || role === 'dm';
  const isEffectiveDM = isDM && !playerVisionPreview;

  // Compute all walls (including auto-perimeter walls carved at open doors)
  const allWalls = getAllCollisionWalls(walls, fogShapes);
  const solidWallsForDoorSnap = allWalls.filter((w) => !w.isDoor);

  // Door ghost preview snapped to nearest solid wall or fog edge
  const doorGhost =
    isEffectiveDM && fogTool === 'door' && mouseMapPos
      ? findNearestWallSegment(mouseMapPos, solidWallsForDoorSnap, 28)
      : null;

  // Active tokens with Light / Vision enabled
  const lightTokens = Object.values(tokens || {}).filter(
    (t) => t?.light?.enabled,
  );

  const viewRect = visibleBounds(
    viewport,
    viewportSize?.width || 1400,
    viewportSize?.height || 980,
  );
  const baseMinX = Math.min(0, viewRect.x0);
  const baseMinY = Math.min(0, viewRect.y0);
  const baseMaxX = Math.max(map?.width || 2100, 1400, viewRect.x1);
  const baseMaxY = Math.max(map?.height || 1400, 980, viewRect.y1);

  const lightPolygons = lightTokens
    .map((token) => {
      const live = draggingPositions?.[token.id];
      const origin = live
        ? { x: live.x, y: live.y }
        : { x: token.x, y: token.y };
      const rangeFt = Number(token.light?.range) || 30;
      const maxDistance = (rangeFt / 5) * (map?.gridSize || DEFAULT_GRID_SIZE);
      const pad = maxDistance + 64;
      const minX = Math.min(baseMinX, origin.x - pad);
      const minY = Math.min(baseMinY, origin.y - pad);
      const maxX = Math.max(baseMaxX, origin.x + pad);
      const maxY = Math.max(baseMaxY, origin.y + pad);
      const tokenBounds = {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      };
      const liveRot = draggingRotations?.[token.id];
      const effectiveRotation =
        liveRot !== undefined
          ? liveRot
          : Number.isFinite(Number(token.rotation))
            ? Number(token.rotation)
            : Number(token.light?.rotation) || 0;
      const arc =
        token.light?.type === 'vision'
          ? {
              angle: Number(token.light.angle) || 90,
              rotation: effectiveRotation,
            }
          : null;
      const poly = computeVisibilityPolygon(origin, allWalls, tokenBounds, {
        maxDistance,
        arc,
      });
      if (!poly || poly.length < 3) return null;
      return {
        token,
        origin,
        flatPoints: poly.flatMap((p) => [p.x, p.y]),
      };
    })
    .filter(Boolean);

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
        {lightPolygons.map(({ token, flatPoints }) => (
          <Line
            key={`light-cutout-${token.id}`}
            points={flatPoints}
            closed
            fill="#000000"
            globalCompositeOperation="destination-out"
            listening={false}
          />
        ))}
      </Group>

      {/* Light aura / directional boundaries for visual feedback */}
      {lightPolygons.map(({ token, origin, flatPoints }) => (
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
            x={origin.x}
            y={origin.y}
            radius={Math.max(6, (map?.gridSize || DEFAULT_GRID_SIZE) * 0.18)}
            fill="rgba(255, 230, 150, 0.25)"
            stroke="#ffd57a"
            strokeWidth={1.5}
          />
        </Group>
      ))}

      {/* Walls & Interactive Doors (strictly DM-only) */}
      {isEffectiveDM &&
        walls.map((wall) => {
          const midX = (wall.p1.x + wall.p2.x) / 2;
          const midY = (wall.p1.y + wall.p2.y) / 2;
          const isDoor = Boolean(wall.isDoor);
          const isOpen = Boolean(wall.isOpen);

          const strokeColor = isDoor
            ? isOpen
              ? '#6be39b'
              : '#f0a854'
            : '#56b9d8';

          return (
            <Group
              key={wall.id}
              listening={isEffectiveDM}
              onMouseDown={(e) => {
                if (isDoor && fogTool !== 'erase') {
                  e.cancelBubble = true;
                }
              }}
              onTouchStart={(e) => {
                if (isDoor && fogTool !== 'erase') {
                  e.cancelBubble = true;
                }
              }}
              onClick={(e) => {
                if (!isEffectiveDM) return;
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
