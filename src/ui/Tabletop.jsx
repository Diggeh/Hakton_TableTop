import { useId, useRef, useState } from 'react';
import { DICE_VISIBILITY } from '../../shared/dice/constants.js';
import { ROLES } from '../../shared/events.js';
import { rollFormula } from '../../shared/dice/roller.js';
import { disconnect, emitDiceRoll } from '../net/socket.js';
import { sessionStore, useSession } from '../store/sessionStore.js';
import { useSoundboard } from '../audio/useSoundboard.js';
import { autosave } from '../autosave/index.js';
import {
  characterDocument,
  dmNotesRecordId,
  dmRecordDocument,
} from '../autosave/documents.js';
import Board from './Board.jsx';
import { SessionStatus, LiveRoster } from './SessionStatus.jsx';
import AssetsPanel from './AssetsPanel.jsx';
import ChatPanel from './ChatPanel.jsx';
import DiceTray, { buildTrayFormula } from './DiceTray.jsx';
import { party } from './fixtures.js';
import CharacterSheet from './CharacterSheet.jsx';
import Compendium from './Compendium.jsx';
import AutosaveStatus from './AutosaveStatus.jsx';
import Soundboard from './Soundboard.jsx';
import { IconButton, Modal } from './Primitives.jsx';

const DEFAULT_NOTES =
  'The keeper’s journal mentions a sealed chamber beneath the altar.\n\nThe sentinel wakes when the tide returns.';

/** Fixture name -> seeded SQLite character id. */
const DEMO_CHARACTER_IDS = { mira: 'char-mira', thorne: 'char-thorne', ilyra: 'char-ilyra' };

/** Finds the stored character row backing a fixture person. */
function characterForPerson(characters, person) {
  if (!person?.name) return null;
  const byId = characters[DEMO_CHARACTER_IDS[person.name.toLowerCase()]];
  if (byId) return byId;
  return (
    Object.values(characters).find(
      (candidate) => candidate.name?.toLowerCase() === person.name.toLowerCase(),
    ) ?? null
  );
}

export default function Tabletop({
  campaign,
  role,
  name,
  userId,
  hostUrl: propHostUrl,
  onLeave,
}) {
  const [playersOpen, setPlayersOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [diceOpen, setDiceOpen] = useState(false);
  const [soundboardOpen, setSoundboardOpen] = useState(false);
  const [assetTrayCategory, setAssetTrayCategory] = useState(null);
  const [assetManagerOpen, setAssetManagerOpen] = useState(false);
  const [assetManagerTab, setAssetManagerTab] = useState('Scenes');

  const hostUrl = role === 'Player' ? (propHostUrl ?? campaign?.hostUrl) : undefined;
  const [scene, setScene] = useState(campaign?.scene ?? 'Drowned Sanctuary');
  const [modal, setModal] = useState(null);
  const soundboardId = useId();
  const soundboardContentId = useId();
  const soundboardTrigger = useRef(null);

  const [inspected, setInspected] = useState(null);
  const [die, setDie] = useState(20);
  const [rollMode, setRollMode] = useState('Normal');
  const [count, setCount] = useState(1);
  const [modifier, setModifier] = useState(0);
  const [visibility, setVisibility] = useState('Public');

  const characters = useSession((state) => state.characters);
  const dmRecords = useSession((state) => state.dmRecords);
  const currentUser = useSession((state) => state.currentUser);
  const soundboard = useSoundboard(false);

  const notesRecordId = dmNotesRecordId(campaign?.id ?? 'default');
  const notesRecord = dmRecords[notesRecordId];
  const notes = notesRecord?.data?.text ?? DEFAULT_NOTES;

  function handleNotesChange(value) {
    const store = sessionStore.getState();
    if (store.dmRecords[notesRecordId]) {
      store.patchDmRecord(notesRecordId, { data: { text: value } });
    } else {
      // First keystroke creates the row; baseRevision null means "insert".
      store.upsertDmRecord({
        id: notesRecordId,
        category: 'session-notes',
        title: 'Session notes',
        data: { text: value },
        revision: null,
      });
    }
    const updated = sessionStore.getState().dmRecords[notesRecordId];
    if (updated) autosave.markDirty(dmRecordDocument(updated));
  }

  function canEditCharacter(character) {
    if (!character) return false;
    if (role === 'DM') return true;
    return Boolean(currentUser?.id && character.ownerId === currentUser.id);
  }

  function handleHpChange(person, value) {
    const store = sessionStore.getState();
    const character = characterForPerson(store.characters, person);
    if (!character) return;

    const max = Number(character.sheetData?.hp?.max ?? person.max) || 0;
    const next = Math.min(max, Math.max(0, Number(value) || 0));
    store.patchCharacter(character.id, {
      sheetData: { hp: { ...(character.sheetData?.hp ?? {}), current: next } },
    });

    const updated = sessionStore.getState().characters[character.id];
    if (updated) autosave.markDirty(characterDocument(updated));
  }

  function inspect(asset, category = 'Characters') {
    setInspected({ name: asset, category });
    setModal('inspect');
  }

  function handleRollFormula(formulaText, trayVisibility = visibility) {
    const result = rollFormula(formulaText);
    if (!result.ok) return result;
    const effectiveVisibility =
      result.roll.visibility === DICE_VISIBILITY.DM ||
      trayVisibility === 'DM only'
        ? DICE_VISIBILITY.DM
        : DICE_VISIBILITY.PUBLIC;
    const roll = { ...result.roll, visibility: effectiveVisibility };
    emitDiceRoll(roll, { senderName: name });
    return { ok: true, roll };
  }

  const person = party.find((p) => p.name === inspected?.name) || party[0];

  function closeSoundboard() {
    setSoundboardOpen(false);
    soundboardTrigger.current?.focus({ preventScroll: true });
  }

  return (
    <div className="tabletop" data-role={role}>
      <div className="tabletop-stage">
        <Board
          displayName={name}
          userId={userId}
          hostUrl={hostUrl}
          scene={scene}
          role={role}
          playersOpen={playersOpen}
          diceOpen={diceOpen}
          chatOpen={chatOpen}
          soundboardOpen={soundboardOpen}
          soundboardId={soundboardId}
          assetTrayCategory={assetTrayCategory}
          assetManagerOpen={assetManagerOpen}
          onAction={(action, trigger) => {
            if (action === 'sheet') inspect('Mira');
            else if (action === 'home') setModal('leave');
            else if (action === 'players') setPlayersOpen((v) => !v);
            else if (action === 'dice') setDiceOpen((v) => !v);
            else if (action === 'chat') setChatOpen((v) => !v);
            else if (action === 'soundboard') {
              soundboardTrigger.current = trigger;
              setSoundboardOpen((value) => !value);
            } else setModal(action);
          }}
          onToggleAssetTray={(category) =>
            setAssetTrayCategory((current) =>
              current === category ? null : category,
            )
          }
          onOpenAssetManager={() => {
            if (assetTrayCategory) setAssetManagerTab(assetTrayCategory);
            setAssetManagerOpen((open) => !open);
          }}
          onSelectScene={setScene}
          onInspectAsset={inspect}
        />

        {(playersOpen || diceOpen || soundboardOpen) && (
          <div className="floating-stack-top-left">
            {playersOpen && (
              <aside
                className="floating-popup player-list-window"
                aria-label="Players"
              >
                <header>
                  <h2>Players</h2>
                  <IconButton
                    label="Close players"
                    onClick={() => setPlayersOpen(false)}
                  >
                    ×
                  </IconButton>
                </header>
                <LiveRoster />
                <div className="player-list-footer">
                  <AutosaveStatus />
                  <SessionStatus />
                </div>
              </aside>
            )}

            {diceOpen && (
              <aside
                className="floating-popup dice-window"
                aria-label="Dice tray"
              >
                <DiceTray
                  rollMode={rollMode}
                  setRollMode={setRollMode}
                  die={die}
                  setDie={setDie}
                  count={count}
                  setCount={setCount}
                  modifier={modifier}
                  setModifier={setModifier}
                  visibility={visibility}
                  setVisibility={setVisibility}
                  role={role}
                  onPrepare={() =>
                    handleRollFormula(
                      buildTrayFormula({ die, count, modifier, rollMode }),
                      visibility,
                    )
                  }
                  onRollFormula={handleRollFormula}
                />
              </aside>
            )}

            {soundboardOpen && (
              <aside
                id={soundboardId}
                className="floating-popup workspace-soundboard"
                aria-label="Soundboard"
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && !event.defaultPrevented) {
                    closeSoundboard();
                  }
                }}
              >
                <header>
                  <h2>Soundboard</h2>
                  <IconButton
                    label="Close soundboard"
                    onClick={closeSoundboard}
                  >
                    ×
                  </IconButton>
                </header>
                <div
                  id={soundboardContentId}
                  className="workspace-soundboard-body"
                >
                  <Soundboard
                    controls={soundboard}
                    canControl={currentUser?.role === ROLES.DM}
                    preview={false}
                  />
                </div>
              </aside>
            )}
          </div>
        )}

        {chatOpen && (
          <div className="floating-stack-right">
            <div className="floating-popup chat-window">
              <ChatPanel
                preview={false}
                name={name}
                hidden={!chatOpen}
                onClose={() => setChatOpen(false)}
              />
            </div>
          </div>
        )}
      </div>

      {role === 'DM' && assetManagerOpen && (
        <Modal
          title="Asset Manager"
          className="asset-manager-modal"
          onClose={() => setAssetManagerOpen(false)}
        >
          <AssetsPanel
            role={role}
            scene={scene}
            category={assetManagerTab}
            onCategoryChange={setAssetManagerTab}
            onScene={setScene}
            onInspect={inspect}
            onClose={() => setAssetManagerOpen(false)}
            inModal
          />
        </Modal>
      )}

      {modal && (
        <Modal
          title={
            {
              leave: role === 'DM' ? 'Return home?' : 'Leave the table?',
              notes: 'DM screen',
              compendium: 'Compendium',
              dice: 'Roll prepared',
              inspect: inspected?.name,
            }[modal]
          }
          onClose={() => setModal(null)}
        >
          {modal === 'leave' && (
            <>
              <p className="leave-prompt">
                {role === 'DM'
                  ? 'Do you wish to leave? The campaign will close.'
                  : 'Do you wish to leave? You may rejoin if you wish.'}
              </p>
              <div className="form-actions leave-actions">
                <button
                  className="primary"
                  onClick={() => {
                    disconnect({ forgetIdentity: true });
                    onLeave();
                  }}
                >
                  Yes
                </button>
                <button onClick={() => setModal(null)}>No</button>
              </div>
            </>
          )}
          {modal === 'notes' && (
            <>
              <AutosaveStatus />
              <label>
                Session notes
                <textarea
                  className="notes-editor"
                  value={notes}
                  onChange={(e) => handleNotesChange(e.target.value)}
                />
              </label>
              <div className="form-actions">
                <button className="primary" onClick={() => setModal(null)}>
                  Done
                </button>
              </div>
            </>
          )}
          {modal === 'compendium' && <Compendium />}
          {modal === 'dice' && (
            <>
              <div className="prepared-dice">
                {buildTrayFormula({ die, count, modifier, rollMode })}
              </div>
              <p>
                {visibility} · {rollMode}
              </p>
              <button
                className="primary"
                onClick={() => {
                  handleRollFormula(
                    buildTrayFormula({ die, count, modifier, rollMode }),
                    visibility,
                  );
                  setModal(null);
                }}
              >
                Roll now
              </button>
            </>
          )}
          {modal === 'inspect' &&
            (inspected.category === 'Characters' ? (
              <CharacterSheet
                person={person}
                character={characterForPerson(characters, person)}
                canEdit={canEditCharacter(characterForPerson(characters, person))}
                onHpChange={(value) => handleHpChange(person, value)}
              />
            ) : (
              <>
                <p className="notice">Sample asset</p>
                <dl>
                  <div>
                    <dt>Category</dt>
                    <dd>{inspected.category}</dd>
                  </div>
                </dl>
              </>
            ))}
        </Modal>
      )}
    </div>
  );
}
