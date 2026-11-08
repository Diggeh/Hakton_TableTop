import {
  DICE_VISIBILITY,
  MAX_CLIENT_ROLL_ID_LENGTH,
} from './constants.js';
import { parseDiceFormula, sanitizeLabel } from './parser.js';
import { resolveDice } from './roller.js';

const ROLL_ID_RE = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_CLIENT_ROLL_ID_LENGTH}}$`);
const VISIBILITIES = new Set(Object.values(DICE_VISIBILITY));

const reject = (error) => ({ ok: false, error });

/**
 * Server-side gatekeeper for a `dice:roll` submission.
 *
 * The client pre-determines die values (the 3D simulation is client side), so the server
 * cannot recompute them, but it can guarantee the payload is structurally honest:
 * the formula must parse, the dice must match the formula, every value must be within
 * its die's range, and kept/dropped flags plus the total are *recomputed here* instead
 * of trusted. Visibility audience is decided by the router from the socket's role, never
 * from this payload.
 *
 * @param {unknown} payload
 * @returns {{ ok: true, roll: import('./roller.js').RollResult } | { ok: false, error: string }}
 */
export function validateRollSubmission(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return reject('Roll payload must be an object.');
  }
  const { clientRollId, formula, visibility = DICE_VISIBILITY.PUBLIC, label, dice, total } = payload;

  if (typeof clientRollId !== 'string' || !ROLL_ID_RE.test(clientRollId)) {
    return reject('Roll id is missing or invalid.');
  }
  if (typeof visibility !== 'string' || !VISIBILITIES.has(visibility)) {
    return reject('Roll visibility is invalid.');
  }
  if (typeof formula !== 'string') return reject('Roll formula must be a string.');

  const parsed = parseDiceFormula(formula);
  if (!parsed.ok) return reject(parsed.error);

  const expected = parsed.value.terms.flatMap((term) => Array(term.count).fill(term.sides));
  if (!Array.isArray(dice) || dice.length !== expected.length) {
    return reject('Dice results do not match the formula.');
  }

  const values = [];
  for (let i = 0; i < expected.length; i++) {
    const die = dice[i];
    if (typeof die !== 'object' || die === null) return reject('Dice results are malformed.');
    if (die.sides !== expected[i]) return reject('Dice results do not match the formula.');
    if (!Number.isInteger(die.value) || die.value < 1 || die.value > expected[i]) {
      return reject(`A d${expected[i]} cannot roll ${String(die.value)}.`);
    }
    values.push(die.value);
  }

  const resolved = resolveDice(parsed.value, values);
  if (total !== undefined && total !== resolved.total) {
    return reject('Roll total does not match the dice.');
  }

  return {
    ok: true,
    roll: {
      clientRollId,
      formula: parsed.value.rawFormula,
      visibility,
      label: sanitizeLabel(label),
      dice: resolved.dice,
      modifier: parsed.value.modifier,
      total: resolved.total,
    },
  };
}
