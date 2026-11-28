/**
 * playtest.ts — a seeded simulated YOUNG player (pure; no DOM, storage or
 * timers): the "does this level drag?" yardstick. createLevel playtests every
 * candidate layout with it, and the anti-slog test (tests/invariants.test.ts)
 * replays it on unseen seeds.
 *
 * Model of a young player: on each placement, with probability `focus` she
 * makes the best-looking move (see {@link moveValue}), otherwise she drops a
 * random tray piece at a random legal spot. When stuck she swaps (a swap is
 * not a placement).
 * `focus = 0` is a purely random player; `focus = 1` is greedy.
 */
import { BOARD_SIZE } from './constants.ts';
import {
  applyMove,
  GOAL,
  isLevelComplete,
  isStuck,
  swapTray,
  type GameState,
  type GeneratorOptions,
} from './game.ts';
import { placements } from './grid.ts';
import { createRng } from './rng.ts';

interface Candidate {
  readonly slot: number;
  readonly r: number;
  readonly c: number;
}

/**
 * How good a placement looks to her, compared lexicographically: goal tiles
 * it clears, lines it clears, then how much of the goal lines' remaining
 * holes it fills. Computed without copying the board.
 */
function moveValue(s: GameState, m: Candidate): [number, number, number] {
  const piece = s.tray[m.slot]!;
  const filled = new Set(piece.cells.map((p) => (m.r + p.r) * BOARD_SIZE + (m.c + p.c)));
  const at = (r: number, c: number) => filled.has(r * BOARD_SIZE + c) || s.board[r * BOARD_SIZE + c] !== 0;
  const cleared = new Set<number>();
  let lines = 0;
  for (let i = 0; i < BOARD_SIZE; i++) {
    let row = true;
    let col = true;
    for (let j = 0; j < BOARD_SIZE; j++) {
      if (!at(i, j)) row = false;
      if (!at(j, i)) col = false;
    }
    if (row) {
      lines++;
      for (let j = 0; j < BOARD_SIZE; j++) cleared.add(i * BOARD_SIZE + j);
    }
    if (col) {
      lines++;
      for (let j = 0; j < BOARD_SIZE; j++) cleared.add(j * BOARD_SIZE + i);
    }
  }
  let goals = 0;
  for (const i of cleared) if (s.board[i] === GOAL) goals++;
  // Progress: for each goal line the piece touches, the fraction of that
  // line's remaining hole it fills (so finishing a nearly-full line wins).
  let progress = 0;
  for (const row of [true, false]) {
    const touched = new Map<number, number>();
    for (const p of piece.cells) {
      const line = row ? m.r + p.r : m.c + p.c;
      touched.set(line, (touched.get(line) ?? 0) + 1);
    }
    for (const [line, added] of touched) {
      let empty = 0;
      let goal = false;
      for (let j = 0; j < BOARD_SIZE; j++) {
        const v = s.board[row ? line * BOARD_SIZE + j : j * BOARD_SIZE + line];
        if (v === 0) empty++;
        if (v === GOAL) goal = true;
      }
      if (goal) progress += added / empty;
    }
  }
  return [goals, lines, progress];
}

function better(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/**
 * Play `start` to completion. Returns the number of placements it took, or
 * `cap + 1` if the level was not finished within `cap` placements.
 */
export function playLevel(
  start: GameState,
  gen: GeneratorOptions,
  driverSeed: number,
  focus: number,
  cap = 200,
): number {
  const rng = createRng(driverSeed);
  let s = start;
  let placed = 0;
  while (!isLevelComplete(s)) {
    if (placed >= cap) return cap + 1;
    if (isStuck(s)) {
      s = swapTray(s, gen);
      continue;
    }
    const moves: Candidate[] = [];
    s.tray.forEach((p, slot) => {
      if (p) for (const { r, c } of placements(s.board, p)) moves.push({ slot, r, c });
    });
    let move = rng.pick(moves);
    if (rng.next() < focus) {
      rng.shuffle(moves); // break ties at random, not by board position
      let best = [0, 0, 0];
      for (const m of moves) {
        const v = moveValue(s, m);
        if (better(v, best)) {
          best = v;
          move = m;
        }
      }
    }
    const res = applyMove(s, move.slot, move.r, move.c, gen);
    if (!res.ok) throw new Error(`sim chose an illegal move: ${res.error}`);
    s = res.result.state;
    placed++;
  }
  return placed;
}

/** The q-quantile (0..1) of `xs`, nearest-rank. */
export function quantile(xs: readonly number[], q: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}
