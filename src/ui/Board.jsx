import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  connect,
  createToken,
  deleteToken,
  updateToken,
} from '../net/socket.js';
import { sessionStore, useSession } from '../store/sessionStore.js';
import { canvasStore, useCanvas } from '../canvas/canvasStore.js';
import { MAX_SCALE } from '../canvas/viewport.js';
import DiceOverlay from '../dice/DiceOverlay.jsx';
import { party } from './fixtures.js';
import ToolIcon from './ToolIcon.jsx';
import AddTokenDialog from './AddTokenDialog.jsx';
import { useUploadedCategoryAssets } from './AssetsPanel.jsx';
import { IconButton } from './Primitives.jsx';

const MapStage = lazy(() => import('../canvas/MapStage.jsx'));

export default function Board({
  displayName,
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

  const connection = useSession((s) => s.connection);
  const connectionError = useSession((s) => s.connectionError);
  const map = useSession((s) => s.map);
  const tokens = useSession((s) => s.tokens);
  const participants = useSession((s) => s.participants);
  const latency = useSession((s) => s.lastMoveLatencyMs);
  const activeRoll = useSession((s) => s.activeRoll);

  const liveScale = useCanvas((s) => s.viewport.scale);
  const gridVisible = useCanvas((s) => s.gridVisible);
  const snapEnabled = useCanvas((s) => s.snap);
  const selectedIds = useCanvas((s) => s.selectedIds);

  const trayItems = useUploadedCategoryAssets(assetTrayCategory || 'Scenes');

  const isDM = role === 'DM';
  const selectedTokens = selectedIds
    .map((id) => tokens[id])
    .filter(Boolean);
  const allSelectedLocked =
    selectedTokens.length > 0 && selectedTokens.every((token) => token.locked);

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
        role: role === 'DM' ? 'dm' : 'player',
        url: hostUrl || undefined,
      })
        .then(() => setError(''))
        .catch((e) => setError(e.message));
  }, [displayName, role, hostUrl]);

  const activeMapStates = {
    players: playersOpen,
    dice: diceOpen,
    soundboard: soundboardOpen,
  };

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
      <div className="board-caption">
        <span className="scene-indicator" />
        <strong>{map?.name ?? scene ?? 'Waiting for map'}</strong>
        <span>{connection}</span>
      </div>
      <div className="board-host" ref={host}>
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
      <nav className="utility-toolbar" aria-label="VTT utilities">
        <IconButton
          label="Select tokens"
          aria-pressed={true}
          title="Click to select, Shift-click for multi-select, drag to move"
          onClick={() => canvasStore.getState().clearSelection()}
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
        <IconButton label="Draw — unavailable" disabled>
          <ToolIcon name="draw" />
        </IconButton>
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
                    className={`asset-tray-item ${
                      assetTrayCategory === 'Scenes' && scene === asset
                        ? 'selected'
                        : ''
                    }`}
                    onClick={() => {
                      if (assetTrayCategory === 'Scenes') {
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
