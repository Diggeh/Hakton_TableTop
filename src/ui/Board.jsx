import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  connect,
  createToken,
  deleteToken,
  updateToken,
} from '../net/socket.js';
import { sessionStore, useSession } from '../store/sessionStore.js';
import { canvasStore, useCanvas } from '../canvas/canvasStore.js';
import {
  MAX_SCALE,
  clampTokenPosition,
  mapToScreen,
  screenToMap,
  snapPoint,
} from '../canvas/viewport.js';
import DiceOverlay from '../dice/DiceOverlay.jsx';
import { party } from './fixtures.js';
import ToolIcon from './ToolIcon.jsx';
import AddTokenDialog from './AddTokenDialog.jsx';
import { useUploadedCategoryAssets } from './AssetsPanel.jsx';
import { IconButton } from './Primitives.jsx';

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
}) {
  const host = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [error, setError] = useState('');
  const [addTokenOpen, setAddTokenOpen] = useState(false);
  const [fogMenuOpen, setFogMenuOpen] = useState(false);
  const [renamingTokenId, setRenamingTokenId] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');

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
  const fogTool = useCanvas((s) => s.fogTool);

  const trayItems = useUploadedCategoryAssets(assetTrayCategory || 'Scenes');

  const isDM = role === 'DM';
  const selectedTokens = selectedIds
    .map((id) => tokens[id])
    .filter(Boolean);
  const singleSelectedToken =
    selectedTokens.length === 1 ? selectedTokens[0] : null;
  const allSelectedLocked =
    selectedTokens.length > 0 && selectedTokens.every((token) => token.locked);

  // Close inline rename when token selection changes
  useEffect(() => {
    if (!singleSelectedToken || singleSelectedToken.id !== renamingTokenId) {
      setRenamingTokenId(null);
    }
  }, [singleSelectedToken, renamingTokenId]);

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

  function handleCanvasDragOver(e) {
    if (!isDM) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  async function handleCanvasDrop(e) {
    if (!isDM) return;
    e.preventDefault();
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
    if (category === 'Scenes' || category === 'Maps') {
      onSelectScene?.(payload.name);
      const currentMap = sessionStore.getState().map;
      if (currentMap) {
        sessionStore.getState().setMap({
          ...currentMap,
          name: payload.name,
        });
      }
      return;
    }

    // Spawn a new token instance at the dropped canvas coordinates (unlimited duplicates allowed)
    const rect = host.current?.getBoundingClientRect();
    const screenPt = rect
      ? { x: e.clientX - rect.left, y: e.clientY - rect.top }
      : { x: size.width / 2, y: size.height / 2 };
    const mapPt = screenToMap(canvasStore.getState().viewport, screenPt);
    const grid = map?.gridSize || 70;
    const mapWidth = map?.width || 1400;
    const mapHeight = map?.height || 980;
    const snapped = snapEnabled ? snapPoint(mapPt, grid) : mapPt;
    const finalPos = clampTokenPosition(snapped, mapWidth, mapHeight, grid);
    const color =
      TOKEN_PALETTE[Object.keys(tokens).length % TOKEN_PALETTE.length];

    await createToken({
      label: payload.name,
      x: finalPos.x,
      y: finalPos.y,
      color,
    });
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

  // Compute screen coordinates for the single-selected token's floating popup bar
  const grid = map?.gridSize || 70;
  const tokenScreenPos = singleSelectedToken
    ? mapToScreen(viewport, {
        x: singleSelectedToken.x,
        y: singleSelectedToken.y,
      })
    : null;
  const tokenRadiusPx = Math.max(8, grid / 2 - 4) * viewport.scale;

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
      <div
        ref={host}
        className="board-viewport"
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

        {/* Single-Clicked Token Property Popup Bar (Rename for DM & Players) */}
        {singleSelectedToken && tokenScreenPos && (
          <div
            className="token-popup-bar"
            style={{
              left: `${Math.max(80, Math.min(size.width - 80, tokenScreenPos.x))}px`,
              top: `${Math.min(size.height - 54, tokenScreenPos.y + tokenRadiusPx + 10)}px`,
            }}
            role="toolbar"
            aria-label={`Token properties for ${singleSelectedToken.label}`}
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
            )}
          </div>
        )}

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

      {/* DM Fog of War & Walls Floating Sub-Toolbar */}
      {isDM && fogMenuOpen && (
        <aside className="fog-toolbar-popup" aria-label="Fog of War tools">
          <header>
            <strong>Fog of War & Vision</strong>
            <button
              type="button"
              className="icon-button"
              aria-label="Close Fog of War tools"
              onClick={() => {
                setFogMenuOpen(false);
                canvasStore.getState().setFogTool(null);
              }}
            >
              ×
            </button>
          </header>
          <div className="fog-tool-group">
            <span>Fog Shapes</span>
            <div className="fog-tool-buttons">
              {[
                { id: 'rect', label: 'Square / Rect' },
                { id: 'circle', label: 'Circle' },
                { id: 'polygon', label: 'Polygon' },
                { id: 'line', label: 'Line Brush' },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={fogTool === t.id}
                  onClick={() => canvasStore.getState().setFogTool(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="fog-tool-group">
            <span>Barriers (Line of Sight)</span>
            <div className="fog-tool-buttons">
              <button
                type="button"
                aria-pressed={fogTool === 'wall'}
                onClick={() => canvasStore.getState().setFogTool('wall')}
              >
                Wall
              </button>
              <button
                type="button"
                aria-pressed={fogTool === 'door'}
                onClick={() => canvasStore.getState().setFogTool('door')}
              >
                Door
              </button>
            </div>
          </div>
          <div className="fog-tool-group">
            <span>Manage</span>
            <div className="fog-tool-buttons">
              <button
                type="button"
                aria-pressed={fogTool === 'erase'}
                onClick={() => canvasStore.getState().setFogTool('erase')}
              >
                Delete Fog / Wall
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => canvasStore.getState().clearFog()}
              >
                Clear All
              </button>
            </div>
          </div>
        </aside>
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
                {trayItems.map((asset, i) => (
                  <button
                    key={asset}
                    type="button"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(
                        'application/x-hakton-asset',
                        JSON.stringify({
                          name: asset,
                          category: assetTrayCategory,
                        }),
                      );
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    className={`asset-tray-item ${
                      assetTrayCategory === 'Scenes' && scene === asset
                        ? 'selected'
                        : ''
                    }`}
                    title={`Drag "${asset}" onto the canvas or click to select`}
                    onClick={() => {
                      if (
                        assetTrayCategory === 'Scenes' ||
                        assetTrayCategory === 'Maps'
                      ) {
                        onSelectScene?.(asset);
                      } else {
                        onInspectAsset?.(asset, assetTrayCategory);
                      }
                    }}
                  >
                    <span
                      className={`asset-thumbnail type-${assetTrayCategory.toLowerCase()} thumbnail-${i % 3}`}
                    >
                      {assetTrayCategory === 'Characters' ? (
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
                ))}
                {trayItems.length === 0 && (
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
