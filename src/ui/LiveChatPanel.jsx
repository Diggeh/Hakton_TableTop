import { useEffect, useRef, useState } from 'react';
import { chatStore, useChat } from '../store/chatStore.js';
import { sessionStore, useSession } from '../store/sessionStore.js';
import {
  loadChatHistory,
  retryPublicText,
  sendPublicText,
} from '../net/chat.js';
import { MAX_TEXT_LENGTH } from '../../shared/chatEvents.js';
import { IconButton } from './Primitives.jsx';

export default function LiveChatPanel({ hidden, width, onClose }) {
  const messages = useChat((s) => s.messages);
  const historyState = useChat((s) => s.historyState);
  const historyError = useChat((s) => s.historyError);
  const connection = useSession((s) => s.connection);
  const user = useSession((s) => s.currentUser);
  const sessionId = useSession((s) => s.session?.id);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const end = useRef(null);
  const connected = connection === 'connected' && Boolean(user?.id);
  useEffect(() => {
    if (!hidden) end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, hidden]);
  useEffect(() => {
    setDraft('');
    setError('');
  }, [user?.id, sessionId]);
  return (
    <aside className="chat-panel" hidden={hidden} style={{ width }}>
      <header>
        <h2>Game log</h2>
        <IconButton label="Collapse chat" onClick={onClose}>
          ›
        </IconButton>
      </header>
      <div className="tabs" role="tablist" aria-label="Chat channels">
        <button role="tab" aria-selected="true">
          Table
        </button>
        <button
          role="tab"
          aria-selected="false"
          disabled
          title="Whispers are not connected yet"
        >
          Whispers
        </button>
        <button
          role="tab"
          aria-selected="false"
          disabled
          title="Dice engine integration is separate"
        >
          Rolls
        </button>
      </div>
      <div
        className="message-list"
        role="log"
        aria-label="Public session messages"
        aria-busy={historyState === 'loading'}
      >
        {historyState === 'loading' && (
          <p className="chat-status" role="status">
            Loading history…
          </p>
        )}
        {historyError && (
          <div className="chat-error" role="alert">
            {historyError}{' '}
            <button
              disabled={!connected}
              onClick={() => void loadChatHistory()}
            >
              Retry history
            </button>
          </div>
        )}
        {!messages.length && historyState === 'ready' && (
          <p className="empty-inline">No messages yet.</p>
        )}
        {messages.map((m) => (
          <article className={`message message-${m.status}`} key={m.id}>
            <span className="message-avatar" aria-hidden="true">
              {m.senderName.slice(0, 1)}
            </span>
            <div className="message-body">
              <div className="message-meta">
                <strong>{m.senderName}</strong>
                <time dateTime={m.createdAt}>
                  {new Date(m.createdAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </div>
              <p>{m.text}</p>
              {m.status === 'pending' && <small role="status">Sending…</small>}
              {m.status === 'failed' && (
                <div className="chat-error">
                  <span>{m.error}</span>
                  <button
                    disabled={!connected}
                    onClick={() => void retryPublicText(m.requestId)}
                  >
                    Retry
                  </button>
                </div>
              )}
            </div>
          </article>
        ))}
        <div ref={end} />
      </div>
      <form
        className="chat-composer"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!connected || !draft.trim()) return;
          const text = draft;
          const requestId = crypto.randomUUID();
          setDraft('');
          setError('');
          const result = await sendPublicText(text, requestId);
          const current = sessionStore.getState();
          if (
            current.currentUser?.id !== user?.id ||
            current.session?.id !== sessionId
          )
            return;
          if (
            !result.success &&
            !chatStore
              .getState()
              .messages.some((m) => m.requestId === requestId)
          ) {
            setError(result.error || 'Message could not be sent.');
            setDraft((current) => current || text);
          }
        }}
      >
        {!connected && (
          <p className="chat-status" role="status">
            {connection === 'connecting' || connection === 'reconnecting'
              ? 'Connecting…'
              : 'Join a live session to chat.'}
          </p>
        )}
        {error && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        <textarea
          aria-label="Message"
          placeholder="Message the table…"
          maxLength={MAX_TEXT_LENGTH}
          value={draft}
          disabled={!connected}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              e.currentTarget.form.requestSubmit();
            }
          }}
        />
        <div>
          <button type="button" disabled title="Image sharing is not connected">
            Attach image
          </button>
          <button className="primary" disabled={!connected || !draft.trim()}>
            Send ↑
          </button>
        </div>
      </form>
    </aside>
  );
}
