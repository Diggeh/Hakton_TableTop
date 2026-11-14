import { useSession } from '../store/sessionStore.js';
import { ROLES } from '../../shared/events.js';

// Presentation of the networking branch's store; never exposes host secrets.
export function SessionStatus() {
  const connection = useSession((s) => s.connection);
  const error = useSession((s) => s.connectionError);
  const user = useSession((s) => s.currentUser);
  const participants = useSession((s) => s.participants);
  const server = useSession((s) => s.serverInfo);
  const address = server?.port
    ? `${server.lanIps?.[0] || '127.0.0.1'}:${server.port}`
    : null;
  return (
    <div className="session-status" role="status" title={error || undefined}>
      {address && <span>Host {address}</span>}
      {user && (
        <span>
          {user.displayName} · {user.role === ROLES.DM ? 'DM' : 'Player'}
        </span>
      )}
      <span>{participants.filter((p) => p.connected).length} online</span>
      <span className={`connection-${connection}`}>{connection}</span>
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
