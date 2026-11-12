/**
 * Pure verdict + formatting for a voice-harness report. Imported by BOTH the browser page and the
 * Node CLI (no DOM / Node APIs allowed here).
 *
 * report = {
 *   peers: number, mic: 'synthetic' | 'device',
 *   joins: [{ name, success, code?, error? }],
 *   links: [{ listener, speaker, speakerFreq, connectionState, iceConnectionState, streamActive,
 *             audioTag, audioPlaying, bytesDelta, energyDelta, detectedHz, toneDb }],
 *   audioTagTotal: number,
 *   leave: { leaver, remaining: [{ name, connections, audioTagsForLeaver }] } | null,
 * }
 */

export const TONE_TOLERANCE_HZ = 25;

export function evaluate(report) {
  const failures = [];
  const expectLinks = report.peers * (report.peers - 1);

  for (const join of report.joins ?? []) {
    if (!join.success) failures.push(`${join.name} failed to join voice: ${join.code} ${join.error ?? ''}`);
  }
  if ((report.links ?? []).length !== expectLinks) {
    failures.push(`expected ${expectLinks} directed links, measured ${(report.links ?? []).length}`);
  }
  if (report.audioTagTotal !== expectLinks) {
    failures.push(`expected ${expectLinks} hidden <audio> tags, found ${report.audioTagTotal}`);
  }

  const links = (report.links ?? []).map((link) => {
    const checks = {
      connected: link.connectionState === 'connected' && link.streamActive === true,
      audioTag: link.audioTag === true && link.audioPlaying === true,
      bytesFlowing: (link.bytesDelta ?? 0) > 0,
      energy: link.energyDelta == null ? true : link.energyDelta > 0,
      tone:
        report.mic === 'synthetic'
          ? link.detectedHz != null && Math.abs(link.detectedHz - link.speakerFreq) <= TONE_TOLERANCE_HZ
          : true,
    };
    const ok = Object.values(checks).every(Boolean);
    if (!ok) {
      const bad = Object.entries(checks)
        .filter(([, v]) => !v)
        .map(([k]) => k)
        .join(', ');
      failures.push(`${link.speaker} -> ${link.listener}: failed [${bad}]`);
    }
    return { ...link, checks, ok };
  });

  if (report.leave) {
    for (const r of report.leave.remaining) {
      if (r.connections !== report.peers - 2 || r.audioTagsForLeaver !== 0) {
        failures.push(
          `${r.name} did not clean up after ${report.leave.leaver} left ` +
            `(connections=${r.connections}, leaver <audio> tags=${r.audioTagsForLeaver})`,
        );
      }
    }
  }

  return { ok: failures.length === 0, failures, links };
}

const pad = (text, width) => String(text).padEnd(width, ' ');

/** Human-readable matrix: rows = listener, columns = speaker. */
export function formatMatrix(report, evaluation) {
  const names = Array.from({ length: report.peers }, (_, i) => `Harness-${i + 1}`);
  const width = 26;
  const lines = [];
  lines.push(pad('listener \\ speaker', 20) + names.map((n) => pad(n, width)).join(''));
  for (const listener of names) {
    let row = pad(listener, 20);
    for (const speaker of names) {
      if (speaker === listener) {
        row += pad('-', width);
        continue;
      }
      const link = evaluation.links.find((l) => l.listener === listener && l.speaker === speaker);
      if (!link) {
        row += pad('MISSING', width);
        continue;
      }
      const hz = link.detectedHz == null ? '?' : `${Math.round(link.detectedHz)}Hz`;
      const kb = ((link.bytesDelta ?? 0) / 1024).toFixed(1);
      row += pad(`${link.ok ? 'OK ' : 'BAD'} ${hz} +${kb}KB`, width);
    }
    lines.push(row);
  }
  return lines.join('\n');
}
