/**
 * generator.ts — the FAIR tray generator.
 *
 * Guarantees: every refilled tray (and every swapped tray) contains at least
 * one piece that fits the current board. On top of that, a tunable
 * `generosity` biases the draw toward pieces that fit and nearly complete
 * lines. That parameter is the future difficulty lever: 0 = plain uniform
 * draw (still with the fit guarantee), higher = kinder.
 *
 * Levels add a second, independent lever, `goalBias`: extra weight for pieces
 * that would complete a line containing a GOAL tile, so a level's draws steer
 * the player toward clearing its goals. It defaults to 0, and a board with no
 * goal tiles (endless) is unaffected by it either way — so with no options
 * passed, draws are exactly what they were before levels existed.
 *
 * All randomness comes from the passed-in `Rng`, and the number of RNG calls
 * depends only on (board, tray, rng state), so draws are reproducible.
 */
import { BOARD_SIZE } from './constants.ts';
import type { Board, Piece, TraySlot } from './game.ts';
import { canPlace, fitsAnywhere } from './grid.ts';
import { DOT, GOAL, PIECES } from './pieces.ts';
import type { Rng } from './rng.ts';

/**
 * Per-game tuning of the draw. Plain JSON-able data. Endless mode passes none
 * (all defaults); a level derives its own from its level number. A game must
 * use the same options on every draw for its trays to be reproducible.
 */
export interface GeneratorOptions {
  /**
   * How strongly to favor pieces that fit and nearly complete lines.
   * 0 = uniform. Default {@link DEFAULT_GENEROSITY}.
   */
  readonly generosity?: number;
  /**
   * Extra helpfulness for each line a placement would complete that contains
   * at least one GOAL tile (on top of that line's normal credit). 0 = no goal
   * preference. Default {@link DEFAULT_GOAL_BIAS}. Only matters on boards
   * that hold goal tiles.
   */
  readonly goalBias?: number;
}

export const DEFAULT_GENEROSITY = 1;
export const DEFAULT_GOAL_BIAS = 0;

/**
 * How helpful `piece` could be on `board`: 0 if it does not fit; otherwise
 * 1 + the best, over all legal placements, of (lines it would complete +
 * 0.25 × lines it would leave one cell short of full + `goalBias` × completed
 * lines that contain a GOAL tile). With `goalBias` 0 (the default) this is
 * exactly the endless scoring. Being part of helpfulness, the goal bonus is
 * scaled by `generosity` like the rest (generosity 0 stays uniform).
 */
export function helpfulness(board: Board, piece: Piece, goalBias: number = DEFAULT_GOAL_BIAS): number {
  // Empty-cell counts per row / column, so each placement is scored without
  // copying the board; plus which rows / columns hold a goal tile.
  const rowEmpty = new Array<number>(BOARD_SIZE).fill(0);
  const colEmpty = new Array<number>(BOARD_SIZE).fill(0);
  const rowGoal = new Array<boolean>(BOARD_SIZE).fill(false);
  const colGoal = new Array<boolean>(BOARD_SIZE).fill(false);
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const v = board[r * BOARD_SIZE + c];
      if (v === 0) {
        rowEmpty[r]!++;
        colEmpty[c]!++;
      } else if (v === GOAL) {
        rowGoal[r] = true;
        colGoal[c] = true;
      }
    }
  }
  // How many of the piece's cells sit in each of its rows / columns.
  const inRow = new Array<number>(piece.h).fill(0);
  const inCol = new Array<number>(piece.w).fill(0);
  for (const p of piece.cells) {
    inRow[p.r]!++;
    inCol[p.c]!++;
  }

  let best = -1;
  for (let r = 0; r <= BOARD_SIZE - piece.h; r++) {
    for (let c = 0; c <= BOARD_SIZE - piece.w; c++) {
      if (!canPlace(board, piece, r, c)) continue;
      let gain = 0;
      for (let i = 0; i < piece.h; i++) {
        const left = rowEmpty[r + i]! - inRow[i]!;
        gain += lineGain(left);
        if (left === 0 && rowGoal[r + i]) gain += goalBias;
      }
      for (let j = 0; j < piece.w; j++) {
        const left = colEmpty[c + j]! - inCol[j]!;
        gain += lineGain(left);
        if (left === 0 && colGoal[c + j]) gain += goalBias;
      }
      if (gain > best) best = gain;
    }
  }
  return best < 0 ? 0 : 1 + best;
}

/** Value of a line left with `emptyAfter` empty cells by a placement. */
function lineGain(emptyAfter: number): number {
  if (emptyAfter === 0) return 1;
  if (emptyAfter === 1) return 0.25;
  return 0;
}

/** Draw weight of every catalog piece for this board (computed once per tray). */
function weightsFor(board: Board, opts: GeneratorOptions): number[] {
  const generosity = opts.generosity ?? DEFAULT_GENEROSITY;
  const goalBias = opts.goalBias ?? DEFAULT_GOAL_BIAS;
  return PIECES.map((p) => {
    const h = helpfulness(board, p, goalBias);
    return h === 0 ? 1 : 1 + generosity * h;
  });
}

/** Draw one piece by weight. Consumes exactly one rng.next(). */
function drawWeighted(weights: readonly number[], rng: Rng): Piece {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rng.next() * total;
  for (let i = 0; i < PIECES.length; i++) {
    x -= weights[i]!;
    if (x < 0) return PIECES[i]!;
  }
  return PIECES[PIECES.length - 1]!;
}

/**
 * The smallest catalog piece that fits (fewest cells; ties by catalog order).
 * This is always the dot unless the board is completely full, which a real
 * game never leaves it (a full board clears every row).
 */
export function smallestFitting(board: Board): Piece {
  const sorted = [...PIECES].sort((a, b) => a.cells.length - b.cells.length);
  return sorted.find((p) => fitsAnywhere(board, p)) ?? DOT;
}

/**
 * Make sure at least one non-null slot fits. If none does, one of the
 * `candidates` slots (chosen by the rng) becomes the smallest fitting piece.
 */
function ensureFit(board: Board, slots: TraySlot[], candidates: readonly number[], rng: Rng): void {
  const anyFits = slots.some((p) => p !== null && fitsAnywhere(board, p));
  if (anyFits || candidates.length === 0) return;
  slots[rng.pick(candidates)] = smallestFitting(board);
}

/** A full new tray of 3 pieces, at least one of which fits. */
export function drawTray(board: Board, rng: Rng, opts: GeneratorOptions = {}): TraySlot[] {
  const w = weightsFor(board, opts);
  const slots: TraySlot[] = [0, 1, 2].map(() => drawWeighted(w, rng));
  ensureFit(board, slots, [0, 1, 2], rng);
  return slots;
}

/**
 * Redraw every non-null slot (used slots stay null), guaranteeing a fit. If
 * every slot is null, draws a full tray instead.
 */
export function redrawTray(
  board: Board,
  tray: readonly TraySlot[],
  rng: Rng,
  opts: GeneratorOptions = {},
): TraySlot[] {
  const live = tray.flatMap((p, i) => (p === null ? [] : [i]));
  if (live.length === 0) return drawTray(board, rng, opts);
  const w = weightsFor(board, opts);
  const slots = tray.slice();
  for (const i of live) slots[i] = drawWeighted(w, rng);
  ensureFit(board, slots, live, rng);
  return slots;
}
