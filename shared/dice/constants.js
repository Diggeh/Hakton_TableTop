/**
 * Dice wire/limit constants shared by the renderer (parser, 3D engine) and the
 * backend (roll validation). Pure constants only: no Node, Electron, or DOM imports.
 */

/** Polyhedral dice supported by the 3D engine. d100 is rendered as a tens/units d10 pair. */
export const DICE_SIDES = Object.freeze([4, 6, 8, 10, 12, 20, 100]);

export const MAX_DICE_PER_TERM = 20;
/** Cap on dice *results* in one roll (a d100 result is two physical dice). */
export const MAX_DICE_PER_ROLL = 30;
/** Cap on physical meshes in flight, keeping the physics pre-simulation cheap. */
export const MAX_PHYSICAL_DICE = 40;
export const MAX_MODIFIER = 999;
export const MAX_FORMULA_LENGTH = 120;
export const MAX_LABEL_LENGTH = 80;
export const MAX_CLIENT_ROLL_ID_LENGTH = 64;

export const DICE_VISIBILITY = Object.freeze({
  PUBLIC: 'public',
  /** Visible only to Dungeon Master sockets (and the roller, when a player used /gmroll). */
  DM: 'dm',
});

/** `chat_messages.type` value used for persisted rolls. */
export const DICE_MESSAGE_TYPE = 'dice_roll';
