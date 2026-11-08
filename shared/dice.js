/**
 * Pure dice contracts shared by the renderer and backend. No Node or DOM
 * imports: validation here is safe to run in either runtime.
 */

export const DICE_SIDES = Object.freeze([4, 6, 8, 10, 12, 20, 100]);
export const MAX_DICE_COUNT = 20;
export const MIN_DICE_MODIFIER = -99;
export const MAX_DICE_MODIFIER = 99;

export const ROLL_MODES = Object.freeze({
  NORMAL: 'normal',
  ADVANTAGE: 'advantage',
  DISADVANTAGE: 'disadvantage',
});

export const ROLL_VISIBILITY = Object.freeze({
  PUBLIC: 'public',
  DM: 'dm',
});

export const CHAT_TYPES = Object.freeze({
  TEXT: 'text',
  WHISPER: 'whisper',
  ROLL: 'roll',
});

function isInt(value) {
  return Number.isInteger(value);
}

/**
 * Validate a client roll request. Advantage/disadvantage is only meaningful
 * for a single d20, so other combinations are rejected instead of guessed.
 *
 * @param {{
 *   count?: number,
 *   sides?: number,
 *   modifier?: number,
 *   mode?: string,
 *   visibility?: string,
 * }} [input]
 * @returns {{ ok: true, value: Required<typeof input> } | { ok: false, error: string }}
 */
export function validateRollInput(input = {}) {
  const count = input.count ?? 1;
  const sides = input.sides;
  const modifier = input.modifier ?? 0;
  const mode = input.mode ?? ROLL_MODES.NORMAL;
  const visibility = input.visibility ?? ROLL_VISIBILITY.PUBLIC;

  if (!isInt(count) || count < 1 || count > MAX_DICE_COUNT) {
    return { ok: false, error: `count must be an integer between 1 and ${MAX_DICE_COUNT}.` };
  }
  if (!DICE_SIDES.includes(sides)) {
    return { ok: false, error: `sides must be one of ${DICE_SIDES.join(', ')}.` };
  }
  if (
    !isInt(modifier) ||
    modifier < MIN_DICE_MODIFIER ||
    modifier > MAX_DICE_MODIFIER
  ) {
    return { ok: false, error: 'modifier must be an integer between -99 and 99.' };
  }
  if (!Object.values(ROLL_MODES).includes(mode)) {
    return { ok: false, error: 'mode must be normal, advantage, or disadvantage.' };
  }
  if (mode !== ROLL_MODES.NORMAL && (count !== 1 || sides !== 20)) {
    return { ok: false, error: 'advantage and disadvantage require exactly 1d20.' };
  }
  if (!Object.values(ROLL_VISIBILITY).includes(visibility)) {
    return { ok: false, error: 'visibility must be public or dm.' };
  }

  return {
    ok: true,
    value: { count, sides, modifier, mode, visibility },
  };
}

/** Human-readable formula, e.g. `2d6+3` or `1d20 (advantage)`. */
export function formatFormula({ count, sides, modifier = 0, mode = ROLL_MODES.NORMAL }) {
  const base = `${count}d${sides}`;
  const mod = modifier === 0 ? '' : modifier > 0 ? `+${modifier}` : `${modifier}`;
  const suffix =
    mode === ROLL_MODES.ADVANTAGE
      ? ' (advantage)'
      : mode === ROLL_MODES.DISADVANTAGE
        ? ' (disadvantage)'
        : '';
  return `${base}${mod}${suffix}`;
}
