import { useEffect, useRef, useState } from 'react';
import { IconButton, Tabs } from './Primitives.jsx';
import { party } from './fixtures.js';
export default function ChatPanel({ name, onClose, hidden, width }) {
  const [tab, setTab] = useState('Table');
  const [recipient, setRecipient] = useState('Dungeon Master');
  const [draft, setDraft] = useState('');
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
  const end = useRef(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, tab, recipient]);
  const shown = messages.filter(
    (m) =>
      m.channel === tab && (tab !== 'Whispers' || m.recipient === recipient),
  );
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
        onChange={setTab}
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
        {shown.map((m) => (
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
        {shown.length === 0 && (
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
          if (!draft.trim()) return;
          setMessages([
            ...messages,
            {
              id: crypto.randomUUID(),
              name,
              text: draft.trim(),
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
        <span className="preview-label">Local only</span>
        <textarea
          aria-label="Message"
          placeholder={
            tab === 'Whispers'
              ? `Whisper to ${recipient}…`
              : 'Message the table…'
          }
          value={draft}
          maxLength={2000}
          disabled={tab === 'Rolls'}
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
          <button
            className="primary"
            disabled={!draft.trim() || tab === 'Rolls'}
          >
            {tab === 'Whispers' ? 'Whisper' : 'Send'} ↑
          </button>
        </div>
      </form>
    </aside>
  );
}
