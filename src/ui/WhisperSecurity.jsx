import { useEffect, useState } from 'react';
import { inspectWhisperSecurity, verifyWhisperSecurity } from '../net/chat.js';
import './whisperSecurity.css';

export default function WhisperSecurity({
  recipientId,
  connected,
  onVerified,
}) {
  const [security, setSecurity] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    setSecurity(null);
    setError('');
    onVerified(false);
    if (!connected || !recipientId) return;
    setBusy(true);
    inspectWhisperSecurity(recipientId)
      .then((result) => {
        if (!active) return;
        setSecurity(result);
        setExpanded(!result.verified);
        onVerified(result.verified);
      })
      .catch((failure) => {
        if (active) setError(failure.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [recipientId, connected, onVerified, refresh]);

  async function verify() {
    setBusy(true);
    setError('');
    try {
      const result = await verifyWhisperSecurity(security);
      setSecurity(result);
      setExpanded(false);
      onVerified(true);
    } catch (failure) {
      onVerified(false);
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  if (!recipientId) return null;
  return (
    <div className="whisper-security">
      {security && (
        <>
          {security.verified ? (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              Encrypted · Verified keys
            </button>
          ) : (
            <strong>
              {security.changed
                ? 'Whisper key changed'
                : 'Verify encrypted whispers'}
            </strong>
          )}
          {expanded && (
            <>
              <p>
                Compare this code with the selected participant in person or
                over a trusted call. Both devices must show the same code.
              </p>
              <code aria-label="Whisper security code">{security.code}</code>
              <p>
                Keys stay on this device. Clearing its app data makes encrypted
                history unreadable.
              </p>
              <button
                type="button"
                disabled={busy || !connected}
                onClick={() => setRefresh((n) => n + 1)}
              >
                Check keys again
              </button>
              {!security.verified && (
                <button
                  type="button"
                  disabled={busy || !connected}
                  onClick={() => void verify()}
                >
                  Codes match
                </button>
              )}
            </>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {!security && busy && (
        <span role="status">Preparing encrypted whispers…</span>
      )}
      {error && (
        <button
          type="button"
          disabled={busy || !connected}
          onClick={() => setRefresh((n) => n + 1)}
        >
          Retry keys
        </button>
      )}
    </div>
  );
}
