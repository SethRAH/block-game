/**
 * levels.ts — seeded level GENERATION (pure; no DOM, storage or timers).
 *
 * A level is an ordinary {@link GameState} whose board starts with pre-placed
 * GOAL and filler tiles; it is played with the unchanged `applyMove` /
 * `swapTray`, passing the level's {@link GeneratorOptions} on every move.
 *
 * ── Solvable by construction ────────────────────────────────────────────────
 *  1. Pick 1–4 parallel TARGET LINES (all rows or all columns).
 *  2. Carve three piece-shaped HOLES into them: each hole is exactly a catalog
 *     piece in its fixed orientation, lying wholly on target-line cells. Holes
 *     never touch each other (so each reads as its own shape), every target
 *     line gets at least one, and no line is entirely hole.
 *  3. Fill the rest of every target line with GOAL tiles (1–3 per line) and
 *     plain filler tiles, so each target line is nearly full.
 *  4. Script the FIRST tray to be exactly the three hole pieces.
 *  Dropping each tray piece into its hole completes every target line and
 *  clears every goal, in any order: target lines are parallel, so clearing
 *  one never touches another, and with at most 4 of the 8 lines holding tiles
 *  no crossing line can fill up. {@link Level.solution} records those moves.
 *  After the first tray, the level's generosity and goal bias steer refills
 *  toward pieces that finish goal lines.
 *
 * A level never starts with a complete line (it would clear on load): every
 * target line has a hole and every other line of that direction is empty.
 * `createLevel` asserts this.
 *
 * ── Reproducibility ─────────────────────────────────────────────────────────
 * A level number must reproduce the exact same level forever, and golden
 * snapshots (tests/level-gen.test.ts) pin levels 1–30. Changing ANYTHING that
 * alters a generated level — the algorithm, {@link levelParams}, the piece
 * catalog, the order of RNG calls — requires bumping LEVEL_GEN_VERSION (which
 * discards in-progress saves made with the old version) and regenerating the
 * snapshots on purpose.
 */
import { BOARD_SIZE } from './constants.ts';
import {
  LEVEL_GEN_VERSION,
  type Board,
  type Cell,
  type Coord,
  type GameState,
  type GeneratorOptions,
  type Piece,
} from './game.ts';
import { emptyBoard, findFullLines } from './grid.ts';
import { GOAL, PALETTE_SIZE, PIECES } from './pieces.ts';
import { createRng, type Rng } from './rng.ts';

/** Levels per stage. Difficulty ramps across a stage, then resets. */
export const LEVELS_PER_STAGE = 5;

/** Where a level number sits: its 1-based stage and 1-based level within it. */
export interface LevelPosition {
  readonly stage: number;
  readonly level: number;
}

/** The difficulty knobs of one level. Plain JSON. */
export interface LevelParams {
  /** Number of target lines holding goal tiles (1–4). */
  readonly targetLines: number;
  /** Bounds on the total number of hole cells she must fill. */
  readonly minHoleCells: number;
  readonly maxHoleCells: number;
  /** Catalog families the scripted hole pieces may be drawn from. */
  readonly holeFamilies: readonly string[];
  /** Refill tuning after the first tray (see {@link GeneratorOptions}). */
  readonly generosity: number;
  readonly goalBias: number;
}

/** One scripted move of a level's built-in solution: tray slot + top-left. */
export interface LevelMove {
  readonly slot: number;
  readonly r: number;
  readonly c: number;
}

/** A generated level. Plain JSON. */
export interface Level {
  readonly levelNumber: number;
  /** The {@link LEVEL_GEN_VERSION} this level was generated with. */
  readonly genVersion: number;
  readonly params: LevelParams;
  /** Pass to every `applyMove` / `swapTray` of this level. */
  readonly gen: GeneratorOptions;
  /** The starting state: goal + filler tiles, first tray = the hole pieces. */
  readonly start: GameState;
  /** Placing the first tray into its holes (in this order, or any order) wins. */
  readonly solution: readonly LevelMove[];
}

function assertLevelNumber(n: number): void {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`level number must be a positive integer, got ${n}`);
}

/** Stage and level-within-stage for level number `n` (1-based). */
export function levelPosition(n: number): LevelPosition {
  assertLevelNumber(n);
  return { stage: Math.floor((n - 1) / LEVELS_PER_STAGE) + 1, level: ((n - 1) % LEVELS_PER_STAGE) + 1 };
}

// ── Difficulty tables (index = level within stage − 1) ──────────────────────
// Tuned against the simulated player (tests/sim-player.ts, run by the
// anti-slog test in tests/invariants.test.ts), not by gut.

/** Target lines across a stage; later stages add one (capped at 4). */
const TARGET_LINES = [1, 1, 2, 2, 3] as const;
/** Hole-piece families, growing across a stage. */
const FAMILY_TIERS = [
  ['dot', 'line2', 'line3'],
  ['dot', 'line2', 'line3'],
  ['dot', 'line2', 'line3', 'square'],
  ['dot', 'line2', 'line3', 'line4', 'square'],
  ['dot', 'line2', 'line3', 'line4', 'square', 'L', 'J', 'T', 'S', 'Z'],
] as const;
/** Generosity: high at the start of a stage, moderate by its end. */
const GENEROSITY = [4, 3.5, 3, 3, 2.5] as const;
const GOAL_BIAS = 8;

/**
 * The difficulty knobs for level `level` (1-based) of stage `stage`. Each
 * stage ramps easy → harder; the next stage starts easy again, a little
 * harder overall (from stage 3 on, one more target line, capped at 4).
 */
export function levelParams(stage: number, level: number): LevelParams {
  assertLevelNumber(stage);
  if (!Number.isInteger(level) || level < 1 || level > LEVELS_PER_STAGE) {
    throw new RangeError(`level within stage must be 1..${LEVELS_PER_STAGE}, got ${level}`);
  }
  const i = level - 1;
  const bump = stage >= 3 ? 1 : 0;
  const targetLines = Math.min(4, TARGET_LINES[i]! + bump);
  return {
    targetLines,
    // About 1.5–3 hole cells per line, never fewer than the 3 hole pieces.
    minHoleCells: Math.max(3, targetLines + 2),
    maxHoleCells: 4 + 2 * targetLines,
    // Four lines need a hole spanning two of them, so the 2-high pieces.
    holeFamilies: targetLines === 4 ? FAMILY_TIERS[4] : FAMILY_TIERS[i]!,
    generosity: GENEROSITY[i]!,
    goalBias: GOAL_BIAS,
  };
}

/** The generator options a level plays with on every move. */
export function levelGenOptions(params: LevelParams): GeneratorOptions {
  return { generosity: params.generosity, goalBias: params.goalBias };
}

/** The fixed seed of level `n` (a uint32). */
export function levelSeed(n: number): number {
  assertLevelNumber(n);
  return (Math.imul(n, 0x9e3779b1) ^ 0x1e7e1) >>> 0;
}

// ── Construction ────────────────────────────────────────────────────────────

const HOLE_PIECES = 3;
/** Attempts per choice of target lines, and overall, before giving up. */
const HOLE_ATTEMPTS = 200;
const MAX_LAYOUTS = 500;

interface Hole {
  readonly piece: Piece;
  readonly r: number;
  readonly c: number;
}

const idx = (r: number, c: number): number => r * BOARD_SIZE + c;

function holeCells(h: Hole): Coord[] {
  return h.piece.cells.map((p) => ({ r: h.r + p.r, c: h.c + p.c }));
}

/** Pick `k` distinct target lines; four lines must include an adjacent pair. */
function pickTargetLines(k: number, rng: Rng): number[] {
  for (;;) {
    const lines = rng.shuffle([...Array(BOARD_SIZE).keys()]).slice(0, k).sort((a, b) => a - b);
    if (k < 4 || lines.some((l, j) => lines[j + 1] === l + 1)) return lines;
  }
}

/**
 * Try once to carve {@link HOLE_PIECES} non-touching holes into the target
 * lines. `lineOf` maps a cell to its line index in the target direction.
 * Returns null when this attempt's random choices don't satisfy the params.
 */
function tryCarve(
  targets: ReadonlySet<number>,
  lineOf: (p: Coord) => number,
  pool: readonly Piece[],
  params: LevelParams,
  rng: Rng,
): Hole[] | null {
  const used = new Set<number>(); // hole cells, plus their 4-neighbours
  const holes: Hole[] = [];
  for (let k = 0; k < HOLE_PIECES; k++) {
    const piece = rng.pick(pool);
    const spots: Hole[] = [];
    for (let r = 0; r <= BOARD_SIZE - piece.h; r++) {
      for (let c = 0; c <= BOARD_SIZE - piece.w; c++) {
        const h = { piece, r, c };
        if (holeCells(h).every((p) => targets.has(lineOf(p)) && !used.has(idx(p.r, p.c)))) spots.push(h);
      }
    }
    if (spots.length === 0) return null;
    const hole = rng.pick(spots);
    holes.push(hole);
    for (const p of holeCells(hole)) {
      for (const [dr, dc] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const r = p.r + dr;
        const c = p.c + dc;
        if (r >= 0 && c >= 0 && r < BOARD_SIZE && c < BOARD_SIZE) used.add(idx(r, c));
      }
    }
  }

  const all = holes.flatMap(holeCells);
  if (all.length < params.minHoleCells || all.length > params.maxHoleCells) return null;
  for (const t of targets) {
    const inLine = all.filter((p) => lineOf(p) === t).length;
    if (inLine === 0 || inLine === BOARD_SIZE) return null; // needs a hole AND a goal
  }
  return unambiguous(holes) ? holes : null;
}

/**
 * Every tray piece has one obvious home: no hole piece fits inside a hole of
 * a DIFFERENT shape (a dot can't be lost in a line3's hole and strand it).
 */
function unambiguous(holes: readonly Hole[]): boolean {
  return holes.every((a) =>
    holes.every((b) => {
      if (a.piece.id === b.piece.id) return true;
      const region = new Set(holeCells(b).map((p) => idx(p.r, p.c)));
      // Anchor a's first cell on each cell of b's hole and see if all of a fits.
      const first = a.piece.cells[0]!;
      return !holeCells(b).some((q) =>
        a.piece.cells.every((p) => region.has(idx(q.r + p.r - first.r, q.c + p.c - first.c))),
      );
    }),
  );
}

/**
 * Generate level `n`: deterministic in `n`, solvable by construction, and
 * stamped with {@link LEVEL_GEN_VERSION}. Throws on an invalid level number
 * (or, defensively, if construction ever broke its own guarantees).
 */
export function createLevel(n: number): Level {
  const { stage, level } = levelPosition(n);
  const params = levelParams(stage, level);
  const seed = levelSeed(n);
  const rng = createRng(seed);
  const pool = PIECES.filter((p) => params.holeFamilies.includes(p.id.replace(/-\d+$/, '')));

  const byRows = rng.next() < 0.5;
  const lineOf = (p: Coord): number => (byRows ? p.r : p.c);
  let holes: Hole[] | null = null;
  let targets: number[] = [];
  for (let layout = 0; layout < MAX_LAYOUTS && !holes; layout++) {
    targets = pickTargetLines(params.targetLines, rng);
    const set = new Set(targets);
    for (let a = 0; a < HOLE_ATTEMPTS && !holes; a++) holes = tryCarve(set, lineOf, pool, params, rng);
  }
  if (!holes) throw new Error(`level ${n}: could not carve holes`);

  // Tiles: every non-hole cell of a target line; 1–3 of each line's are goals.
  const isHole = new Set(holes.flatMap(holeCells).map((p) => idx(p.r, p.c)));
  const board: Cell[] = emptyBoard().slice();
  for (const t of targets) {
    const tiles: number[] = [];
    for (let j = 0; j < BOARD_SIZE; j++) {
      const i = byRows ? idx(t, j) : idx(j, t);
      if (!isHole.has(i)) tiles.push(i);
    }
    const goals = rng.int(1, Math.min(3, tiles.length));
    rng.shuffle(tiles).forEach((i, j) => {
      board[i] = j < goals ? GOAL : rng.int(1, PALETTE_SIZE);
    });
  }
  assertFreshBoard(n, board);

  // The first tray is exactly the hole pieces, in a shuffled slot order.
  const order = rng.shuffle([...holes.keys()]);
  const tray = order.map((h) => holes[h]!.piece);
  const solution = order.map((h, slot) => ({ slot, r: holes[h]!.r, c: holes[h]!.c }));

  return {
    levelNumber: n,
    genVersion: LEVEL_GEN_VERSION,
    params,
    gen: levelGenOptions(params),
    start: { board, tray, score: 0, seed, rngState: rng.getState() },
    solution,
  };
}

/** A level must start with goals to clear and NO complete line (it would auto-clear). */
function assertFreshBoard(n: number, board: Board): void {
  const full = findFullLines(board);
  if (full.rows.length > 0 || full.cols.length > 0) throw new Error(`level ${n} starts with a complete line`);
  if (!board.includes(GOAL)) throw new Error(`level ${n} has no goal tiles`);
}
