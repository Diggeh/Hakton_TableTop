import { useState } from 'react';
import { useSession } from '../store/sessionStore.js';
import { DEFAULT_PORT, ROLES } from '../../shared/events.js';
import { encodeInternetCode, encodeRoomCode } from '../../shared/roomCode.js';

// Presentation of the networking branch's store; never exposes host secrets.
export function SessionStatus() {
  const connection = useSession((s) => s.connection);
  const error = useSession((s) => s.connectionError);
  const user = useSession((s) => s.currentUser);
  const participants = useSession((s) => s.participants);
  const server = useSession((s) => s.serverInfo);
  const [copiedKey, setCopiedKey] = useState(null);

  const lanIp = server?.lanIps?.[0] || '127.0.0.1';
  const port = server?.port || DEFAULT_PORT;
  const lanCode = server?.roomCode || encodeRoomCode(lanIp, port);
  const internetCode =
    server?.internetCode ||
    encodeInternetCode(`${server?.sessionId || 'default'}:${lanIp}:${port}`);

  function copyCode(key, value) {
    if (!value) return;
    navigator.clipboard?.writeText(value).catch(() => {});
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((current) => (current === key ? null : current));
    }, 1800);
  }

  return (
    <div className="session-status" role="status" title={error || undefined}>
      <div className="session-room-codes">
        <button
          type="button"
          className="room-code-pill"
          title="Click to copy Local LAN Room Code"
          onClick={() => copyCode('lan', lanCode)}
        >
          <span className="room-code-label">LAN Code</span>
          <strong>{copiedKey === 'lan' ? 'Copied!' : lanCode}</strong>
        </button>
        <button
          type="button"
          className="room-code-pill is-webrtc"
          title="Click to copy Internet (WebRTC) Room Code"
          onClick={() => copyCode('net', internetCode)}
        >
          <span className="room-code-label">Internet Code</span>
          <strong>{copiedKey === 'net' ? 'Copied!' : internetCode}</strong>
        </button>
      </div>
      <div className="session-meta-row">
        {user && (
          <span>
            {user.displayName} · {user.role === ROLES.DM ? 'DM' : 'Player'}
          </span>
        )}
        <span>{participants.filter((p) => p.connected).length} online</span>
        <span className={`connection-${connection}`}>{connection}</span>
      </div>
    </div>
  );
}

export function LiveRoster() {
  const participants = useSession((s) => s.participants);
  return (
    <div className="player-list-content" aria-label="Live participants">
      {participants.map((p) => (
        <div className="live-participant" key={p.id}>
          <span>{p.displayName}</span>
          <small>
            {p.connected ? (p.role === ROLES.DM ? 'DM' : 'Online') : 'Offline'}
          </small>
        </div>
      ))}
      {!participants.length && (
        <span className="roster-empty">Waiting for session</span>
      )}
    </div>
  );
}
