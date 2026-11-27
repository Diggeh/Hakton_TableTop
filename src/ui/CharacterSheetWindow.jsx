import { resolveAssetUrl } from '../net/socket.js';
import { useSession } from '../store/sessionStore.js';
import { resolveCharacterPortrait } from './CharacterSheetPopup.jsx';
import ToolIcon from './ToolIcon.jsx';

export function CharacterSheetWindow({
  windowState,
  onFocus,
  onChangeBounds,
  onMinimize,
  onClose,
}) {
  const character = useSession(
    (s) => s.characters?.[windowState.characterId] || null,
  );
  const tokensMap = useSession((s) => s.tokens);

  if (!character || windowState.minimized) return null;

  const portraitUrl = resolveCharacterPortrait(character, tokensMap);
  const initials =
    String(character.name || '?').trim().slice(0, 2).toUpperCase() || '?';
  const ownerBadge =
    character.sheetData?.ownerRole === 'player'
      ? `Player · ${character.sheetData?.ownerName || 'Player'}`
      : `DM · ${character.sheetData?.ownerName || 'DM'}`;

  function startDragWindow(e) {
    if (e.button !== 0 || e.target.closest('button, input')) return;
    e.preventDefault();
    onFocus?.(character.id);
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = windowState.x;
    const originY = windowState.y;

    const onMove = (ev) => {
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
      const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
      const nextX = Math.max(8, Math.min(vw - 160, originX + (ev.clientX - startX)));
      const nextY = Math.max(48, Math.min(vh - 80, originY + (ev.clientY - startY)));
      onChangeBounds?.(character.id, { x: nextX, y: nextY });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function startResizeWindow(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onFocus?.(character.id);
    const startX = e.clientX;
    const startY = e.clientY;
    const originW = windowState.width;
    const originH = windowState.height;

    const onMove = (ev) => {
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
      const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
      const maxW = Math.max(380, vw - windowState.x - 12);
      const maxH = Math.max(260, vh - windowState.y - 12);
      onChangeBounds?.(character.id, {
        width: Math.max(380, Math.min(maxW, originW + (ev.clientX - startX))),
        height: Math.max(260, Math.min(maxH, originH + (ev.clientY - startY))),
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  return (
    <section
      className="character-sheet-floating-window"
      role="dialog"
      aria-label={`${character.name} Character Sheet`}
      style={{
        left: `${windowState.x}px`,
        top: `${windowState.y}px`,
        width: `${windowState.width}px`,
        height: `${windowState.height}px`,
        zIndex: windowState.zIndex,
      }}
      onMouseDown={() => onFocus?.(character.id)}
    >
      <header
        className="character-sheet-window-header"
        onPointerDown={startDragWindow}
      >
        <div className="character-sheet-window-title">
          <ToolIcon name="sheet" />
          <strong>{character.name}</strong>
          <span className="character-sheet-owner-pill">{ownerBadge}</span>
        </div>
        <div className="note-window-controls">
          <button
            type="button"
            className="note-window-btn"
            aria-label={`Minimize ${character.name} sheet`}
            title="Minimize"
            onClick={() => onMinimize?.(character.id)}
          >
            <ToolIcon name="minimize" />
          </button>
          <button
            type="button"
            className="note-window-btn close"
            aria-label={`Close ${character.name} sheet`}
            title="Close"
            onClick={() => onClose?.(character.id)}
          >
            <ToolIcon name="close" />
          </button>
        </div>
      </header>

      <div className="character-sheet-window-body">
        <div className="character-sheet-banner">
          <span
            className="sheet-banner-avatar"
            style={
              !portraitUrl
                ? { background: character.sheetData?.color || '#2a4654' }
                : undefined
            }
          >
            {portraitUrl ? (
              <img src={resolveAssetUrl(portraitUrl)} alt={character.name} />
            ) : (
              initials
            )}
          </span>
          <div className="character-sheet-banner-info">
            <h3>{character.name}</h3>
            <p>{ownerBadge}</p>
          </div>
        </div>

        <div className="character-sheet-placeholder">
          <p>
            Character Sheet workspace for <strong>{character.name}</strong>.
          </p>
          <small>
            Stats, abilities, equipment, and spells will populate here once
            sheet templates are added.
          </small>
        </div>
      </div>

      <div
        className="note-resize-handle se"
        aria-hidden="true"
        onPointerDown={startResizeWindow}
      />
    </section>
  );
}

export function MinimizedCharacterSheetsBar({
  windows,
  onRestore,
  onClose,
}) {
  const charactersMap = useSession((s) => s.characters);
  const minimized = (windows || []).filter(
    (w) => w.minimized && charactersMap?.[w.characterId],
  );
  if (minimized.length === 0) return null;

  return (
    <div className="minimized-sheets-bar" aria-label="Minimized character sheets">
      {minimized.map((win) => {
        const ch = charactersMap[win.characterId];
        return (
          <div key={win.characterId} className="minimized-note-pill">
            <button
              type="button"
              className="minimized-note-restore"
              onClick={() => onRestore?.(win.characterId)}
              title={`Restore ${ch.name}`}
            >
              <ToolIcon name="sheet" />
              <span>{ch.name}</span>
            </button>
            <button
              type="button"
              className="minimized-note-close"
              aria-label={`Close ${ch.name} sheet`}
              onClick={() => onClose?.(win.characterId)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
