/**
 * solver.ts — the PERFECT PLAYER for a level (pure; no DOM, storage or timers).
 *
 * Finds the fewest placements that clear every goal tile, playing the real
 * rules: `applyMove` with the level's generator options, so trays refill from
 * the seeded generator exactly as they would for her.
 *
 * "Perfect" is bounded to keep the search small:
 *  • a piece is played INTO a goal line: wholly on empty target-line cells,
 *    touching a target line that still holds a goal, or anywhere it FINISHES
 *    such a line (overhanging past it is fine then). Overhangs that don't
 *    finish a line are not searched: they multiply the states for little gain
 *    (on levels 1–15 allowing them changed no count);
 *  • a piece that can't be is PARKED out of the way, at the first legal spot
 *    (row-major) off every target line, else off every goal-holding line, and
 *    only once no piece can be played into a goal line;
 *  • a state that would need a swap (stuck) is a dead end.
 * Known limit: parking a spare piece elsewhere changes the board the next
 * refill is drawn for, so a lucky player can now and then get kinder pieces
 * and finish in fewer moves. Searching every parking spot is too slow, so the
 * count is "perfect, parking at the canonical spot".
 * The search is breadth-first over distinct states (board + tray + rng), so
 * the first winning path found is a shortest one. It gives up (null) past
 * MAX_STATES states, so createLevel stays fast; such a layout is just skipped.
 */
import { BOARD_SIZE } from './constants.ts';
import {
  applyMove,
  GOAL,
  isLevelComplete,
  isStuck,
  type ClearedLines,
  type GameState,
  type GeneratorOptions,
} from './game.ts';
import { placements } from './grid.ts';

/** One placement: tray slot + top-left board cell. */
export interface SolverMove {
  readonly slot: number;
  readonly r: number;
  readonly c: number;
}

/** Search budget (distinct states); past it the layout counts as unsolved. */
const MAX_STATES = 800;
const stateKey = (s: GameState): string =>
  `${s.board.join('')}|${s.tray.map((p) => p?.id ?? '-').join(',')}|${s.rngState}`;

/**
 * Whether filling `cells` would complete a target line that holds a goal.
 * `emptyIn(row, i)` is that line's empty-cell count before the move.
 */
function finishesGoalLine(
  cells: ReadonlyArray<readonly [number, number]>,
  goalRows: ReadonlySet<number>,
  goalCols: ReadonlySet<number>,
  emptyIn: (row: boolean, i: number) => number,
): boolean {
  const check = (row: boolean, lines: ReadonlySet<number>) => {
    for (const line of lines) {
      const added = cells.filter(([y, x]) => (row ? y : x) === line).length;
      if (added > 0 && added === emptyIn(row, line)) return true;
    }
    return false;
  };
  return check(true, goalRows) || check(false, goalCols);
}

/** The placements the perfect player considers in `s` (see the file comment). */
function candidateMoves(s: GameState, targets: ClearedLines): SolverMove[] {
  const goalRows = new Set<number>();
  const goalCols = new Set<number>();
  s.board.forEach((v, i) => {
    if (v !== GOAL) return;
    const r = Math.floor(i / BOARD_SIZE);
    const c = i % BOARD_SIZE;
    if (targets.rows.includes(r)) goalRows.add(r);
    if (targets.cols.includes(c)) goalCols.add(c);
  });
  const rowEmpty = new Array<number>(BOARD_SIZE).fill(0);
  const colEmpty = new Array<number>(BOARD_SIZE).fill(0);
  s.board.forEach((v, i) => {
    if (v !== 0) return;
    rowEmpty[Math.floor(i / BOARD_SIZE)]!++;
    colEmpty[i % BOARD_SIZE]!++;
  });
  const emptyIn = (row: boolean, i: number) => (row ? rowEmpty : colEmpty)[i]!;
  const onTarget = (r: number, c: number) => targets.rows.includes(r) || targets.cols.includes(c);
  const onGoalLine = (r: number, c: number) => goalRows.has(r) || goalCols.has(c);

  const holeMoves: SolverMove[] = [];
  const dumps: SolverMove[] = [];
  const seen = new Set<string>();
  s.tray.forEach((piece, slot) => {
    if (!piece || seen.has(piece.id)) return; // the same piece in two slots plays alike
    seen.add(piece.id);
    const spots = placements(s.board, piece);
    const cellsAt = (r: number, c: number) => piece.cells.map((p) => [r + p.r, c + p.c] as const);
    const holes = spots.filter(({ r, c }) => {
      const cells = cellsAt(r, c);
      if (!cells.some(([y, x]) => onGoalLine(y, x))) return false;
      return cells.every(([y, x]) => onTarget(y, x)) || finishesGoalLine(cells, goalRows, goalCols, emptyIn);
    });
    for (const { r, c } of holes) holeMoves.push({ slot, r, c });
    if (holes.length > 0) return;
    const dump =
      spots.find(({ r, c }) => cellsAt(r, c).every(([y, x]) => !onTarget(y, x))) ??
      spots.find(({ r, c }) => cellsAt(r, c).every(([y, x]) => !onGoalLine(y, x)));
    if (dump) dumps.push({ slot, ...dump });
  });
  // Dumping only matters for when the tray refills, so dump once no hole move is left.
  return holeMoves.length > 0 ? holeMoves : dumps;
}

/**
 * The shortest perfect-player solution of `start` using at most `maxMoves`
 * placements, or `null` if there is none within that bound.
 */
export function solveLevel(
  start: GameState,
  gen: GeneratorOptions,
  targets: ClearedLines,
  maxMoves: number,
): SolverMove[] | null {
  if (isLevelComplete(start)) return [];
  let frontier: Array<{ s: GameState; path: SolverMove[] }> = [{ s: start, path: [] }];
  const seen = new Set<string>([stateKey(start)]);
  for (let depth = 0; depth < maxMoves && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const { s, path } of frontier) {
      for (const m of candidateMoves(s, targets)) {
        const res = applyMove(s, m.slot, m.r, m.c, gen);
        if (!res.ok) continue;
        const after = res.result.state;
        const route = [...path, m];
        if (isLevelComplete(after)) return route;
        if (isStuck(after)) continue;
        const key = stateKey(after);
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > MAX_STATES) return null;
        next.push({ s: after, path: route });
      }
    }
    frontier = next;
  }
  return null;
}
