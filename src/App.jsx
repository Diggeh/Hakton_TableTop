import { useEffect, useRef, useState } from 'react';
import MapStage from '@/canvas/MapStage.jsx';
import { connect } from '@/net/socket.js';
import { useSession } from '@/store/sessionStore.js';

export default function App() {
  const connection = useSession((s) => s.connection);
  const mapName = useSession((s) => s.map?.name);
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

  return (
    <div className="flex h-full flex-col bg-navy text-white">
      <header className="flex items-center justify-between border-b border-cerulean px-4 py-2">
        <h1 className="text-lg font-bold tracking-wide text-aqua">Hakton</h1>
        <span className="text-sm text-cerulean">
          {mapName ?? 'No map'} · <span className="text-aqua">{connection}</span>
        </span>
      </header>
      <main ref={hostRef} className="min-h-0 flex-1">
        <MapStage width={size.width} height={size.height} />
      </main>
    </div>
  );
}
