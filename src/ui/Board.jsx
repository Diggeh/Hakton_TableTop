import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  connect,
  createToken,
  deleteToken,
  disconnect,
  resolveAssetUrl,
  retryConnection,
  updateToken,
} from '../net/socket.js';
import { sessionStore, useSession } from '../store/sessionStore.js';
import { assetStore } from '../store/assetStore.js';
import { canvasStore, useCanvas } from '../canvas/canvasStore.js';
import {
  MAX_SCALE,
  mapToScreen,
  screenToMap,
  snapPoint,
} from '../canvas/viewport.js';
import DiceOverlay from '../dice/DiceOverlay.jsx';
import { party } from './fixtures.js';
import ToolIcon from './ToolIcon.jsx';
import AddTokenDialog from './AddTokenDialog.jsx';
import { useUploadedCategoryAssetEntries } from './AssetsPanel.jsx';
import { IconButton } from './Primitives.jsx';
import VoiceCallToolbar from './VoiceCallToolbar.jsx';
import VideoCallStrip from './VideoCallStrip.jsx';

const MapStage = lazy(() => import('../canvas/MapStage.jsx'));

const TOKEN_PALETTE = ['#adfcf9', '#8fd2c5', '#f0a854', '#db9685', '#9ec5fe'];

export default function Board({
  displayName,
  userId,
  hostUrl,
  scene,
  role,
  playersOpen = false,
  diceOpen = false,
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
  onLeave,
}) {
  const host = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [error, setError] = useState('');
  const [addTokenOpen, setAddTokenOpen] = useState(false);
  const [fogMenuOpen, setFogMenuOpen] = useState(false);
  const [renamingTokenId, setRenamingTokenId] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [lightMenuOpen, setLightMenuOpen] = useState(false);

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
  const fogTool = useCanvas((s) => s.fogTool);
  const playerVisionPreview = useCanvas((s) => s.playerVisionPreview);

  const trayEntries = useUploadedCategoryAssetEntries(assetTrayCategory || 'Scenes');
  const lightSyncTimersRef = useRef(new Map());

  const currentUser = useSession((s) => s.currentUser);
  const isDM =
    role === 'DM' ||
    role === 'dm' ||
    currentUser?.role === 'dm' ||
    currentUser?.isHost;
  const selectedTokens = selectedIds
    .map((id) => tokens[id])
    .filter(Boolean);
  const singleSelectedToken =
    selectedTokens.length === 1 ? selectedTokens[0] : null;
  const selectedTokenId = singleSelectedToken?.id ?? null;
  const allSelectedLocked =
    selectedTokens.length > 0 && selectedTokens.every((token) => token.locked);

  // Clean up pending debounced light sync timers on unmount
  useEffect(() => {
    const timers = lightSyncTimersRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  // Close inline rename & light popover ONLY when switching or clearing selected token ID
  useEffect(() => {
    setRenamingTokenId(null);
    setLightMenuOpen(false);
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
      setLightMenuOpen(true);
    } else {
      setLightMenuOpen(false);
    }
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
    canvasStore.getState().fit();
  }

  function handleToggleGrid() {
    canvasStore.getState().toggleGrid();
  }

  async function handleDeleteSelected() {
    const ids = [...canvasStore.getState().selectedIds];
    if (ids.length === 0) return;
    canvasStore.getState().clearSelection();
    await Promise.all(ids.map((id) => deleteToken(id)));
  }

  async function handleToggleLock() {
    const next = !allSelectedLocked;
    await Promise.all(
      selectedTokens.map((token) => updateToken(token.id, { locked: next })),
    );
  }

  async function handleRenameSubmit(e) {
    e.preventDefault();
    if (!singleSelectedToken) return;
    const clean = renameDraft.trim();
    if (!clean) return;
    await updateToken(singleSelectedToken.id, { label: clean });
    setRenamingTokenId(null);
  }

  function handleSelectScene(newSceneName) {
    if (!newSceneName) return;
    const currentSceneName = scene || map?.name || 'Active Scene';
    sessionStore.getState().saveSceneSnapshot(currentSceneName);
    sessionStore.getState().loadSceneAssets(newSceneName);

    const key = String(newSceneName).trim().toLowerCase();
    const saved = sessionStore.getState().sceneAssets?.[key];

    if (!saved?.map || !saved.map.imageUrl) {
      const storeAssets = assetStore.getState().assets;
      const matchingAsset = storeAssets.find(
        (a) =>
          a.name.toLowerCase() === newSceneName.toLowerCase() &&
          ((a.category || '').toLowerCase() === 'scenes' ||
            (a.category || '').toLowerCase() === 'maps' ||
            a.type === 'map'),
      );
      const resolvedUrl =
        matchingAsset?.url ||
        (matchingAsset?.id
          ? `/assets/${encodeURIComponent(matchingAsset.id)}/file`
          : null);

      if (saved?.map) {
        if (resolvedUrl) {
          sessionStore.getState().setMap({
            ...saved.map,
            imageUrl: resolvedUrl,
            width: matchingAsset.width || saved.map.width || 1400,
            height: matchingAsset.height || saved.map.height || 980,
          });
          sessionStore.getState().setSelectedMapAsset(matchingAsset);
        }
      } else {
        const currentMap = sessionStore.getState().map || {
          id: 1,
          width: 1400,
          height: 980,
          gridSize: 70,
        };
        sessionStore.getState().setMap({
          ...currentMap,
          name: newSceneName,
          imageUrl: resolvedUrl || null,
          width: matchingAsset?.width || currentMap.width || 1400,
          height: matchingAsset?.height || currentMap.height || 980,
        });
        sessionStore.getState().setSelectedMapAsset(matchingAsset || null);
      }
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
      handleSelectScene(payload.name);
      return;
    }

    // Spawn a new token / entity instance on the canvas for Characters, Maps, Props, Attachments
    const rect = host.current?.getBoundingClientRect();
    const screenPt = rect
      ? { x: e.clientX - rect.left, y: e.clientY - rect.top }
      : { x: size.width / 2, y: size.height / 2 };
    const mapPt = screenToMap(canvasStore.getState().viewport, screenPt);
    const grid = map?.gridSize || 70;
    const mapWidth = map?.width || 1400;
    const mapHeight = map?.height || 980;
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
      placedW = Math.round(placedW * (alignScale / 100));
      placedH = Math.round(placedH * (alignScale / 100));
      const maxW = mapWidth * 0.9;
      const maxH = mapHeight * 0.9;
      if (placedW > maxW || placedH > maxH) {
        const ratio = Math.min(maxW / placedW, maxH / placedH);
        placedW = Math.round(placedW * ratio);
        placedH = Math.round(placedH * ratio);
      }
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
      })
        .then(() => setError(''))
        .catch((e) => setError(e.message));
  }, [displayName, userId, role, hostUrl]);

  const activeMapStates = {
    players: playersOpen,
    dice: diceOpen,
    soundboard: soundboardOpen,
  };

  // Compute screen coordinates for the single-selected token's floating popup bar & non-obstructing Light menu
  const grid = map?.gridSize || 70;
  const isSelectedTokenDragging = Boolean(
    singleSelectedToken && draggingIds.includes(singleSelectedToken.id),
  );
  const tokenScreenPos = singleSelectedToken
    ? mapToScreen(viewport, {
        x: singleSelectedToken.x,
        y: singleSelectedToken.y,
      })
    : null;
  const tokenRadiusPx = Math.max(8, grid / 2 - 4) * viewport.scale;
  const popupLeft = tokenScreenPos
    ? Math.max(80, Math.min(size.width - 80, tokenScreenPos.x))
    : 0;
  const popupTop = tokenScreenPos
    ? singleSelectedToken?.isMap
      ? Math.max(64, Math.min(size.height - 64, tokenScreenPos.y))
      : Math.max(54, Math.min(size.height - 54, tokenScreenPos.y + tokenRadiusPx + 10))
    : 0;

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
  const effectiveDirection = singleSelectedToken
    ? draggingRotations[singleSelectedToken.id] ??
      singleSelectedToken.rotation ??
      singleSelectedToken.light?.rotation ??
      0
    : 0;
  const normalizedDirection =
    ((Math.round(Number(effectiveDirection) || 0) % 360) + 360) % 360;

  return (
    <section className="board" aria-label="Tabletop canvas">
      <div className="top-left-toolbar-row">
        <nav className="extension-toolbar" aria-label="VTT extensions">
          {[
            'home',
            'players',
            'dice',
            'sheet',
            'initiative',
            'soundboard',
            ...(role === 'DM' ? ['notes'] : []),
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
                    initiative: 'Initiative tracker — unavailable',
                    notes: 'DM screen',
                    compendium: 'Compendium',
                    soundboard: 'Music box',
                  }[action]
                }
                disabled={action === 'initiative'}
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
        {isDM && <VoiceCallToolbar role={role} />}
      </div>
      <div className="board-caption" role="status">
        <span className="scene-indicator" />
        <strong>{scene || map?.name || 'Active Scene'}</strong>
        {map?.width && map?.height ? (
          <span>
            {map.width} × {map.height}
          </span>
        ) : null}
      </div>
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

        {/* Single-Clicked Token Property Popup Bar (Rename & Light Controls) */}
        {singleSelectedToken && tokenScreenPos && !isSelectedTokenDragging && (
          <div
            className="token-popup-bar"
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

                    {/* Triple-dot menu button to configure activated light properties */}
                    {singleSelectedToken.light?.enabled && (
                      <IconButton
                        label="Light properties menu"
                        title="Configure Light & Vision Properties"
                        aria-pressed={lightMenuOpen}
                        aria-expanded={lightMenuOpen}
                        onClick={() => setLightMenuOpen((v) => !v)}
                      >
                        <ToolIcon name="dots" />
                      </IconButton>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* Non-Obstructing Light Settings Popover Menu (positioned beside token) */}
        {singleSelectedToken &&
          tokenScreenPos &&
          !isSelectedTokenDragging &&
          !singleSelectedToken.isMap &&
          lightMenuOpen &&
          singleSelectedToken.light?.enabled && (
            <div
              className="token-light-menu"
              style={{
                left: `${lightMenuLeft}px`,
                top: `${lightMenuTop}px`,
              }}
              role="dialog"
              aria-label="Light Settings"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="token-light-header">
                <strong>Light & Vision</strong>
                <button
                  type="button"
                  className="close-menu-btn"
                  onClick={() => setLightMenuOpen(false)}
                >
                  ×
                </button>
              </div>

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
            </div>
          )}

        {(error || connectionError || connection !== 'connected') && (
          <div className="board-notice" role="status">
            <div>
              {error ||
                connectionError ||
                (hostUrl
                  ? `Session ${connection}. Waiting for ${hostUrl}.`
                  : window.hakton
                    ? `Session ${connection}. Waiting for the local host.`
                    : 'Session disconnected. Waiting for connection.')}
            </div>
            {!isDM && (connection === 'failed' || connection === 'disconnected' || Boolean(error)) && (
              <div className="board-notice-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => void retryConnection()}
                >
                  Retry
                </button>
                {onLeave && (
                  <button
                    type="button"
                    onClick={() => {
                      disconnect({ forgetIdentity: true });
                      onLeave();
                    }}
                  >
                    Change Code
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {!isDM && <VoiceCallToolbar role={role} />}
      <VideoCallStrip />

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
          aria-pressed={!fogTool}
          title="Click to select, Shift-click for multi-select, drag to move"
          onClick={() => {
            canvasStore.getState().setFogTool(null);
            canvasStore.getState().clearSelection();
          }}
        >
          <ToolIcon name="select" />
        </IconButton>
        <IconButton
          label="Multi select — hold Shift"
          title="Hold Shift and click tokens, then drag to move the group"
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
          label="Toggle grid"
          aria-pressed={gridOn}
          onClick={handleToggleGrid}
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
                  aria-pressed={allSelectedLocked}
                  onClick={handleToggleLock}
                >
                  <ToolIcon name={allSelectedLocked ? 'unlock' : 'lock'} />
                </IconButton>
                <IconButton
                  label="Delete selected tokens"
                  onClick={handleDeleteSelected}
                >
                  <ToolIcon name="trash" />
                </IconButton>
              </>
            )}
          </>
        )}
      </nav>
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
