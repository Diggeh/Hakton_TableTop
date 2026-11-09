import { EventEmitter } from 'node:events';

/**
 * In-process stand-ins for the browser-only pieces of the voice mesh (PeerJS/WebRTC, getUserMedia,
 * the DOM). The Socket.io + host signaling under test is REAL; only the media plane is simulated,
 * because Node has no RTCPeerConnection. The real media plane is exercised by `npm run voice:harness`.
 */

export class FakeTrack {
  constructor(label) {
    this.kind = 'audio';
    this.label = label;
    this.readyState = 'live';
  }

  stop() {
    this.readyState = 'ended';
  }
}

export class FakeStream {
  constructor(label) {
    this.id = `stream-${label}`;
    this.label = label;
    this.tracks = [new FakeTrack(label)];
  }

  getTracks() {
    return this.tracks;
  }

  getAudioTracks() {
    return this.tracks;
  }

  get active() {
    return this.tracks.some((t) => t.readyState === 'live');
  }
}

/** Minimal RTCPeerConnection: state fields + EventTarget. */
export class FakePeerConnection extends EventTarget {
  constructor() {
    super();
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
  }

  setStates(connectionState, iceConnectionState) {
    this.connectionState = connectionState;
    this.iceConnectionState = iceConnectionState;
    this.dispatchEvent(new Event('iceconnectionstatechange'));
    this.dispatchEvent(new Event('connectionstatechange'));
  }

  async getStats() {
    // Mimics RTCStatsReport.forEach for the fields getStats() reads.
    const stats = [
      { type: 'inbound-rtp', kind: 'audio', bytesReceived: 4242, packetsReceived: 21 },
      { type: 'outbound-rtp', kind: 'audio', bytesSent: 4242, packetsSent: 21 },
    ];
    return { forEach: (fn) => stats.forEach(fn) };
  }
}

class FakeMediaConnection extends EventEmitter {
  constructor(network, ownerPeer, remoteId, localStream, metadata) {
    super();
    this.network = network;
    this.ownerPeer = ownerPeer;
    this.peer = remoteId;
    this.localStream = localStream;
    this.metadata = metadata;
    this.peerConnection = new FakePeerConnection();
    this.open = false;
    this.twin = null;
  }

  answer(stream) {
    this.localStream = stream;
    this.network.establish(this, this.twin);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.peerConnection.setStates('closed', 'closed');
    this.emit('close');
    // Real WebRTC tears down both ends; the remote learns asynchronously.
    const twin = this.twin;
    if (twin && !twin.closed) setImmediate(() => twin.close());
  }
}

class FakePeer extends EventEmitter {
  constructor(network, id) {
    super();
    this.network = network;
    this.id = id;
    this.open = false;
    this.destroyed = false;
    this.disconnected = false;
  }

  call(remoteId, stream, options = {}) {
    return this.network.dial(this, remoteId, stream, options.metadata);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.open = false;
    this.network.peers.delete(this.id);
    for (const conn of [...this.network.connectionsOf(this)]) conn.close();
    this.emit('close');
  }
}

export class FakePeerNetwork {
  constructor() {
    this.peers = new Map();
    this.sequence = 0;
    /** Every `peer.call()` ever made, in order: `{ from, to }`. */
    this.calls = [];
    this.allConnections = [];
    /** `createPeer(options, requestedId)` factory to hand to VoiceMeshManager. */
    this.createPeer = async (options, requestedId) => {
      const id = requestedId ?? `fake-peer-${++this.sequence}`;
      const peer = new FakePeer(this, id);
      this.peers.set(id, peer);
      peer.options = options;
      setImmediate(() => {
        if (peer.destroyed) return;
        peer.open = true;
        peer.emit('open', id);
      });
      return peer;
    };
  }

  connectionsOf(peer) {
    return this.allConnections.filter((c) => c.ownerPeer === peer && !c.closed);
  }

  dial(callerPeer, remoteId, stream, metadata) {
    this.calls.push({ from: callerPeer.id, to: remoteId });
    const outgoing = new FakeMediaConnection(this, callerPeer, remoteId, stream, metadata);
    this.allConnections.push(outgoing);
    const callee = this.peers.get(remoteId);
    if (!callee || callee.destroyed || !callee.open) {
      setImmediate(() =>
        callerPeer.emit('error', { type: 'peer-unavailable', message: `Could not connect to peer ${remoteId}` }),
      );
      return outgoing;
    }
    const incoming = new FakeMediaConnection(this, callee, callerPeer.id, null, metadata);
    this.allConnections.push(incoming);
    outgoing.twin = incoming;
    incoming.twin = outgoing;
    setImmediate(() => callee.emit('call', incoming));
    return outgoing;
  }

  /** Called when the callee answers: both sides go "connected" and receive the other's stream. */
  establish(incoming, outgoing) {
    if (!outgoing || outgoing.closed || incoming.closed) return;
    setImmediate(() => {
      for (const conn of [incoming, outgoing]) {
        conn.open = true;
        conn.peerConnection.setStates('connecting', 'checking');
      }
      for (const conn of [incoming, outgoing]) {
        conn.peerConnection.setStates('connected', 'connected');
      }
      // Each side hears the stream the OTHER side passed to call()/answer().
      incoming.emit('stream', outgoing.localStream);
      outgoing.emit('stream', incoming.localStream);
    });
  }
}

// ---------------------------------------------------------------------------- fake DOM

export class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.attrs = {};
    this.style = {};
    this.children = [];
    this.parent = null;
    this.id = '';
    this.srcObject = null;
    this.autoplay = false;
    this.paused = true;
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }

  getAttribute(name) {
    return this.attrs[name] ?? null;
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  play() {
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }

  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
}

export class FakeDocument {
  constructor() {
    this.body = new FakeElement('body');
  }

  createElement(tag) {
    return new FakeElement(tag);
  }

  getElementById(id) {
    for (const el of this.body.walk()) if (el.id === id) return el;
    return null;
  }

  /** Test helper: every `<audio>` currently attached, as `{ peerId, el }`. */
  audioElements() {
    return [...this.body.walk()]
      .filter((el) => el.tagName === 'AUDIO')
      .map((el) => ({ peerId: el.getAttribute('data-voice-peer-id'), el }));
  }
}
