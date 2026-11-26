import { useEffect, useRef, useState } from 'react';
import { useSession } from '../store/sessionStore.js';
import { VOICE_STATUS, useVoice } from '../store/voiceStore.js';
import { IconButton } from './Primitives.jsx';
import ToolIcon from './ToolIcon.jsx';

function initialsFor(name) {
  const clean = String(name || 'User').trim();
  if (!clean) return 'U';
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

function VideoTile({
  displayName,
  isSelf,
  stream,
  streamRevision,
  showVideo,
  muted,
  deafened,
  speaking,
}) {
  const videoRef = useRef(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return undefined;
    el.muted = true;
    if (!showVideo || !stream) {
      el.srcObject = null;
      return undefined;
    }
    if (el.srcObject !== stream) {
      el.srcObject = stream;
    }
    el.play?.().catch?.(() => {});
    return () => {
      if (el.srcObject === stream) {
        el.srcObject = null;
      }
    };
  }, [showVideo, stream, streamRevision]);

  return (
    <div
      className={`video-tile ${speaking ? 'is-speaking' : ''} ${isSelf ? 'is-self' : ''}`}
      aria-label={`${displayName}${isSelf ? ' (You)' : ''}${speaking ? ', speaking' : ''}`}
    >
      {showVideo ? (
        <video
          ref={videoRef}
          className={`video-tile-media ${isSelf ? 'is-mirrored' : ''}`}
          muted
          autoPlay
          playsInline
        />
      ) : (
        <div className="video-tile-avatar" aria-hidden="true">
          <span>{initialsFor(displayName)}</span>
        </div>
      )}

      <div className="video-tile-overlay">
        <span className="video-tile-name">
          {displayName}
          {isSelf ? ' (You)' : ''}
        </span>
        {(muted || deafened) && (
          <span className="video-tile-badges">
            {muted && (
              <span className="video-tile-badge" title="Muted">
                <ToolIcon name="micOff" />
              </span>
            )}
            {deafened && (
              <span className="video-tile-badge is-deafened" title="Deafened">
                <ToolIcon name="headphonesOff" />
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

export default function VideoCallStrip() {
  const status = useVoice((s) => s.status);
  const localPeerId = useVoice((s) => s.peerId);
  const localStream = useVoice((s) => s.localStream);
  const localStreamRevision = useVoice((s) => s.localStreamRevision);
  const localVideoEnabled = useVoice((s) => s.localVideoEnabled);
  const localAudioMuted = useVoice((s) => s.localAudioMuted);
  const localDeafened = useVoice((s) => s.localDeafened);
  const listenOnly = useVoice((s) => s.listenOnly);
  const localSpeaking = useVoice((s) => s.localSpeaking);
  const peers = useVoice((s) => s.peers);
  const roster = useVoice((s) => s.roster);

  const currentUser = useSession((s) => s.currentUser);
  const participants = useSession((s) => s.participants);
  const [collapsed, setCollapsed] = useState(false);

  if (status !== VOICE_STATUS.CONNECTED && status !== VOICE_STATUS.RECONNECTING) {
    return null;
  }

  const participantById = new Map();
  for (const p of participants) {
    if (p?.id) participantById.set(p.id, p);
  }

  const rosterByPeerId = new Map();
  for (const entry of roster) {
    if (entry?.peerId && entry.peerId !== localPeerId) {
      rosterByPeerId.set(entry.peerId, entry);
    }
  }

  const remotePeerIds = [];
  const seenPeerIds = new Set();
  for (const entry of roster) {
    if (entry?.peerId && entry.peerId !== localPeerId && !seenPeerIds.has(entry.peerId)) {
      seenPeerIds.add(entry.peerId);
      remotePeerIds.push(entry.peerId);
    }
  }
  for (const peerId of Object.keys(peers)) {
    if (peerId !== localPeerId && !seenPeerIds.has(peerId)) {
      seenPeerIds.add(peerId);
      remotePeerIds.push(peerId);
    }
  }

  const tiles = [
    {
      key: 'self',
      isSelf: true,
      displayName: currentUser?.displayName || 'You',
      stream: localStream,
      streamRevision: localStreamRevision,
      showVideo: Boolean(localVideoEnabled && localStream),
      muted: Boolean(localAudioMuted || listenOnly),
      deafened: Boolean(localDeafened),
      speaking: Boolean(localSpeaking && !localAudioMuted && !listenOnly),
    },
    ...remotePeerIds.map((peerId) => {
      const peer = peers[peerId];
      const rosterEntry = rosterByPeerId.get(peerId);
      const playerId = peer?.playerId ?? rosterEntry?.playerId;
      const participant = playerId ? participantById.get(playerId) : null;
      const displayName =
        peer?.displayName ||
        rosterEntry?.displayName ||
        participant?.displayName ||
        'Participant';
      const muted = Boolean(peer?.muted ?? rosterEntry?.muted);
      const deafened = Boolean(peer?.deafened ?? rosterEntry?.deafened);
      const hasVideo = Boolean(peer?.hasVideo && peer?.stream);

      return {
        key: peerId,
        isSelf: false,
        displayName,
        stream: peer?.stream ?? null,
        streamRevision: 0,
        showVideo: hasVideo,
        muted,
        deafened,
        speaking: Boolean(peer?.speaking && !muted),
      };
    }),
  ];

  const anySpeaking = tiles.some((t) => t.speaking);

  if (collapsed) {
    return (
      <div className="video-call-strip is-collapsed" role="region" aria-label="Video call">
        <button
          type="button"
          className="video-strip-pill"
          onClick={() => setCollapsed(false)}
          title="Expand video call strip"
        >
          <span
            className={`video-speaking-dot ${anySpeaking ? 'is-active' : ''}`}
            aria-hidden="true"
          />
          <span>Call · {tiles.length}</span>
          <ToolIcon name="chevronUp" />
        </button>
      </div>
    );
  }

  return (
    <section className="video-call-strip" aria-label="Video call participants">
      <header className="video-strip-header">
        <div className="video-strip-title">
          <span
            className={`video-speaking-dot ${anySpeaking ? 'is-active' : ''}`}
            aria-hidden="true"
          />
          <span>Call · {tiles.length}</span>
        </div>
        <IconButton
          label="Collapse video call strip"
          title="Collapse video call strip"
          onClick={() => setCollapsed(true)}
        >
          <ToolIcon name="chevronDown" />
        </IconButton>
      </header>
      <div className="video-strip-tiles">
        {tiles.map((tile) => (
          <VideoTile
            key={tile.key}
            displayName={tile.displayName}
            isSelf={tile.isSelf}
            stream={tile.stream}
            streamRevision={tile.streamRevision}
            showVideo={tile.showVideo}
            muted={tile.muted}
            deafened={tile.deafened}
            speaking={tile.speaking}
          />
        ))}
      </div>
    </section>
  );
}
