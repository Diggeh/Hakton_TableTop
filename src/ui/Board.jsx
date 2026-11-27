import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_GRID_SIZE,
  MAX_GRID_SIZE,
  MIN_GRID_SIZE,
} from '../../shared/events.js';
import {
  connect,
  createToken,
  deleteToken,
  resolveAssetUrl,
  selectSceneMap,
  updateSceneMap,
  updateToken,
} from '../net/socket.js';
import { sessionStore, useSession } from '../store/sessionStore.js';
import { assetStore } from '../store/assetStore.js';
import { canvasStore, useCanvas } from '../canvas/canvasStore.js';
import {
  MAX_SCALE,
  fitViewport,
  mapToScreen,
  screenToMap,
  snapPoint,
} from '../canvas/viewport.js';
import DiceOverlay from '../dice/DiceOverlay.jsx';
import { party } from './fixtures.js';
import ToolIcon from './ToolIcon.jsx';
import AddTokenDialog from './AddTokenDialog.jsx';
import HpRing from './HpRing.jsx';
import { canViewTokenHp } from '../../shared/combat.js';
import { useUploadedCategoryAssetEntries } from './AssetsPanel.jsx';
import { IconButton } from './Primitives.jsx';

const MapStage = lazy(() => import('../canvas/MapStage.jsx'));

const TOKEN_PALETTE = ['#adfcf9', '#8fd2c5', '#f0a854', '#db9685', '#9ec5fe'];

export default function Board({
  displayName,
  userId,
  hostUrl,
  campaignId,
  campaignName,
  scene,
  role,
  playersOpen = false,
  diceOpen = false,
  initiativeOpen = false,
  notesOpen = false,
  chatOpen = false,
  soundboardOpen = false,
  soundboardId,
  assetTrayCategory = null,
  assetManagerOpen = false,
  onAction,
  onToggleAssetTray,
  onOpenAssetManager,
  onSelectScene,
  onInspectAsset,
}) {
  const host = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [error, setError] = useState('');
  const [addTokenOpen, setAddTokenOpen] = useState(false);
  const [fogMenuOpen, setFogMenuOpen] = useState(false);
  const [gridMenuOpen, setGridMenuOpen] = useState(false);
  const [renamingTokenId, setRenamingTokenId] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [propertyMenuOpen, setPropertyMenuOpen] = useState(false);
  const [propertyMenuTab, setPropertyMenuTab] = useState('combat');

  const connection = useSession((s) => s.connection);
  const connectionError = useSession((s) => s.connectionError);
  const map = useSession((s) => s.map);
  const tokens = useSession((s) => s.tokens);
  const participants = useSession((s) => s.participants);
  const latency = useSession((s) => s.lastMoveLatencyMs);
  const activeRoll = useSession((s) => s.activeRoll);

  const viewport = useCanvas((s) => s.viewport);
  const liveScale = viewport.scale;
  const gridVisible = useCanvas((s) => s.gridVisible);
  const snapEnabled = useCanvas((s) => s.snap);
  const selectedIds = useCanvas((s) => s.selectedIds);
  const draggingIds = useCanvas((s) => s.draggingIds);
  const draggingRotations = useCanvas((s) => s.draggingRotations);
  const draggingTransforms = useCanvas((s) => s.draggingTransforms);
  const fogTool = useCanvas((s) => s.fogTool);
  const selectTool = useCanvas((s) => s.selectTool);
  const playerVisionPreview = useCanvas((s) => s.playerVisionPreview);

  const trayEntries = useUploadedCategoryAssetEntries(assetTrayCategory || 'Scenes');
  const lightSyncTimersRef = useRef(new Map());
  const combatSyncTimersRef = useRef(new Map());
  const gridSyncTimerRef = useRef(null);

  const currentUser = useSession((s) => s.currentUser);
  const isDM =
    role === 'DM' ||
    role === 'dm' ||
    currentUser?.role === 'dm' ||
    currentUser?.isHost;
  const viewerRole = isDM ? 'dm' : 'player';
  const myParticipantId = currentUser?.id || currentUser?.userId || userId || null;
  const connectedParticipants = [...participants]
    .filter((p) => p.connected)
    .sort((a, b) => {
      if (a.role === 'dm' && b.role !== 'dm') return -1;
      if (b.role === 'dm' && a.role !== 'dm') return 1;
      return String(a.displayName || '').localeCompare(String(b.displayName || ''));
    });
  const selectedTokens = selectedIds
    .map((id) => tokens[id])
    .filter(Boolean);
  const singleSelectedToken =
    selectedTokens.length === 1 ? selectedTokens[0] : null;
  const selectedTokenId = singleSelectedToken?.id ?? null;
  const allSelectedLocked =
    selectedTokens.length > 0 && selectedTokens.every((token) => token.locked);

  // Clean up pending debounced light, combat & grid sync timers on unmount
  useEffect(() => {
    const timers = lightSyncTimersRef.current;
    const combatTimers = combatSyncTimersRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      for (const timer of combatTimers.values()) {
        clearTimeout(timer);
      }
      combatTimers.clear();
      if (gridSyncTimerRef.current) {
        clearTimeout(gridSyncTimerRef.current);
        gridSyncTimerRef.current = null;
      }
    };
  }, []);

  // Close inline rename & properties popover ONLY when switching or clearing selected token ID
  useEffect(() => {
    setRenamingTokenId(null);
    setPropertyMenuOpen(false);
  }, [selectedTokenId]);

  function handleToggleLight(token) {
    if (!token) return;
    const timers = lightSyncTimersRef.current;
    if (timers.has(token.id)) {
      clearTimeout(timers.get(token.id));
      timers.delete(token.id);
    }
    const hasLight = Boolean(token.light?.enabled);
    const tokenRot = Number.isFinite(Number(token.rotation))
      ? ((Number(token.rotation) % 360) + 360) % 360
      : Number(token.light?.rotation) || 0;
    const updatedLight = {
      enabled: !hasLight,
      type: token.light?.type || 'torch',
      range: Number(token.light?.range) || 30,
      angle: Number(token.light?.angle) || 90,
      rotation: tokenRot,
    };
    const updatedToken = { ...token, light: updatedLight };
    sessionStore.getState().upsertToken(updatedToken);
    updateToken(token.id, { light: updatedLight });
    if (!hasLight) {
      setPropertyMenuTab('light');
      setPropertyMenuOpen(true);
    } else if (token.combat?.enabled) {
      setPropertyMenuTab('combat');
    } else {
      setPropertyMenuOpen(false);
    }
  }

  function buildCombatWirePayload(token, nextCombat) {
    if (canViewTokenHp(token, viewerRole, participants)) {
      return nextCombat;
    }
    // Preserve hidden HP on the server when a viewer without HP visibility edits combat/initiative
    return {
      enabled: Boolean(nextCombat.enabled),
      initiative: nextCombat.initiative ?? null,
    };
  }

  function handleToggleCombat(token) {
    if (!token) return;
    const timers = combatSyncTimersRef.current;
    if (timers.has(token.id)) {
      clearTimeout(timers.get(token.id));
      timers.delete(token.id);
    }
    const wasInCombat = Boolean(token.combat?.enabled);
    const canViewHp = canViewTokenHp(token, viewerRole, participants);
    const nextCombat = {
      enabled: !wasInCombat,
      initiative: !wasInCombat ? token.combat?.initiative ?? null : null,
      hp: canViewHp ? token.combat?.hp ?? 10 : token.combat?.hp ?? null,
      maxHp: canViewHp ? token.combat?.maxHp ?? 10 : token.combat?.maxHp ?? null,
      ...(token.combat?.hpHidden ? { hpHidden: true } : {}),
    };
    const updatedToken = { ...token, combat: nextCombat };
    sessionStore.getState().upsertToken(updatedToken);
    updateToken(token.id, { combat: buildCombatWirePayload(token, nextCombat) });
    if (!wasInCombat) {
      setPropertyMenuTab('combat');
      setPropertyMenuOpen(true);
    } else if (token.light?.enabled) {
      setPropertyMenuTab('light');
    } else {
      setPropertyMenuOpen(false);
    }
  }

  function handleUpdateCombat(token, updates, { immediate = false } = {}) {
    if (!token) return;
    const canViewHp = canViewTokenHp(token, viewerRole, participants);
    const currentCombat = token.combat || {
      enabled: true,
      initiative: null,
      hp: canViewHp ? 10 : null,
      maxHp: canViewHp ? 10 : null,
    };
    const nextCombat = {
      ...currentCombat,
      ...updates,
      enabled: updates.enabled ?? currentCombat.enabled ?? true,
    };
    sessionStore.getState().upsertToken({ ...token, combat: nextCombat });

    const timers = combatSyncTimersRef.current;
    if (timers.has(token.id)) {
      clearTimeout(timers.get(token.id));
      timers.delete(token.id);
    }
    if (immediate) {
      updateToken(token.id, { combat: buildCombatWirePayload(token, nextCombat) });
    } else {
      const timer = setTimeout(() => {
        timers.delete(token.id);
        const latest = sessionStore.getState().tokens[token.id] || token;
        const latestCombat = latest.combat || nextCombat;
        updateToken(token.id, { combat: buildCombatWirePayload(latest, latestCombat) });
      }, 120);
      timers.set(token.id, timer);
    }
  }

  function handleChangeTokenOwner(token, nextOwnerId) {
    if (!token || !isDM) return;
    const cleanOwnerId = nextOwnerId || null;
    const target = participants.find((p) => p.id === cleanOwnerId) || null;
    const nextOwnerRole = target
      ? target.role === 'dm'
        ? 'dm'
        : 'player'
      : null;
    sessionStore.getState().upsertToken({
      ...token,
      ownerId: cleanOwnerId,
      ownerRole: nextOwnerRole,
    });
    updateToken(token.id, {
      ownerId: cleanOwnerId,
      ownerRole: nextOwnerRole,
    });
  }

  function handleUpdateLight(token, updates, { immediate = false } = {}) {
    if (!token) return;
    const baseRot = Number.isFinite(Number(token.rotation))
      ? ((Number(token.rotation) % 360) + 360) % 360
      : Number(token.light?.rotation) || 0;
    const currentLight = token.light || {
      enabled: true,
      type: 'torch',
      range: 30,
      angle: 90,
      rotation: baseRot,
    };
    const hasRotUpdate = 'rotation' in updates;
    const normRot = hasRotUpdate
      ? ((Math.round(Number(updates.rotation) || 0) % 360) + 360) % 360
      : null;
    const updatedLight = {
      ...currentLight,
      ...updates,
      ...(hasRotUpdate ? { rotation: normRot } : {}),
    };
    const updatedToken = {
      ...token,
      light: updatedLight,
      ...(hasRotUpdate ? { rotation: normRot } : {}),
    };
    sessionStore.getState().upsertToken(updatedToken);

    const timers = lightSyncTimersRef.current;
    if (timers.has(token.id)) {
      clearTimeout(timers.get(token.id));
      timers.delete(token.id);
    }
    const wirePatch = hasRotUpdate
      ? { rotation: normRot, light: updatedLight }
      : { light: updatedLight };
    if (immediate) {
      updateToken(token.id, wirePatch);
    } else {
      const timer = setTimeout(() => {
        timers.delete(token.id);
        const latest = sessionStore.getState().tokens[token.id];
        const latestPatch = {
          light: latest?.light || updatedLight,
          ...(hasRotUpdate
            ? { rotation: latest?.rotation ?? normRot }
            : {}),
        };
        updateToken(token.id, latestPatch);
      }, 100);
      timers.set(token.id, timer);
    }
  }

  const zoomPercent = Math.round(liveScale * 100);
  const gridOn = gridVisible;
  const canZoomIn = liveScale < MAX_SCALE - 0.0001;

  function handleZoomIn() {
    canvasStore.getState().zoomBy(1.2);
  }

  function handleZoomOut() {
    canvasStore.getState().zoomBy(1 / 1.2);
  }

  function handleResetZoom() {
    const placedMaps = Object.values(sessionStore.getState().tokens || {}).filter(
      (t) => t.isMap,
    );
    if (placedMaps.length > 0 && size.width > 0 && size.height > 0) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const m of placedMaps) {
        const halfW = (m.width || 800) / 2;
        const halfH = (m.height || 600) / 2;
        minX = Math.min(minX, m.x - halfW);
        minY = Math.min(minY, m.y - halfH);
        maxX = Math.max(maxX, m.x + halfW);
        maxY = Math.max(maxY, m.y + halfH);
      }
      const boxW = Math.max(1, maxX - minX);
      const boxH = Math.max(1, maxY - minY);
      const fitted = fitViewport(boxW, boxH, size.width, size.height, 0.92);
      canvasStore.getState().setViewport({
        x: fitted.x - minX * fitted.scale,
        y: fitted.y - minY * fitted.scale,
        scale: fitted.scale,
      });
      return;
    }
    const mapW = map?.width || 1920;
    const mapH = map?.height || 1080;
    if (size.width > 0 && size.height > 0) {
      canvasStore.getState().setViewport({
        x: Math.round((size.width - mapW) / 2),
        y: Math.round((size.height - mapH) / 2),
        scale: 1,
      });
      return;
    }
    canvasStore.getState().fit();
  }

  function handleToggleGrid() {
    canvasStore.getState().toggleGrid();
  }

  function handleGridSizeChange(nextValue, { immediate = false } = {}) {
    const clamped = Math.min(
      MAX_GRID_SIZE,
      Math.max(MIN_GRID_SIZE, Math.round(Number(nextValue) || DEFAULT_GRID_SIZE)),
    );
    const currentMap = sessionStore.getState().map || {
      id: 1,
      name: scene || 'Untitled Scene',
      width: 1920,
      height: 1080,
    };
    sessionStore.getState().setMap({ ...currentMap, gridSize: clamped });

    if (gridSyncTimerRef.current) {
      clearTimeout(gridSyncTimerRef.current);
      gridSyncTimerRef.current = null;
    }
    if (immediate) {
      void updateSceneMap({ id: currentMap.id, gridSize: clamped });
    } else {
      gridSyncTimerRef.current = setTimeout(() => {
        gridSyncTimerRef.current = null;
        const latestMap = sessionStore.getState().map;
        void updateSceneMap({
          id: latestMap?.id ?? currentMap.id,
          gridSize: latestMap?.gridSize ?? clamped,
        });
      }, 100);
    }
  }

  async function handleDeleteSelected() {
    const ids = [...canvasStore.getState().selectedIds];
    if (ids.length === 0) return;
    const currentTokens = sessionStore.getState().tokens;
    const deletable = ids.filter((id) => !currentTokens[id]?.locked);
    if (deletable.length === 0) return;
    const remaining = ids.filter((id) => !deletable.includes(id));
    canvasStore.getState().setSelection(remaining);
    await Promise.all(deletable.map((id) => deleteToken(id)));
  }

  async function handleToggleLock() {
    const next = !allSelectedLocked;
    await Promise.all(
      selectedTokens.map((token) => updateToken(token.id, { locked: next })),
    );
  }

  async function handleToggleSingleLock(token) {
    if (!token) return;
    const next = !token.locked;
    sessionStore.getState().upsertToken({ ...token, locked: next });
    await updateToken(token.id, { locked: next });
  }

  async function handleRenameSubmit(e) {
    e.preventDefault();
    if (!singleSelectedToken) return;
    const clean = renameDraft.trim();
    if (!clean) return;
    await updateToken(singleSelectedToken.id, { label: clean });
    setRenamingTokenId(null);
  }

  async function handleSelectScene(newSceneName, assetHint = null) {
    if (!newSceneName) return;
    const currentSceneName = scene || map?.name || 'Untitled Scene';
    const nextKey = String(newSceneName).trim().toLowerCase();
    const currKey = String(currentSceneName).trim().toLowerCase();
    if (nextKey === currKey) return;

    canvasStore.getState().clearSelection();

    const storeAssets = assetStore.getState().assets;
    const matchingAsset =
      (assetHint?.id ? storeAssets.find((a) => a.id === assetHint.id) : null) ||
      storeAssets.find(
        (a) =>
          (a.category || '').toLowerCase() === 'scenes' &&
          (a.name || '').toLowerCase() === nextKey,
      ) ||
      null;
    const resolvedUrl =
      assetHint?.url ||
      matchingAsset?.url ||
      (matchingAsset?.id
        ? `/assets/${encodeURIComponent(matchingAsset.id)}/file`
        : null);

    const rawW = Number(assetHint?.width || matchingAsset?.width) || 1920;
    const rawH = Number(assetHint?.height || matchingAsset?.height) || 1080;
    const alignScale =
      Number(assetHint?.metadata?.scale || matchingAsset?.metadata?.scale) || 100;
    const placedW = Math.max(80, Math.round(rawW * (alignScale / 100)));
    const placedH = Math.max(80, Math.round(rawH * (alignScale / 100)));
    const sceneGridSize =
      Number(assetHint?.metadata?.gridSize || matchingAsset?.metadata?.gridSize) ||
      DEFAULT_GRID_SIZE;

    const selectResult = await selectSceneMap({
      name: newSceneName,
      createIfMissing: true,
      width: placedW,
      height: placedH,
      gridSize: sceneGridSize,
    });

    const activeTokens = Object.values(sessionStore.getState().tokens || {});
    const hasPlacedMap = activeTokens.some((t) => t.isMap);
    const activeMap = sessionStore.getState().map;

    // Imported scene images are spawned once inside that scene as movable/resizable/rotatable/lockable map objects
    if (resolvedUrl && !hasPlacedMap) {
      const centerW = activeMap?.width || placedW;
      const centerH = activeMap?.height || placedH;
      const sceneTokenPayload = {
        label: newSceneName,
        x: Math.round(centerW / 2),
        y: Math.round(centerH / 2),
        color: '#8fd2c5',
        isMap: true,
        imageUrl: resolvedUrl,
        width: placedW,
        height: placedH,
        rotation: 0,
      };
      const res = await createToken(sceneTokenPayload);
      if (!res?.ok || !res?.token) {
        sessionStore.getState().upsertToken({
          ...sceneTokenPayload,
          id: `tok_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          mapId: activeMap?.id ?? 1,
          locked: false,
        });
      }
    }

    if (selectResult?.ok) {
      sessionStore.getState().saveSceneSnapshot(newSceneName);
    }

    if (size.width > 0 && size.height > 0) {
      const viewW = activeMap?.width || placedW;
      const viewH = activeMap?.height || placedH;
      canvasStore.getState().setViewport({
        x: Math.round((size.width - viewW) / 2),
        y: Math.round((size.height - viewH) / 2),
        scale: 1,
      });
    }

    onSelectScene?.(newSceneName);
  }

  function handleCanvasDragEnter(e) {
    if (!isDM) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }

  function handleCanvasDragOver(e) {
    if (!isDM) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }

  async function handleCanvasDrop(e) {
    if (!isDM) return;
    e.preventDefault();
    e.stopPropagation();
    const raw =
      e.dataTransfer.getData('application/x-hakton-asset') ||
      e.dataTransfer.getData('text/plain');
    if (!raw) return;

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { name: raw, category: assetTrayCategory || 'Characters' };
    }
    if (!payload?.name) return;

    const category = payload.category || assetTrayCategory || 'Characters';
    if (category === 'Scenes') {
      await handleSelectScene(payload.name, payload);
      return;
    }

    // Spawn a new token / entity instance on the canvas for Characters, Maps, Props, Attachments
    const rect = host.current?.getBoundingClientRect();
    const screenPt = rect
      ? { x: e.clientX - rect.left, y: e.clientY - rect.top }
      : { x: size.width / 2, y: size.height / 2 };
    const mapPt = screenToMap(canvasStore.getState().viewport, screenPt);
    const grid = map?.gridSize || DEFAULT_GRID_SIZE;
    const isMapAsset =
      category.toLowerCase() === 'maps' ||
      String(payload.category || '').toLowerCase() === 'maps';
    const snapped = isMapAsset ? mapPt : snapEnabled ? snapPoint(mapPt, grid) : mapPt;
    const finalPos = snapped;

    // Determine category-specific color & style
    let tokenColor;
    if (category === 'Characters') {
      const partyMatch = party.find(
        (p) => p.name.toLowerCase() === payload.name.toLowerCase(),
      );
      tokenColor = partyMatch?.color || '#adfcf9';
    } else if (isMapAsset) {
      tokenColor = '#8fd2c5';
    } else if (category === 'Props') {
      tokenColor = '#f0a854';
    } else if (category === 'Attachments') {
      tokenColor = '#db9685';
    } else {
      tokenColor =
        TOKEN_PALETTE[Object.keys(tokens).length % TOKEN_PALETTE.length];
    }

    const storeAssets = assetStore.getState().assets;
    const matchingAsset = isMapAsset
      ? (payload.id ? storeAssets.find((a) => a.id === payload.id) : null) ||
        storeAssets.find(
          (a) =>
            (a.category || '').toLowerCase() === 'maps' &&
            a.name.toLowerCase() === payload.name.toLowerCase(),
        ) ||
        storeAssets.find(
          (a) => a.name.toLowerCase() === payload.name.toLowerCase(),
        )
      : null;

    const imageUrl = isMapAsset
      ? payload.url ||
        matchingAsset?.url ||
        (matchingAsset?.id
          ? `/assets/${encodeURIComponent(matchingAsset.id)}/file`
          : null) ||
        null
      : null;

    let placedW;
    let placedH;
    if (isMapAsset) {
      placedW = Number(payload.width || matchingAsset?.width) || 800;
      placedH = Number(payload.height || matchingAsset?.height) || 600;
      const alignScale =
        Number(payload.metadata?.scale || matchingAsset?.metadata?.scale) || 100;
      placedW = Math.max(80, Math.round(placedW * (alignScale / 100)));
      placedH = Math.max(80, Math.round(placedH * (alignScale / 100)));
    }

    const tokenPayload = {
      label: payload.name,
      x: finalPos.x,
      y: finalPos.y,
      color: tokenColor,
      isMap: isMapAsset,
      imageUrl,
      width: placedW,
      height: placedH,
    };

    const res = await createToken(tokenPayload);
    // Guarantee optimistic local visibility on canvas if server ack is delayed or offline
    if (!res?.ok || !res?.token) {
      const localToken = {
        id: `tok_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        mapId: map?.id ?? 1,
        label: payload.name,
        x: finalPos.x,
        y: finalPos.y,
        color: tokenColor,
        locked: false,
        isMap: isMapAsset,
        imageUrl,
        width: placedW ?? null,
        height: placedH ?? null,
      };
      sessionStore.getState().upsertToken(localToken);
    }
  }

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (window.hakton || hostUrl)
      connect({
        displayName,
        userId,
        role: role === 'DM' ? 'dm' : 'player',
        url: hostUrl || undefined,
        campaignKey: role === 'DM' ? campaignId : undefined,
        campaignName: role === 'DM' ? campaignName : undefined,
      })
        .then(() => setError(''))
        .catch((e) => setError(e.message));
  }, [displayName, userId, role, hostUrl, campaignId, campaignName]);

  const activeMapStates = {
    players: playersOpen,
    dice: diceOpen,
    initiative: initiativeOpen,
    notes: notesOpen,
    soundboard: soundboardOpen,
  };

  // Compute screen coordinates for the single-selected token's floating popup bar & non-obstructing Light menu
  const grid = map?.gridSize || DEFAULT_GRID_SIZE;
  const isSelectedTokenDragging = Boolean(
    singleSelectedToken &&
      (draggingIds.includes(singleSelectedToken.id) ||
        draggingTransforms[singleSelectedToken.id]),
  );
  const tokenScreenPos = singleSelectedToken
    ? mapToScreen(viewport, {
        x: singleSelectedToken.x,
        y: singleSelectedToken.y,
      })
    : null;
  const tokenRadiusPx = Math.max(8, grid / 2 - 4) * viewport.scale;

  const effectiveDirection = singleSelectedToken
    ? draggingRotations[singleSelectedToken.id] ??
      singleSelectedToken.rotation ??
      singleSelectedToken.light?.rotation ??
      0
    : 0;
  const normalizedDirection =
    ((Math.round(Number(effectiveDirection) || 0) % 360) + 360) % 360;

  const MENU_W = 256;
  const MENU_H = 310;
  const MENU_GAP = Math.max(tokenRadiusPx + 46, 78);
  const lightMenuFitsRight = tokenScreenPos
    ? tokenScreenPos.x + MENU_GAP + MENU_W <= size.width - 12
    : true;
  const lightMenuLeft = tokenScreenPos
    ? lightMenuFitsRight
      ? Math.min(size.width - MENU_W - 12, tokenScreenPos.x + MENU_GAP)
      : Math.max(12, tokenScreenPos.x - MENU_GAP - MENU_W)
    : 0;
  const lightMenuTop = tokenScreenPos
    ? Math.max(16, Math.min(Math.max(16, size.height - MENU_H - 16), tokenScreenPos.y - 72))
    : 0;

  // Position popup bar cleanly away from 12 o'clock rotate icon AND away from downward (6 o'clock) vision cones
  const isPointingDown =
    Boolean(singleSelectedToken && !singleSelectedToken.isMap) &&
    normalizedDirection >= 45 &&
    normalizedDirection <= 135;
  let popupPlacementClass = '';
  let popupLeft = tokenScreenPos
    ? Math.max(96, Math.min(size.width - 96, tokenScreenPos.x))
    : 0;
  let popupTop = 0;
  if (tokenScreenPos && singleSelectedToken) {
    if (singleSelectedToken.isMap) {
      const mapHalfHPx = ((singleSelectedToken.height || 600) * viewport.scale) / 2;
      popupTop = Math.max(
        64,
        Math.min(size.height - 88, tokenScreenPos.y + mapHalfHPx + 14),
      );
    } else if (isPointingDown) {
      const sideGap = Math.max(tokenRadiusPx + 18, 42);
      const placeLeft = lightMenuFitsRight && tokenScreenPos.x > 190;
      popupPlacementClass = placeLeft ? 'side-left' : 'side-right';
      popupLeft = placeLeft
        ? Math.max(168, tokenScreenPos.x - sideGap)
        : Math.min(size.width - 180, tokenScreenPos.x + sideGap);
      popupTop = Math.max(54, Math.min(size.height - 56, tokenScreenPos.y));
    } else {
      popupTop = Math.max(
        54,
        Math.min(size.height - 56, tokenScreenPos.y + tokenRadiusPx + 14),
      );
    }
  }

  return (
    <section className="board" aria-label="Tabletop canvas">
      <nav className="extension-toolbar" aria-label="VTT extensions">
        {[
          'home',
          'players',
          'dice',
          'sheet',
          'initiative',
          'soundboard',
          'notes',
          'compendium',
        ].map((action) => {
          const isToggle = Object.hasOwn(activeMapStates, action);
          const isOpen = activeMapStates[action];
          return (
            <IconButton
              key={action}
              label={
                {
                  home: 'Home',
                  players: 'Players',
                  dice: 'Dice tray',
                  sheet: 'Character sheet',
                  initiative: 'Initiative tracker',
                  notes: 'Notes',
                  compendium: 'Compendium',
                  soundboard: 'Music box',
                }[action]
              }
              aria-pressed={isToggle ? isOpen : undefined}
              aria-expanded={isToggle ? isOpen : undefined}
              aria-controls={action === 'soundboard' ? soundboardId : undefined}
              onClick={(event) => onAction(action, event.currentTarget)}
            >
              <ToolIcon name={action} />
            </IconButton>
          );
        })}
      </nav>
      <div
        ref={host}
        className="board-viewport"
        onDragEnter={handleCanvasDragEnter}
        onDragOver={handleCanvasDragOver}
        onDrop={handleCanvasDrop}
      >
        <Suspense
          fallback={
            <div className="board-notice" role="status">
              Loading canvas…
            </div>
          }
        >
          <MapStage
            width={size.width}
            height={size.height}
            role={role}
            onDeleteSelection={isDM ? handleDeleteSelected : null}
          />
        </Suspense>
        <DiceOverlay
          width={size.width}
          height={size.height}
          activeRoll={activeRoll}
          onRollSettledIntoTray={(roll) =>
            sessionStore.getState().settleRollIntoTray(roll)
          }
          onRollLifecycleEnd={() => sessionStore.getState().clearActiveRoll()}
        />

        {/* Single-Clicked Token Property Popup Bar (Rename, Light & Lock Controls) */}
        {singleSelectedToken && tokenScreenPos && !isSelectedTokenDragging && (
          <div
            className={`token-popup-bar${popupPlacementClass ? ` ${popupPlacementClass}` : ''}`}
            style={{
              left: `${popupLeft}px`,
              top: `${popupTop}px`,
            }}
            role="toolbar"
            aria-label={`Token properties for ${singleSelectedToken.label}`}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {renamingTokenId === singleSelectedToken.id ? (
              <form className="token-rename-form" onSubmit={handleRenameSubmit}>
                <input
                  aria-label="Token name"
                  value={renameDraft}
                  maxLength={40}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  autoFocus
                />
                <button type="submit" className="primary">
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setRenamingTokenId(null)}
                >
                  ×
                </button>
              </form>
            ) : (
              <>
                <IconButton
                  label="Edit token name"
                  title={`Rename ${singleSelectedToken.label}`}
                  onClick={() => {
                    setRenameDraft(singleSelectedToken.label || '');
                    setRenamingTokenId(singleSelectedToken.id);
                  }}
                >
                  <ToolIcon name="text" />
                </IconButton>

                {!singleSelectedToken.isMap && (
                  <>
                    {/* Sword button to toggle "In combat" property (Initiative + HP in properties popover) */}
                    <IconButton
                      label={
                        singleSelectedToken.combat?.enabled
                          ? 'Remove from combat'
                          : 'Mark as in combat'
                      }
                      title={
                        singleSelectedToken.combat?.enabled
                          ? 'In combat — click to remove from combat'
                          : 'Give In Combat property (Initiative & HP)'
                      }
                      aria-pressed={Boolean(singleSelectedToken.combat?.enabled)}
                      className={
                        singleSelectedToken.combat?.enabled ? 'active-combat-btn' : ''
                      }
                      onClick={() => handleToggleCombat(singleSelectedToken)}
                    >
                      <ToolIcon name="sword" />
                    </IconButton>

                    {/* Lightbulb button to toggle light on token (Cancels Fog of War) */}
                    <IconButton
                      label={
                        singleSelectedToken.light?.enabled
                          ? 'Turn off light'
                          : 'Give light property'
                      }
                      title={
                        singleSelectedToken.light?.enabled
                          ? 'Turn off token light'
                          : 'Give token light (Cancels out Fog of War)'
                      }
                      aria-pressed={Boolean(singleSelectedToken.light?.enabled)}
                      className={
                        singleSelectedToken.light?.enabled ? 'active-light-btn' : ''
                      }
                      onClick={() => handleToggleLight(singleSelectedToken)}
                    >
                      <ToolIcon name="light" />
                    </IconButton>

                    {/* Triple-dot menu button to configure active properties (Combat & Light) */}
                    {(singleSelectedToken.light?.enabled ||
                      singleSelectedToken.combat?.enabled) && (
                      <IconButton
                        label="Token properties menu"
                        title="Configure Token Properties"
                        aria-pressed={propertyMenuOpen}
                        aria-expanded={propertyMenuOpen}
                        onClick={() => {
                          setPropertyMenuOpen((open) => {
                            const nextOpen = !open;
                            if (nextOpen) {
                              if (
                                propertyMenuTab === 'combat' &&
                                !singleSelectedToken.combat?.enabled &&
                                singleSelectedToken.light?.enabled
                              ) {
                                setPropertyMenuTab('light');
                              } else if (
                                propertyMenuTab === 'light' &&
                                !singleSelectedToken.light?.enabled &&
                                singleSelectedToken.combat?.enabled
                              ) {
                                setPropertyMenuTab('combat');
                              }
                            }
                            return nextOpen;
                          });
                        }}
                      >
                        <ToolIcon name="dots" />
                      </IconButton>
                    )}
                  </>
                )}

                {isDM && (
                  <IconButton
                    label={
                      singleSelectedToken.locked
                        ? `Unlock ${singleSelectedToken.label}`
                        : `Lock ${singleSelectedToken.label}`
                    }
                    title={
                      singleSelectedToken.locked
                        ? 'Locked — click to unlock'
                        : 'Unlocked — click to lock'
                    }
                    aria-pressed={Boolean(singleSelectedToken.locked)}
                    className={singleSelectedToken.locked ? 'active-lock-btn' : ''}
                    onClick={() => handleToggleSingleLock(singleSelectedToken)}
                  >
                    <ToolIcon name={singleSelectedToken.locked ? 'lock' : 'unlock'} />
                  </IconButton>
                )}

                {isDM && singleSelectedToken.isMap && (
                  <IconButton
                    label={`Remove ${singleSelectedToken.label}`}
                    title={
                      singleSelectedToken.locked
                        ? 'Unlock before removing'
                        : 'Remove placed map/scene image'
                    }
                    disabled={Boolean(singleSelectedToken.locked)}
                    onClick={handleDeleteSelected}
                  >
                    <ToolIcon name="trash" />
                  </IconButton>
                )}
              </>
            )}
          </div>
        )}

        {/* Non-Obstructing Token Properties Popover Menu (Combat & Light tabs beside token) */}
        {singleSelectedToken &&
          tokenScreenPos &&
          !isSelectedTokenDragging &&
          !singleSelectedToken.isMap &&
          propertyMenuOpen &&
          (singleSelectedToken.light?.enabled || singleSelectedToken.combat?.enabled) && (() => {
            const hasCombat = Boolean(singleSelectedToken.combat?.enabled);
            const hasLight = Boolean(singleSelectedToken.light?.enabled);
            const activeTab =
              propertyMenuTab === 'combat' && hasCombat
                ? 'combat'
                : hasLight
                  ? 'light'
                  : 'combat';
            const canViewHp = canViewTokenHp(
              singleSelectedToken,
              viewerRole,
              participants,
            );
            const canEditCombat =
              isDM ||
              !singleSelectedToken.ownerId ||
              (Boolean(myParticipantId) &&
                singleSelectedToken.ownerId === myParticipantId);
            const canEditHp =
              canViewHp &&
              (isDM ||
                (Boolean(myParticipantId) &&
                  singleSelectedToken.ownerId === myParticipantId));

            return (
              <div
                className="token-light-menu token-properties-menu"
                style={{
                  left: `${lightMenuLeft}px`,
                  top: `${lightMenuTop}px`,
                }}
                role="dialog"
                aria-label="Token Properties"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="token-light-header">
                  <strong>
                    {activeTab === 'combat' ? 'In Combat' : 'Light & Vision'}
                  </strong>
                  <button
                    type="button"
                    className="close-menu-btn"
                    onClick={() => setPropertyMenuOpen(false)}
                  >
                    ×
                  </button>
                </div>

                {hasCombat && hasLight && (
                  <div className="token-properties-tabs" role="tablist">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeTab === 'combat'}
                      className={activeTab === 'combat' ? 'active' : ''}
                      onClick={() => setPropertyMenuTab('combat')}
                    >
                      Combat
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeTab === 'light'}
                      className={activeTab === 'light' ? 'active' : ''}
                      onClick={() => setPropertyMenuTab('light')}
                    >
                      Light
                    </button>
                  </div>
                )}

                {activeTab === 'combat' && hasCombat ? (
                  <>
                    {isDM && (
                      <div className="token-light-section">
                        <label
                          className="token-light-label"
                          htmlFor="combat-owner-select"
                        >
                          Owner
                        </label>
                        <select
                          id="combat-owner-select"
                          className="combat-owner-select"
                          value={singleSelectedToken.ownerId || ''}
                          onChange={(e) =>
                            handleChangeTokenOwner(singleSelectedToken, e.target.value)
                          }
                        >
                          <option value="">Unassigned (DM HP)</option>
                          {connectedParticipants.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.displayName}
                              {p.role === 'dm' ? ' (DM)' : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    <div className="token-light-section">
                      <div className="token-light-row">
                        <label htmlFor="combat-initiative-input">Initiative</label>
                        <span className="token-light-value">
                          {singleSelectedToken.combat?.initiative ?? 'Unset'}
                        </span>
                      </div>
                      <input
                        id="combat-initiative-input"
                        type="number"
                        step="1"
                        placeholder="Enter rolled initiative…"
                        disabled={!canEditCombat}
                        value={singleSelectedToken.combat?.initiative ?? ''}
                        onChange={(e) => {
                          const raw = e.target.value;
                          const nextInit =
                            raw === '' ? null : Math.round(Number(raw));
                          handleUpdateCombat(singleSelectedToken, {
                            initiative: Number.isFinite(nextInit) ? nextInit : null,
                          });
                        }}
                      />
                    </div>

                    <div className="token-light-section">
                      <span className="token-light-label">HP</span>
                      {canViewHp ? (
                        <div className="combat-hp-row">
                          <HpRing
                            hp={singleSelectedToken.combat?.hp}
                            maxHp={singleSelectedToken.combat?.maxHp}
                          />
                          <div className="combat-hp-inputs">
                            <label>
                              <span>Current</span>
                              <input
                                aria-label="Current HP"
                                type="number"
                                min="0"
                                step="1"
                                disabled={!canEditHp}
                                value={singleSelectedToken.combat?.hp ?? ''}
                                onChange={(e) => {
                                  const raw = e.target.value;
                                  const val =
                                    raw === ''
                                      ? null
                                      : Math.max(0, Math.round(Number(raw)));
                                  handleUpdateCombat(singleSelectedToken, {
                                    hp: val,
                                  });
                                }}
                              />
                            </label>
                            <label>
                              <span>Max</span>
                              <input
                                aria-label="Max HP"
                                type="number"
                                min="1"
                                step="1"
                                disabled={!canEditHp}
                                value={singleSelectedToken.combat?.maxHp ?? ''}
                                onChange={(e) => {
                                  const raw = e.target.value;
                                  const val =
                                    raw === ''
                                      ? null
                                      : Math.max(1, Math.round(Number(raw)));
                                  handleUpdateCombat(singleSelectedToken, {
                                    maxHp: val,
                                  });
                                }}
                              />
                            </label>
                          </div>
                        </div>
                      ) : (
                        <p className="combat-hp-hidden">
                          {isDM
                            ? 'HP hidden (Player-owned token)'
                            : 'HP hidden (DM-only token)'}
                        </p>
                      )}
                    </div>

                    <div className="token-light-footer">
                      <button
                        type="button"
                        className="danger-btn remove-light-btn"
                        disabled={!canEditCombat}
                        onClick={() => handleToggleCombat(singleSelectedToken)}
                      >
                        Leave Combat
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="token-light-section">
                      <div className="token-light-row">
                        <label htmlFor="light-range-input">Range</label>
                        <span className="token-light-value">
                          {singleSelectedToken.light?.range || 30} ft
                        </span>
                      </div>
                      <input
                        id="light-range-input"
                        type="range"
                        min="5"
                        max="120"
                        step="5"
                        value={singleSelectedToken.light?.range || 30}
                        onChange={(e) =>
                          handleUpdateLight(singleSelectedToken, {
                            range: Number(e.target.value),
                          })
                        }
                      />
                    </div>

                    <div className="token-light-section">
                      <span className="token-light-label">Mode</span>
                      <div className="token-light-mode-group">
                        <button
                          type="button"
                          className={`mode-btn ${
                            singleSelectedToken.light?.type !== 'vision' ? 'active' : ''
                          }`}
                          onClick={() =>
                            handleUpdateLight(
                              singleSelectedToken,
                              { type: 'torch' },
                              { immediate: true },
                            )
                          }
                          title="Torch / Lantern (360° Made Light)"
                        >
                          <ToolIcon name="torch" />
                          <span>Torch (360°)</span>
                        </button>
                        <button
                          type="button"
                          className={`mode-btn ${
                            singleSelectedToken.light?.type === 'vision' ? 'active' : ''
                          }`}
                          onClick={() =>
                            handleUpdateLight(
                              singleSelectedToken,
                              { type: 'vision' },
                              { immediate: true },
                            )
                          }
                          title="Line of Sight (Directional Vision Cone)"
                        >
                          <ToolIcon name="cone" />
                          <span>Line of Sight</span>
                        </button>
                      </div>
                    </div>

                    {singleSelectedToken.light?.type === 'vision' && (
                      <>
                        <div className="token-light-section">
                          <div className="token-light-row">
                            <label htmlFor="light-rotation-input">Direction</label>
                            <span className="token-light-value">
                              {normalizedDirection}°
                            </span>
                          </div>
                          <input
                            id="light-rotation-input"
                            type="range"
                            min="0"
                            max="359"
                            step="1"
                            value={normalizedDirection}
                            onChange={(e) =>
                              handleUpdateLight(singleSelectedToken, {
                                rotation: Number(e.target.value),
                              })
                            }
                          />
                        </div>
                        <div className="token-light-section">
                          <div className="token-light-row">
                            <label htmlFor="light-angle-input">Cone Angle</label>
                            <span className="token-light-value">
                              {singleSelectedToken.light?.angle || 90}°
                            </span>
                          </div>
                          <input
                            id="light-angle-input"
                            type="range"
                            min="30"
                            max="180"
                            step="15"
                            value={singleSelectedToken.light?.angle || 90}
                            onChange={(e) =>
                              handleUpdateLight(singleSelectedToken, {
                                angle: Number(e.target.value),
                              })
                            }
                          />
                        </div>
                      </>
                    )}

                    <div className="token-light-footer">
                      <button
                        type="button"
                        className="danger-btn remove-light-btn"
                        onClick={() => handleToggleLight(singleSelectedToken)}
                      >
                        Remove Light
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })()}

        {(error || connectionError || connection !== 'connected') && (
          <div className="board-notice" role="status">
            {error ||
              connectionError ||
              (hostUrl
                ? `Session ${connection}. Waiting for ${hostUrl}.`
                : window.hakton
                  ? `Session ${connection}. Waiting for the local host.`
                  : 'Session disconnected. Waiting for connection.')}
          </div>
        )}
      </div>

      {/* DM Fog of War & Walls Top Horizontal Bar */}
      {isDM && fogMenuOpen && (
        <div className="fog-top-bar" role="toolbar" aria-label="Fog of War tools">
          <div className="fog-bar-section" title="Fog Creation Tools">
            <IconButton
              label="Line Brush (Auto-fills enclosed shape)"
              title="Line Brush (Auto-fills enclosed shapes)"
              aria-pressed={fogTool === 'line'}
              onClick={() => canvasStore.getState().setFogTool('line')}
            >
              <ToolIcon name="brush" />
            </IconButton>
            <IconButton
              label="Custom Polygon"
              title="Custom Polygon (Click points, click hovering handle on start to fill)"
              aria-pressed={fogTool === 'polygon'}
              onClick={() => canvasStore.getState().setFogTool('polygon')}
            >
              <ToolIcon name="polygon" />
            </IconButton>
            <IconButton
              label="Rectangle Fog"
              title="Rectangle Fog"
              aria-pressed={fogTool === 'rect'}
              onClick={() => canvasStore.getState().setFogTool('rect')}
            >
              <ToolIcon name="rect" />
            </IconButton>
            <IconButton
              label="Circle Fog"
              title="Circle Fog"
              aria-pressed={fogTool === 'circle'}
              onClick={() => canvasStore.getState().setFogTool('circle')}
            >
              <ToolIcon name="circle" />
            </IconButton>
          </div>

          <span className="fog-top-bar-divider" />

          <div className="fog-bar-section" title="Barriers & Doors">
            <IconButton
              label="Mount Door on Wall"
              title="Mount Door (Click on any fog shape wall edge to mount a door)"
              aria-pressed={fogTool === 'door'}
              onClick={() => canvasStore.getState().setFogTool('door')}
            >
              <ToolIcon name="door" />
            </IconButton>
          </div>

          <span className="fog-top-bar-divider" />

          <div className="fog-bar-section" title="Manage Fog">
            <IconButton
              label="Erase Fog or Door"
              title="Erase Fog or Door (Click any placed fog shape or door to remove it)"
              aria-pressed={fogTool === 'erase'}
              onClick={() => canvasStore.getState().setFogTool('erase')}
            >
              <ToolIcon name="eraser" />
            </IconButton>
            <IconButton
              className="danger-btn"
              label="Clear All Fog & Doors"
              title="Clear All Fog & Doors"
              onClick={() => canvasStore.getState().clearFog()}
            >
              <ToolIcon name="trash" />
            </IconButton>
          </div>

          <span className="fog-top-bar-divider" />

          <div className="fog-bar-section" title="Player Vision Preview">
            <IconButton
              label="Toggle Player Vision Preview"
              title={
                playerVisionPreview
                  ? 'Exit Player Vision Preview'
                  : 'Preview Player Vision (Pitch-Black Fog)'
              }
              aria-pressed={playerVisionPreview}
              onClick={() => canvasStore.getState().togglePlayerVisionPreview()}
            >
              <ToolIcon name="preview" />
            </IconButton>
            {playerVisionPreview && (
              <span className="fog-preview-pill">Player View</span>
            )}
          </div>

          <span className="fog-top-bar-divider" />

          <IconButton
            label="Close Fog Tools"
            title="Close Fog of War bar"
            onClick={() => {
              setFogMenuOpen(false);
              canvasStore.getState().setFogTool(null);
            }}
          >
            <ToolIcon name="close" />
          </IconButton>
        </div>
      )}

      <nav className="utility-toolbar" aria-label="VTT utilities">
        <IconButton
          label="Select tokens"
          aria-pressed={!fogTool && selectTool === 'select'}
          title="Click to select, Shift-click for multi-select, drag to move"
          onClick={() => {
            canvasStore.getState().setFogTool(null);
            canvasStore.getState().setSelectTool('select');
            canvasStore.getState().clearSelection();
          }}
        >
          <ToolIcon name="select" />
        </IconButton>
        <IconButton
          label="Lasso multi-select"
          aria-pressed={!fogTool && selectTool === 'lasso'}
          title="Lasso tool — drag a loop around tokens (Shift to add)"
          onClick={() => {
            canvasStore
              .getState()
              .setSelectTool(selectTool === 'lasso' ? 'select' : 'lasso');
          }}
        >
          <ToolIcon name="multi" />
        </IconButton>
        <IconButton
          label="Text chat"
          aria-pressed={chatOpen}
          aria-expanded={chatOpen}
          onClick={() => onAction('chat')}
        >
          <ToolIcon name="chat" />
        </IconButton>
        <IconButton label="Measure distance — unavailable" disabled>
          <ToolIcon name="ruler" />
        </IconButton>
        {isDM ? (
          <IconButton
            label="Fog of War"
            title="Fog of War, Walls & Doors"
            aria-pressed={fogMenuOpen || Boolean(fogTool)}
            aria-expanded={fogMenuOpen}
            onClick={() => setFogMenuOpen((v) => !v)}
          >
            <ToolIcon name="fog" />
          </IconButton>
        ) : (
          <IconButton label="Draw — unavailable" disabled>
            <ToolIcon name="draw" />
          </IconButton>
        )}
        <span className="toolbar-divider" />
        <IconButton
          label={isDM ? 'Grid settings' : 'Toggle grid'}
          title={isDM ? 'Grid visibility & cell size' : 'Toggle grid'}
          aria-pressed={isDM ? gridOn || gridMenuOpen : gridOn}
          aria-expanded={isDM ? gridMenuOpen : undefined}
          onClick={() => {
            if (isDM) setGridMenuOpen((v) => !v);
            else handleToggleGrid();
          }}
        >
          <ToolIcon name="grid" />
        </IconButton>
        <IconButton
          label="Toggle grid snapping (hold Alt to bypass)"
          aria-pressed={snapEnabled}
          onClick={() => canvasStore.getState().toggleSnap()}
        >
          <ToolIcon name="snap" />
        </IconButton>
        <IconButton label="Fit map" onClick={handleResetZoom}>
          <ToolIcon name="fit" />
        </IconButton>
        <IconButton
          label="Zoom in"
          disabled={!canZoomIn}
          onClick={handleZoomIn}
        >
          +
        </IconButton>
        <button
          className="zoom-value"
          title="Fit map to window"
          onClick={handleResetZoom}
        >
          {zoomPercent}%
        </button>
        <IconButton label="Zoom out" onClick={handleZoomOut}>
          −
        </IconButton>
        {isDM && (
          <>
            <span className="toolbar-divider" />
            <IconButton
              label="Add token"
              onClick={() => setAddTokenOpen(true)}
            >
              <ToolIcon name="plus" />
            </IconButton>
              {selectedTokens.length > 0 && (
              <>
                <IconButton
                  label={
                    allSelectedLocked ? 'Unlock selected tokens' : 'Lock selected tokens'
                  }
                  title={
                    allSelectedLocked
                      ? 'Locked — click to unlock'
                      : 'Unlocked — click to lock'
                  }
                  aria-pressed={allSelectedLocked}
                  onClick={handleToggleLock}
                >
                  <ToolIcon name={allSelectedLocked ? 'lock' : 'unlock'} />
                </IconButton>
                <IconButton
                  label="Delete selected tokens"
                  title={
                    allSelectedLocked
                      ? 'Unlock selected tokens before deleting'
                      : 'Delete selected tokens'
                  }
                  disabled={allSelectedLocked}
                  onClick={handleDeleteSelected}
                >
                  <ToolIcon name="trash" />
                </IconButton>
              </>
            )}
          </>
        )}
      </nav>
      {isDM && gridMenuOpen && (
        <div
          className="grid-settings-popover"
          role="dialog"
          aria-label="Grid Settings"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="grid-settings-header">
            <strong>Grid Settings</strong>
            <button
              type="button"
              className="close-menu-btn"
              aria-label="Close Grid Settings"
              onClick={() => setGridMenuOpen(false)}
            >
              ×
            </button>
          </div>
          <div className="grid-settings-row">
            <span>Show Grid</span>
            <button
              type="button"
              className={`grid-toggle-btn ${gridOn ? 'active' : ''}`}
              aria-pressed={gridOn}
              onClick={handleToggleGrid}
            >
              {gridOn ? 'On' : 'Off'}
            </button>
          </div>
          <div className="grid-settings-section">
            <div className="grid-settings-row">
              <label htmlFor="board-grid-size-input">Cell Size</label>
              <span className="grid-size-value">{grid} px</span>
            </div>
            <input
              id="board-grid-size-input"
              type="range"
              min={MIN_GRID_SIZE}
              max={MAX_GRID_SIZE}
              step={1}
              value={Math.min(MAX_GRID_SIZE, Math.max(MIN_GRID_SIZE, grid))}
              onChange={(e) => handleGridSizeChange(Number(e.target.value))}
            />
            <div className="grid-size-steppers">
              <button
                type="button"
                aria-label="Decrease grid size"
                title="Decrease cell size (−5 px, Shift −1 px)"
                onClick={(e) =>
                  handleGridSizeChange(grid - (e.shiftKey ? 1 : 5), {
                    immediate: true,
                  })
                }
              >
                −
              </button>
              <button
                type="button"
                className="grid-reset-btn"
                onClick={() =>
                  handleGridSizeChange(DEFAULT_GRID_SIZE, { immediate: true })
                }
              >
                Reset ({DEFAULT_GRID_SIZE} px)
              </button>
              <button
                type="button"
                aria-label="Increase grid size"
                title="Increase cell size (+5 px, Shift +1 px)"
                onClick={(e) =>
                  handleGridSizeChange(grid + (e.shiftKey ? 1 : 5), {
                    immediate: true,
                  })
                }
              >
                +
              </button>
            </div>
          </div>
        </div>
      )}
      {role === 'DM' && (
        <div className="asset-dock-region">
          {assetTrayCategory && (
            <section
              className="asset-tray-popup"
              aria-label={`Uploaded ${assetTrayCategory.toLowerCase()}`}
            >
              <div className="asset-tray-items">
                {trayEntries.map((entry, i) => {
                  const asset = entry.name;
                  return (
                    <button
                      key={entry.id || asset}
                      type="button"
                      draggable
                      onDragStart={(e) => {
                        const payload = JSON.stringify({
                          id: entry.id,
                          name: asset,
                          category: assetTrayCategory,
                          url: entry.url,
                          width: entry.width,
                          height: entry.height,
                          metadata: entry.metadata,
                        });
                        e.dataTransfer.setData('application/x-hakton-asset', payload);
                        e.dataTransfer.setData('text/plain', payload);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      className={`asset-tray-item ${
                        assetTrayCategory === 'Scenes' && scene === asset
                          ? 'selected'
                          : ''
                      }`}
                      title={`Drag "${asset}" onto the canvas`}
                    >
                      <span
                        className={`asset-thumbnail type-${assetTrayCategory.toLowerCase()} thumbnail-${i % 3}`}
                      >
                        {entry.url ? (
                          <img
                            className="asset-thumbnail-img"
                            src={resolveAssetUrl(entry.url)}
                            alt={asset}
                            draggable={false}
                          />
                        ) : assetTrayCategory === 'Characters' ? (
                          party[i]?.initials || asset.slice(0, 2).toUpperCase()
                        ) : assetTrayCategory === 'Attachments' ? (
                          '≡'
                        ) : (
                          <span className="mini-plan">
                            <i />
                            <i />
                            <i />
                          </span>
                        )}
                      </span>
                      <strong>{asset}</strong>
                      {assetTrayCategory === 'Scenes' && scene === asset && (
                        <small>Active</small>
                      )}
                    </button>
                  );
                })}
                {trayEntries.length === 0 && (
                  <span className="asset-tray-empty">
                    No uploaded {assetTrayCategory.toLowerCase()}
                  </span>
                )}
              </div>
            </section>
          )}
          <nav className="asset-launcher" aria-label="VTT assets">
            <div className="asset-launcher-categories">
              {['Scenes', 'Characters', 'Maps', 'Props', 'Attachments'].map(
                (category) => (
                  <IconButton
                    key={category}
                    label={`Uploaded ${category.toLowerCase()}`}
                    aria-pressed={assetTrayCategory === category}
                    aria-expanded={assetTrayCategory === category}
                    onClick={() => onToggleAssetTray?.(category)}
                  >
                    <ToolIcon name={category} />
                  </IconButton>
                ),
              )}
            </div>
            <IconButton
              className="icon-button asset-import-trigger"
              label="Import assets"
              aria-pressed={assetManagerOpen}
              aria-expanded={assetManagerOpen}
              onClick={() => onOpenAssetManager?.()}
            >
              <ToolIcon name="assetMenu" />
            </IconButton>
          </nav>
        </div>
      )}
      <span className="board-scale">
        {latency == null
          ? '5 ft / square'
          : `5 ft / square · sync ${Math.round(latency)} ms`}
      </span>
      {isDM && addTokenOpen && (
        <AddTokenDialog
          map={map}
          participants={participants}
          onCreate={createToken}
          onClose={() => setAddTokenOpen(false)}
        />
      )}
    </section>
  );
}
