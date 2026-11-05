import { useEffect, useRef, useState } from 'react';
import MapStage from '@/canvas/MapStage.jsx';
import { connect } from '@/net/socket.js';
import { useSession } from '@/store/sessionStore.js';
import { ROLES } from '@shared/events.js';

export default function App() {
  const connection = useSession((s) => s.connection);
  const connectionError = useSession((s) => s.connectionError);
  const mapName = useSession((s) => s.map?.name);
  const currentUser = useSession((s) => s.currentUser);
  const participants = useSession((s) => s.participants);
  const serverInfo = useSession((s) => s.serverInfo);

  const hostRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    connect();
  }, []);

  useEffect(() => {
    const el = hostRef.current;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onlineCount = participants.filter((p) => p.connected).length;
  const hostAddress =
    serverInfo?.lanIps?.[0] && serverInfo?.port
      ? `${serverInfo.lanIps[0]}:${serverInfo.port}`
      : serverInfo?.port
        ? `127.0.0.1:${serverInfo.port}`
        : null;

  return (
    <div className="flex h-full flex-col bg-navy text-white">
      <header className="flex items-center justify-between border-b border-cerulean px-4 py-2">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold tracking-wide text-aqua">Hakton</h1>
          {hostAddress && (
            <span className="border border-cerulean px-2 py-0.5 text-xs text-cerulean">
              Host {hostAddress}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-sm text-cerulean">
          {currentUser && (
            <span>
              <span className="text-white">{currentUser.displayName}</span>{' '}
              <span className="text-xs uppercase text-aqua">
                ({currentUser.role === ROLES.DM ? 'DM' : 'Player'})
              </span>
            </span>
          )}
          {participants.length > 0 && (
            <span>
              · <span className="text-aqua">{onlineCount}</span> online
            </span>
          )}
          <span>
            · {mapName ?? 'No map'} ·{' '}
            <span className="text-aqua" title={connectionError ?? undefined}>
              {connection}
            </span>
          </span>
        </div>
      </header>
      <main ref={hostRef} className="min-h-0 flex-1">
        <MapStage width={size.width} height={size.height} />
      </main>
    </div>
  );
}
