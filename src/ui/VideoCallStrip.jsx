import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSession } from '../store/sessionStore.js';
import { VOICE_STATUS, useVoice, voiceStore } from '../store/voiceStore.js';
import { IconButton } from './Primitives.jsx';
import ToolIcon from './ToolIcon.jsx';
import VoiceCallToolbar from './VoiceCallToolbar.jsx';
import {
  MAX_TILE_WIDTH,
  MIN_TILE_WIDTH,
  TILE_WIDTH_STEP,
  clampStripPosition,
  clampTileWidth,
  computePopoutGridCols,
  loadVideoStripLayout,
  nextLayoutMode,
  saveVideoStripLayout,
  tileHeightForWidth,
} from './videoLayout.js';

function initialsFor(name) {
  const clean = String(name || 'User').trim();
  if (!clean) return 'U';
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

function layoutIconFor(mode) {
  if (mode === 'column') return 'layoutColumn';
  if (mode === 'grid') return 'layoutGrid';
  return 'layoutRow';
}

function layoutLabelFor(mode) {
  if (mode === 'column') return 'Vertical stack (click for grid)';
  if (mode === 'grid') return 'Grid layout (click for horizontal strip)';
  return 'Horizontal strip (click for vertical stack)';
}

function copyStylesToPopout(targetDoc) {
  targetDoc.head.innerHTML = '';
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = Array.from(sheet.cssRules || [])
        .map((rule) => rule.cssText)
        .join('\n');
      if (rules) {
        const styleEl = targetDoc.createElement('style');
        styleEl.textContent = rules;
        targetDoc.head.appendChild(styleEl);
      }
    } catch {
      if (sheet.href) {
        const linkEl = targetDoc.createElement('link');
        linkEl.rel = 'stylesheet';
        linkEl.href = sheet.href;
        targetDoc.head.appendChild(linkEl);
      }
    }
  }
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
    const liveVideoTracks = (stream.getVideoTracks?.() ?? []).filter(
      (t) => t && t.readyState !== 'ended',
    );
    const MediaStreamCtor = el.ownerDocument?.defaultView?.MediaStream ?? globalThis.MediaStream;
    const playbackStream =
      liveVideoTracks.length > 0 && typeof MediaStreamCtor === 'function'
        ? new MediaStreamCtor(liveVideoTracks)
        : stream;
    el.srcObject = playbackStream;
    el.play?.().catch?.(() => {});
    return () => {
      if (el.srcObject === playbackStream) {
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

function PopoutCallView({
  tiles,
  anySpeaking,
  alwaysOnTop,
  canPinOnTop,
  onToggleAlwaysOnTop,
  onDockBack,
}) {
  const shellRef = useRef(null);
  const [cols, setCols] = useState(() => computePopoutGridCols(tiles.length, 580, 390));

  useEffect(() => {
    const el = shellRef.current;
    if (!el) return undefined;
    const updateCols = (w, h) => {
      setCols(computePopoutGridCols(tiles.length, w, h));
    };
    const rect = el.getBoundingClientRect();
    updateCols(rect.width || 580, rect.height || 390);
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        updateCols(entry.contentRect.width, entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [tiles.length]);

  return (
    <div ref={shellRef} className="video-popout-shell">
      <header className="video-popout-header">
        <div className="video-strip-title">
          <span
            className={`video-speaking-dot ${anySpeaking ? 'is-active' : ''}`}
            aria-hidden="true"
          />
          <strong>Voice & Video Call · {tiles.length}</strong>
        </div>
        <div className="video-strip-actions">
          {canPinOnTop && (
            <IconButton
              label={alwaysOnTop ? 'Unpin from top' : 'Keep window on top'}
              title={alwaysOnTop ? 'Unpin from top' : 'Keep window on top'}
              aria-pressed={alwaysOnTop}
              onClick={onToggleAlwaysOnTop}
            >
              <ToolIcon name="pin" />
            </IconButton>
          )}
          <IconButton
            label="Return call display to tabletop"
            title="Dock back into tabletop"
            onClick={onDockBack}
          >
            <ToolIcon name="popin" />
          </IconButton>
        </div>
      </header>

      <div
        className="video-popout-grid"
        style={{ '--popout-cols': String(cols) }}
      >
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

      <footer className="video-popout-footer">
        <VoiceCallToolbar variant="popout" />
      </footer>
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
  const [layout, setLayout] = useState(() => loadVideoStripLayout());
  const [dragging, setDragging] = useState(false);
  const [popout, setPopout] = useState(null);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [popoutError, setPopoutError] = useState('');

  const stripRef = useRef(null);
  const popoutRef = useRef(null);
  popoutRef.current = popout;

  const inCall = status === VOICE_STATUS.CONNECTED || status === VOICE_STATUS.RECONNECTING;

  const closePopout = useCallback(() => {
    const current = popoutRef.current;
    popoutRef.current = null;
    setPopout(null);
    setAlwaysOnTop(false);
    voiceStore.getState().setPopoutOpen(false);
    if (current?.win && !current.win.closed) {
      try {
        current.win.close();
      } catch {
        // Ignore close errors
      }
    }
  }, []);

  useEffect(() => {
    if (!inCall && popoutRef.current) {
      closePopout();
    }
  }, [inCall, closePopout]);

  useEffect(() => {
    const handleMainUnload = () => {
      if (popoutRef.current?.win && !popoutRef.current.win.closed) {
        try {
          popoutRef.current.win.close();
        } catch {
          // Ignore close errors
        }
      }
    };
    window.addEventListener('beforeunload', handleMainUnload);
    return () => {
      window.removeEventListener('beforeunload', handleMainUnload);
      handleMainUnload();
    };
  }, []);

  // Re-clamp custom docked position on resize or tile size/layout change so panel never clips off-board
  useEffect(() => {
    if (layout.x === null || layout.y === null || collapsed || popout) return undefined;
    const reClamp = () => {
      const stripEl = stripRef.current;
      const parentEl = stripEl?.offsetParent;
      if (!stripEl || !parentEl) return;
      const stripRect = stripEl.getBoundingClientRect();
      const parentRect = parentEl.getBoundingClientRect();
      const clamped = clampStripPosition({
        x: layout.x,
        y: layout.y,
        panelWidth: stripRect.width,
        panelHeight: stripRect.height,
        containerWidth: parentRect.width,
        containerHeight: parentRect.height,
      });
      if (clamped.x !== layout.x || clamped.y !== layout.y) {
        setLayout((prev) => saveVideoStripLayout({ ...prev, ...clamped }));
      }
    };
    reClamp();
    window.addEventListener('resize', reClamp);
    return () => window.removeEventListener('resize', reClamp);
  }, [layout.x, layout.y, layout.tileWidth, layout.layoutMode, collapsed, popout, peers, roster]);

  if (!inCall) {
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
        streamRevision: peer?.streamRevision ?? 0,
        showVideo: hasVideo,
        muted,
        deafened,
        speaking: Boolean(peer?.speaking && !muted),
      };
    }),
  ];

  const anySpeaking = tiles.some((t) => t.speaking);

  function handleOpenPopout() {
    setPopoutError('');
    if (popout?.win && !popout.win.closed) {
      if (window.hakton?.popout?.focus) {
        void window.hakton.popout.focus();
      } else {
        popout.win.focus?.();
      }
      return;
    }

    const childWin = window.open(
      'about:blank',
      'hakton-video-popout',
      'width=580,height=390,resizable=yes',
    );
    if (!childWin) {
      setPopoutError('Pop-out window was blocked.');
      return;
    }

    try {
      const targetDoc = childWin.document;
      targetDoc.title = 'Hakton — Voice & Video Call';
      copyStylesToPopout(targetDoc);
      targetDoc.documentElement.className = 'hakton-popout-html';
      targetDoc.body.className = 'hakton-app hakton-popout-body';
      targetDoc.body.innerHTML = '';

      const container = targetDoc.createElement('div');
      container.id = 'hakton-popout-root';
      container.className = 'hakton-popout-root';
      targetDoc.body.appendChild(container);

      let cleaned = false;
      const onChildClosed = () => {
        if (cleaned) return;
        cleaned = true;
        if (popoutRef.current?.win === childWin) {
          popoutRef.current = null;
          setPopout(null);
          setAlwaysOnTop(false);
          voiceStore.getState().setPopoutOpen(false);
        }
      };
      childWin.addEventListener('beforeunload', onChildClosed);
      childWin.addEventListener('unload', onChildClosed);

      setCollapsed(false);
      voiceStore.getState().setPopoutOpen(true);
      setPopout({ win: childWin, container });
    } catch {
      try {
        childWin.close();
      } catch {
        // Ignore close error
      }
      setPopoutError('Could not initialize pop-out window.');
    }
  }

  async function handleToggleAlwaysOnTop() {
    const next = !alwaysOnTop;
    const res = await window.hakton?.popout?.setAlwaysOnTop?.(next);
    if (res?.ok) {
      setAlwaysOnTop(Boolean(res.alwaysOnTop));
    }
  }

  function handleCycleLayout() {
    setLayout((prev) => saveVideoStripLayout({ ...prev, layoutMode: nextLayoutMode(prev.layoutMode) }));
  }

  function handleStepTileSize(delta) {
    setLayout((prev) =>
      saveVideoStripLayout({ ...prev, tileWidth: clampTileWidth(prev.tileWidth + delta) }),
    );
  }

  function handleResetPosition() {
    setLayout((prev) => saveVideoStripLayout({ ...prev, x: null, y: null }));
  }

  function handleHeaderMouseDown(event) {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('button')) return;
    const stripEl = stripRef.current;
    const parentEl = stripEl?.offsetParent;
    if (!stripEl || !parentEl) return;

    event.preventDefault();
    event.stopPropagation();

    const stripRect = stripEl.getBoundingClientRect();
    const parentRect = parentEl.getBoundingClientRect();
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const originX = stripRect.left - parentRect.left;
    const originY = stripRect.top - parentRect.top;
    let moved = false;
    let latest = { x: originX, y: originY };

    setDragging(true);

    const onMouseMove = (moveEvent) => {
      const dx = moveEvent.clientX - startClientX;
      const dy = moveEvent.clientY - startClientY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      latest = clampStripPosition({
        x: originX + dx,
        y: originY + dy,
        panelWidth: stripRect.width,
        panelHeight: stripRect.height,
        containerWidth: parentRect.width,
        containerHeight: parentRect.height,
      });
      setLayout((prev) => ({ ...prev, ...latest }));
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      setDragging(false);
      if (moved) {
        setLayout((prev) => saveVideoStripLayout({ ...prev, ...latest }));
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  function handleResizeMouseDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const startWidth = layout.tileWidth;
    const resizeFromTopLeft = layout.x === null || layout.y === null;
    let latestWidth = startWidth;

    const onMouseMove = (moveEvent) => {
      const dx = moveEvent.clientX - startClientX;
      const dy = moveEvent.clientY - startClientY;
      const delta = resizeFromTopLeft
        ? Math.round((-dx - dy * 0.65) * 0.75)
        : Math.round((dx + dy * 0.65) * 0.75);
      latestWidth = clampTileWidth(startWidth + delta);
      setLayout((prev) => ({ ...prev, tileWidth: latestWidth }));
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      setLayout((prev) => saveVideoStripLayout({ ...prev, tileWidth: latestWidth }));
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  const popoutPortal = popout?.container
    ? createPortal(
        <PopoutCallView
          tiles={tiles}
          anySpeaking={anySpeaking}
          alwaysOnTop={alwaysOnTop}
          canPinOnTop={Boolean(window.hakton?.popout?.setAlwaysOnTop)}
          onToggleAlwaysOnTop={() => void handleToggleAlwaysOnTop()}
          onDockBack={closePopout}
        />,
        popout.container,
      )
    : null;

  if (popout) {
    return (
      <>
        {popoutPortal}
        <div
          className="video-call-strip is-collapsed"
          role="region"
          aria-label="Popped out video call"
        >
          <div className="video-popout-docked-pill">
            <button
              type="button"
              className="video-popout-focus-btn"
              onClick={() => {
                if (window.hakton?.popout?.focus) {
                  void window.hakton.popout.focus();
                } else {
                  popout.win?.focus?.();
                }
              }}
              title="Focus popped-out call window"
            >
              <span
                className={`video-speaking-dot ${anySpeaking ? 'is-active' : ''}`}
                aria-hidden="true"
              />
              <span>Popped out · {tiles.length}</span>
            </button>
            <IconButton
              label="Dock call display back into tabletop"
              title="Dock back into tabletop"
              onClick={closePopout}
            >
              <ToolIcon name="popin" />
            </IconButton>
          </div>
        </div>
      </>
    );
  }

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

  const isPositioned = layout.x !== null && layout.y !== null;
  const tileHeight = tileHeightForWidth(layout.tileWidth);
  const stripStyle = {
    '--video-tile-w': `${layout.tileWidth}px`,
    '--video-tile-h': `${tileHeight}px`,
    ...(isPositioned ? { left: `${layout.x}px`, top: `${layout.y}px` } : {}),
  };

  return (
    <section
      ref={stripRef}
      className={`video-call-strip is-layout-${layout.layoutMode} ${isPositioned ? 'is-positioned' : ''} ${dragging ? 'is-dragging' : ''}`}
      style={stripStyle}
      aria-label="Video call participants"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className={`video-strip-resize-handle ${isPositioned ? 'is-bottom-right' : 'is-top-left'}`}
        title="Drag to resize participant tiles"
        aria-hidden="true"
        onMouseDown={handleResizeMouseDown}
      />

      <header
        className="video-strip-header"
        title={isPositioned ? 'Drag to move · Double-click to snap back bottom-right' : 'Drag header to reposition'}
        onMouseDown={handleHeaderMouseDown}
        onDoubleClick={(e) => {
          if (e.target instanceof Element && e.target.closest('button')) return;
          handleResetPosition();
        }}
      >
        <div className="video-strip-title">
          <span
            className={`video-speaking-dot ${anySpeaking ? 'is-active' : ''}`}
            aria-hidden="true"
          />
          <span>Call · {tiles.length}</span>
        </div>

        <div className="video-strip-actions">
          <button
            type="button"
            className="video-strip-step-btn"
            disabled={layout.tileWidth <= MIN_TILE_WIDTH}
            aria-label="Shrink camera tiles"
            title="Shrink camera tiles"
            onClick={() => handleStepTileSize(-TILE_WIDTH_STEP)}
          >
            −
          </button>
          <button
            type="button"
            className="video-strip-step-btn"
            disabled={layout.tileWidth >= MAX_TILE_WIDTH}
            aria-label="Enlarge camera tiles"
            title="Enlarge camera tiles"
            onClick={() => handleStepTileSize(TILE_WIDTH_STEP)}
          >
            +
          </button>
          <IconButton
            label={layoutLabelFor(layout.layoutMode)}
            title={layoutLabelFor(layout.layoutMode)}
            onClick={handleCycleLayout}
          >
            <ToolIcon name={layoutIconFor(layout.layoutMode)} />
          </IconButton>
          <IconButton
            label="Pop out call window"
            title={popoutError || 'Pop out call into its own window'}
            onClick={handleOpenPopout}
          >
            <ToolIcon name="popout" />
          </IconButton>
          <IconButton
            label="Collapse video call strip"
            title="Collapse video call strip"
            onClick={() => setCollapsed(true)}
          >
            <ToolIcon name="chevronDown" />
          </IconButton>
        </div>
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
