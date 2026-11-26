/**
 * Lightweight Web Audio speaking-activity detector.
 * Uses one shared AudioContext + per-stream AnalyserNode (never routed to destination)
 * and a single throttled poll loop with hold hysteresis so speaking rings don't flicker
 * or flood React with 60 fps updates.
 */

const DEFAULT_POLL_MS = 100;
const DEFAULT_THRESHOLD = 0.035;
const DEFAULT_HOLD_MS = 350;

function defaultAudioContextFactory() {
  try {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    return Ctx ? new Ctx() : null;
  } catch {
    return null;
  }
}

export class SpeakingDetector {
  /**
   * @param {{
   *   onSpeakingChange?: (key: string, speaking: boolean) => void,
   *   audioContextFactory?: () => AudioContext | null,
   *   pollIntervalMs?: number,
   *   threshold?: number,
   *   holdMs?: number,
   *   now?: () => number,
   * }} [opts]
   */
  constructor({
    onSpeakingChange,
    audioContextFactory = defaultAudioContextFactory,
    pollIntervalMs = DEFAULT_POLL_MS,
    threshold = DEFAULT_THRESHOLD,
    holdMs = DEFAULT_HOLD_MS,
    now = () => Date.now(),
  } = {}) {
    this.onSpeakingChange = onSpeakingChange;
    this.audioContextFactory = audioContextFactory;
    this.pollIntervalMs = pollIntervalMs;
    this.threshold = threshold;
    this.holdMs = holdMs;
    this.now = now;

    this.ctx = null;
    this.entries = new Map();
    this.timer = null;
  }

  #ensureContext() {
    if (this.ctx) return this.ctx;
    const ctx = this.audioContextFactory?.() ?? null;
    if (
      !ctx ||
      typeof ctx.createMediaStreamSource !== 'function' ||
      typeof ctx.createAnalyser !== 'function'
    ) {
      return null;
    }
    this.ctx = ctx;
    if (ctx.state === 'suspended') {
      ctx.resume?.().catch?.(() => {});
    }
    return ctx;
  }

  #startPolling() {
    if (this.timer || this.entries.size === 0) return;
    this.timer = setInterval(() => this.sample(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  #stopPollingIfEmpty() {
    if (this.entries.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Starts monitoring `stream` under `key` ('local' or peerId). */
  track(key, stream) {
    if (!key || !stream) return false;
    const audioTracks = stream.getAudioTracks?.() ?? [];
    if (audioTracks.length === 0) return false;

    const existing = this.entries.get(key);
    if (existing && existing.stream === stream) return true;
    if (existing) this.untrack(key);

    const ctx = this.#ensureContext();
    if (!ctx) return false;

    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);

      const data = new Uint8Array(analyser.fftSize || 256);
      this.entries.set(key, {
        stream,
        source,
        analyser,
        data,
        speaking: false,
        suppressed: false,
        lastLoudAt: 0,
      });
      this.#startPolling();
      return true;
    } catch {
      return false;
    }
  }

  /** Suppresses speaking detection (e.g. when local mic is muted or remote peers are deafened). */
  setSuppressed(key, suppressed) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.suppressed = Boolean(suppressed);
    if (entry.suppressed && entry.speaking) {
      entry.speaking = false;
      this.onSpeakingChange?.(key, false);
    }
  }

  /** Samples all tracked streams once (public so unit tests can drive it deterministically). */
  sample() {
    const currentNow = this.now();
    for (const [key, entry] of this.entries.entries()) {
      let nextSpeaking = false;
      if (!entry.suppressed) {
        try {
          entry.analyser.getByteTimeDomainData(entry.data);
          let sum = 0;
          const len = entry.data.length || 1;
          for (let i = 0; i < len; i += 1) {
            const norm = (entry.data[i] - 128) / 128;
            sum += norm * norm;
          }
          const rms = Math.sqrt(sum / len);
          if (rms >= this.threshold) {
            entry.lastLoudAt = currentNow;
            nextSpeaking = true;
          } else if (entry.speaking && currentNow - entry.lastLoudAt < this.holdMs) {
            nextSpeaking = true;
          }
        } catch {
          nextSpeaking = false;
        }
      }

      if (nextSpeaking !== entry.speaking) {
        entry.speaking = nextSpeaking;
        this.onSpeakingChange?.(key, nextSpeaking);
      }
    }
  }

  /** Stops monitoring `key` and disconnects its Web Audio nodes. */
  untrack(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    try {
      entry.source?.disconnect?.();
    } catch {
      // Ignore disconnect errors
    }
    try {
      entry.analyser?.disconnect?.();
    } catch {
      // Ignore disconnect errors
    }
    if (entry.speaking) {
      entry.speaking = false;
      this.onSpeakingChange?.(key, false);
    }
    this.#stopPollingIfEmpty();
  }

  /** Tears down all tracked streams, timer, and shared AudioContext. */
  destroy() {
    for (const key of [...this.entries.keys()]) {
      this.untrack(key);
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      try {
        ctx.close?.();
      } catch {
        // Ignore AudioContext close errors
      }
    }
  }
}
