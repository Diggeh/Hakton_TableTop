import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseTimestampMs, mergeChatTimeline } from '../../src/ui/chatTimeline.js';

describe('chat timeline ordering', () => {
  it('parses both SQLite UTC timestamps and ISO UTC strings consistently', () => {
    const sqliteTs = parseTimestampMs('2026-11-26 11:49:00');
    const isoTs = parseTimestampMs('2026-11-26T11:50:00.000Z');
    assert.ok(Number.isFinite(sqliteTs));
    assert.ok(Number.isFinite(isoTs));
    assert.ok(isoTs > sqliteTs);
  });

  it('orders text chat sent after a dice roll below the dice roll in chronological sequence', () => {
    const roll = {
      id: 'roll-1',
      formula: '1d12',
      total: 1,
      senderName: 'Diggie',
      createdAt: '2026-11-26T15:49:10.000Z',
    };
    const msg = {
      id: 42,
      senderName: 'Diggie',
      body: 'tes',
      createdAt: '2026-11-26 15:50:05',
    };

    const timeline = mergeChatTimeline([msg], [roll]);
    assert.equal(timeline.length, 2);
    assert.equal(timeline[0].kind, 'roll');
    assert.equal(timeline[1].kind, 'message');
    assert.equal(timeline[1].item.body, 'tes');
  });

  it('orders a dice roll sent after a chat message after that message', () => {
    const msg = {
      id: 1,
      senderName: 'Diggie',
      body: 'Rolling now',
      createdAt: '2026-11-26T15:48:00.000Z',
    };
    const roll = {
      id: 'roll-2',
      formula: '1d20',
      total: 17,
      senderName: 'Diggie',
      createdAt: '2026-11-26T15:48:30.000Z',
    };

    const timeline = mergeChatTimeline([msg], [roll]);
    assert.equal(timeline[0].kind, 'message');
    assert.equal(timeline[1].kind, 'roll');
  });
});
