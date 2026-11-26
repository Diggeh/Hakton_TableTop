import { useState } from 'react';
import {
  loadNetworkConfig,
  resetNetworkConfig,
  saveNetworkConfig,
} from '../net/networkConfig.js';

export default function NetworkSettingsDrawer({ compact = false }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => loadNetworkConfig());
  const [savedNote, setSavedNote] = useState('');

  function handleSave(e) {
    e.preventDefault();
    const saved = saveNetworkConfig(draft);
    setDraft(saved);
    setSavedNote('Saved (applies on next connection).');
    setTimeout(() => setSavedNote(''), 2500);
  }

  function handleReset() {
    const defaults = resetNetworkConfig();
    setDraft(defaults);
    setSavedNote('Reset to free public defaults.');
    setTimeout(() => setSavedNote(''), 2500);
  }

  return (
    <div className={`network-settings-drawer ${compact ? 'is-compact' : ''}`}>
      <button
        type="button"
        className="text-button network-settings-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '▾ Hide Advanced Network' : '▸ Advanced Network (Signaling & TURN)'}
      </button>

      {open && (
        <form className="network-settings-form" onSubmit={handleSave}>
          <p className="network-settings-hint">
            Leave blank to use free PeerJS cloud (0.peerjs.com) and public STUN.
          </p>
          <label>
            Signaling host
            <input
              placeholder="0.peerjs.com (default)"
              value={draft.signalingHost}
              onChange={(e) =>
                setDraft((d) => ({ ...d, signalingHost: e.target.value }))
              }
            />
          </label>
          <div className="network-settings-row">
            <label>
              Port
              <input
                placeholder="443"
                value={draft.signalingPort}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, signalingPort: e.target.value }))
                }
              />
            </label>
            <label>
              Path
              <input
                placeholder="/"
                value={draft.signalingPath}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, signalingPath: e.target.value }))
                }
              />
            </label>
          </div>
          <label className="network-settings-check">
            <input
              type="checkbox"
              checked={Boolean(draft.signalingSecure)}
              onChange={(e) =>
                setDraft((d) => ({ ...d, signalingSecure: e.target.checked }))
              }
            />
            <span>Use TLS (HTTPS / WSS)</span>
          </label>
          <label>
            TURN server URL (optional, for strict NAT)
            <input
              placeholder="turn:relay.example.com:3478"
              value={draft.turnUrl}
              onChange={(e) =>
                setDraft((d) => ({ ...d, turnUrl: e.target.value }))
              }
            />
          </label>
          {draft.turnUrl.trim() && (
            <div className="network-settings-row">
              <label>
                TURN username
                <input
                  value={draft.turnUsername}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, turnUsername: e.target.value }))
                  }
                />
              </label>
              <label>
                TURN credential
                <input
                  type="password"
                  value={draft.turnCredential}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, turnCredential: e.target.value }))
                  }
                />
              </label>
            </div>
          )}
          {savedNote && (
            <p className="network-settings-saved" role="status">
              {savedNote}
            </p>
          )}
          <div className="network-settings-actions">
            <button type="button" onClick={handleReset}>
              Reset Defaults
            </button>
            <button type="submit" className="primary">
              Save
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
