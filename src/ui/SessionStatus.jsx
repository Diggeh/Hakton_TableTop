import { useState } from 'react';
import { useSession } from '../store/sessionStore.js';
import { VOICE_STATUS, useVoice } from '../store/voiceStore.js';
import { CONNECTION_STATUS, DEFAULT_PORT, ROLES } from '../../shared/events.js';
import { encodeInternetCode, encodeRoomCode } from '../../shared/roomCode.js';
import { toggleInternetBridge } from '../net/socket.js';
import { joinVoiceMesh } from '../net/voice.js';
import NetworkSettingsDrawer from './NetworkSettingsDrawer.jsx';

export function VoiceCallJoinBar() {
  const connection = useSession((s) => s.connection);
  const voiceStatus = useVoice((s) => s.status);
  const voiceError = useVoice((s) => s.error);
  const voiceNotice = useVoice((s) => s.notice);
  const listenOnly = useVoice((s) => s.listenOnly);
  const roster = useVoice((s) => s.roster);

  const inCall =
    voiceStatus === VOICE_STATUS.CONNECTED ||
    voiceStatus === VOICE_STATUS.RECONNECTING;
  const joining =
    voiceStatus === VOICE_STATUS.ACQUIRING_MEDIA ||
    voiceStatus === VOICE_STATUS.SIGNALING;
  const sessionConnected = connection === CONNECTION_STATUS.CONNECTED;

  return (
    <div className="voice-join-bar" aria-label="Voice call">
      {inCall ? (
        <div className="voice-join-active">
          <span className="voice-status-badge is-connected">
            {voiceStatus === VOICE_STATUS.RECONNECTING
              ? 'Reconnecting call…'
              : 'In Voice Call'}
          </span>
          <small>{roster.length || 1} in call</small>
        </div>
      ) : (
        <button
          type="button"
          className="primary voice-join-btn"
          disabled={!sessionConnected || joining}
          onClick={() => void joinVoiceMesh()}
        >
          {joining
            ? 'Joining Voice Call…'
            : voiceStatus === VOICE_STATUS.ERROR
              ? 'Retry Voice Call'
              : 'Join Voice Call'}
        </button>
      )}
      {(listenOnly || voiceNotice) && (
        <p className="voice-join-notice" role="status">
          {voiceNotice || 'No mic detected — listen-only'}
        </p>
      )}
      {voiceStatus === VOICE_STATUS.ERROR && voiceError && (
        <p className="voice-join-error" role="alert">
          {voiceError}
        </p>
      )}
    </div>
  );
}

// Presentation of the networking branch's store; never exposes host secrets.
export function SessionStatus() {
  const connection = useSession((s) => s.connection);
  const error = useSession((s) => s.connectionError);
  const user = useSession((s) => s.currentUser);
  const participants = useSession((s) => s.participants);
  const server = useSession((s) => s.serverInfo);
  const bridge = useSession((s) => s.internetBridge);
  const [copiedKey, setCopiedKey] = useState(null);

  const isHost = Boolean(user?.isHost || user?.role === ROLES.DM);
  const lanIp = server?.lanIps?.[0] || '127.0.0.1';
  const port = server?.port || DEFAULT_PORT;
  const lanCode = server?.roomCode || encodeRoomCode(lanIp, port);
  const internetCode =
    bridge?.code ||
    server?.internetCode ||
    encodeInternetCode(`${server?.sessionId || 'default'}:${lanIp}:${port}`);
  const bridgeStatus = bridge?.status || 'offline';

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
        <div className="internet-code-group">
          <button
            type="button"
            className="room-code-pill is-webrtc"
            title={
              bridge?.error
                ? `Internet Play (${bridgeStatus}): ${bridge.error}`
                : `Click to copy Internet (WebRTC) Room Code (${bridgeStatus})`
            }
            onClick={() => copyCode('net', internetCode)}
          >
            <span
              className={`internet-bridge-dot is-${bridgeStatus}`}
              aria-hidden="true"
            />
            <span className="room-code-label">Internet Code</span>
            <strong>{copiedKey === 'net' ? 'Copied!' : internetCode}</strong>
          </button>
          {isHost && (
            <button
              type="button"
              className={`internet-toggle-btn ${bridge?.enabled ? 'is-on' : ''}`}
              title={
                bridge?.enabled
                  ? 'Disable Internet Play (switch to LAN-only)'
                  : 'Enable Internet Play (PeerJS)'
              }
              onClick={() => void toggleInternetBridge(!bridge?.enabled)}
            >
              {bridge?.enabled ? 'On' : 'Off'}
            </button>
          )}
        </div>
      </div>
      {bridge?.error && bridgeStatus === 'error' && (
        <p className="internet-bridge-error" role="alert">
          {bridge.error}
        </p>
      )}
      <div className="session-meta-row">
        {user && (
          <span>
            {user.displayName} · {user.role === ROLES.DM ? 'DM' : 'Player'}
          </span>
        )}
        <span>{participants.filter((p) => p.connected).length} online</span>
        <span className={`connection-${connection}`}>{connection}</span>
      </div>
      <NetworkSettingsDrawer compact />
    </div>
  );
}

export function LiveRoster() {
  const participants = useSession((s) => s.participants);
  const currentUser = useSession((s) => s.currentUser);
  const voiceRoster = useVoice((s) => s.roster);
  const voicePeers = useVoice((s) => s.peers);
  const localPeerId = useVoice((s) => s.peerId);
  const localVideoEnabled = useVoice((s) => s.localVideoEnabled);

  const voiceByPlayerId = new Map();
  for (const entry of voiceRoster) {
    if (entry?.playerId) voiceByPlayerId.set(entry.playerId, entry);
  }

  return (
    <div className="player-list-content" aria-label="Live participants">
      {participants.map((p) => {
        const voiceEntry = voiceByPlayerId.get(p.id);
        const peerId = voiceEntry?.peerId ?? p.peerId;
        const inCall = Boolean(peerId);
        const isSelf = currentUser?.id && p.id === currentUser.id;
        const hasCam = isSelf
          ? Boolean(localPeerId && localVideoEnabled)
          : Boolean(peerId && voicePeers[peerId]?.hasVideo);
        return (
          <div className="live-participant" key={p.id}>
            <span>{p.displayName}</span>
            <span className="live-participant-badges">
              {inCall && <em className="voice-roster-badge">Call</em>}
              {hasCam && <em className="voice-roster-badge is-cam">Cam</em>}
              <small>
                {p.connected ? (p.role === ROLES.DM ? 'DM' : 'Online') : 'Offline'}
              </small>
            </span>
          </div>
        );
      })}
      {!participants.length && (
        <span className="roster-empty">Waiting for session</span>
      )}
    </div>
  );
}
