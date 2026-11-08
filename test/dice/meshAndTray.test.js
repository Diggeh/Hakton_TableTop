import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDieMesh,
  expandPhysicalDice,
  getDieGeometry,
  getDieMaterial,
} from '../../src/dice/geometry/DiceMeshFactory.js';
import { computeFrustumBounds } from '../../src/dice/DiceScene.js';
import { buildTrayFormula } from '../../shared/dice/parser.js';
import { normalizeRollEntry } from '../../src/store/sessionStore.js';

describe('DiceMeshFactory & Frustum Bounds', () => {
  it('expands standard dice 1-to-1 and d100 into a tens (d100) + units (d10) pair', () => {
    const physical = expandPhysicalDice([
      { termIndex: 0, sides: 20, sign: 1, value: 18, kept: true },
      { termIndex: 1, sides: 100, sign: 1, value: 74, kept: true },
      { termIndex: 1, sides: 100, sign: 1, value: 100, kept: false },
    ]);

    assert.equal(physical.length, 5);
    assert.deepEqual(
      physical.map((p) => [p.kind, p.variant, p.targetValue, p.displayValue, p.kept]),
      [
        ['d20', 'd20', 18, '18', true],
        ['d10', 'd100', 7, '70', true],
        ['d10', 'd10', 4, '4', true],
        ['d10', 'd100', 10, '00', false],
        ['d10', 'd10', 10, '0', false],
      ],
    );
  });

  it('caches Three.js BufferGeometries and Materials across calls', () => {
    for (const kind of ['d4', 'd6', 'd8', 'd10', 'd12', 'd20']) {
      const g1 = getDieGeometry(kind);
      const g2 = getDieGeometry(kind);
      assert.equal(g1, g2, `${kind} geometry should be cached`);
      assert.ok(g1.attributes.position.count >= 12);
      assert.ok(g1.attributes.uv.count === g1.attributes.position.count);
    }

    const m1 = getDieMaterial('d20');
    const m2 = getDieMaterial('d20');
    assert.equal(m1, m2);

    const mesh = createDieMesh('d100');
    assert.equal(mesh.geometry, getDieGeometry('d10'));
  });

  it('computes positive camera frustum bounds for any viewport aspect ratio', () => {
    const wide = computeFrustumBounds(1280, 720);
    const square = computeFrustumBounds(800, 800);
    assert.ok(wide.halfWidth > wide.halfHeight);
    assert.ok(Math.abs(square.halfWidth - square.halfHeight) < 1e-6);
  });
});

describe('DiceTray formula builder & store normalization', () => {
  it('builds formulas for Normal, Advantage, and Disadvantage modes', () => {
    assert.equal(
      buildTrayFormula({ die: 20, count: 1, modifier: 5, rollMode: 'Normal' }),
      '1d20+5',
    );
    assert.equal(
      buildTrayFormula({ die: 20, count: 1, modifier: -2, rollMode: 'Advantage' }),
      '2d20kh1-2',
    );
    assert.equal(
      buildTrayFormula({ die: 20, count: 1, modifier: 0, rollMode: 'Disadvantage' }),
      '2d20kl1',
    );
    assert.equal(
      buildTrayFormula({ die: 6, count: 4, modifier: 0, rollMode: 'Advantage' }),
      '4d6kh1',
    );
    // Multi-click diceCounts pool from the remodeled Dice Tray
    assert.equal(
      buildTrayFormula({
        diceCounts: { 4: 0, 6: 3, 8: 0, 10: 0, 12: 0, 20: 1, 100: 1 },
        modifier: 4,
        rollMode: 'Advantage',
      }),
      '3d6+2d20kh1+1d100+4',
    );
    assert.equal(
      buildTrayFormula({
        diceCounts: { 4: 0, 6: 0, 8: 0, 10: 0, 12: 0, 20: 0, 100: 0 },
        modifier: 2,
        rollMode: 'Normal',
      }),
      '',
    );
  });

  it('normalizes both server chat_messages rows and local RollResults', () => {
    const fromServer = normalizeRollEntry({
      id: 'roll_abc',
      sender_id: 'p_1',
      sender_name: 'Mira',
      recipient_id: null,
      created_at: '2026-11-05T09:00:00.000Z',
      payload: {
        clientRollId: 'abc',
        formula: '1d20+4',
        visibility: 'public',
        label: 'Stealth',
        dice: [{ sides: 20, value: 15, kept: true }],
        modifier: 4,
        total: 19,
      },
    });
    assert.equal(fromServer.clientRollId, 'abc');
    assert.equal(fromServer.senderName, 'Mira');
    assert.equal(fromServer.total, 19);
    assert.equal(fromServer.label, 'Stealth');
  });
});
