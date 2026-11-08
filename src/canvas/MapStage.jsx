import { useCallback, useEffect, useRef, useState } from 'react';
import Konva from 'konva';
import { Stage, Layer } from 'react-konva';
import { useSession } from '../store/sessionStore.js';
import { canvasStore, useCanvas } from './canvasStore.js';
import MapLayer from './MapLayer.jsx';
import GridLayer from './GridLayer.jsx';
import TokenLayer from './TokenLayer.jsx';

// Only the primary mouse button starts a token drag; middle-click always pans.
Konva.dragButtons = [0];

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

/**
 * Live tabletop stage. The stage transform is the single source of zoom/pan;
 * it is applied imperatively from the vanilla canvas store so 60fps panning
 * never re-renders React.
 */
export default function MapStage({ width, height, role, onDeleteSelection }) {
  const map = useSession((state) => state.map);
  const stageRef = useRef(null);
  const panRef = useRef(null);
  const spaceRef = useRef(false);
  const fittedForMap = useRef(null);

  const gridVisible = useCanvas((state) => state.gridVisible);
  const [panMode, setPanMode] = useState(false);

  const setCursor = useCallback((cursor) => {
    const container = stageRef.current?.container();
    if (container) container.style.cursor = cursor;
  }, []);

  // Keep the Konva stage transform in sync with the vanilla viewport store.
  useEffect(() => {
    let previous = canvasStore.getState().viewport;

    const apply = () => {
      const stage = stageRef.current;
      if (!stage) return;
      const { viewport } = canvasStore.getState();
      stage.scale({ x: viewport.scale, y: viewport.scale });
      stage.position({ x: viewport.x, y: viewport.y });
      stage.batchDraw();
    };

    apply();
    const unsubscribe = canvasStore.subscribe((state) => {
      if (state.viewport !== previous) {
        previous = state.viewport;
        apply();
      }
    });
    return unsubscribe;
  }, []);

  // Fit the map the first time it appears, preserve the centre on resize.
  useEffect(() => {
    if (!width || !height) return;
    const store = canvasStore.getState();
    store.setViewportSize({ width, height });
    if (!map) return;
    store.setMapSize({
      width: map.width || 0,
      height: map.height || 0,
    });
    if (fittedForMap.current !== map.id) {
      fittedForMap.current = map.id;
      store.fit();
    }
  }, [width, height, map]);

  // Keyboard: space pans, +/- zooms, 0 fits, Delete removes the selection.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (isTypingTarget(event.target)) return;

      if (event.code === 'Space') {
        // Let a focused toolbar button handle its own activation.
        if (event.target?.tagName === 'BUTTON') return;
        event.preventDefault();
        if (!spaceRef.current) {
          spaceRef.current = true;
          setPanMode(true);
          setCursor('grab');
        }
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        canvasStore.getState().zoomBy(1.2);
      } else if (event.key === '-') {
        event.preventDefault();
        canvasStore.getState().zoomBy(1 / 1.2);
      } else if (event.key === '0') {
        event.preventDefault();
        canvasStore.getState().fit();
      } else if (event.key === 'Escape') {
        canvasStore.getState().clearSelection();
      } else if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        role === 'DM' &&
        onDeleteSelection
      ) {
        event.preventDefault();
        onDeleteSelection();
      }
    };

    const onKeyUp = (event) => {
      if (event.code !== 'Space') return;
      spaceRef.current = false;
      setPanMode(false);
      if (!panRef.current) setCursor('default');
    };

    const onBlur = () => {
      spaceRef.current = false;
      setPanMode(false);
      if (!panRef.current) setCursor('default');
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [onDeleteSelection, role, setCursor]);

  const handleMouseDown = (event) => {
    const stage = stageRef.current;
    if (!stage) return;
    const native = event.evt;
    const isEmpty = event.target === stage;
    const isMiddle = native.button === 1;

    if (!(isMiddle || spaceRef.current || (isEmpty && native.button === 0))) {
      return;
    }

    native.preventDefault();
    if (isEmpty && native.button === 0) {
      canvasStore.getState().clearSelection();
    }

    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    panRef.current = {
      start: pointer,
      viewport: canvasStore.getState().viewport,
    };
    setCursor('grabbing');
  };

  const handleMouseMove = () => {
    const pan = panRef.current;
    const stage = stageRef.current;
    if (!pan || !stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    canvasStore.getState().setViewport({
      x: pan.viewport.x + (pointer.x - pan.start.x),
      y: pan.viewport.y + (pointer.y - pan.start.y),
      scale: pan.viewport.scale,
    });
  };

  const endPan = () => {
    if (!panRef.current) return;
    panRef.current = null;
    setCursor(spaceRef.current ? 'grab' : 'default');
  };

  const handleWheel = (event) => {
    event.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const delta =
      event.evt.deltaMode === 1 ? event.evt.deltaY * 16 : event.evt.deltaY;
    const factor = Math.exp(-delta * 0.0015);
    canvasStore.getState().zoomAt(pointer, factor);
  };

  const handleDoubleClick = (event) => {
    if (event.target === stageRef.current) {
      canvasStore.getState().fit();
    }
  };

  const gridSize = map?.gridSize ?? 70;

  return (
    <Stage
      ref={stageRef}
      width={width}
      height={height}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={endPan}
      onMouseLeave={endPan}
      onWheel={handleWheel}
      onDblClick={handleDoubleClick}
    >
      <Layer listening={false}>
        <MapLayer map={map} />
      </Layer>
      <Layer listening={false}>
        {gridVisible && <GridLayer map={map} gridSize={gridSize} />}
      </Layer>
      <Layer>
        <TokenLayer
          map={map}
          gridSize={gridSize}
          role={role}
          panMode={panMode}
          onCursor={setCursor}
        />
      </Layer>
    </Stage>
  );
}
