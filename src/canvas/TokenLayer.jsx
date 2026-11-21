import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Circle, Group, Image as KonvaImage, Rect, Text } from 'react-konva';
import { useSession } from '../store/sessionStore.js';
import { canvasStore, useCanvas } from './canvasStore.js';
import { emitTokenMove, resolveAssetUrl } from '../net/socket.js';
import { clampTokenPosition, snapPoint } from './viewport.js';
import { getAllCollisionWalls, resolveTokenMoveWithWalls } from './fogVision.js';
import { useCanvasImage } from './useCanvasImage.js';

const DEFAULT_COLOR = '#adfcf9';

const TokenNode = memo(function TokenNode({
  token,
  grid,
  mapWidth,
  mapHeight,
  selected,
  draggable,
  panMode,
  onSelect,
  onDragStart,
  onDragMove,
  onDragEnd,
  onCursor,
  registerNode,
}) {
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const startRef = useRef({ x: token.x, y: token.y });
  const lastValidPosRef = useRef({ x: token.x, y: token.y });
  const nodeRef = useRef(null);

  const resolvedMapUrl =
    token.isMap && token.imageUrl ? resolveAssetUrl(token.imageUrl) : null;
  const { image } = useCanvasImage(resolvedMapUrl);

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
  const displayX = dragging ? startRef.current.x : token.x;
  const displayY = dragging ? startRef.current.y : token.y;
  const mapW = token.width || image?.naturalWidth || 800;
  const mapH = token.height || image?.naturalHeight || 600;

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

      // Clamp inside playable map bounds
      const clamped = clampTokenPosition(mapPos, mapWidth, mapHeight, grid);

      // Check collision against all blocking walls and closed doors (open doors have carved gaps)
      const store = canvasStore.getState();
      const allWalls = getAllCollisionWalls(store.walls, store.fogShapes);
      const start = lastValidPosRef.current || { x: token.x, y: token.y };
      const resolved = resolveTokenMoveWithWalls(start, clamped, allWalls, {
        buffer: Math.min(radius + 2, 16),
      });

      const finalMap = resolved.position;
      lastValidPosRef.current = finalMap;
      const absTransform = stage.getAbsoluteTransform();
      return absTransform.point(finalMap);
    },
    [grid, mapHeight, mapWidth, radius, token.isMap, token.x, token.y],
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
        onSelect(token.id, Boolean(event.evt.shiftKey));
      }}
      onTouchStart={(event) => {
        event.cancelBubble = true;
        onSelect(token.id, false);
      }}
      onDragStart={(event) => {
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
      {token.isMap ? (
        <>
          {selected && (
            <Rect
              x={-mapW / 2 - 4}
              y={-mapH / 2 - 4}
              width={mapW + 8}
              height={mapH + 8}
              stroke="#adfcf9"
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
              cornerRadius={4}
              shadowColor="#020a12"
              shadowBlur={12}
              shadowOpacity={0.5}
            />
          ) : (
            <Group>
              <Rect
                x={-mapW / 2}
                y={-mapH / 2}
                width={mapW}
                height={mapH}
                fill="#182c3c"
                stroke={token.locked ? '#db9685' : hovered ? '#ffffff' : '#3f5f6f'}
                strokeWidth={2}
                cornerRadius={4}
                shadowColor="#020a12"
                shadowBlur={12}
                shadowOpacity={0.5}
              />
              <Text
                text={`🗺️ ${token.label}`}
                x={-mapW / 2 + 16}
                y={-mapH / 2 + 16}
                fontSize={18}
                fontStyle="bold"
                fill="#adfcf9"
                listening={false}
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
            fill={fill}
            opacity={0.94}
            stroke={token.locked ? '#db9685' : hovered ? '#ffffff' : '#e7fbfa'}
            strokeWidth={token.locked ? 2.5 : 2}
            strokeScaleEnabled={false}
            dash={token.locked ? [5, 4] : undefined}
            shadowColor="#020a12"
            shadowBlur={8}
            shadowOpacity={0.45}
            perfectDrawEnabled={false}
          />
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

  const grid = gridSize > 0 ? gridSize : 70;
  const mapWidth = map?.width ?? 0;
  const mapHeight = map?.height ?? 0;
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
        if (token) {
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
    [tokensMap],
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
        const clampedLead = clampTokenPosition(snapped, mapWidth, mapHeight, grid);
        lead = resolveTokenMoveWithWalls(position, clampedLead, allWalls, {
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
          const candidate = clampTokenPosition(
            { x: start.x + dx, y: start.y + dy },
            mapWidth,
            mapHeight,
            grid,
          );
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
    [grid, mapHeight, mapWidth, snapEnabled],
  );

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
        const canDrag =
          !panMode &&
          (isDM ||
            (!token.locked &&
              (!token.ownerId || token.ownerId === currentUser?.id)));

        return (
          <TokenNode
            key={token.id}
            token={token}
            grid={grid}
            mapWidth={mapWidth}
            mapHeight={mapHeight}
            selected={selectedIds.includes(token.id)}
            draggable={canDrag}
            panMode={panMode}
            onSelect={handleSelect}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onCursor={onCursor}
            registerNode={registerNode}
          />
        );
      })}
    </>
  );
}
