import { parseDiceFormula } from './parser.js';

/**
 * @typedef {{ termIndex: number, sides: number, sign: 1 | -1, value: number, kept: boolean }} DieResult
 * @typedef {{
 *   clientRollId: string,
 *   formula: string,
 *   visibility: 'public' | 'dm',
 *   label: string | null,
 *   dice: DieResult[],
 *   modifier: number,
 *   total: number,
 * }} RollResult
 */

/**
 * Uniform integer in [1, sides] from a CSPRNG. Rejection sampling removes modulo bias.
 * @param {number} sides
 */
export function secureRandomInt(sides) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) throw new Error('A secure random source is unavailable.');
  const limit = Math.floor(0x100000000 / sides) * sides;
  const buf = new Uint32Array(1);
  do {
    cryptoApi.getRandomValues(buf);
  } while (buf[0] >= limit);
  return (buf[0] % sides) + 1;
}

function newRollId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Builds the full result (kept/dropped flags + total) from raw die values.
 * This is the single source of truth shared by the roller and the server validator,
 * so a client can only influence the individual die values, never the arithmetic.
 *
 * @param {import('./parser.js').ParsedRoll} parsed
 * @param {number[]} values flat die values in term order
 * @returns {{ dice: DieResult[], total: number }}
 */
export function resolveDice(parsed, values) {
  /** @type {DieResult[]} */
  const dice = [];
  let cursor = 0;

  parsed.terms.forEach((term, termIndex) => {
    const group = [];
    for (let i = 0; i < term.count; i++) {
      group.push({ termIndex, sides: term.sides, sign: term.sign, value: values[cursor++], kept: true });
    }
    if (term.keep) {
      // Stable ordering: ties keep the earlier die, so the outcome is deterministic.
      const order = group
        .map((die, index) => ({ die, index }))
        .sort((a, b) =>
          term.keep.mode === 'highest'
            ? b.die.value - a.die.value || a.index - b.index
            : a.die.value - b.die.value || a.index - b.index,
        );
      order.forEach(({ die }, rank) => {
        die.kept = rank < term.keep.count;
      });
    }
    dice.push(...group);
  });

  const total = dice.reduce((sum, d) => (d.kept ? sum + d.sign * d.value : sum), parsed.modifier);
  return { dice, total };
}

/**
 * Pre-determines every die outcome for a parsed formula.
 * @param {import('./parser.js').ParsedRoll} parsed
 * @param {{ random?: (sides: number) => number, id?: string }} [opts]
 * @returns {RollResult}
 */
export function evaluateRoll(parsed, { random = secureRandomInt, id } = {}) {
  const values = [];
  for (const term of parsed.terms) {
    for (let i = 0; i < term.count; i++) values.push(random(term.sides));
  }
  const { dice, total } = resolveDice(parsed, values);
  return {
    clientRollId: id ?? newRollId(),
    formula: parsed.rawFormula,
    visibility: parsed.visibility,
    label: parsed.label,
    dice,
    modifier: parsed.modifier,
    total,
  };
}

/**
 * Parse + evaluate in one step.
 * @param {string} input
 * @param {Parameters<typeof evaluateRoll>[1]} [opts]
 * @returns {{ ok: true, roll: RollResult } | { ok: false, error: string }}
 */
export function rollFormula(input, opts) {
  const parsed = parseDiceFormula(input);
  if (!parsed.ok) return parsed;
  return { ok: true, roll: evaluateRoll(parsed.value, opts) };
}
