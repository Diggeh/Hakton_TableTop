import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRollCommand, parseDiceFormula, physicalDiceCount } from '../../shared/dice/parser.js';
import { evaluateRoll, resolveDice, rollFormula, secureRandomInt } from '../../shared/dice/roller.js';
import { validateRollSubmission } from '../../shared/dice/validate.js';

const parse = (text) => {
  const result = parseDiceFormula(text);
  assert.ok(result.ok, result.error);
  return result.value;
};

describe('dice formula parser', () => {
  it('parses a basic roll with modifier', () => {
    const p = parse('1d20+5');
    assert.deepEqual(p.terms, [{ sign: 1, count: 1, sides: 20, keep: null }]);
    assert.equal(p.modifier, 5);
    assert.equal(p.rawFormula, '1d20+5');
    assert.equal(p.visibility, 'public');
  });

  it('defaults the count to one and tolerates whitespace and case', () => {
    assert.equal(parse('  D8 +  d6 - 2 ').rawFormula, '1d8+1d6-2');
  });

  it('parses keep highest/lowest for advantage, disadvantage and ability scores', () => {
    assert.deepEqual(parse('2d20kh1').terms[0].keep, { mode: 'highest', count: 1 });
    assert.deepEqual(parse('2d20kl').terms[0].keep, { mode: 'lowest', count: 1 });
    assert.deepEqual(parse('4d6k3').terms[0].keep, { mode: 'highest', count: 3 });
    assert.equal(parse('4d6kh3').rawFormula, '4d6kh3');
  });

  it('supports subtracting dice, percentile shorthand and multiple terms', () => {
    const p = parse('2d8-1d4+d%');
    assert.deepEqual(
      p.terms.map((t) => [t.sign, t.count, t.sides]),
      [[1, 2, 8], [-1, 1, 4], [1, 1, 100]],
    );
  });

  it('handles command prefixes and visibility', () => {
    assert.equal(parse('/r 1d20').visibility, 'public');
    assert.equal(parse('/roll 1d20').visibility, 'public');
    assert.equal(parse('/gmroll 1d20').visibility, 'dm');
    assert.equal(parse('/gm 1d20').visibility, 'dm');
    assert.equal(parse('/R 2d6').rawFormula, '2d6');
  });

  it('extracts and sanitises a label comment', () => {
    const p = parse('/r 1d20+7 # Longsword attack\u0007');
    assert.equal(p.label, 'Longsword attack');
    assert.equal(p.rawFormula, '1d20+7');
    assert.equal(parse('1d20 #').label, null);
  });

  it('detects roll commands', () => {
    assert.ok(isRollCommand('/r 1d20'));
    assert.ok(isRollCommand('/gmroll 1d20'));
    assert.ok(!isRollCommand('/rest for the night'));
    assert.ok(!isRollCommand('I roll a 1d20'));
  });

  it('counts a d100 as two physical dice', () => {
    assert.equal(physicalDiceCount(parse('2d100+1d20').terms), 5);
  });

  for (const [input, fragment] of [
    ['', 'Enter a dice formula'],
    ['/r', 'Enter a dice formula'],
    ['5', 'at least one die'],
    ['1d7', 'not supported'],
    ['0d20', 'between 1 and'],
    ['21d6', 'between 1 and'],
    ['2d20kh3', 'Keep count'],
    ['2d20kh0', 'Keep count'],
    ['1d20++5', 'operators'],
    ['1d20+', 'operators'],
    ['1d20+abc', 'Unrecognised'],
    ['1d20+1000', 'Modifiers are limited'],
    ['20d6+20d6', 'at most'],
    [null, 'Enter a dice formula'],
  ]) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      const result = parseDiceFormula(input);
      assert.equal(result.ok, false);
      assert.match(result.error, new RegExp(fragment, 'i'));
    });
  }
});

describe('dice roller', () => {
  const sequence = (...values) => {
    let i = 0;
    return () => values[i++];
  };

  it('keeps the highest die for advantage and drops the other', () => {
    const roll = evaluateRoll(parse('2d20kh1+5'), { random: sequence(7, 18), id: 'r1' });
    assert.deepEqual(roll.dice.map((d) => [d.value, d.kept]), [[7, false], [18, true]]);
    assert.equal(roll.total, 23);
    assert.equal(roll.clientRollId, 'r1');
  });

  it('keeps the lowest die for disadvantage', () => {
    const roll = evaluateRoll(parse('2d20kl1'), { random: sequence(7, 18) });
    assert.equal(roll.total, 7);
    assert.deepEqual(roll.dice.map((d) => d.kept), [true, false]);
  });

  it('drops the lowest die of 4d6kh3 and breaks ties toward keeping the earlier die', () => {
    const roll = evaluateRoll(parse('4d6kh3'), { random: sequence(2, 5, 2, 6) });
    assert.equal(roll.total, 13);
    assert.deepEqual(roll.dice.map((d) => d.kept), [true, true, false, true]);
  });

  it('subtracts negative dice terms and applies the modifier once', () => {
    const roll = evaluateRoll(parse('1d8-1d4+3'), { random: sequence(6, 2) });
    assert.equal(roll.total, 6 - 2 + 3);
    assert.deepEqual(roll.dice.map((d) => d.sign), [1, -1]);
  });

  it('resolveDice recomputes totals from raw values', () => {
    assert.equal(resolveDice(parse('2d6+1'), [3, 4]).total, 8);
  });

  it('rollFormula reports parse errors and rolls valid formulas within range', () => {
    assert.equal(rollFormula('nonsense').ok, false);
    for (let i = 0; i < 200; i++) {
      const result = rollFormula('3d6+2');
      assert.ok(result.ok);
      assert.ok(result.roll.total >= 5 && result.roll.total <= 20);
    }
  });

  it('secureRandomInt covers the full range roughly uniformly', () => {
    for (const sides of [4, 6, 8, 10, 12, 20, 100]) {
      const counts = new Map();
      const n = sides * 400;
      for (let i = 0; i < n; i++) {
        const v = secureRandomInt(sides);
        assert.ok(Number.isInteger(v) && v >= 1 && v <= sides);
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      assert.equal(counts.size, sides, `d${sides} never produced some faces`);
      for (const c of counts.values()) {
        assert.ok(c > 400 * 0.5 && c < 400 * 1.6, `d${sides} bucket count ${c} looks biased`);
      }
    }
  });
});

describe('roll submission validation (server side)', () => {
  const honest = () => {
    const roll = evaluateRoll(parse('2d20kh1+5'), { random: () => 9, id: 'abc-123' });
    return { ...roll, dice: roll.dice.map((d) => ({ ...d })) };
  };

  it('accepts an honest roll and echoes a normalised copy', () => {
    const result = validateRollSubmission(honest());
    assert.ok(result.ok, result.error);
    assert.equal(result.roll.total, 14);
    assert.equal(result.roll.formula, '2d20kh1+5');
    assert.equal(result.roll.clientRollId, 'abc-123');
  });

  it('recomputes kept flags and total instead of trusting the client', () => {
    const payload = honest();
    payload.dice[0].value = 3;
    payload.dice[1].value = 17;
    payload.dice[0].kept = true; // a lie
    delete payload.total;
    const result = validateRollSubmission(payload);
    assert.ok(result.ok);
    assert.deepEqual(result.roll.dice.map((d) => d.kept), [false, true]);
    assert.equal(result.roll.total, 22);
  });

  const mutations = {
    'a wrong total': (p) => ({ ...p, total: 99 }),
    'an out-of-range die': (p) => ({ ...p, dice: [{ ...p.dice[0], value: 21 }, p.dice[1]] }),
    'a zero die': (p) => ({ ...p, dice: [{ ...p.dice[0], value: 0 }, p.dice[1]] }),
    'a fractional die': (p) => ({ ...p, dice: [{ ...p.dice[0], value: 1.5 }, p.dice[1]] }),
    'a missing die': (p) => ({ ...p, dice: [p.dice[0]] }),
    'an extra die': (p) => ({ ...p, dice: [...p.dice, p.dice[0]] }),
    'mismatched sides': (p) => ({ ...p, dice: [{ ...p.dice[0], sides: 12 }, p.dice[1]] }),
    'a bad formula': (p) => ({ ...p, formula: '2d7' }),
    'a bad visibility': (p) => ({ ...p, visibility: 'everyone' }),
    'a bad roll id': (p) => ({ ...p, clientRollId: 'no spaces allowed!' }),
    'a missing roll id': (p) => ({ ...p, clientRollId: undefined }),
    'a non-array dice list': (p) => ({ ...p, dice: 'nope' }),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    it(`rejects ${name}`, () => {
      const result = validateRollSubmission(mutate(honest()));
      assert.equal(result.ok, false);
    });
  }

  it('rejects non-object payloads', () => {
    for (const bad of [null, undefined, 5, 'roll', []]) {
      assert.equal(validateRollSubmission(bad).ok, false);
    }
  });

  it('sanitises labels and defaults visibility to public', () => {
    const payload = honest();
    delete payload.visibility;
    payload.label = `  Stealth\u0000 check  `;
    const result = validateRollSubmission(payload);
    assert.ok(result.ok);
    assert.equal(result.roll.visibility, 'public');
    assert.equal(result.roll.label, 'Stealth  check');
  });
});
