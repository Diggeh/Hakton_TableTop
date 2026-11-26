import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  canViewTokenHp,
  sortInitiativeEntries,
  stripHiddenCombatFields,
} from '../../shared/combat.js';

describe('combat initiative & role-based HP visibility helpers', () => {
  it('sorts active combatants highest to lowest, breaking ties alphabetically and omitting unset entries', () => {
    const sorted = sortInitiativeEntries([
      { id: 'm1', label: 'Map', isMap: true, combat: { enabled: true, initiative: 99 } },
      { id: 't1', label: 'Zara', combat: { enabled: true, initiative: 14 } },
      { id: 't2', label: 'Aria', combat: { enabled: true, initiative: 14 } },
      { id: 't3', label: 'Grog', combat: { enabled: true, initiative: 21 } },
      { id: 't4', label: 'Lurker', combat: { enabled: true, initiative: null } },
      { id: 't5', label: 'Bystander', combat: { enabled: false, initiative: 30 } },
    ]);

    assert.deepEqual(
      sorted.map((t) => [t.label, t.combat.initiative]),
      [
        ['Grog', 21],
        ['Aria', 14],
        ['Zara', 14],
      ],
    );
  });

  it('enforces exclusive HP visibility between DM-owned/unassigned tokens and Player-owned tokens', () => {
    const participants = [
      { id: 'dm-1', role: 'dm', displayName: 'DM' },
      { id: 'p-1', role: 'player', displayName: 'Aria' },
    ];

    const dmToken = {
      id: 'tok-dm',
      ownerId: 'dm-1',
      ownerRole: 'dm',
      combat: { enabled: true, initiative: 15, hp: 40, maxHp: 50 },
    };
    const unassignedToken = {
      id: 'tok-free',
      ownerId: null,
      ownerRole: null,
      combat: { enabled: true, initiative: 12, hp: 20, maxHp: 20 },
    };
    const playerToken = {
      id: 'tok-p1',
      ownerId: 'p-1',
      ownerRole: 'player',
      combat: { enabled: true, initiative: 18, hp: 28, maxHp: 32 },
    };

    assert.equal(canViewTokenHp(dmToken, 'dm', participants), true);
    assert.equal(canViewTokenHp(dmToken, 'player', participants), false);

    assert.equal(canViewTokenHp(unassignedToken, 'dm', participants), true);
    assert.equal(canViewTokenHp(unassignedToken, 'player', participants), false);

    assert.equal(canViewTokenHp(playerToken, 'dm', participants), false);
    assert.equal(canViewTokenHp(playerToken, 'player', participants), true);

    const dmViewOfPlayer = stripHiddenCombatFields(playerToken, 'dm', participants);
    assert.equal(dmViewOfPlayer.combat.initiative, 18);
    assert.equal(dmViewOfPlayer.combat.hp, null);
    assert.equal(dmViewOfPlayer.combat.maxHp, null);
    assert.equal(dmViewOfPlayer.combat.hpHidden, true);

    const playerViewOfDm = stripHiddenCombatFields(dmToken, 'player', participants);
    assert.equal(playerViewOfDm.combat.initiative, 15);
    assert.equal(playerViewOfDm.combat.hp, null);
    assert.equal(playerViewOfDm.combat.hpHidden, true);
  });
});
