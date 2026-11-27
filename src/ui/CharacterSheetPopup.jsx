import { useState } from 'react';
import {
  createCharacterSheet,
  deleteCharacterSheet,
  resolveAssetUrl,
} from '../net/socket.js';
import { useSession } from '../store/sessionStore.js';
import ToolIcon from './ToolIcon.jsx';
import { IconButton } from './Primitives.jsx';

export function resolveCharacterPortrait(character, tokensMap) {
  const tokenId = character?.sheetData?.tokenId;
  const linked = tokenId ? tokensMap?.[tokenId] : null;
  const rawUrl = linked?.imageUrl || character?.sheetData?.imageUrl || null;
  return rawUrl ? resolveAssetUrl(rawUrl) : null;
}

function TokenAvatar({ name, imageUrl, color }) {
  const resolved = imageUrl ? resolveAssetUrl(imageUrl) : null;
  const initials = String(name || '?').trim().slice(0, 2).toUpperCase() || '?';
  return (
    <span
      className="sheet-avatar"
      style={!resolved ? { background: color || '#2a4654' } : undefined}
    >
      {resolved ? <img src={resolved} alt={name || 'Token'} /> : initials}
    </span>
  );
}

/**
 * Character Sheets extension popup (DM & Player views).
 * - Player: limited to 1 character sheet bound to an owned Character Token.
 * - DM: Add Character Sheet For eligible Character Tokens + view all player & DM sheets.
 */
export default function CharacterSheetPopup({
  role,
  onOpenSheet,
  onClose,
}) {
  const isDM = role === 'DM' || role === 'dm';
  const charactersMap = useSession((s) => s.characters);
  const tokensMap = useSession((s) => s.tokens);
  const participants = useSession((s) => s.participants);
  const currentUser = useSession((s) => s.currentUser);

  const [busyTokenId, setBusyTokenId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');

  const myId = currentUser?.id || null;
  const allCharacters = Object.values(charactersMap || {});
  const allTokens = Object.values(tokensMap || {});

  const characterTokens = allTokens.filter(
    (t) => !t.isMap && (t.category || 'characters') === 'characters',
  );
  const linkedTokenIds = new Set(
    allCharacters.map((c) => c.sheetData?.tokenId).filter(Boolean),
  );

  function participantLabel(ownerId) {
    if (!ownerId) return 'Unassigned';
    const match = participants.find((p) => p.id === ownerId);
    if (match) return match.displayName;
    if (ownerId === myId) return currentUser?.displayName || (isDM ? 'DM' : 'You');
    return 'Player';
  }

  async function handleAddForToken(token) {
    if (!token || busyTokenId) return;
    setErrorMsg('');
    setBusyTokenId(token.id);
    const res = await createCharacterSheet({ tokenId: token.id });
    setBusyTokenId(null);
    if (!res?.ok || !res?.character) {
      const msg =
        res?.reason === 'limit_reached'
          ? 'This player already has a character sheet (max 1 per player).'
          : res?.reason === 'already_exists'
            ? 'This token already has a character sheet.'
            : res?.reason === 'forbidden'
              ? 'You can only create a sheet for a Character Token assigned to you.'
              : 'Could not add character sheet.';
      setErrorMsg(msg);
      return;
    }
    onOpenSheet?.(res.character.id);
  }

  async function handleConfirmDelete(charId) {
    if (!charId) return;
    setErrorMsg('');
    const res = await deleteCharacterSheet(charId);
    setConfirmDeleteId(null);
    if (!res?.ok) {
      setErrorMsg('Could not remove character sheet.');
    }
  }

  if (!isDM) {
    const myCharacter =
      allCharacters.find((c) => myId && c.ownerId === myId) || null;
    const myOwnedTokens = characterTokens.filter(
      (t) => myId && t.ownerId === myId,
    );

    return (
      <aside
        className="floating-popup character-sheets-window"
        aria-label="Character Sheet"
      >
        <header>
          <h2>Character Sheet</h2>
          <IconButton label="Close character sheet" onClick={onClose}>
            ×
          </IconButton>
        </header>

        <div className="character-sheets-body">
          {errorMsg && (
            <p className="sheet-inline-error" role="alert">
              {errorMsg}
            </p>
          )}

          {myCharacter ? (
            <div className="character-sheet-section">
              <div className="character-sheet-card is-active-owner">
                <TokenAvatar
                  name={myCharacter.name}
                  imageUrl={resolveCharacterPortrait(myCharacter, tokensMap)}
                  color={myCharacter.sheetData?.color}
                />
                <div className="character-sheet-meta">
                  <strong>{myCharacter.name}</strong>
                  <small>Your Character Sheet</small>
                </div>
                <button
                  type="button"
                  className="primary sheet-open-btn"
                  onClick={() => onOpenSheet?.(myCharacter.id)}
                >
                  Open
                </button>
              </div>

              {confirmDeleteId === myCharacter.id ? (
                <div className="sheet-confirm-box" role="alertdialog">
                  <span>Remove your character sheet?</span>
                  <div>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void handleConfirmDelete(myCharacter.id)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="sheet-unlink-btn"
                  onClick={() => setConfirmDeleteId(myCharacter.id)}
                >
                  Unlink / Change Token
                </button>
              )}
            </div>
          ) : (
            <div className="character-sheet-section">
              <h3 className="character-sheet-subheading">
                Add Character Sheet For
              </h3>
              {myOwnedTokens.length === 0 ? (
                <p className="sheet-empty-hint">
                  No Character Tokens are assigned to you yet. Ask your DM to
                  assign ownership of a Character Token on the canvas.
                </p>
              ) : (
                <ul className="character-sheet-list">
                  {myOwnedTokens.map((token) => (
                    <li key={token.id} className="character-sheet-card">
                      <TokenAvatar
                        name={token.label}
                        imageUrl={token.imageUrl}
                        color={token.color}
                      />
                      <div className="character-sheet-meta">
                        <strong>{token.label}</strong>
                        <small>Owned Character Token</small>
                      </div>
                      <button
                        type="button"
                        className="primary sheet-add-btn"
                        disabled={busyTokenId === token.id}
                        onClick={() => void handleAddForToken(token)}
                      >
                        {busyTokenId === token.id ? 'Adding…' : '+ Add'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </aside>
    );
  }

  // DM Panel: "Add Character Sheet For" + "All Character Sheets" (including Players' sheets)
  const eligibleTokens = characterTokens.filter(
    (t) => !linkedTokenIds.has(t.id),
  );
  const playerHasSheetIds = new Set(
    allCharacters
      .filter((c) => c.ownerId && c.ownerId !== myId)
      .map((c) => c.ownerId),
  );
  const sortedSheets = [...allCharacters].sort((a, b) => {
    const aIsPlayer = a.sheetData?.ownerRole === 'player' ? 0 : 1;
    const bIsPlayer = b.sheetData?.ownerRole === 'player' ? 0 : 1;
    if (aIsPlayer !== bIsPlayer) return aIsPlayer - bIsPlayer;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  return (
    <aside
      className="floating-popup character-sheets-window"
      aria-label="Character Sheets"
    >
      <header>
        <h2>Character Sheets</h2>
        <IconButton label="Close character sheets" onClick={onClose}>
          ×
        </IconButton>
      </header>

      <div className="character-sheets-body">
        {errorMsg && (
          <p className="sheet-inline-error" role="alert">
            {errorMsg}
          </p>
        )}

        <div className="character-sheet-section">
          <h3 className="character-sheet-subheading">Add Character Sheet For</h3>
          {eligibleTokens.length === 0 ? (
            <p className="sheet-empty-hint">
              Place a Character Token on the canvas to create a sheet for it.
            </p>
          ) : (
            <ul className="character-sheet-list">
              {eligibleTokens.map((token) => {
                const ownerTaken =
                  token.ownerId &&
                  token.ownerRole === 'player' &&
                  playerHasSheetIds.has(token.ownerId);
                return (
                  <li key={token.id} className="character-sheet-card">
                    <TokenAvatar
                      name={token.label}
                      imageUrl={token.imageUrl}
                      color={token.color}
                    />
                    <div className="character-sheet-meta">
                      <strong>{token.label}</strong>
                      <small>Owner: {participantLabel(token.ownerId)}</small>
                    </div>
                    <button
                      type="button"
                      className="primary sheet-add-btn"
                      disabled={busyTokenId === token.id || Boolean(ownerTaken)}
                      title={
                        ownerTaken
                          ? 'Assigned player already has their 1 allowed sheet'
                          : `Create character sheet for ${token.label}`
                      }
                      onClick={() => void handleAddForToken(token)}
                    >
                      {busyTokenId === token.id ? '…' : '+ Add'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="character-sheet-section">
          <h3 className="character-sheet-subheading">
            Table Character Sheets ({sortedSheets.length})
          </h3>
          {sortedSheets.length === 0 ? (
            <p className="sheet-empty-hint">
              No character sheets created yet.
            </p>
          ) : (
            <ul className="character-sheet-list">
              {sortedSheets.map((char) => {
                const ownerLabel =
                  char.sheetData?.ownerName || participantLabel(char.ownerId);
                return (
                  <li key={char.id} className="character-sheet-card">
                    <TokenAvatar
                      name={char.name}
                      imageUrl={resolveCharacterPortrait(char, tokensMap)}
                      color={char.sheetData?.color}
                    />
                    <div
                      className="character-sheet-meta is-clickable"
                      onClick={() => onOpenSheet?.(char.id)}
                    >
                      <strong>{char.name}</strong>
                      <small>
                        {char.sheetData?.ownerRole === 'player'
                          ? `Player · ${ownerLabel}`
                          : `DM · ${ownerLabel}`}
                      </small>
                    </div>
                    <div className="character-sheet-actions">
                      <button
                        type="button"
                        className="sheet-open-btn"
                        onClick={() => onOpenSheet?.(char.id)}
                      >
                        Open
                      </button>
                      {confirmDeleteId === char.id ? (
                        <button
                          type="button"
                          className="danger sheet-del-confirm"
                          title="Confirm remove sheet"
                          onClick={() => void handleConfirmDelete(char.id)}
                        >
                          Remove?
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="sheet-del-btn"
                          aria-label={`Delete sheet ${char.name}`}
                          title="Delete character sheet"
                          onClick={() => setConfirmDeleteId(char.id)}
                        >
                          <ToolIcon name="trash" />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}
