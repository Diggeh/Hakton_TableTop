import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  connect,
  createToken,
  deleteToken,
  updateToken,
} from '../net/socket.js';
import { useSession } from '../store/sessionStore.js';
import { canvasStore, useCanvas } from '../canvas/canvasStore.js';
import { MAX_SCALE } from '../canvas/viewport.js';
import { party } from './fixtures.js';
import ToolIcon from './ToolIcon.jsx';
import AddTokenDialog from './AddTokenDialog.jsx';
import { IconButton } from './Primitives.jsx';

const MapStage = lazy(() => import('../canvas/MapStage.jsx'));

// Keeps the existing live canvas and network store intact. Preview never seeds live state.
export default function Board({
  preview,
  displayName,
  scene,
  role,
  onAction,
  onAssets,
  assetsOpen,
}) {
  const host = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(100);
  const [grid, setGrid] = useState(true);
  const [error, setError] = useState('');
  const [addTokenOpen, setAddTokenOpen] = useState(false);

  const connection = useSession((s) => s.connection);
  const connectionError = useSession((s) => s.connectionError);
  const map = useSession((s) => s.map);
  const tokens = useSession((s) => s.tokens);
  const participants = useSession((s) => s.participants);
  const latency = useSession((s) => s.lastMoveLatencyMs);

  const liveScale = useCanvas((s) => s.viewport.scale);
  const gridVisible = useCanvas((s) => s.gridVisible);
  const snapEnabled = useCanvas((s) => s.snap);
  const selectedIds = useCanvas((s) => s.selectedIds);

  const isDM = role === 'DM';
  const selectedTokens = selectedIds
    .map((id) => tokens[id])
    .filter(Boolean);
  const allSelectedLocked =
    selectedTokens.length > 0 && selectedTokens.every((token) => token.locked);

  const zoomPercent = preview ? zoom : Math.round(liveScale * 100);
  const gridOn = preview ? grid : gridVisible;
  const canZoomIn = preview ? zoom < 150 : liveScale < MAX_SCALE - 0.0001;

  function handleZoomIn() {
    if (preview) setZoom((value) => Math.min(value + 10, 150));
    else canvasStore.getState().zoomBy(1.2);
  }

  function handleZoomOut() {
    if (preview) setZoom((value) => Math.max(value - 10, 50));
    else canvasStore.getState().zoomBy(1 / 1.2);
  }

  function handleResetZoom() {
    if (preview) setZoom(100);
    else canvasStore.getState().fit();
  }

  function handleToggleGrid() {
    if (preview) setGrid((value) => !value);
    else canvasStore.getState().toggleGrid();
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
    if (!preview && window.hakton)
      connect({ displayName, role: role === 'DM' ? 'dm' : 'player' })
        .then(() => setError(''))
        .catch((e) => setError(e.message));
  }, [preview, displayName, role]);
  return (
    <section className="board" aria-label="Tabletop canvas">
      <nav className="extension-toolbar" aria-label="VTT extensions">
        {[
          'home',
          'players',
          'dice',
          'sheet',
          'initiative',
          ...(role === 'DM' ? ['soundboard', 'notes'] : []),
          'compendium',
        ].map((action) => (
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
            onClick={() => onAction(action)}
          >
            <ToolIcon name={action} />
          </IconButton>
        ))}
      </nav>
      <div className="board-caption">
        <span className="scene-indicator" />
        <strong>{preview ? scene : (map?.name ?? 'Waiting for map')}</strong>
        {!preview && <span>{connection}</span>}
      </div>
      <div className="board-host" ref={host}>
        {preview ? (
          <div
            className={`preview-map ${grid ? 'with-grid' : ''}`}
            style={{
              transform: `translate(-50%, -50%) scale(${(zoom / 100) * Math.min(size.width / 880, size.height / 640, 1)})`,
            }}
          >
            <div className="map-room room-a">
              <span>VESTIBULE</span>
              <div className="map-stairs" aria-hidden="true">
                {[0, 1, 2, 3, 4].map((step) => (
                  <i key={step} />
                ))}
              </div>
            </div>
            <div className="map-corridor" />
            <div className="map-room room-b">
              <span>SANCTUARY</span>
              <div className="map-altar" />
              <div className="map-pillars" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
              </div>
            </div>
            <div className="map-room room-c">
              <span>ARCHIVE</span>
              <div className="map-shelves" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
            </div>
            {party.map((p, i) => (
              <div
                key={p.name}
                className={`map-token token-${i}`}
                style={{ '--token-color': p.color }}
                title={p.name}
              >
                {p.initials}
              </div>
            ))}
            <div className="map-token enemy-token" title="Sentinel">
              S
            </div>
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="board-notice" role="status">
                Loading live canvas…
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
        )}
        {!preview &&
          (error || connectionError || connection !== 'connected') && (
            <div className="board-notice" role="status">
              {error ||
                connectionError ||
                (window.hakton
                  ? `Session ${connection}. Waiting for the local host.`
                  : 'The live board requires the Electron desktop app.')}
            </div>
          )}
      </div>
      <nav className="utility-toolbar" aria-label="VTT utilities">
        <IconButton
          label="Select tokens"
          aria-pressed={true}
          title="Click to select, Shift-click for multi-select, drag to move"
          disabled={preview}
          onClick={() => canvasStore.getState().clearSelection()}
        >
          <ToolIcon name="select" />
        </IconButton>
        <IconButton
          label="Multi select — hold Shift"
          title="Hold Shift and click tokens, then drag to move the group"
          disabled={preview}
        >
          <ToolIcon name="multi" />
        </IconButton>
        <IconButton label="Text chat" onClick={() => onAction('chat')}>
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
          disabled={preview}
          aria-pressed={snapEnabled}
          onClick={() => canvasStore.getState().toggleSnap()}
        >
          <ToolIcon name="snap" />
        </IconButton>
        <IconButton label="Fit map" disabled={preview} onClick={handleResetZoom}>
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
          title={preview ? 'Reset zoom' : 'Fit map to window'}
          onClick={handleResetZoom}
        >
          {zoomPercent}%
        </button>
        <IconButton label="Zoom out" onClick={handleZoomOut}>
          −
        </IconButton>
        {!preview && isDM && (
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
        <nav className="asset-launcher" aria-label="VTT assets">
          {['Scenes', 'Characters', 'Maps', 'Props', 'Attachments'].map(
            (category) => (
              <IconButton
                key={category}
                label={`Open ${category.toLowerCase()}`}
                aria-expanded={assetsOpen}
                onClick={() => onAssets(category)}
              >
                <ToolIcon name={category} />
              </IconButton>
            ),
          )}
          <IconButton
            label="Asset menu"
            aria-expanded={assetsOpen}
            onClick={() => onAssets('Scenes')}
          >
            <ToolIcon name="assetMenu" />
          </IconButton>
        </nav>
      )}
      <span className="board-scale">
        {preview
          ? '5 ft / square'
          : latency == null
            ? '5 ft / square · live canvas'
            : `5 ft / square · sync ${Math.round(latency)} ms`}
      </span>
      {!preview && isDM && addTokenOpen && (
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
