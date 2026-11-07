import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { connect } from '../net/socket.js';
import { useSession } from '../store/sessionStore.js';
import { party } from './fixtures.js';
import ToolIcon from './ToolIcon.jsx';
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
  const connection = useSession((s) => s.connection);
  const connectionError = useSession((s) => s.connectionError);
  const map = useSession((s) => s.map);
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
      connect({ displayName, role: role === 'DM' ? 'dm' : 'player' }).catch(
        (e) => setError(e.message),
      );
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
            <MapStage width={size.width} height={size.height} />
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
          title="Drag tokens on the live board"
        >
          <ToolIcon name="select" />
        </IconButton>
        <IconButton label="Multi select — unavailable" disabled>
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
          disabled={!preview}
          aria-pressed={grid}
          onClick={() => setGrid(!grid)}
        >
          <ToolIcon name="grid" />
        </IconButton>
        <IconButton
          label="Zoom in"
          disabled={!preview || zoom >= 150}
          onClick={() => setZoom((z) => z + 10)}
        >
          +
        </IconButton>
        <button
          className="zoom-value"
          title="Reset zoom"
          disabled={!preview}
          onClick={() => setZoom(100)}
        >
          {zoom}%
        </button>
        <IconButton
          label="Zoom out"
          disabled={!preview || zoom <= 50}
          onClick={() => setZoom((z) => z - 10)}
        >
          −
        </IconButton>
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
        {preview ? '5 ft / square' : 'Live canvas'}
      </span>
    </section>
  );
}
