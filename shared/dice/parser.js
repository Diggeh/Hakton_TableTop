import {
  DICE_SIDES,
  DICE_VISIBILITY,
  MAX_DICE_PER_ROLL,
  MAX_DICE_PER_TERM,
  MAX_FORMULA_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_MODIFIER,
  MAX_PHYSICAL_DICE,
} from './constants.js';

const COMMAND_RE = /^\s*\/(roll|gmroll|gm|r)(?=\s|$)\s*/i;
const DIE_TERM_RE = /^(\d*)d(\d+|%)(?:(kh|kl|k)(\d*))?$/i;
const NUMBER_TERM_RE = /^\d+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/g;

/**
 * @typedef {{ mode: 'highest' | 'lowest', count: number }} KeepRule
 * @typedef {{ sign: 1 | -1, count: number, sides: number, keep: KeepRule | null }} DieTerm
 * @typedef {{
 *   rawFormula: string,
 *   visibility: 'public' | 'dm',
 *   label: string | null,
 *   terms: DieTerm[],
 *   modifier: number,
 * }} ParsedRoll
 */

const fail = (error) => ({ ok: false, error });

/** Strips control characters, trims, and length-limits a user supplied roll label. */
export function sanitizeLabel(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(CONTROL_CHARS_RE, ' ').trim().slice(0, MAX_LABEL_LENGTH);
  return cleaned || null;
}

/** Physical meshes needed for a set of terms (a d100 is a tens + units d10 pair). */
export function physicalDiceCount(terms) {
  return terms.reduce((n, t) => n + t.count * (t.sides === 100 ? 2 : 1), 0);
}

/** Canonical formula text, e.g. `2d20kh1+5`. Used for storage and server re-validation. */
export function formatFormula(terms, modifier) {
  let out = '';
  terms.forEach((t, i) => {
    out += t.sign < 0 ? '-' : i === 0 ? '' : '+';
    out += `${t.count}d${t.sides}`;
    if (t.keep) out += `${t.keep.mode === 'highest' ? 'kh' : 'kl'}${t.keep.count}`;
  });
  if (modifier) out += modifier > 0 ? `+${modifier}` : `${modifier}`;
  return out;
}

/**
 * Parses a dice expression such as `/r 2d20kh1 + 5 # Longsword`.
 *
 * Supported: `NdS` (S in 4/6/8/10/12/20/100 or `%`), keep highest/lowest (`kh`, `kl`, `k`),
 * flat modifiers, `+`/`-` between terms, `# label` comments, and the `/r`, `/roll`
 * (public) and `/gmroll`, `/gm` (DM only) command prefixes.
 *
 * @param {unknown} input
 * @returns {{ ok: true, value: ParsedRoll } | { ok: false, error: string }}
 */
export function parseDiceFormula(input) {
  if (typeof input !== 'string') return fail('Enter a dice formula, e.g. 2d20kh1+5.');
  if (input.length > MAX_FORMULA_LENGTH + MAX_LABEL_LENGTH + 16) {
    return fail('That formula is too long.');
  }

  let text = input;
  let visibility = DICE_VISIBILITY.PUBLIC;
  const command = COMMAND_RE.exec(text);
  if (command) {
    if (/^(gmroll|gm)$/i.test(command[1])) visibility = DICE_VISIBILITY.DM;
    text = text.slice(command[0].length);
  }

  const hashAt = text.indexOf('#');
  const label = hashAt >= 0 ? sanitizeLabel(text.slice(hashAt + 1)) : null;
  const expression = (hashAt >= 0 ? text.slice(0, hashAt) : text).replace(/\s+/g, '');

  if (!expression) return fail('Enter a dice formula, e.g. 2d20kh1+5.');
  if (expression.length > MAX_FORMULA_LENGTH) return fail('That formula is too long.');

  const tokens = [...expression.matchAll(/([+-]?)([^+-]+)/g)];
  if (tokens.reduce((n, m) => n + m[0].length, 0) !== expression.length) {
    return fail('Check the + and - operators in your formula.');
  }

  /** @type {DieTerm[]} */
  const terms = [];
  let modifier = 0;

  for (const [, signChar, body] of tokens) {
    const sign = signChar === '-' ? -1 : 1;
    const die = DIE_TERM_RE.exec(body);
    if (die) {
      const count = die[1] === '' ? 1 : Number(die[1]);
      const sides = die[2] === '%' ? 100 : Number(die[2]);
      if (count < 1 || count > MAX_DICE_PER_TERM) {
        return fail(`Roll between 1 and ${MAX_DICE_PER_TERM} dice per term.`);
      }
      if (!DICE_SIDES.includes(sides)) {
        return fail(`d${sides} is not supported. Use d${DICE_SIDES.join(', d')}.`);
      }
      let keep = null;
      if (die[3]) {
        const keepCount = die[4] === '' ? 1 : Number(die[4]);
        if (keepCount < 1 || keepCount > count) {
          return fail(`Keep count must be between 1 and ${count} for ${count}d${sides}.`);
        }
        keep = { mode: die[3].toLowerCase() === 'kl' ? 'lowest' : 'highest', count: keepCount };
      }
      terms.push({ sign, count, sides, keep });
    } else if (NUMBER_TERM_RE.test(body)) {
      modifier += sign * Number(body);
      if (Math.abs(modifier) > MAX_MODIFIER) return fail(`Modifiers are limited to ±${MAX_MODIFIER}.`);
    } else {
      return fail(`Unrecognised term "${body}".`);
    }
  }

  if (terms.length === 0) return fail('Add at least one die, e.g. 1d20.');
  if (terms.reduce((n, t) => n + t.count, 0) > MAX_DICE_PER_ROLL) {
    return fail(`Roll at most ${MAX_DICE_PER_ROLL} dice at once.`);
  }
  if (physicalDiceCount(terms) > MAX_PHYSICAL_DICE) {
    return fail(`That roll needs more than ${MAX_PHYSICAL_DICE} physical dice.`);
  }

  return {
    ok: true,
    value: { rawFormula: formatFormula(terms, modifier), visibility, label, terms, modifier },
  };
}

/** True when the text starts with a roll command (`/r`, `/roll`, `/gmroll`, `/gm`). */
export function isRollCommand(text) {
  return typeof text === 'string' && COMMAND_RE.test(text);
}

/**
 * Builds a canonical formula string from the DiceTray's controls.
 * Supports either a multi-die pool (`diceCounts: { 4: n, 6: n, ... }`) or a single
 * `{ die, count, modifier, rollMode }` descriptor.
 */
export function buildTrayFormula({ diceCounts, die = 20, count = 1, modifier = 0, rollMode = 'Normal' } = {}) {
  const entries = diceCounts
    ? [4, 6, 8, 10, 20, 12, 100]
        .map((sides) => [sides, Number(diceCounts[sides]) || 0])
        .filter(([, c]) => c > 0)
    : count > 0
      ? [[die, count]]
      : [];

  if (entries.length === 0) return '';

  const termParts = entries.map(([sides, rawCount], idx) => {
    let effectiveCount = rawCount;
    let keepSuffix = '';
    // Apply Advantage/Disadvantage to the d20 term if present, otherwise to the first selected die term
    const hasD20 = entries.some(([s]) => s === 20);
    const applyKeep = hasD20 ? sides === 20 : idx === 0;
    if (applyKeep && rollMode === 'Advantage') {
      effectiveCount = Math.max(2, rawCount);
      keepSuffix = 'kh1';
    } else if (applyKeep && rollMode === 'Disadvantage') {
      effectiveCount = Math.max(2, rawCount);
      keepSuffix = 'kl1';
    }
    return `${effectiveCount}d${sides}${keepSuffix}`;
  });

  const modPart = modifier ? `${modifier > 0 ? '+' : ''}${modifier}` : '';
  return `${termParts.join('+')}${modPart}`;
}

