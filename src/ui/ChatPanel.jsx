import { useEffect, useRef, useState } from 'react';
import { DICE_VISIBILITY } from '../../shared/dice/constants.js';
import { isRollCommand } from '../../shared/dice/parser.js';
import { rollFormula } from '../../shared/dice/roller.js';
import { emitDiceRoll } from '../net/socket.js';
import { useSession } from '../store/sessionStore.js';
import LiveChatPanel from './LiveChatPanel.jsx';
import { IconButton, Tabs } from './Primitives.jsx';
import { party } from './fixtures.js';

export function RollLogEntry({ roll }) {
  return (
    <article className="message message-roll" key={roll.id}>
      <span className="message-avatar" aria-hidden="true">
        {(roll.senderName || 'A').slice(0, 1)}
      </span>
      <div className="message-body">
        <div className="message-meta">
          <strong>{roll.senderName}</strong>
          <time>{roll.time}</time>
        </div>
        <div className="chat-roll-card">
          <div className="chat-roll-header">
            <span className="chat-roll-formula">
              {roll.label ? `${roll.label} (${roll.formula})` : roll.formula}
            </span>
            {roll.visibility === DICE_VISIBILITY.DM && (
              <small className="chat-roll-secret">DM Roll</small>
            )}
          </div>
          <div className="chat-roll-dice">
            {roll.dice.map((d, idx) => (
              <span
                key={idx}
                className={`dice-chip ${d.kept ? 'is-kept' : 'is-dropped'}`}
                title={`d${d.sides}: ${d.value}${d.kept ? '' : ' (dropped)'}`}
              >
                <small>d{d.sides}</small>
                <strong>{d.value}</strong>
              </span>
            ))}
            {roll.modifier !== 0 && (
              <span className="dice-chip is-modifier">
                <strong>
                  {roll.modifier > 0 ? `+${roll.modifier}` : roll.modifier}
                </strong>
              </span>
            )}
            <span className="chat-roll-total">= {roll.total}</span>
          </div>
        </div>
      </div>
    </article>
  );
}

export default function ChatPanel({ preview = true, ...props }) {
  return preview ? (
    <PreviewChatPanel {...props} />
  ) : (
    <LiveChatPanel {...props} />
  );
}

function PreviewChatPanel({ name, onClose, hidden, width }) {
  const [tab, setTab] = useState('Table');
  const [recipient, setRecipient] = useState('Dungeon Master');
  const [draft, setDraft] = useState('');
  const [rollError, setRollError] = useState('');
  const [messages, setMessages] = useState([
    {
      id: 'a',
      name: 'Dungeon Master',
      text: 'The tide recedes, revealing a stairway cut into the stone.',
      channel: 'Table',
      time: '20:14',
    },
    {
      id: 'b',
      name: 'Mira',
      text: 'I check the steps for tracks.',
      channel: 'Table',
      time: '20:15',
    },
    {
      id: 'c',
      name: 'Thorne',
      text: 'I’ll take the lead. Stay close.',
      channel: 'Table',
      time: '20:16',
    },
  ]);

  const rollHistory = useSession((s) => s.rollHistory);
  const end = useRef(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, rollHistory, tab, recipient]);

  const shownMessages = messages.filter(
    (m) =>
      m.channel === tab && (tab !== 'Whispers' || m.recipient === recipient),
  );

  const shownRolls =
    tab === 'Rolls'
      ? rollHistory
      : tab === 'Table'
        ? rollHistory.filter((r) => r.visibility !== DICE_VISIBILITY.DM)
        : [];

  return (
    <aside className="chat-panel" hidden={hidden} style={{ width }}>
      <header>
        <h2>Game log</h2>
        <IconButton label="Collapse chat" onClick={onClose}>
          ›
        </IconButton>
      </header>
      <Tabs
        items={['Table', 'Whispers', 'Rolls']}
        value={tab}
        onChange={(nextTab) => {
          setRollError('');
          setTab(nextTab);
        }}
        label="Chat channels"
      />
      {tab === 'Whispers' && (
        <label className="recipient">
          To
          <select
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
          >
            {['Dungeon Master', ...party.map((p) => p.name)].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
      )}
      <div
        className="message-list"
        role="log"
        aria-label={`${tab} preview messages`}
      >
        <div className="log-divider">Session 08</div>
        {tab !== 'Rolls' &&
          shownMessages.map((m) => (
            <article className="message" key={m.id}>
              <span className="message-avatar" aria-hidden="true">
                {m.name.slice(0, 1)}
              </span>
              <div className="message-body">
                <div className="message-meta">
                  <strong>{m.name}</strong>
                  <time>{m.time}</time>
                </div>
                <p>{m.text}</p>
                {m.recipient && <small>Whisper to {m.recipient}</small>}
              </div>
            </article>
          ))}
        {shownRolls.map((roll) => (
          <RollLogEntry key={roll.id} roll={roll} />
        ))}
        {shownMessages.length === 0 && shownRolls.length === 0 && (
          <p className="empty-inline">
            {tab === 'Rolls' ? 'No rolls yet.' : `No whispers to ${recipient}.`}
          </p>
        )}
        <div ref={end} />
      </div>
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = draft.trim();
          if (!trimmed) return;
          setRollError('');

          if (tab === 'Rolls' || isRollCommand(trimmed)) {
            const evaluated = rollFormula(trimmed);
            if (!evaluated.ok) {
              setRollError(evaluated.error);
              return;
            }
            emitDiceRoll(evaluated.roll, { senderName: name });
            setDraft('');
            return;
          }

          setMessages([
            ...messages,
            {
              id: crypto.randomUUID(),
              name,
              text: trimmed,
              channel: tab,
              recipient: tab === 'Whispers' ? recipient : null,
              time: new Date().toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              }),
            },
          ]);
          setDraft('');
        }}
      >
        {rollError ? (
          <span className="dice-tray-error" role="alert">
            {rollError}
          </span>
        ) : (
          <span className="preview-label">
            {tab === 'Rolls' ? 'Dice formula (/r, /gmroll)' : 'Local / Session'}
          </span>
        )}
        <textarea
          aria-label="Message"
          placeholder={
            tab === 'Rolls'
              ? 'Roll formula, e.g. 2d20kh1+5 or /gmroll 1d20+7…'
              : tab === 'Whispers'
                ? `Whisper to ${recipient}…`
                : 'Message the table or type /r 2d20+5…'
          }
          value={draft}
          maxLength={2000}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form.requestSubmit();
            }
          }}
        />
        <div>
          <button type="button" disabled title="Image sharing unavailable">
            Attach image
          </button>
          <button className="primary" disabled={!draft.trim()}>
            {tab === 'Rolls'
              ? 'Roll 🎲'
              : tab === 'Whispers'
                ? 'Whisper ↑'
                : 'Send ↑'}
          </button>
        </div>
      </form>
    </aside>
  );
}
