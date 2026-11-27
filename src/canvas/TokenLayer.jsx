import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Circle, Group, Image as KonvaImage, Line, Path, Rect, Text } from 'react-konva';
import { DEFAULT_GRID_SIZE } from '../../shared/events.js';
import { sessionStore, useSession } from '../store/sessionStore.js';
import { canvasStore, useCanvas } from './canvasStore.js';
import { emitTokenMove, resolveAssetUrl, updateToken } from '../net/socket.js';
import { screenToMap, snapPoint } from './viewport.js';
import { getAllCollisionWalls, resolveTokenMoveWithWalls } from './fogVision.js';
import { useCanvasImage } from './useCanvasImage.js';

const DEFAULT_COLOR = '#adfcf9';
const MIN_MAP_SIZE = 80;
const MIN_PROP_SIZE = 18;

function RotateHandleBadge({ x, y, onStartRotate, onCursor }) {
  return (
    <Group x={x} y={y}>
      <Circle
        radius={10}
        hitStrokeWidth={12}
        fill="#102533"
        stroke="#ffd57a"
        strokeWidth={1.8}
        strokeScaleEnabled={false}
        shadowColor="#020a12"
        shadowBlur={6}
        shadowOpacity={0.5}
        onMouseDown={onStartRotate}
        onTouchStart={onStartRotate}
        onMouseEnter={(e) => {
          e.cancelBubble = true;
          onCursor?.('grab');
        }}
        onMouseLeave={(e) => {
          e.cancelBubble = true;
          onCursor?.('default');
        }}
      />
      <Path
        data="M 4.2 -1.2 A 4.5 4.5 0 1 0 3.2 3.2 M 4.5 -4.2 L 4.5 -0.8 L 1.2 -0.8"
        stroke="#ffd57a"
        strokeWidth={1.5}
        strokeScaleEnabled={false}
        lineCap="round"
        lineJoin="round"
        listening={false}
      />
    </Group>
  );
}

const RESIZE_HANDLES = [
  { id: 'nw', hx: -1, hy: -1, cursor: 'nwse-resize' },
  { id: 'n', hx: 0, hy: -1, cursor: 'ns-resize' },
  { id: 'ne', hx: 1, hy: -1, cursor: 'nesw-resize' },
  { id: 'e', hx: 1, hy: 0, cursor: 'ew-resize' },
  { id: 'se', hx: 1, hy: 1, cursor: 'nwse-resize' },
  { id: 's', hx: 0, hy: 1, cursor: 'ns-resize' },
  { id: 'sw', hx: -1, hy: 1, cursor: 'nesw-resize' },
  { id: 'w', hx: -1, hy: 0, cursor: 'ew-resize' },
];

const TokenNode = memo(function TokenNode({
  token,
  grid,
  selected,
  draggable,
  canTransform,
  panMode,
  livePosition,
  liveRotation,
  liveTransform,
  onSelect,
  onDragStart,
  onDragMove,
  onDragEnd,
  onRotateCommit,
  onResizeCommit,
  onCursor,
  registerNode,
}) {
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const startRef = useRef({ x: token.x, y: token.y });
  const lastValidPosRef = useRef({ x: token.x, y: token.y });
  const pendingSingleSelectRef = useRef(false);
  const nodeRef = useRef(null);
  const rotateCleanupRef = useRef(null);
  const resizeCleanupRef = useRef(null);

  useEffect(() => {
    return () => {
      if (rotateCleanupRef.current) {
        rotateCleanupRef.current();
        rotateCleanupRef.current = null;
      }
      if (resizeCleanupRef.current) {
        resizeCleanupRef.current();
        resizeCleanupRef.current = null;
      }
    };
  }, []);

  const resolvedImageUrl = token.imageUrl ? resolveAssetUrl(token.imageUrl) : null;
  const { image } = useCanvasImage(resolvedImageUrl);
  const isObjectSprite =
    !token.isMap &&
    (token.category === 'props' || token.category === 'attachments');
  const minBoxSize = isObjectSprite ? MIN_PROP_SIZE : MIN_MAP_SIZE;

  const setRef = useCallback(
    (node) => {
      nodeRef.current = node;
      registerNode(token.id, node);
    },
    [registerNode, token.id],
  );

  const radius = Math.max(8, grid / 2 - 4);
  const fontSize = Math.max(9, Math.round(grid * 0.2));
  const fill = token.color || DEFAULT_COLOR;
  const displayX = liveTransform
    ? liveTransform.x
    : dragging
      ? startRef.current.x
      : livePosition
        ? livePosition.x
        : token.x;
  const displayY = liveTransform
    ? liveTransform.y
    : dragging
      ? startRef.current.y
      : livePosition
        ? livePosition.y
        : token.y;
  const defaultSpriteDims = (() => {
    const targetMax = Math.max(24, Math.round(grid * 1.15));
    const nw = image?.naturalWidth || image?.width || 0;
    const nh = image?.naturalHeight || image?.height || 0;
    if (nw > 0 && nh > 0) {
      const fit = targetMax / Math.max(nw, nh);
      return {
        w: Math.max(MIN_PROP_SIZE, Math.round(nw * fit)),
        h: Math.max(MIN_PROP_SIZE, Math.round(nh * fit)),
      };
    }
    return { w: grid, h: grid };
  })();
  const mapW =
    liveTransform?.width ??
    (token.width ||
      (isObjectSprite ? defaultSpriteDims.w : image?.naturalWidth || 800));
  const mapH =
    liveTransform?.height ??
    (token.height ||
      (isObjectSprite ? defaultSpriteDims.h : image?.naturalHeight || 600));
  const displayRotation =
    liveRotation !== undefined
      ? liveRotation
      : Number.isFinite(Number(token.rotation))
        ? Number(token.rotation)
        : Number(token.light?.rotation) || 0;

  const dragBoundFunc = useCallback(
    (pos) => {
      const node = nodeRef.current;
      const stage = node?.getStage();
      if (!stage) return pos;
      const transform = stage.getAbsoluteTransform().copy();
      transform.invert();
      const mapPos = transform.point(pos);

      // Maps are large background / room tiles; do not restrict them by wall collisions
      if (token.isMap) {
        lastValidPosRef.current = mapPos;
        const absTransform = stage.getAbsoluteTransform();
        return absTransform.point(mapPos);
      }

      // Check collision against all blocking walls and closed doors (open doors have carved gaps)
      const store = canvasStore.getState();
      const allWalls = getAllCollisionWalls(store.walls, store.fogShapes);
      const start = lastValidPosRef.current || { x: token.x, y: token.y };
      const resolved = resolveTokenMoveWithWalls(start, mapPos, allWalls, {
        buffer: Math.min(radius + 2, 16),
      });

      const finalMap = resolved.position;
      lastValidPosRef.current = finalMap;
      const absTransform = stage.getAbsoluteTransform();
      return absTransform.point(finalMap);
    },
    [radius, token.isMap, token.x, token.y],
  );

  const startRotateDrag = useCallback(
    (event) => {
      event.cancelBubble = true;
      event.evt?.preventDefault?.();
      event.evt?.stopPropagation?.();

      const node = nodeRef.current;
      const stage = node?.getStage();
      const container = stage?.container();
      if (!container) return;

      if (rotateCleanupRef.current) {
        rotateCleanupRef.current();
        rotateCleanupRef.current = null;
      }

      const center = { x: node.x(), y: node.y() };
      let latestDeg = displayRotation;
      onCursor?.('grabbing');

      const onMove = (ev) => {
        const rect = container.getBoundingClientRect();
        const mapPt = screenToMap(canvasStore.getState().viewport, {
          x: ev.clientX - rect.left,
          y: ev.clientY - rect.top,
        });
        let deg =
          ((Math.atan2(mapPt.y - center.y, mapPt.x - center.x) * 180) / Math.PI +
            360) %
          360;
        deg = ev.shiftKey ? (Math.round(deg / 15) * 15) % 360 : Math.round(deg) % 360;
        latestDeg = deg;
        canvasStore.getState().setDraggingRotation(token.id, deg);
      };

      const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        rotateCleanupRef.current = null;
      };

      const onUp = () => {
        cleanup();
        onCursor?.('default');
        canvasStore.getState().clearDraggingRotation(token.id);
        onRotateCommit?.(token.id, latestDeg);
      };

      rotateCleanupRef.current = cleanup;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [displayRotation, onCursor, onRotateCommit, token.id],
  );

  const startResizeDrag = useCallback(
    (hx, hy, cursorName, event) => {
      event.cancelBubble = true;
      event.evt?.preventDefault?.();
      event.evt?.stopPropagation?.();

      const node = nodeRef.current;
      const stage = node?.getStage();
      const container = stage?.container();
      if (!container) return;

      if (resizeCleanupRef.current) {
        resizeCleanupRef.current();
        resizeCleanupRef.current = null;
      }

      const startCenter = { x: node.x(), y: node.y() };
      const startW = mapW;
      const startH = mapH;
      const theta = (displayRotation * Math.PI) / 180;
      const ux = Math.cos(theta);
      const uy = Math.sin(theta);
      const vx = -Math.sin(theta);
      const vy = Math.cos(theta);

      // Anchor opposite corner/edge in world coordinates so the far side stays pinned
      const anchorX =
        startCenter.x -
        (hx !== 0 ? hx * (startW / 2) * ux : 0) -
        (hy !== 0 ? hy * (startH / 2) * vx : 0);
      const anchorY =
        startCenter.y -
        (hx !== 0 ? hx * (startW / 2) * uy : 0) -
        (hy !== 0 ? hy * (startH / 2) * vy : 0);

      let latestTransform = {
        x: startCenter.x,
        y: startCenter.y,
        width: startW,
        height: startH,
      };
      onCursor?.(cursorName || 'nwse-resize');

      const onMove = (ev) => {
        const rect = container.getBoundingClientRect();
        const mapPt = screenToMap(canvasStore.getState().viewport, {
          x: ev.clientX - rect.left,
          y: ev.clientY - rect.top,
        });
        const dx = mapPt.x - anchorX;
        const dy = mapPt.y - anchorY;
        const projU = dx * ux + dy * uy;
        const projV = dx * vx + dy * vy;

        let nextW = startW;
        let nextH = startH;

        if (hx !== 0 && hy !== 0) {
          const rawW = Math.max(minBoxSize, hx * projU);
          const rawH = Math.max(minBoxSize, hy * projV);
          if (ev.shiftKey) {
            nextW = Math.round(rawW);
            nextH = Math.round(rawH);
          } else {
            const minScale = Math.max(minBoxSize / startW, minBoxSize / startH);
            const scale = Math.max(minScale, Math.max(rawW / startW, rawH / startH));
            nextW = Math.round(startW * scale);
            nextH = Math.round(startH * scale);
          }
        } else if (hx !== 0) {
          nextW = Math.max(minBoxSize, Math.round(hx * projU));
        } else if (hy !== 0) {
          nextH = Math.max(minBoxSize, Math.round(hy * projV));
        }

        const nextX = Math.round(
          anchorX +
            (hx !== 0 ? hx * (nextW / 2) * ux : 0) +
            (hy !== 0 ? hy * (nextH / 2) * vx : 0),
        );
        const nextY = Math.round(
          anchorY +
            (hx !== 0 ? hx * (nextW / 2) * uy : 0) +
            (hy !== 0 ? hy * (nextH / 2) * vy : 0),
        );

        latestTransform = { x: nextX, y: nextY, width: nextW, height: nextH };
        canvasStore.getState().setDraggingTransform(token.id, latestTransform);
      };

      const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        resizeCleanupRef.current = null;
      };

      const onUp = () => {
        cleanup();
        onCursor?.('default');
        canvasStore.getState().clearDraggingTransform(token.id);
        onResizeCommit?.(token.id, latestTransform);
      };

      resizeCleanupRef.current = cleanup;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [displayRotation, mapH, mapW, onCursor, onResizeCommit, token.id],
  );

  return (
    <Group
      ref={setRef}
      id={`token-${token.id}`}
      x={displayX}
      y={displayY}
      draggable={draggable && !panMode}
      dragBoundFunc={dragBoundFunc}
      onMouseDown={(event) => {
        // Middle-click / space-pan gestures must reach the Stage handler.
        if (panMode || event.evt.button !== 0) return;
        event.cancelBubble = true;
        const additive = Boolean(event.evt.shiftKey);
        const currentSelected = canvasStore.getState().selectedIds;
        if (!additive && currentSelected.length > 1 && currentSelected.includes(token.id)) {
          // Defer collapsing a multi-selection until mouseup without drag so group dragging works cleanly
          pendingSingleSelectRef.current = true;
          return;
        }
        pendingSingleSelectRef.current = false;
        onSelect(token.id, additive);
      }}
      onMouseUp={(event) => {
        if (event.evt.button !== 0) return;
        if (pendingSingleSelectRef.current) {
          pendingSingleSelectRef.current = false;
          onSelect(token.id, false);
        }
      }}
      onTouchStart={(event) => {
        event.cancelBubble = true;
        onSelect(token.id, false);
      }}
      onDragStart={(event) => {
        pendingSingleSelectRef.current = false;
        const curPos = { x: event.target.x(), y: event.target.y() };
        startRef.current = curPos;
        lastValidPosRef.current = curPos;
        setDragging(true);
        onDragStart(token.id, event.target);
      }}
      onDragMove={(event) => onDragMove(token.id, event.target)}
      onDragEnd={(event) => {
        onDragEnd(token.id, event.target, {
          altKey: Boolean(event.evt.altKey),
          position: { x: event.target.x(), y: event.target.y() },
        });
        setDragging(false);
      }}
      onMouseEnter={() => {
        setHovered(true);
        if (!panMode) onCursor?.('pointer');
      }}
      onMouseLeave={() => {
        setHovered(false);
        if (!panMode) onCursor?.('default');
      }}
    >
      {token.isMap || isObjectSprite ? (
        <>
          <Group rotation={displayRotation}>
            {selected && (
              <Rect
                x={-mapW / 2 - 4}
                y={-mapH / 2 - 4}
                width={mapW + 8}
                height={mapH + 8}
                stroke={token.locked ? '#db9685' : '#adfcf9'}
                strokeWidth={2}
                strokeScaleEnabled={false}
                dash={[8, 6]}
                listening={false}
                cornerRadius={6}
              />
            )}
            {image ? (
              <KonvaImage
                image={image}
                x={-mapW / 2}
                y={-mapH / 2}
                width={mapW}
                height={mapH}
                cornerRadius={token.isMap ? 4 : 0}
                shadowColor="#020a12"
                shadowBlur={token.isMap ? 12 : 6}
                shadowOpacity={token.isMap ? 0.5 : 0.35}
              />
            ) : (
              <Group>
                <Rect
                  x={-mapW / 2}
                  y={-mapH / 2}
                  width={mapW}
                  height={mapH}
                  fill={isObjectSprite ? fill : '#182c3c'}
                  stroke={token.locked ? '#db9685' : hovered ? '#ffffff' : '#3f5f6f'}
                  strokeWidth={2}
                  cornerRadius={4}
                  shadowColor="#020a12"
                  shadowBlur={isObjectSprite ? 8 : 12}
                  shadowOpacity={0.5}
                />
                <Text
                  text={token.isMap ? `🗺️ ${token.label}` : token.label}
                  x={isObjectSprite ? -mapW / 2 + 4 : -mapW / 2 + 16}
                  y={isObjectSprite ? -fontSize / 2 : -mapH / 2 + 16}
                  width={isObjectSprite ? Math.max(12, mapW - 8) : undefined}
                  align={isObjectSprite ? 'center' : 'left'}
                  wrap="none"
                  ellipsis
                  fontSize={isObjectSprite ? fontSize : 18}
                  fontStyle="bold"
                  fill={isObjectSprite ? '#081824' : '#adfcf9'}
                  listening={false}
                />
              </Group>
            )}
            {selected && token.locked && (
              <Group x={-mapW / 2 + 10} y={-mapH / 2 + 10} listening={false}>
                <Rect
                  width={74}
                  height={22}
                  fill="rgba(11, 24, 32, 0.88)"
                  stroke="#db9685"
                  strokeWidth={1.5}
                  cornerRadius={6}
                />
                <Text
                  text="Locked"
                  x={0}
                  y={4}
                  width={74}
                  align="center"
                  fontSize={11}
                  fontStyle="bold"
                  fill="#ffd0c4"
                />
              </Group>
            )}
            {selected && canTransform && !panMode && (
              <>
                <Line
                  points={[0, -mapH / 2 - 4, 0, -mapH / 2 - 18]}
                  stroke="#adfcf9"
                  strokeWidth={2}
                  strokeScaleEnabled={false}
                  listening={false}
                />
                <RotateHandleBadge
                  x={0}
                  y={-mapH / 2 - 28}
                  onStartRotate={startRotateDrag}
                  onCursor={onCursor}
                />
                {RESIZE_HANDLES.map((h) => {
                  const isCorner = h.hx !== 0 && h.hy !== 0;
                  if (isObjectSprite && !isCorner) return null;
                  const hw = isCorner ? (isObjectSprite ? 9 : 12) : h.hy !== 0 ? 18 : 8;
                  const hh = isCorner ? (isObjectSprite ? 9 : 12) : h.hx !== 0 ? 18 : 8;
                  return (
                    <Rect
                      key={h.id}
                      x={(h.hx * mapW) / 2}
                      y={(h.hy * mapH) / 2}
                      width={hw}
                      height={hh}
                      offsetX={hw / 2}
                      offsetY={hh / 2}
                      hitStrokeWidth={12}
                      fill={isCorner ? '#adfcf9' : '#e7fbfa'}
                      stroke="#081824"
                      strokeWidth={1.8}
                      strokeScaleEnabled={false}
                      cornerRadius={isCorner ? 2 : 3}
                      onMouseDown={(e) => startResizeDrag(h.hx, h.hy, h.cursor, e)}
                      onTouchStart={(e) => startResizeDrag(h.hx, h.hy, h.cursor, e)}
                      onMouseEnter={(e) => {
                        e.cancelBubble = true;
                        onCursor?.(h.cursor);
                      }}
                      onMouseLeave={(e) => {
                        e.cancelBubble = true;
                        onCursor?.('default');
                      }}
                    />
                  );
                })}
              </>
            )}
          </Group>
          {isObjectSprite && image && (hovered || selected) && token.label && (
            <Group
              x={0}
              y={mapH / 2 + 6}
              listening={false}
            >
              <Rect
                x={-Math.max(40, Math.min(130, token.label.length * 6.8 + 14)) / 2}
                y={0}
                width={Math.max(40, Math.min(130, token.label.length * 6.8 + 14))}
                height={18}
                cornerRadius={9}
                fill="rgba(8, 20, 29, 0.88)"
                stroke="rgba(173, 252, 249, 0.35)"
                strokeWidth={1}
              />
              <Text
                text={token.label}
                x={-Math.max(40, Math.min(130, token.label.length * 6.8 + 14)) / 2}
                y={4}
                width={Math.max(40, Math.min(130, token.label.length * 6.8 + 14))}
                align="center"
                wrap="none"
                ellipsis
                fontSize={10}
                fontStyle="bold"
                fill="#e7fbfa"
              />
            </Group>
          )}
        </>
      ) : (
        <>
          {selected && (
            <Circle
              radius={radius + 5}
              stroke="#adfcf9"
              strokeWidth={2}
              strokeScaleEnabled={false}
              dash={[6, 4]}
              listening={false}
            />
          )}
          <Circle
            radius={radius}
            fill={image ? '#0e202c' : fill}
            opacity={0.96}
            stroke={selected && token.locked ? '#db9685' : hovered ? '#ffffff' : '#e7fbfa'}
            strokeWidth={selected && token.locked ? 2.5 : 2}
            strokeScaleEnabled={false}
            dash={selected && token.locked ? [5, 4] : undefined}
            shadowColor="#020a12"
            shadowBlur={8}
            shadowOpacity={0.45}
            perfectDrawEnabled={false}
          />
          {image && (() => {
            const nw = image.naturalWidth || image.width || radius * 2;
            const nh = image.naturalHeight || image.height || radius * 2;
            const scale = Math.max((radius * 2) / nw, (radius * 2) / nh);
            const drawW = nw * scale;
            const drawH = nh * scale;
            const clipRadius = Math.max(2, radius - 1.5);
            return (
              <>
                <Group
                  clipFunc={(ctx) => {
                    ctx.beginPath();
                    ctx.arc(0, 0, clipRadius, 0, Math.PI * 2, false);
                    ctx.closePath();
                  }}
                  listening={false}
                >
                  <KonvaImage
                    image={image}
                    x={-drawW / 2}
                    y={-drawH / 2}
                    width={drawW}
                    height={drawH}
                  />
                </Group>
                <Circle
                  radius={radius}
                  fillEnabled={false}
                  stroke={selected && token.locked ? '#db9685' : hovered ? '#ffffff' : '#e7fbfa'}
                  strokeWidth={selected && token.locked ? 2.5 : 2}
                  strokeScaleEnabled={false}
                  dash={selected && token.locked ? [5, 4] : undefined}
                  listening={false}
                />
              </>
            );
          })()}
          <Group rotation={displayRotation} listening={false}>
            <Line
              points={[radius - 2, -6, radius + 7, 0, radius - 2, 6]}
              closed
              fill="#ffffff"
              stroke="#081824"
              strokeWidth={1.5}
              strokeScaleEnabled={false}
            />
          </Group>
          {selected && canTransform && !panMode && (
            <RotateHandleBadge
              x={0}
              y={-(radius + 22)}
              onStartRotate={startRotateDrag}
              onCursor={onCursor}
            />
          )}
          {!image ? (
            <Text
              text={token.label}
              x={-grid * 0.85}
              y={-fontSize / 2}
              width={grid * 1.7}
              align="center"
              wrap="none"
              ellipsis
              fontSize={fontSize}
              fontStyle="bold"
              fill="#081824"
              listening={false}
            />
          ) : (
            (hovered || selected) && token.label && (
              <Group x={0} y={radius + 6} listening={false}>
                <Rect
                  x={-Math.max(40, Math.min(130, token.label.length * 6.8 + 14)) / 2}
                  y={0}
                  width={Math.max(40, Math.min(130, token.label.length * 6.8 + 14))}
                  height={18}
                  cornerRadius={9}
                  fill="rgba(8, 20, 29, 0.88)"
                  stroke="rgba(173, 252, 249, 0.35)"
                  strokeWidth={1}
                />
                <Text
                  text={token.label}
                  x={-Math.max(40, Math.min(130, token.label.length * 6.8 + 14)) / 2}
                  y={4}
                  width={Math.max(40, Math.min(130, token.label.length * 6.8 + 14))}
                  align="center"
                  wrap="none"
                  ellipsis
                  fontSize={10}
                  fontStyle="bold"
                  fill="#e7fbfa"
                />
              </Group>
            )
          )}
        </>
      )}
    </Group>
  );
});

/**
 * Interactive token layer. Coordinates are map-space; the stage transform
 * handles zoom/pan, so drag gestures stay correct at any scale.
 */
export default function TokenLayer({
  map,
  gridSize,
  role,
  panMode,
  onCursor,
  filter = 'all',
}) {
  const tokensMap = useSession((state) => state.tokens);
  const currentUser = useSession((state) => state.currentUser);
  const selectedIds = useCanvas((state) => state.selectedIds);
  const snapEnabled = useCanvas((state) => state.snap);
  const draggingPositions = useCanvas((state) => state.draggingPositions);
  const draggingRotations = useCanvas((state) => state.draggingRotations);
  const draggingTransforms = useCanvas((state) => state.draggingTransforms);

  const grid = gridSize > 0 ? gridSize : DEFAULT_GRID_SIZE;
  const isDM =
    role === 'DM' ||
    role === 'dm' ||
    currentUser?.role === 'dm' ||
    currentUser?.role === 'DM';

  const nodesRef = useRef(new Map());
  const dragRef = useRef(null);

  const registerNode = useCallback((id, node) => {
    if (node) nodesRef.current.set(id, node);
    else nodesRef.current.delete(id);
  }, []);

  // Drop selections that point at tokens deleted by another client.
  useEffect(() => {
    const current = canvasStore.getState().selectedIds;
    const alive = current.filter((id) => tokensMap[id]);
    if (alive.length !== current.length) {
      canvasStore.getState().setSelection(alive);
    }
  }, [tokensMap]);

  const handleSelect = useCallback((id, additive) => {
    canvasStore.getState().selectToken(id, additive);
  }, []);

  const handleDragStart = useCallback(
    (id, node) => {
      const store = canvasStore.getState();
      let ids = store.selectedIds;
      if (!ids.includes(id)) {
        store.setSelection([id]);
        ids = [id];
      }

      const positions = new Map();
      for (const tokenId of ids) {
        const token = tokensMap[tokenId];
        const mayMove =
          token &&
          !token.locked &&
          (isDM || !token.ownerId || token.ownerId === currentUser?.id);
        if (mayMove) {
          positions.set(tokenId, {
            x: token.x,
            y: token.y,
            isMap: Boolean(token.isMap),
          });
        }
      }
      positions.set(id, {
        x: node.x(),
        y: node.y(),
        isMap: Boolean(tokensMap[id]?.isMap),
      });

      dragRef.current = {
        leadId: id,
        leadStart: { x: node.x(), y: node.y() },
        leadIsMap: Boolean(tokensMap[id]?.isMap),
        positions,
      };
      store.setDraggingIds(Array.from(positions.keys()));
    },
    [currentUser?.id, isDM, tokensMap],
  );

  const handleDragMove = useCallback((id, node) => {
    const drag = dragRef.current;
    if (!drag || drag.leadId !== id) return;

    const leadPos = { x: node.x(), y: node.y() };
    const store = canvasStore.getState();
    store.setDraggingPosition(id, leadPos);

    const dx = leadPos.x - drag.leadStart.x;
    const dy = leadPos.y - drag.leadStart.y;
    drag.positions.forEach((start, tokenId) => {
      if (tokenId === id) return;
      const other = nodesRef.current.get(tokenId);
      const nextPos = { x: start.x + dx, y: start.y + dy };
      if (other) other.position(nextPos);
      store.setDraggingPosition(tokenId, nextPos);
    });
  }, []);

  const handleDragEnd = useCallback(
    (id, node, { altKey, position }) => {
      const drag = dragRef.current;
      if (!drag || drag.leadId !== id) return;

      const store = canvasStore.getState();
      const allWalls = getAllCollisionWalls(store.walls, store.fogShapes);
      const buffer = Math.min(Math.max(8, grid / 2 - 4) + 2, 16);

      let lead;
      if (drag.leadIsMap) {
        lead = position;
      } else {
        const snapped =
          snapEnabled && !altKey ? snapPoint(position, grid) : position;
        lead = resolveTokenMoveWithWalls(position, snapped, allWalls, {
          buffer,
        }).position;
      }

      const dx = lead.x - drag.leadStart.x;
      const dy = lead.y - drag.leadStart.y;

      const moves = [];
      drag.positions.forEach((start, tokenId) => {
        let final;
        if (tokenId === id) {
          final = lead;
        } else if (start.isMap) {
          final = { x: start.x + dx, y: start.y + dy };
        } else {
          const candidate = { x: start.x + dx, y: start.y + dy };
          final = resolveTokenMoveWithWalls(start, candidate, allWalls, {
            buffer,
          }).position;
        }
        const other = nodesRef.current.get(tokenId);
        if (other) other.position(final);
        if (final.x !== start.x || final.y !== start.y) {
          moves.push({ id: tokenId, x: final.x, y: final.y });
        }
      });

      dragRef.current = null;
      store.setDraggingIds([]);
      store.clearDraggingPositions();

      for (const move of moves) {
        emitTokenMove(move.id, move.x, move.y);
      }
    },
    [grid, snapEnabled],
  );

  const handleRotateCommit = useCallback((id, degrees) => {
    const latest = sessionStore.getState().tokens[id];
    if (!latest) return;
    const rot = ((Math.round(Number(degrees) || 0) % 360) + 360) % 360;
    const patch = {
      rotation: rot,
      ...(latest.light ? { light: { ...latest.light, rotation: rot } } : {}),
    };
    sessionStore.getState().upsertToken({ ...latest, ...patch });
    updateToken(id, patch);
  }, []);

  const handleResizeCommit = useCallback((id, next) => {
    const latest = sessionStore.getState().tokens[id];
    if (!latest || !next) return;
    const minSize = latest.isMap ? MIN_MAP_SIZE : MIN_PROP_SIZE;
    const x = Math.round(Number(next.x) || 0);
    const y = Math.round(Number(next.y) || 0);
    const width = Math.max(minSize, Math.round(Number(next.width) || 0));
    const height = Math.max(minSize, Math.round(Number(next.height) || 0));
    sessionStore.getState().upsertToken({ ...latest, x, y, width, height });
    emitTokenMove(id, x, y);
    updateToken(id, { width, height });
  }, []);

  const visibleTokens = Object.values(tokensMap)
    .filter((token) => {
      if (filter === 'maps') return Boolean(token.isMap);
      if (filter === 'tokens') return !token.isMap;
      return true;
    })
    .sort((a, b) => (a.isMap ? 0 : 1) - (b.isMap ? 0 : 1));

  return (
    <>
      {visibleTokens.map((token) => {
        const canEdit =
          !panMode &&
          (isDM || !token.ownerId || token.ownerId === currentUser?.id);
        const canDrag = canEdit && !token.locked;
        const canTransform = canEdit && !token.locked && (token.isMap ? isDM : true);

        return (
          <TokenNode
            key={token.id}
            token={token}
            grid={grid}
            selected={selectedIds.includes(token.id)}
            draggable={canDrag}
            canTransform={canTransform}
            panMode={panMode}
            livePosition={draggingPositions[token.id]}
            liveRotation={draggingRotations[token.id]}
            liveTransform={draggingTransforms[token.id]}
            onSelect={handleSelect}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onRotateCommit={handleRotateCommit}
            onResizeCommit={handleResizeCommit}
            onCursor={onCursor}
            registerNode={registerNode}
          />
        );
      })}
    </>
  );
}
