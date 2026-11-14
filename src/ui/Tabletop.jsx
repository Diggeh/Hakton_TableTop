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
import ToolIcon from './ToolIcon.jsx';
import { party } from './fixtures.js';
import CharacterSheet from './CharacterSheet.jsx';
import Compendium from './Compendium.jsx';
import AutosaveStatus from './AutosaveStatus.jsx';
import Soundboard from './Soundboard.jsx';
import { useWorkspaceLayout, Workspace, WorkspacePanel } from './Workspace.jsx';
import { Mark, IconButton, Modal } from './Primitives.jsx';

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

export default function Tabletop({ campaign, role, name, onLeave }) {
  const [left, setLeft] = useState(true);
  const [chat, setChat] = useState(true);
  const [diceOpen, setDiceOpen] = useState(true);
  const [assets, setAssets] = useState(true);
  const [assetTab, setAssetTab] = useState('Scenes');
  const hostUrl = role === 'Player' ? campaign.hostUrl : undefined;
  // In the packaged desktop app open on the live board; keep the designed
  // preview board in a plain browser (where the host server is unavailable).
  const [preview, setPreview] = useState(
    () => !hostUrl && (typeof window === 'undefined' || !window.hakton),
  );
  const [scene, setScene] = useState(campaign.scene);
  const [modal, setModal] = useState(null);
  const [soundboardOpen, setSoundboardOpen] = useState(false);
  const [soundboardCollapsed, setSoundboardCollapsed] = useState(false);
  const soundboardId = useId();
  const soundboardContentId = useId();
  const soundboardTrigger = useRef(null);
  const layout = useWorkspaceLayout(role, {
    players: left ? 0 : 42,
    map: 0,
    chat: chat ? 0 : 34,
    ...(diceOpen ? { dice: 0 } : {}),
    ...(assets && role === 'DM' ? { assets: 0 } : {}),
    ...(soundboardOpen ? { soundboard: soundboardCollapsed ? 39 : 0 } : {}),
  });
  const [inspected, setInspected] = useState(null);
  const [die, setDie] = useState(20);
  const [rollMode, setRollMode] = useState('Normal');
  const [count, setCount] = useState(1);
  const [modifier, setModifier] = useState(0);
  const [visibility, setVisibility] = useState('Public');
  const [previewNotes, setPreviewNotes] = useState(DEFAULT_NOTES);

  const characters = useSession((state) => state.characters);
  const dmRecords = useSession((state) => state.dmRecords);
  const currentUser = useSession((state) => state.currentUser);
  const soundboard = useSoundboard(preview);

  const notesRecordId = dmNotesRecordId(campaign?.id ?? 'default');
  const notesRecord = dmRecords[notesRecordId];
  const notes = preview ? previewNotes : (notesRecord?.data?.text ?? DEFAULT_NOTES);

  function handleNotesChange(value) {
    if (preview) {
      setPreviewNotes(value);
      return;
    }
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
    if (!character || preview) return false;
    if (role === 'DM') return true;
    return Boolean(currentUser?.id && character.ownerId === currentUser.id);
  }

  function handleHpChange(person, value) {
    if (preview) return;
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
      <header className="table-header">
        <button
          className="brand"
          title="Return to campaigns"
          onClick={() => setModal('leave')}
        >
          <Mark />
          <span>HAKTON</span>
        </button>
        <span className="header-divider" />
        <div className="table-title">
          <strong>{campaign.name}</strong>
          <span>{role === 'DM' ? 'Dungeon Master' : 'Player'}</span>
        </div>
        <div className="table-header-actions">
          {!preview && <AutosaveStatus />}
          {!preview && <SessionStatus />}
          <select
            aria-label="Board source"
            value={preview ? 'preview' : 'live'}
            onChange={(e) => {
              if (e.target.value === 'preview') disconnect();
              setPreview(e.target.value === 'preview');
            }}
          >
            <option value="preview">Preview board</option>
            <option value="live">Existing live board</option>
          </select>
          <button
            className="workspace-reset"
            disabled={!layout.changed}
            onClick={layout.reset}
          >
            Reset layout
          </button>
          <IconButton label="Return home" onClick={() => setModal('leave')}>
            <ToolIcon name="home" />
          </IconButton>
        </div>
      </header>
      <Workspace layout={layout}>
        <WorkspacePanel as="aside" panel="players" title="Players" className="player-list-window"
          collapsedHeight={left ? 0 : 42}>
          <header>
            <h2>Players</h2>
            <IconButton
              label={left ? 'Collapse players' : 'Expand players'}
              onClick={() => setLeft(!left)}
            >
              {left ? '−' : '+'}
            </IconButton>
          </header>
          {left &&
            (!preview ? (
              <LiveRoster />
            ) : (
              <div className="player-list-content">
                <button
                  className="player-host"
                  onClick={() => setModal('leave')}
                >
                  {role === 'DM' ? name : 'Dungeon Master'}
                  <small>DM</small>
                </button>
                {party.map((p) => (
                  <button
                    key={p.name}
                    disabled={role !== 'DM' && p.name !== 'Mira'}
                    onClick={() => inspect(p.name)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            ))}
        </WorkspacePanel>
        <WorkspacePanel as="aside" panel="dice" title="Dice tray" className="dice-window"
          hidden={!diceOpen}>
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
        </WorkspacePanel>
        <WorkspacePanel as="main" panel="map" title="Map" className="canvas-window">
          {role === 'DM' && (
            <nav className="scene-bar" aria-label="Asset bars">
              {['Scenes', 'Characters', 'Maps', 'Props', 'Attachments'].map(
                (category) => (
                  <button
                    key={category}
                    aria-pressed={assets && assetTab === category}
                    onClick={() => {
                      setAssetTab(category);
                      setAssets(true);
                    }}
                  >
                    {category}
                  </button>
                ),
              )}
            </nav>
          )}
          <Board
            preview={preview}
            displayName={name}
            hostUrl={hostUrl}
            scene={scene}
            role={role}
            soundboardOpen={soundboardOpen}
            soundboardId={soundboardId}
            onAction={(action, trigger) => {
              if (action === 'sheet') inspect('Mira');
              else if (action === 'home') setModal('leave');
              else if (action === 'players') setLeft((v) => !v);
              else if (action === 'dice') setDiceOpen((v) => !v);
              else if (action === 'chat') setChat((v) => !v);
              else if (action === 'soundboard') {
                soundboardTrigger.current = trigger;
                setSoundboardOpen((value) => !value);
              } else setModal(action);
            }}
            onAssets={(category) => {
              setAssetTab(category);
              setAssets((a) => category !== assetTab || !a);
            }}
            assetsOpen={assets}
          />
        </WorkspacePanel>
        {role === 'DM' && assets && (
          <WorkspacePanel panel="assets" title="Assets" className="assets-window">
            <AssetsPanel
              role={role}
              scene={scene}
              category={assetTab}
              onCategoryChange={setAssetTab}
              onScene={setScene}
              onInspect={inspect}
              onClose={() => setAssets(false)}
            />
          </WorkspacePanel>
        )}
        <WorkspacePanel as="div" panel="chat" title="Game log" className="chat-window"
          collapsedHeight={chat ? 0 : 34}>
          <ChatPanel
            preview={preview}
            name={name}
            hidden={!chat}
            onClose={() => setChat(false)}
          />
          {!chat && (
            <button className="chat-reopen" onClick={() => setChat(true)}>
              Chat +
            </button>
          )}
        </WorkspacePanel>
        <WorkspacePanel
          id={soundboardId}
          panel="soundboard"
          title="Soundboard"
          aria-label="Soundboard"
          className="workspace-soundboard"
          collapsedHeight={soundboardCollapsed ? 39 : 0}
          hidden={!soundboardOpen}
          titleGrip
          focusOnShow
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.defaultPrevented) closeSoundboard();
          }}
        >
          <header>
            {layout.soundboardDocked && (
              <IconButton label="Float soundboard" onClick={layout.undockSoundboard}>↗</IconButton>
            )}
            <IconButton
              label={soundboardCollapsed ? 'Expand soundboard' : 'Collapse soundboard'}
              aria-controls={soundboardContentId}
              aria-expanded={!soundboardCollapsed}
              onClick={() => setSoundboardCollapsed((value) => !value)}
            >
              {soundboardCollapsed ? '+' : '−'}
            </IconButton>
            <IconButton label="Close soundboard" onClick={closeSoundboard}>×</IconButton>
          </header>
          <div id={soundboardContentId} className="workspace-soundboard-body" hidden={soundboardCollapsed}>
            <Soundboard
              controls={soundboard}
              canControl={preview ? role === 'DM' : currentUser?.role === ROLES.DM}
              preview={preview}
            />
          </div>
        </WorkspacePanel>
      </Workspace>
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
                    if (!preview) disconnect({ forgetIdentity: true });
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
              {preview ? (
                <p className="preview-label">Not saved</p>
              ) : (
                <AutosaveStatus />
              )}
              <label>
                Session notes
                <textarea
                  className="notes-editor"
                  value={notes}
                  readOnly={preview}
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
