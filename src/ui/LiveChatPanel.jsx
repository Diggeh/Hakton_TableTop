import { useEffect, useRef, useState } from 'react';
import { chatStore, useChat } from '../store/chatStore.js';
import { sessionStore, useSession } from '../store/sessionStore.js';
import {
  loadChatHistory,
  retryChatMessage,
  sendChatMessage,
} from '../net/chat.js';
import { MAX_TEXT_LENGTH } from '../../shared/chatEvents.js';
import { IconButton, Tabs } from './Primitives.jsx';
import ChatImage from './ChatImage.jsx';
import { prepareChatImage } from '../net/chatImage.js';

export default function LiveChatPanel({ hidden, width, onClose }) {
  const messages = useChat((s) => s.messages);
  const historyState = useChat((s) => s.historyState);
  const historyError = useChat((s) => s.historyError);
  const connection = useSession((s) => s.connection);
  const user = useSession((s) => s.currentUser);
  const sessionId = useSession((s) => s.session?.id);
  const participants = useSession((s) => s.participants);
  const [tab, setTab] = useState('Table');
  const [recipientId, setRecipientId] = useState('');
  const [attachment, setAttachment] = useState(null);
  const [preparing, setPreparing] = useState(false);
  const fileInput = useRef(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const end = useRef(null);
  const connected = connection === 'connected' && Boolean(user?.id);
  const privateTab = tab === 'Whispers';
  const recipients = participants.filter((p) => p.id !== user?.id);
  const recipient = recipients.find((p) => p.id === recipientId);
  const canCompose = connected && (!privateTab || Boolean(recipient));
  const shown = messages.filter(
    (message) => Boolean(message.recipientId) === privateTab,
  );
  const composeScope = JSON.stringify([sessionId, user?.id, tab, recipientId]);
  const currentScope = useRef(composeScope);
  currentScope.current = composeScope;

  useEffect(() => {
    if (!hidden) end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, hidden, tab]);
  useEffect(() => {
    setDraft('');
    setError('');
    setAttachment(null);
  }, [composeScope]);

  async function submit(event) {
    event.preventDefault();
    if (!canCompose || preparing || (!draft.trim() && !attachment)) return;
    setError('');
    setPreparing(true);
    let image;
    if (attachment) {
      try {
        image = await prepareChatImage(attachment);
      } catch (error) {
        if (currentScope.current === composeScope) setError(error.message);
        setPreparing(false);
        return;
      }
    }
    const current = sessionStore.getState();
    if (
      currentScope.current !== composeScope ||
      current.currentUser?.id !== user?.id ||
      current.session?.id !== sessionId
    ) {
      setPreparing(false);
      return;
    }
    const requestId = crypto.randomUUID();
    const result = await sendChatMessage(
      {
        type: image ? 'image' : privateTab ? 'whisper' : 'text',
        text: draft,
        image,
        recipientId: privateTab ? recipient.id : null,
        recipientName: privateTab ? recipient.displayName : undefined,
      },
      requestId,
    );
    setPreparing(false);
    if (currentScope.current !== composeScope) return;
    if (
      result.success ||
      chatStore.getState().messages.some((m) => m.requestId === requestId)
    ) {
      setDraft((value) => (value === draft ? '' : value));
      setAttachment((value) => (value === attachment ? null : value));
    } else {
      setError(result.error || 'Message could not be sent.');
    }
  }
  return (
    <aside className="chat-panel" hidden={hidden} style={{ width }}>
      <header>
        <h2>Game log</h2>
        <IconButton label="Collapse chat" onClick={onClose}>
          ›
        </IconButton>
      </header>
      <Tabs
        items={['Table', 'Whispers']}
        value={tab}
        onChange={setTab}
        label="Chat channels"
      />
      {privateTab && (
        <label className="recipient">
          To
          <select
            value={recipientId}
            onChange={(e) => setRecipientId(e.target.value)}
          >
            <option value="">Choose a participant</option>
            {recipients.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
                {p.connected ? '' : ' (offline)'}
              </option>
            ))}
          </select>
        </label>
      )}
      <div
        className="message-list"
        role="log"
        aria-label={privateTab ? 'Private whispers' : 'Public session messages'}
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
        {!shown.length && historyState === 'ready' && (
          <p className="empty-inline">No messages yet.</p>
        )}
        {shown.map((m) => (
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
              {m.recipientId && (
                <small>
                  To{' '}
                  {m.recipientId === user?.id
                    ? 'you'
                    : m.recipientName || 'participant'}
                </small>
              )}
              {m.text && <p>{m.text}</p>}
              {m.type === 'image' && (
                <ChatImage
                  message={m}
                  connected={connected}
                  visible={!hidden}
                />
              )}
              {m.status === 'pending' && <small role="status">Sending…</small>}
              {m.status === 'failed' && (
                <div className="chat-error">
                  <span>{m.error}</span>
                  <button
                    disabled={!connected}
                    onClick={() => void retryChatMessage(m.requestId)}
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
      <form className="chat-composer" onSubmit={submit}>
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
          placeholder={privateTab ? 'Write a whisper…' : 'Message the table…'}
          maxLength={MAX_TEXT_LENGTH}
          value={draft}
          disabled={!canCompose || preparing}
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
        <input
          ref={fileInput}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            setAttachment(e.target.files[0] || null);
            setError('');
            e.target.value = '';
          }}
        />
        {attachment && (
          <div className="chat-file">
            <small>{attachment.name}</small>
            <button
              type="button"
              disabled={preparing}
              onClick={() => setAttachment(null)}
            >
              Remove
            </button>
          </div>
        )}
        <div>
          <button
            type="button"
            disabled={!canCompose || preparing}
            onClick={() => fileInput.current?.click()}
          >
            Attach image
          </button>
          <button
            className="primary"
            disabled={
              !canCompose || preparing || (!draft.trim() && !attachment)
            }
          >
            {preparing ? 'Sending…' : privateTab ? 'Whisper ↑' : 'Send ↑'}
          </button>
        </div>
      </form>
    </aside>
  );
}
