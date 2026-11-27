/**
 * Pre-installed demo characters have been removed so players and DMs create
 * sheets explicitly from Character Tokens on the board.
 */
export const DEMO_CHARACTERS = Object.freeze([]);

/**
 * Preserved as a lifecycle hook for DB initialization without seeding preset rows.
 */
export async function seedIfEmpty() {
  // Intentionally empty: no pre-installed campaigns or demo character sheets.
}
