import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Circle, Group, Text } from 'react-konva';
import { useSession } from '../store/sessionStore.js';
import { canvasStore, useCanvas } from './canvasStore.js';
import { emitTokenMove } from '../net/socket.js';
import { clampTokenPosition, snapPoint } from './viewport.js';
import { resolveTokenMoveWithWalls } from './fogVision.js';

const DEFAULT_COLOR = '#adfcf9';

const TokenNode = memo(function TokenNode({
  token,
  grid,
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

  const setRef = useCallback(
    (node) => {
      registerNode(token.id, node);
    },
    [registerNode, token.id],
  );

  const radius = Math.max(8, grid / 2 - 4);
  const fontSize = Math.max(9, Math.round(grid * 0.2));
  const fill = token.color || DEFAULT_COLOR;
  const displayX = dragging ? startRef.current.x : token.x;
  const displayY = dragging ? startRef.current.y : token.y;

  return (
    <Group
      ref={setRef}
      id={`token-${token.id}`}
      x={displayX}
      y={displayY}
      draggable={draggable && !panMode}
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
        startRef.current = { x: event.target.x(), y: event.target.y() };
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
    </Group>
  );
});

/**
 * Interactive token layer. Coordinates are map-space; the stage transform
 * handles zoom/pan, so drag gestures stay correct at any scale.
 */
export default function TokenLayer({ map, gridSize, role, panMode, onCursor }) {
  const tokensMap = useSession((state) => state.tokens);
  const currentUser = useSession((state) => state.currentUser);
  const selectedIds = useCanvas((state) => state.selectedIds);
  const snapEnabled = useCanvas((state) => state.snap);

  const grid = gridSize > 0 ? gridSize : 70;
  const mapWidth = map?.width ?? 0;
  const mapHeight = map?.height ?? 0;
  const isDM = role === 'DM' || currentUser?.role === 'dm';

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
        if (token) positions.set(tokenId, { x: token.x, y: token.y });
      }
      positions.set(id, { x: node.x(), y: node.y() });

      dragRef.current = {
        leadId: id,
        leadStart: { x: node.x(), y: node.y() },
        positions,
      };
      store.setDraggingIds(Array.from(positions.keys()));
    },
    [tokensMap],
  );

  const handleDragMove = useCallback((id, node) => {
    const drag = dragRef.current;
    if (!drag || drag.leadId !== id) return;

    const dx = node.x() - drag.leadStart.x;
    const dy = node.y() - drag.leadStart.y;
    drag.positions.forEach((start, tokenId) => {
      if (tokenId === id) return;
      const other = nodesRef.current.get(tokenId);
      if (other) other.position({ x: start.x + dx, y: start.y + dy });
    });
  }, []);

  const handleDragEnd = useCallback(
    (id, node, { altKey, position }) => {
      const drag = dragRef.current;
      if (!drag || drag.leadId !== id) return;

      const snapped =
        snapEnabled && !altKey ? snapPoint(position, grid) : position;
      const lead = clampTokenPosition(snapped, mapWidth, mapHeight, grid);
      const dx = lead.x - drag.leadStart.x;
      const dy = lead.y - drag.leadStart.y;

      const walls = canvasStore.getState().walls;
      const moves = [];
      drag.positions.forEach((start, tokenId) => {
        const candidate =
          tokenId === id
            ? lead
            : clampTokenPosition(
                { x: start.x + dx, y: start.y + dy },
                mapWidth,
                mapHeight,
                grid,
              );
        const resolved = resolveTokenMoveWithWalls(start, candidate, walls);
        const final = resolved.position;
        const other = nodesRef.current.get(tokenId);
        if (other) other.position(final);
        if (final.x !== start.x || final.y !== start.y) {
          moves.push({ id: tokenId, x: final.x, y: final.y });
        }
      });

      dragRef.current = null;
      canvasStore.getState().setDraggingIds([]);

      for (const move of moves) {
        emitTokenMove(move.id, move.x, move.y);
      }
    },
    [grid, mapHeight, mapWidth, snapEnabled],
  );

  return (
    <>
      {Object.values(tokensMap).map((token) => {
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
