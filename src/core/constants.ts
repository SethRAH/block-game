/**
 * Board/tray dimensions. Kept in their own leaf module so lower-level modules
 * (grid.ts, generator.ts) can import them without a circular value import
 * through game.ts. game.ts re-exports them as part of the public API.
 */

/** The board is 8×8. */
export const BOARD_SIZE = 8;

/** Number of cells on the board (64). */
export const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;

/** The tray holds 3 pieces; it refills once all 3 are used. */
export const TRAY_SIZE = 3;
