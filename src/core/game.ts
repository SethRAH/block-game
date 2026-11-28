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
 *  • Endless mode now, but shaped so a seeded *level* can plug in later WITHOUT
 *    rewriting core. Per the design doc (docs/design.md) a level is a seeded
 *    starting board of pre-placed tiles whose goal is to clear them all. A
 *    level reuses this exact `GameState` shape and the `applyMove` /
 *    `swapTray` signatures: it just starts from a non-empty board. The goal
 *    is ADDITIVE: goal tiles are the reserved cell value {@link GOAL} in the
 *    board itself, the win check is {@link isLevelComplete}, and a level's
 *    generator tuning rides on an optional trailing {@link GeneratorOptions}
 *    argument to `applyMove` / `swapTray`. No existing field or signature
 *    changed; endless mode passes no options and behaves exactly as before.
 *  • `GameState` is plain JSON (structurally cloneable / JSON round-trippable):
 *    no class instances, no functions, no Maps — so it saves to localStorage,
 *    restores after a reload, and snapshots cheaply for undo.
 *  • Every function returns NEW state; nothing here mutates its input.
 *  • Deterministic: all randomness comes from the seeded RNG whose state is
 *    stored in `rngState`. The same seed + the same sequence of moves
 *    (placements AND swaps) reproduces the identical states. Undo is just
 *    restoring an earlier snapshot, so it is deterministic too.
 *  • NO piece rotation, anywhere. Pieces come pre-oriented.
 *  • NEVER losable: there is no "game over". If the player gets stuck,
 *    `isStuck` says so and the UI offers a visible "Swap pieces?" that calls
 *    `swapTray`, which always yields a placeable piece. Undo is the other way
 *    out. Score only ever goes up.
 */

// ── Dimensions ───────────────────────────────────────────────────────────────

// BOARD_SIZE (8), CELL_COUNT (64) and TRAY_SIZE (3) live in constants.ts so
// lower modules can import them without a cycle; they are re-exported here.
export { BOARD_SIZE, CELL_COUNT, TRAY_SIZE } from './constants.ts';

// GOAL (the reserved goal-tile cell value) lives in pieces.ts beside
// PALETTE_SIZE, which it is defined against; re-exported here.
export { GOAL } from './pieces.ts';

// The per-game generator options (generosity, goal-line bias). Endless mode
// passes none; a level derives its own from its level number.
export type { GeneratorOptions } from './generator.ts';

import { TRAY_SIZE } from './constants.ts';
import { drawTray, redrawTray, type GeneratorOptions } from './generator.ts';
import {
  canPlace,
  clearLines,
  emptyBoard,
  findFullLines,
  fitsAnywhere,
  pieceInBounds,
  place,
} from './grid.ts';
import { GOAL } from './pieces.ts';
import { createRng } from './rng.ts';

// ── Scoring constants (tunable; not part of the frozen API) ─────────────────
/** Points for each cell of a placed piece. */
export const POINTS_PER_CELL = 1;
/** Bonus for each row or column cleared. */
export const POINTS_PER_LINE = 10;
/** Extra combo bonus: COMBO_STEP × n × (n − 1) for n lines cleared at once. */
export const COMBO_STEP = 5;

/** Score gained for placing `cells` cells and clearing `lines` lines. */
export function scoreFor(cells: number, lines: number): number {
  return cells * POINTS_PER_CELL + lines * POINTS_PER_LINE + COMBO_STEP * lines * Math.max(0, lines - 1);
}

// ── Primitive types ──────────────────────────────────────────────────────────

/**
 * One board cell. `0` = empty. A positive integer = filled, and its value is a
 * theme-agnostic PALETTE INDEX (from the placed piece's `color`), never a
 * concrete CSS color: the UI maps index → color, so color themes can change
 * without migrating saved games, while settled-block colors still survive
 * reload / undo / replay. Cleared cells go back to `0`.
 *
 * One value past the palette is reserved: {@link GOAL} (`PALETTE_SIZE + 1`)
 * marks a level's goal tile. It is a filled cell to every rule (it blocks
 * placement, counts toward a full line, and clears with its line); storing it
 * IN the board — rather than in a separate mask — means it survives
 * `applyMove`, undo and save/reload with no extra state.
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
 * for laying out a tray slot. `color` is the theme-agnostic palette index
 * (positive integer, never a CSS color) written into each occupied board cell
 * when the piece is placed.
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
 * A set of full lines: row indices and column indices (either may be empty).
 * The one spelling used everywhere on the public surface — both for lines a
 * move actually cleared ({@link MoveResult}) and lines a placement WOULD clear
 * ({@link previewClears}).
 */
export interface ClearedLines {
  readonly rows: readonly number[];
  readonly cols: readonly number[];
}

/**
 * A successful move's outcome. `cleared` holds the rows/columns that became
 * full and were cleared by THIS move; the UI uses them to animate the clear.
 * `scoreDelta` is how much `score` rose; it is ALWAYS `>= 0` (score never goes
 * down).
 */
export interface MoveResult {
  readonly state: GameState;
  readonly cleared: ClearedLines;
  readonly scoreDelta: number;
}

/** Discriminated result of {@link applyMove}: either a new state or an error. */
export type ApplyMoveResult =
  | { readonly ok: true; readonly result: MoveResult }
  | { readonly ok: false; readonly error: MoveError };

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * Start a fresh endless game from `seed`. Produces an empty board, a full
 * tray of 3 pieces from the fair generator, score 0, and `rngState` positioned
 * after the initial draw. The same seed always yields the identical starting
 * state and (given the same moves) the identical sequence of trays thereafter.
 * No piece rotation.
 */
export function newGame(seed: number): GameState {
  const rng = createRng(seed);
  const board = emptyBoard();
  const tray = drawTray(board, rng);
  return { board, tray, score: 0, seed, rngState: rng.getState() };
}

/**
 * Place the piece in tray `slot` with its top-left corner at board (`r`, `c`).
 * The piece is placed exactly as oriented in the tray (no rotation).
 *
 * On success returns `{ ok: true, result }` with a NEW state in which:
 *  1. the piece's cells are written onto the board,
 *  2. then every row AND every column that is completely full is cleared
 *     (both directions; a single move can clear rows and columns at once),
 *  3. the slot is emptied; when all 3 slots are now empty the tray REFILLS
 *     from the fair generator (advancing `rngState`),
 *  4. `score` rises by `scoreDelta` (always `>= 0`).
 *
 * `applyMove` NEVER swaps or alters the remaining tray pieces. If, after the
 * move, none of them fit, the state is simply "stuck" — see {@link isStuck}
 * and {@link swapTray}. (A freshly REFILLED tray always contains at least one
 * fitting piece — that is the fair generator's guarantee — so being stuck can
 * only happen with 1–2 leftover pieces.)
 *
 * On failure returns `{ ok: false, error }` and the caller keeps its old state.
 *
 * `gen` tunes the refill draw (see {@link GeneratorOptions}). Omitted = the
 * endless defaults, identical to the behavior before levels existed. For
 * reproducibility a game must pass the SAME `gen` on every move: a level
 * derives it from its level number, so it never needs saving.
 *
 * ── Scoring (scoreDelta) ──
 *   + points per cell of the placed piece,
 *   + a per-line bonus for each row/column cleared,
 *   + a combo bonus that grows when several lines clear from one move.
 * Exact constants live with the implementation and may be tuned. Nothing ever
 * subtracts score.
 */
export function applyMove(
  state: GameState,
  slot: number,
  r: number,
  c: number,
  gen: GeneratorOptions = {},
): ApplyMoveResult {
  if (!Number.isInteger(slot) || slot < 0 || slot >= TRAY_SIZE) return { ok: false, error: 'invalid-slot' };
  const piece = state.tray[slot];
  if (!piece) return { ok: false, error: 'empty-slot' };
  if (!pieceInBounds(piece, r, c)) return { ok: false, error: 'out-of-bounds' };
  if (!canPlace(state.board, piece, r, c)) return { ok: false, error: 'overlap' };

  const placed = place(state.board, piece, r, c);
  const lines = findFullLines(placed);
  const board = clearLines(placed, lines);
  const scoreDelta = scoreFor(piece.cells.length, lines.rows.length + lines.cols.length);

  let tray: TraySlot[] = state.tray.slice();
  tray[slot] = null;
  let rngState = state.rngState;
  if (tray.every((p) => p === null)) {
    const rng = createRng(state.seed, state.rngState);
    tray = drawTray(board, rng, gen);
    rngState = rng.getState();
  }

  return {
    ok: true,
    result: {
      state: { board, tray, score: state.score + scoreDelta, seed: state.seed, rngState },
      cleared: lines,
      scoreDelta,
    },
  };
}

/**
 * Whether the piece in tray `slot` can legally be placed with its top-left at
 * board (`r`, `c`) — i.e. {@link applyMove} would succeed. Pure and cheap; the
 * UI calls it continuously during a drag to color the ghost preview green/red.
 * Returns `false` (never throws) for an invalid or empty slot.
 *
 * `canPlaceAt`, {@link previewClears} and {@link applyMove} always agree:
 * `canPlaceAt` is true exactly when `applyMove` succeeds, and when several
 * failures apply `applyMove` reports them in fixed precedence
 * `invalid-slot` → `empty-slot` → `out-of-bounds` → `overlap`.
 */
export function canPlaceAt(state: GameState, slot: number, r: number, c: number): boolean {
  if (!Number.isInteger(slot) || slot < 0 || slot >= TRAY_SIZE) return false;
  const piece = state.tray[slot];
  return !!piece && canPlace(state.board, piece, r, c);
}

/**
 * The rows and columns that WOULD clear if the piece in tray `slot` were
 * placed at (`r`, `c`), without changing anything. The UI calls it during a
 * drag to highlight lines that are about to clear. Returns `null` when the
 * placement is not legal (same conditions as {@link canPlaceAt}).
 */
export function previewClears(
  state: GameState,
  slot: number,
  r: number,
  c: number,
): ClearedLines | null {
  if (!canPlaceAt(state, slot, r, c)) return null;
  const piece = state.tray[slot]!;
  return findFullLines(place(state.board, piece, r, c));
}

/**
 * True when NONE of the remaining (non-null) tray pieces can be placed
 * anywhere on the board. The UI then shows a big, calm "Swap pieces?" button
 * (which calls {@link swapTray}); undo stays available as the other way out.
 * There is no game-over state.
 */
export function isStuck(state: GameState): boolean {
  const live = state.tray.filter((p): p is Piece => p !== null);
  // An all-empty tray is never "stuck" (applyMove always refills it).
  if (live.length === 0) return false;
  return !live.some((p) => fitsAnywhere(state.board, p));
}

/**
 * The visible rescue: redraw every remaining (unused, non-null) tray slot from
 * the RNG, GUARANTEEING that at least one of the new pieces fits. Already-used
 * (`null`) slots stay `null`, so the tray's progress toward a refill is kept.
 * If the fair draw yields no fit, one slot falls back to the SMALLEST piece
 * that fits — ultimately the 1×1 dot.
 *
 * The dot always fits: a board is never left completely full, because filling
 * the last empty cell completes every row and clears them all. (An invariant
 * test asserts this.)
 *
 * `swapTray` is itself a MOVE:
 *  • it returns a NEW state (board and score unchanged),
 *    advancing `rngState`;
 *  • the caller pushes the prior state onto the undo stack, so ONE undo
 *    reverses it exactly;
 *  • it is deterministic, so replaying the same seed + the same sequence of
 *    placements and swaps reproduces the same trays.
 *
 * It is intended for when {@link isStuck} is true, but is well-defined at any
 * time (it never fails).
 *
 * `gen` is the same per-game generator tuning as {@link applyMove}'s; omitted
 * = the endless defaults.
 */
export function swapTray(state: GameState, gen: GeneratorOptions = {}): GameState {
  const rng = createRng(state.seed, state.rngState);
  const tray = redrawTray(state.board, state.tray, rng, gen);
  return { ...state, tray, rngState: rng.getState() };
}

// ── Levels (additive) ────────────────────────────────────────────────────────

/**
 * Version of the level GENERATOR. A level number must reproduce the exact same
 * level forever, so anything that would change a generated level (the
 * algorithm, its parameters, the piece catalog it draws from) must keep
 * existing level numbers identical — golden snapshots enforce this. A saved
 * in-progress level records the version it was generated with; a mismatch
 * means the save cannot be trusted to match its number and is discarded.
 */
export const LEVEL_GEN_VERSION = 2;

/**
 * True when the board holds no {@link GOAL} tile — every goal has been
 * cleared and the level is won. Pure; a board that never had goals (endless)
 * is trivially "complete", so callers only ask it of a level.
 */
export function isLevelComplete(state: GameState): boolean {
  return !state.board.includes(GOAL);
}
