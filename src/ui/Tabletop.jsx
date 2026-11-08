import { useState } from 'react';
import { DICE_VISIBILITY } from '../../shared/dice/constants.js';
import { rollFormula } from '../../shared/dice/roller.js';
import { disconnect, emitDiceRoll } from '../net/socket.js';
import Board from './Board.jsx';
import { SessionStatus, LiveRoster } from './SessionStatus.jsx';
import AssetsPanel from './AssetsPanel.jsx';
import ChatPanel from './ChatPanel.jsx';
import DiceTray, { buildTrayFormula } from './DiceTray.jsx';
import ToolIcon from './ToolIcon.jsx';
import { party } from './fixtures.js';
import CharacterSheet from './CharacterSheet.jsx';
import Compendium from './Compendium.jsx';
import { Mark, IconButton, Modal } from './Primitives.jsx';

export default function Tabletop({ campaign, role, name, onLeave }) {
  const [left, setLeft] = useState(true);
  const [chat, setChat] = useState(true);
  const [diceOpen, setDiceOpen] = useState(true);
  const [assets, setAssets] = useState(true);
  const [assetTab, setAssetTab] = useState('Scenes');
  const [preview, setPreview] = useState(true);
  const [scene, setScene] = useState(campaign.scene);
  const [modal, setModal] = useState(null);
  const [inspected, setInspected] = useState(null);
  const [die, setDie] = useState(20);
  const [rollMode, setRollMode] = useState('Normal');
  const [count, setCount] = useState(1);
  const [modifier, setModifier] = useState(0);
  const [visibility, setVisibility] = useState('Public');
  const [notes, setNotes] = useState(
    'The keeper’s journal mentions a sealed chamber beneath the altar.\n\nThe sentinel wakes when the tide returns.',
  );
  const [hp, setHp] = useState(28);

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
          <IconButton label="Return home" onClick={() => setModal('leave')}>
            <ToolIcon name="home" />
          </IconButton>
        </div>
      </header>
      <div
        className={`table-workspace prototype-layout ${assets && role === 'DM' ? 'assets-open' : ''}`}
      >
        <aside className="player-list-window">
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
        </aside>
        <aside className="dice-window" hidden={!diceOpen}>
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
        <main className="canvas-window">
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
            scene={scene}
            role={role}
            onAction={(action) => {
              if (action === 'sheet') inspect('Mira');
              else if (action === 'home') setModal('leave');
              else if (action === 'players') setLeft((v) => !v);
              else if (action === 'dice') setDiceOpen((v) => !v);
              else if (action === 'chat') setChat((v) => !v);
              else setModal(action);
            }}
            onAssets={(category) => {
              setAssetTab(category);
              setAssets((a) => category !== assetTab || !a);
            }}
            assetsOpen={assets}
          />
        </main>
        {role === 'DM' && assets && (
          <AssetsPanel
            role={role}
            scene={scene}
            category={assetTab}
            onCategoryChange={setAssetTab}
            onScene={setScene}
            onInspect={inspect}
            onClose={() => setAssets(false)}
          />
        )}
        <div className="chat-window">
          <ChatPanel
            name={name}
            hidden={!chat}
            onClose={() => setChat(false)}
          />
          {!chat && (
            <button className="chat-reopen" onClick={() => setChat(true)}>
              Chat +
            </button>
          )}
        </div>
      </div>
      {modal && (
        <Modal
          title={
            {
              leave: role === 'DM' ? 'Return home?' : 'Leave the table?',
              notes: 'DM screen',
              compendium: 'Compendium',
              soundboard: 'Soundboard',
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
                    if (!preview) disconnect();
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
              <p className="preview-label">Not saved</p>
              <label>
                Session notes
                <textarea
                  className="notes-editor"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
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
          {modal === 'soundboard' && (
            <>
              <p className="notice">Playback unavailable</p>
              {['Coastal wind', 'Sanctuary ambience', 'Battle drums'].map(
                (t) => (
                  <div className="reference-row" key={t}>
                    <span>{t}</span>
                    <button disabled>Play</button>
                  </div>
                ),
              )}
              <label>
                Volume
                <input
                  type="range"
                  min="0"
                  max="100"
                  defaultValue="60"
                  disabled
                />
              </label>
            </>
          )}
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
              <CharacterSheet person={person} hp={hp} setHp={setHp} />
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
