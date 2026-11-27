/**
 * game.ts — the central game-state contract for the block-PLACEMENT puzzle
 * (Block Blast / 1010! / Woodoku genre). Pure logic, NO DOM / storage / timers.
 *
 * This file is the public API that the rest of `core`, the `ui` layer, and the
 * tests build against, so it is defined and reviewed FIRST, then frozen. The
 * bodies (and the lower modules pieces.ts / grid.ts / generator.ts / undo.ts
 * that it composes) land only after the API is frozen.
 *
 * ── Design constraints this API must satisfy ────────────────────────────────
 *  • Endless mode now, but shaped so a seeded *level* (a fixed starting board +
 *    a fixed piece sequence) can plug in later WITHOUT rewriting core. That is
 *    why `GameState` carries `seed` + `rngState`: endless draws pieces from the
 *    RNG on refill; a future level would instead carry a scripted sequence, but
 *    the state shape and `applyMove` signature stay identical.
 *  • `GameState` is plain JSON (structurally cloneable / JSON round-trippable):
 *    no class instances, no functions, no Maps — so it saves to localStorage,
 *    restores after a reload, and snapshots cheaply for undo.
 *  • Every function returns NEW state; nothing here mutates its input.
 *  • NEVER losable: there is no "game over". The RESCUE RULE below guarantees a
 *    fitting piece always exists after every move.
 */

// ── Dimensions ───────────────────────────────────────────────────────────────

/** The board is 8×8. */
export const BOARD_SIZE = 8;

/** Number of cells on the board (64). */
export const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;

/** The tray holds 3 pieces; it refills once all 3 are used. */
export const TRAY_SIZE = 3;

// ── Primitive types ──────────────────────────────────────────────────────────

/**
 * One board cell. `0` = empty. A positive integer = filled, and its value is a
 * color id (purely cosmetic, chosen from the placed piece) so the UI can tint
 * settled blocks. Cleared cells go back to `0`.
 */
export type Cell = number;

/**
 * The board, row-major, length {@link CELL_COUNT}. The cell at (row `r`, col
 * `c`) is `board[r * BOARD_SIZE + c]`. Readonly: placement returns a new board.
 */
export type Board = readonly Cell[];

/** A single cell offset within a piece / a single board coordinate. */
export interface Coord {
  readonly r: number;
  readonly c: number;
}

/**
 * A placeable shape (1–5 cells): dot, lines of 2/3/4/5, 2×2, L/J, T, S/Z, in
 * their fixed orientations. The player does NOT rotate pieces; the generator
 * hands out already-oriented variants.
 *
 * `cells` are offsets normalized so the shape's bounding box starts at (0,0)
 * — i.e. `min r == 0` and `min c == 0`. `w`/`h` are that bounding box, handy
 * for laying out a tray slot. `color` is the cosmetic color id written into
 * each occupied board cell when the piece is placed.
 *
 * `id` identifies the oriented shape (e.g. "L4-0", "line3-v"); the exact
 * catalog lives in pieces.ts and may be tuned without changing this API.
 */
export interface Piece {
  readonly id: string;
  readonly cells: readonly Coord[];
  readonly w: number;
  readonly h: number;
  readonly color: number;
}

/** A tray slot: a piece waiting to be placed, or `null` once it has been used. */
export type TraySlot = Piece | null;

/** The tray: exactly {@link TRAY_SIZE} slots. */
export type Tray = readonly TraySlot[];

// ── Game state (plain JSON) ──────────────────────────────────────────────────

/**
 * The entire game at one instant — plain JSON, safe to `JSON.stringify` for
 * saving and to deep-copy for an undo snapshot.
 *
 *  • `board`    — current 8×8 cells.
 *  • `tray`     — the 3 current slots (some may be `null` after being placed).
 *  • `score`    — running score (see scoring below).
 *  • `seed`     — the seed this game started from (reproducibility).
 *  • `rngState` — snapshot of the RNG's internal state, so a reload or an undo
 *                 resumes the piece stream EXACTLY where it was. Advancing the
 *                 RNG (a refill) writes the new state back here.
 */
export interface GameState {
  readonly board: Board;
  readonly tray: Tray;
  readonly score: number;
  readonly seed: number;
  readonly rngState: number;
}

// ── Moves ────────────────────────────────────────────────────────────────────

/** Why an attempted move was rejected (the state is returned unchanged). */
export type MoveError =
  /** `slot` is not in `[0, TRAY_SIZE)`. */
  | 'invalid-slot'
  /** That tray slot is already empty (`null`). */
  | 'empty-slot'
  /** The piece would fall outside the 8×8 board at (r, c). */
  | 'out-of-bounds'
  /** The piece would overlap an already-filled cell. */
  | 'overlap';

/**
 * A successful move's outcome. `clearedRows` / `clearedCols` are the indices
 * that became full and were cleared by THIS move (either may be empty); the UI
 * uses them to flash the cleared lines. `scoreDelta` is how much `score` rose.
 */
export interface MoveResult {
  readonly state: GameState;
  readonly clearedRows: readonly number[];
  readonly clearedCols: readonly number[];
  readonly scoreDelta: number;
}

/** Discriminated result of {@link applyMove}: either a new state or an error. */
export type ApplyMoveResult =
  | { readonly ok: true; readonly result: MoveResult }
  | { readonly ok: false; readonly error: MoveError };

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * Start a fresh endless game from `seed`. Produces an empty board, a full tray
 * of 3 fitting pieces, score 0, and `rngState` positioned after the initial
 * draw. The same seed always yields the identical starting state and (given the
 * same moves) the identical sequence of trays thereafter.
 */
export declare function newGame(seed: number): GameState;

/**
 * Place the piece in tray `slot` with its top-left corner at board (`r`, `c`).
 *
 * On success returns `{ ok: true, result }` with a NEW state in which:
 *  1. the piece's cells are written onto the board,
 *  2. then every row AND every column that is completely full is cleared
 *     (all directions; a single move can clear rows and columns at once),
 *  3. the slot is emptied; when all 3 slots are now empty the tray REFILLS
 *     (advancing `rngState`),
 *  4. the RESCUE RULE is applied (see below),
 *  5. `score` rises by `scoreDelta`.
 *
 * On failure returns `{ ok: false, error }` and the caller keeps its old state.
 *
 * ── RESCUE RULE (the "no game over" guarantee) ──
 * After the board/clear/refill above, if NONE of the remaining tray pieces fit
 * anywhere on the board, one tray piece is swapped for the SMALLEST piece that
 * does fit. The 1×1 dot is the ultimate fallback and is ALWAYS placeable,
 * because a board with no room for a dot would be completely full — and a full
 * board clears every row, freeing space. (An invariant test asserts this.)
 *
 * ── Scoring (scoreDelta) ──
 *   + points per cell of the placed piece,
 *   + a per-line bonus for each row/column cleared,
 *   + a combo bonus that grows when several lines clear from one move.
 * Exact constants live with the implementation and may be tuned.
 */
export declare function applyMove(
  state: GameState,
  slot: number,
  r: number,
  c: number,
): ApplyMoveResult;

/**
 * Whether the piece in tray `slot` can legally be placed with its top-left at
 * board (`r`, `c`) — i.e. {@link applyMove} would succeed. Pure and cheap; the
 * UI calls it continuously during a drag to color the ghost preview green/red.
 * Returns `false` (never throws) for an invalid or empty slot.
 */
export declare function canPlaceAt(
  state: GameState,
  slot: number,
  r: number,
  c: number,
): boolean;
