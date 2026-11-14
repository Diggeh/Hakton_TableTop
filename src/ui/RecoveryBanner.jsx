import { useEffect, useState } from 'react';

/**
 * One-time, dismissible notice when the database was restored from a backup or
 * recreated after corruption. Everything already happened automatically; this
 * is disclosure, not a save prompt.
 */
export default function RecoveryBanner() {
  const [status, setStatus] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const bridge = typeof window !== 'undefined' ? window.hakton : null;
    if (!bridge?.getRecoveryStatus) return undefined;

    Promise.resolve(bridge.getRecoveryStatus())
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        // Recovery telemetry is optional outside Electron.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (dismissed || !status) return null;
  if (!status.recovered && !status.corruptFile) return null;

  const message = status.recovered
    ? 'The local database was damaged and has been restored from the latest automatic backup.'
    : 'The local database was damaged and could not be restored. A new database was started; the damaged file was preserved.';

  return (
    <div className="recovery-banner" role="status" aria-live="polite">
      <div>
        <strong>Database recovered</strong>
        <span>{message}</span>
        {status.corruptFile ? <code>{status.corruptFile}</code> : null}
      </div>
      <button onClick={() => setDismissed(true)}>Dismiss</button>
    </div>
  );
}
