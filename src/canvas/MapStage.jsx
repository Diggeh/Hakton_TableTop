import { useCallback, useEffect, useRef, useState } from 'react';
import Konva from 'konva';
import { Stage, Layer, Line } from 'react-konva';
import { DEFAULT_GRID_SIZE } from '../../shared/events.js';
import { sessionStore, useSession } from '../store/sessionStore.js';
import { updateSceneMap } from '../net/socket.js';
import { canvasStore, useCanvas } from './canvasStore.js';
import { selectTokensInLasso } from './lasso.js';
import { screenToMap } from './viewport.js';
import {
  detectClosedLoop,
  findNearestWallSegment,
  getAllCollisionWalls,
  projectPointOnSegment,
} from './fogVision.js';
import MapLayer from './MapLayer.jsx';
import GridLayer from './GridLayer.jsx';
import TokenLayer from './TokenLayer.jsx';
import FogLayer from './FogLayer.jsx';

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
  const currentUser = useSession((state) => state.currentUser);
  const stageRef = useRef(null);
  const panRef = useRef(null);
  const spaceRef = useRef(false);
  const fittedForMap = useRef(null);

  const isDM = role === 'DM' || role === 'dm' || currentUser?.role === 'dm' || currentUser?.role === 'DM';

  const gridVisible = useCanvas((state) => state.gridVisible);
  const selectTool = useCanvas((state) => state.selectTool);
  const viewportScale = useCanvas((state) => state.viewport.scale);
  const fogTool = useCanvas((state) => state.fogTool);
  const fogShapes = useCanvas((state) => state.fogShapes);
  const walls = useCanvas((state) => state.walls);
  const fogSyncTimerRef = useRef(null);
  const [panMode, setPanMode] = useState(false);
  const [draftShape, setDraftShape] = useState(null);
  const [lassoDraft, setLassoDraft] = useState(null);
  const [polygonDraft, setPolygonDraft] = useState([]);
  const [mouseMapPos, setMouseMapPos] = useState(null);

  const handleFinishPolygon = useCallback(() => {
    if (polygonDraft.length >= 6) {
      canvasStore.getState().addFogShape({
        type: 'polygon',
        points: polygonDraft,
      });
      setPolygonDraft([]);
    }
  }, [polygonDraft]);

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

  // Center each newly loaded scene at 100% zoom so default 35px cells render at 1:1 scale.
  useEffect(() => {
    if (!width || !height) return;
    const store = canvasStore.getState();
    store.setViewportSize({ width, height });
    if (!map) return;
    const mapW = map.width || 1920;
    const mapH = map.height || 1080;
    store.setMapSize({
      width: mapW,
      height: mapH,
    });
    if (fittedForMap.current !== map.id) {
      fittedForMap.current = map.id;
      store.setViewport({
        x: Math.round((width - mapW) / 2),
        y: Math.round((height - mapH) / 2),
        scale: 1,
      });
    }
  }, [width, height, map]);

  // Persist Fog of War & wall/door edits to SQLite for the active scene.
  useEffect(() => {
    if (!map?.id) return undefined;
    const nextScene = {
      fogShapes: Array.isArray(fogShapes) ? fogShapes : [],
      walls: Array.isArray(walls) ? walls : [],
    };
    const serverScene = {
      fogShapes: Array.isArray(map.sceneData?.fogShapes) ? map.sceneData.fogShapes : [],
      walls: Array.isArray(map.sceneData?.walls) ? map.sceneData.walls : [],
    };
    if (JSON.stringify(nextScene) === JSON.stringify(serverScene)) return undefined;

    if (fogSyncTimerRef.current) clearTimeout(fogSyncTimerRef.current);
    fogSyncTimerRef.current = setTimeout(() => {
      fogSyncTimerRef.current = null;
      void updateSceneMap({ id: map.id, sceneData: nextScene });
    }, 180);
    return () => {
      if (fogSyncTimerRef.current) {
        clearTimeout(fogSyncTimerRef.current);
        fogSyncTimerRef.current = null;
      }
    };
  }, [fogShapes, walls, map?.id, map?.sceneData]);

  // Reset draft when switching fog or selection tools
  useEffect(() => {
    setDraftShape(null);
    setPolygonDraft([]);
  }, [fogTool]);

  useEffect(() => {
    if (selectTool === 'lasso' && !fogTool && !panMode) {
      setCursor('crosshair');
    } else if (!panMode && !panRef.current) {
      setCursor('default');
      setLassoDraft(null);
    }
  }, [selectTool, fogTool, panMode, setCursor]);

  // Keyboard: space pans, +/- zooms, 0 fits, Enter finishes polygon, Escape clears selection/tool, Delete removes selection.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (isTypingTarget(event.target)) return;

      if (event.code === 'Space') {
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
      } else if (event.key === 'Enter' && polygonDraft.length >= 6) {
        event.preventDefault();
        handleFinishPolygon();
      } else if (event.key === 'Escape') {
        canvasStore.getState().clearSelection();
        setDraftShape(null);
        setLassoDraft(null);
        setPolygonDraft([]);
        canvasStore.getState().setSelectTool('select');
        if (canvasStore.getState().fogTool) {
          canvasStore.getState().setFogTool(null);
        }
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
  }, [onDeleteSelection, polygonDraft, role, setCursor]);

  const handleMouseDown = (event) => {
    const stage = stageRef.current;
    if (!stage) return;
    const native = event.evt;
    const isEmpty = event.target === stage;
    const isMiddle = native.button === 1;

    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    // DM Fog & Wall manual drawing tools
    if (
      isDM &&
      fogTool &&
      fogTool !== 'erase' &&
      native.button === 0 &&
      !spaceRef.current
    ) {
      native.preventDefault();
      const mapPt = screenToMap(canvasStore.getState().viewport, pointer);

      if (fogTool === 'polygon') {
        if (polygonDraft.length >= 6) {
          const firstX = polygonDraft[0];
          const firstY = polygonDraft[1];
          if (Math.hypot(mapPt.x - firstX, mapPt.y - firstY) < 22) {
            handleFinishPolygon();
            return;
          }
        }
        // Ensure side length is not too small (minimum 12px)
        if (polygonDraft.length >= 2) {
          const prevX = polygonDraft[polygonDraft.length - 2];
          const prevY = polygonDraft[polygonDraft.length - 1];
          if (Math.hypot(mapPt.x - prevX, mapPt.y - prevY) < 12) {
            return;
          }
        }
        setPolygonDraft((prev) => [...prev, mapPt.x, mapPt.y]);
        return;
      }

      if (fogTool === 'door') {
        const store = canvasStore.getState();
        const nearExistingDoor = store.walls.some(
          (w) =>
            w.isDoor &&
            Math.hypot(
              mapPt.x - (w.p1.x + w.p2.x) / 2,
              mapPt.y - (w.p1.y + w.p2.y) / 2,
            ) <= 14,
        );
        if (nearExistingDoor) return;

        const allWalls = getAllCollisionWalls(store.walls, store.fogShapes);
        const solidWalls = allWalls.filter((w) => !w.isDoor);
        const nearest = findNearestWallSegment(mapPt, solidWalls, 48);
        if (nearest) {
          const p1 = { x: Math.round(nearest.point.x), y: Math.round(nearest.point.y) };
          setDraftShape({
            type: 'door',
            p1,
            p2: p1,
            anchorWall: nearest.wall,
          });
        } else {
          const snap = store.snap;
          const grid = map?.gridSize || DEFAULT_GRID_SIZE;
          const startPt = snap ? snapPoint(mapPt, grid) : { x: Math.round(mapPt.x), y: Math.round(mapPt.y) };
          setDraftShape({
            type: 'door',
            p1: startPt,
            p2: startPt,
            anchorWall: null,
          });
        }
        return;
      }

      if (fogTool === 'rect') {
        setDraftShape({
          type: 'rect',
          x: mapPt.x,
          y: mapPt.y,
          width: 0,
          height: 0,
        });
        return;
      }

      if (fogTool === 'circle') {
        setDraftShape({
          type: 'circle',
          x: mapPt.x,
          y: mapPt.y,
          radius: 0,
        });
        return;
      }

      if (fogTool === 'line') {
        setDraftShape({
          type: 'line',
          points: [mapPt.x, mapPt.y],
          strokeWidth: 44,
        });
        return;
      }

      if (fogTool === 'wall') {
        setDraftShape({
          type: 'wall',
          p1: mapPt,
          p2: mapPt,
        });
        return;
      }
    }

    // Freehand Lasso multi-select tool
    if (
      selectTool === 'lasso' &&
      !fogTool &&
      isEmpty &&
      native.button === 0 &&
      !spaceRef.current
    ) {
      native.preventDefault();
      const mapPt = screenToMap(canvasStore.getState().viewport, pointer);
      setLassoDraft({
        points: [mapPt.x, mapPt.y],
        additive: Boolean(native.shiftKey),
      });
      setCursor('crosshair');
      return;
    }

    if (!(isMiddle || spaceRef.current || (isEmpty && native.button === 0))) {
      return;
    }

    native.preventDefault();
    if (isEmpty && native.button === 0) {
      canvasStore.getState().clearSelection();
    }

    panRef.current = {
      start: pointer,
      viewport: canvasStore.getState().viewport,
    };
    setCursor('grabbing');
  };

  const handleMouseMove = () => {
    const stage = stageRef.current;
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const mapPt = screenToMap(canvasStore.getState().viewport, pointer);
    setMouseMapPos(mapPt);

    if (lassoDraft) {
      setLassoDraft((prev) => {
        if (!prev) return null;
        const pts = prev.points;
        const lastX = pts[pts.length - 2];
        const lastY = pts[pts.length - 1];
        const minStep = 4 / (canvasStore.getState().viewport.scale || 1);
        if (Math.hypot(mapPt.x - lastX, mapPt.y - lastY) < minStep) return prev;
        return { ...prev, points: [...pts, mapPt.x, mapPt.y] };
      });
      return;
    }

    if (draftShape) {
      setDraftShape((prev) => {
        if (!prev) return null;
        if (prev.type === 'rect') {
          return {
            ...prev,
            width: mapPt.x - prev.x,
            height: mapPt.y - prev.y,
          };
        }
        if (prev.type === 'circle') {
          return {
            ...prev,
            radius: Math.hypot(mapPt.x - prev.x, mapPt.y - prev.y),
          };
        }
        if (prev.type === 'line') {
          return {
            ...prev,
            points: [...prev.points, mapPt.x, mapPt.y],
          };
        }
        if (prev.type === 'wall') {
          return {
            ...prev,
            p2: mapPt,
          };
        }
        if (prev.type === 'door') {
          if (prev.anchorWall) {
            const proj = projectPointOnSegment(mapPt, prev.anchorWall.p1, prev.anchorWall.p2);
            return {
              ...prev,
              p2: { x: Math.round(proj.x), y: Math.round(proj.y) },
            };
          }
          const snap = canvasStore.getState().snap;
          const grid = map?.gridSize || DEFAULT_GRID_SIZE;
          const endPt = snap ? snapPoint(mapPt, grid) : { x: Math.round(mapPt.x), y: Math.round(mapPt.y) };
          return {
            ...prev,
            p2: endPt,
          };
        }
        return prev;
      });
      return;
    }

    const pan = panRef.current;
    if (!pan) return;
    canvasStore.getState().setViewport({
      x: pan.viewport.x + (pointer.x - pan.start.x),
      y: pan.viewport.y + (pointer.y - pan.start.y),
      scale: pan.viewport.scale,
    });
  };

  const endPan = () => {
    if (lassoDraft) {
      const current = lassoDraft;
      setLassoDraft(null);
      const store = canvasStore.getState();
      if (current.points.length >= 6) {
        const allTokens = Object.values(sessionStore.getState().tokens || {});
        const matched = selectTokensInLasso(allTokens, current.points, {
          includeMaps: false,
          filterFn: (t) =>
            isDM || (!t.locked && (!t.ownerId || t.ownerId === currentUser?.id)),
        });
        if (current.additive) {
          store.setSelection([...store.selectedIds, ...matched]);
        } else {
          store.setSelection(matched);
        }
      } else if (!current.additive) {
        store.clearSelection();
      }
      store.setSelectTool('select');
      setCursor(spaceRef.current ? 'grab' : 'default');
      return;
    }

    if (draftShape) {
      const current = draftShape;
      setDraftShape(null);
      if (
        current.type === 'rect' &&
        Math.abs(current.width) > 8 &&
        Math.abs(current.height) > 8
      ) {
        canvasStore.getState().addFogShape(current);
      } else if (current.type === 'circle' && current.radius > 8) {
        canvasStore.getState().addFogShape(current);
      } else if (current.type === 'line' && current.points.length >= 4) {
        const loop = detectClosedLoop(current.points, 45);
        if (loop.isClosed && Array.isArray(loop.points) && loop.points.length >= 6) {
          canvasStore.getState().addFogShape({
            type: 'polygon',
            points: loop.points,
          });
        } else {
          canvasStore.getState().addFogShape(current);
        }
      } else if (
        current.type === 'wall' &&
        Math.hypot(
          current.p2.x - current.p1.x,
          current.p2.y - current.p1.y,
        ) > 8
      ) {
        canvasStore.getState().addWall({
          p1: current.p1,
          p2: current.p2,
          isDoor: false,
          isOpen: false,
        });
      } else if (current.type === 'door') {
        const dist = Math.hypot(
          current.p2.x - current.p1.x,
          current.p2.y - current.p1.y,
        );
        if (dist >= 14) {
          canvasStore.getState().addWall({
            p1: current.p1,
            p2: current.p2,
            isDoor: true,
            isOpen: false,
            wallId: current.anchorWall?.id ?? null,
          });
        } else if (current.anchorWall) {
          const wall = current.anchorWall;
          const wallLen = Math.hypot(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y);
          const ux = (wall.p2.x - wall.p1.x) / (wallLen || 1);
          const uy = (wall.p2.y - wall.p1.y) / (wallLen || 1);
          const half = Math.min(28, wallLen / 2);
          canvasStore.getState().addWall({
            p1: { x: Math.round(current.p1.x - ux * half), y: Math.round(current.p1.y - uy * half) },
            p2: { x: Math.round(current.p1.x + ux * half), y: Math.round(current.p1.y + uy * half) },
            isDoor: true,
            isOpen: false,
            wallId: current.anchorWall.id,
          });
        }
      }
    }

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
    if (fogTool === 'polygon' && polygonDraft.length >= 6) {
      canvasStore.getState().addFogShape({
        type: 'polygon',
        points: polygonDraft,
      });
      setPolygonDraft([]);
      return;
    }
    if (event.target === stageRef.current) {
      canvasStore.getState().fit();
    }
  };

  const gridSize = map?.gridSize ?? DEFAULT_GRID_SIZE;

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
      <Layer listening={selectTool !== 'lasso'}>
        <TokenLayer
          map={map}
          gridSize={gridSize}
          role={role}
          panMode={panMode || Boolean(fogTool)}
          onCursor={setCursor}
          filter="maps"
        />
      </Layer>
      <Layer listening={false}>
        {gridVisible && <GridLayer map={map} gridSize={gridSize} />}
      </Layer>
      <Layer>
        <TokenLayer
          map={map}
          gridSize={gridSize}
          role={role}
          panMode={panMode || Boolean(fogTool)}
          onCursor={setCursor}
          filter="tokens"
        />
      </Layer>
      <Layer>
        <FogLayer
          map={map}
          role={role}
          draftShape={draftShape}
          polygonDraft={polygonDraft}
          mouseMapPos={mouseMapPos}
          onFinishPolygon={handleFinishPolygon}
        />
      </Layer>
      {lassoDraft && lassoDraft.points.length >= 4 && (
        <Layer listening={false}>
          <Line
            points={lassoDraft.points}
            closed={lassoDraft.points.length >= 6}
            fill="rgba(173, 252, 249, 0.14)"
            stroke="#adfcf9"
            strokeWidth={1.6 / (viewportScale || 1)}
            dash={[6 / (viewportScale || 1), 4 / (viewportScale || 1)]}
            listening={false}
          />
        </Layer>
      )}
    </Stage>
  );
}
