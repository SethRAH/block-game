/**
 * levels.ts — seeded level GENERATION (pure; no DOM, storage or timers).
 *
 * A level is an ordinary {@link GameState} whose board starts with pre-placed
 * GOAL and filler tiles; it is played with the unchanged `applyMove` /
 * `swapTray`, passing the level's {@link GeneratorOptions} on every move.
 *
 * ── The curve (every stage, a little harder overall each stage) ─────────────
 * "Moves" = placements the PERFECT player (solver.ts) needs.
 *   L1  1 target line                 first tray fully scripted   3 moves
 *   L2  2 parallel lines              fully scripted              4
 *   L3  a row crossing a column       fully scripted              5
 *   L4  3 lines                       partly scripted             6–7
 *   L5  3–4 lines, one gap needing    tray from the generator     8–9
 *       more than one piece
 * "Scripted" = that many first-tray slots are exactly hole pieces; the other
 * slots, and every later tray, come from the seeded generator, whose goal-line
 * bias rises across the stage so the bigger levels don't drag.
 *
 * ── Construction (solvable by construction) ─────────────────────────────────
 *  1. Pick the target lines (rows and/or columns; the main ones sometimes
 *     side by side so 2-high shapes fit).
 *  2. Carve piece-shaped HOLES: each is a catalog piece in its fixed
 *     orientation (bars, 2×2, L/J, T, S/Z…) lying wholly on target-line cells;
 *     holes never touch each other. On L5 one gap is two touching pieces that
 *     no single piece fills. Every target line gets a hole and keeps a tile.
 *  3. Fill the rest of each target line with GOAL tiles (1–3 per line) and
 *     plain filler, so every target line is nearly full.
 *  4. Build the first tray (scripted hole pieces + generator draws).
 *  5. Run the perfect player against the REAL rules and generator. The layout
 *     is kept only if it wins within the level's move range; its moves are
 *     recorded in {@link Level.solution}. So every level is solvable, and the
 *     move count is a measured fact, not a hope.
 * A level never starts with a complete line (it would clear on load): every
 * target line has a hole, and no other line can hold more than 4 tiles.
 * `createLevel` asserts this.
 *
 * ── Reproducibility ─────────────────────────────────────────────────────────
 * A level number must reproduce the exact same level forever, and golden
 * snapshots (tests/level-gen.test.ts) pin levels 1–30. Changing ANYTHING that
 * alters a generated level — the algorithm, {@link levelParams}, the solver,
 * the generator, the piece catalog, the order of RNG calls — requires bumping
 * LEVEL_GEN_VERSION (which discards in-progress saves made with the old
 * version) and regenerating the snapshots on purpose.
 */
import { BOARD_SIZE, TRAY_SIZE } from './constants.ts';
import {
  LEVEL_GEN_VERSION,
  type Board,
  type Cell,
  type ClearedLines,
  type Coord,
  type GameState,
  type GeneratorOptions,
  type Piece,
  type TraySlot,
} from './game.ts';
import { drawTray } from './generator.ts';
import { emptyBoard, findFullLines } from './grid.ts';
import { GOAL, PALETTE_SIZE, PIECES } from './pieces.ts';
import { createRng, type Rng } from './rng.ts';
import { playLevel } from './playtest.ts';
import { solveLevel, type SolverMove } from './solver.ts';

/** Levels per stage. Difficulty ramps across a stage, then resets. */
export const LEVELS_PER_STAGE = 5;

/** Where a level number sits: its 1-based stage and 1-based level within it. */
export interface LevelPosition {
  readonly stage: number;
  readonly level: number;
}

/** The difficulty knobs of one level. Plain JSON. */
export interface LevelParams {
  /** Number of target lines holding goal tiles (1–4)… */
  readonly targetLines: number;
  /** …of which this many run across the others (a row crossing columns). */
  readonly crossLines: number;
  /** Bounds on the number of separate holes carved. */
  readonly minHoles: number;
  readonly maxHoles: number;
  /** Whether one gap is two touching pieces that no single piece fills. */
  readonly bigGap: boolean;
  /** First-tray slots that are hole pieces; the rest come from the generator. */
  readonly scripted: number;
  /** Bounds on the placements the perfect player needs. */
  readonly minMoves: number;
  readonly maxMoves: number;
  /** Catalog families the holes are cut from. */
  readonly holeFamilies: readonly string[];
  /** Refill tuning (see {@link GeneratorOptions}). */
  readonly generosity: number;
  readonly goalBias: number;
}

/** One move of a level's built-in perfect solution: tray slot + top-left. */
export type LevelMove = SolverMove;

/** A generated level. Plain JSON. */
export interface Level {
  readonly levelNumber: number;
  /** The {@link LEVEL_GEN_VERSION} this level was generated with. */
  readonly genVersion: number;
  readonly params: LevelParams;
  /** Pass to every `applyMove` / `swapTray` of this level. */
  readonly gen: GeneratorOptions;
  /** The target lines (the only lines holding tiles at the start). */
  readonly targets: ClearedLines;
  /** The starting state: goal + filler tiles and the first tray. */
  readonly start: GameState;
  /**
   * A shortest perfect-player win from `start` (with `gen`); its length is the
   * level's move count. Later trays in it are the generator's real refills.
   */
  readonly solution: readonly LevelMove[];
}

function assertPositive(what: string, n: number): void {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`${what} must be a positive integer, got ${n}`);
}

/** Stage and level-within-stage for level number `n` (1-based). */
export function levelPosition(n: number): LevelPosition {
  assertPositive('level number', n);
  return { stage: Math.floor((n - 1) / LEVELS_PER_STAGE) + 1, level: ((n - 1) % LEVELS_PER_STAGE) + 1 };
}

// ── The curve (index = level within stage − 1) ──────────────────────────────
// Tuned against the perfect player (solver.ts) and the simulated young player
// (playtest.ts, also run by the anti-slog test in tests/invariants.test.ts).

const CURVE = [
  { lines: 1, cross: 0, holes: [3, 3], bigGap: false, scripted: 3, moves: [3, 3] },
  { lines: 2, cross: 0, holes: [4, 4], bigGap: false, scripted: 3, moves: [4, 4] },
  { lines: 2, cross: 1, holes: [4, 4], bigGap: false, scripted: 3, moves: [5, 5] },
  { lines: 3, cross: 1, holes: [3, 3], bigGap: false, scripted: 2, moves: [6, 7] },
  { lines: 3, cross: 1, holes: [2, 2], bigGap: true, scripted: 0, moves: [8, 9] },
] as const;

/** Hole families by EFFECTIVE difficulty: always varied, widening as it rises. */
const FAMILY_TIERS = [
  ['dot', 'line2', 'line3', 'square', 'L', 'J', 'T'],
  ['dot', 'line2', 'line3', 'line4', 'square', 'L', 'J', 'T'],
  ['dot', 'line2', 'line3', 'line4', 'line5', 'square', 'L', 'J', 'T', 'S', 'Z'],
] as const;

/** Goal-line bias and generosity RISE across a stage so later levels don't drag. */
const GENEROSITY = [3, 3, 3.5, 4, 4.5] as const;
const GOAL_BIAS = [6, 8, 10, 12, 14] as const;
/** From stage 3 on, every level is this much less generous. */
const LATER_STAGE_GENEROSITY_CUT = 0.5;

/**
 * The difficulty knobs for level `level` (1–5) of stage `stage`. Every stage
 * follows the same escalating curve and is a little harder overall than the
 * last: from stage 2 the hole shapes widen a tier (by EFFECTIVE difficulty),
 * and from stage 3 the generator is a little less generous. (A fourth target
 * line on L5 was tried and dropped: it pushed the slog test past its bars.)
 * Returns a fresh object every call: nothing in it aliases module state.
 */
export function levelParams(stage: number, level: number): LevelParams {
  assertPositive('stage', stage);
  if (!Number.isInteger(level) || level < 1 || level > LEVELS_PER_STAGE) {
    throw new RangeError(`level within stage must be 1..${LEVELS_PER_STAGE}, got ${level}`);
  }
  const i = level - 1;
  const step = CURVE[i]!;
  // Effective difficulty: the level's place in the curve plus the stage bump.
  const effective = Math.min(FAMILY_TIERS.length - 1, Math.floor(i / 2) + (stage >= 2 ? 1 : 0));
  return {
    targetLines: step.lines,
    crossLines: step.cross,
    minHoles: step.holes[0],
    maxHoles: step.holes[1],
    bigGap: step.bigGap,
    scripted: step.scripted,
    minMoves: step.moves[0],
    maxMoves: step.moves[1],
    holeFamilies: [...FAMILY_TIERS[effective]!],
    generosity: GENEROSITY[i]! - (stage >= 3 ? LATER_STAGE_GENEROSITY_CUT : 0),
    goalBias: GOAL_BIAS[i]!,
  };
}

/** The generator options a level plays with on every move. */
export function levelGenOptions(params: LevelParams): GeneratorOptions {
  return { generosity: params.generosity, goalBias: params.goalBias };
}

/** The fixed seed of level `n` (a uint32). */
export function levelSeed(n: number): number {
  assertPositive('level number', n);
  return (Math.imul(n, 0x9e3779b1) ^ 0x1e7e1) >>> 0;
}

// ── Construction ────────────────────────────────────────────────────────────

/**
 * Every candidate that passes the perfect player is also PLAYTESTED by the
 * simulated young player (playtest.ts, half-focused) and dropped if it drags.
 * These limits are stricter than the anti-slog test's (median <= 20, p90 <=
 * 35), which then checks levels 1–30 on seeds the filter never saw.
 */
const PLAYTESTS = 16;
const PLAYTEST_FOCUS = 0.5;
const PLAYTEST_MEDIAN = 14;
const PLAYTEST_P90 = 26;

/**
 * Whether the simulated young player finishes `start` briskly enough: at most
 * half the runs over PLAYTEST_MEDIAN and at most 10% over PLAYTEST_P90. Runs
 * are capped at the p90 bar and the check stops as soon as it has failed.
 */
function playsBriskly(start: GameState, gen: GeneratorOptions, seed: number): boolean {
  const slowAllowed = Math.floor(PLAYTESTS / 2);
  const draggyAllowed = Math.floor(PLAYTESTS / 10);
  let slow = 0;
  let draggy = 0;
  for (let k = 0; k < PLAYTESTS; k++) {
    const placed = playLevel(start, gen, (seed ^ Math.imul(k + 1, 0x85ebca6b)) >>> 0, PLAYTEST_FOCUS, PLAYTEST_P90);
    if (placed > PLAYTEST_MEDIAN) slow++;
    if (placed > PLAYTEST_P90) draggy++;
    if (slow > slowAllowed || draggy > draggyAllowed) return false;
  }
  return true;
}

/** Layout candidates to try (each is solved by the perfect player). */
const MAX_CANDIDATES = 4000;
/** Carving attempts per choice of target lines. */
const CARVE_ATTEMPTS = 40;

interface Hole {
  readonly piece: Piece;
  readonly r: number;
  readonly c: number;
}

const idx = (r: number, c: number): number => r * BOARD_SIZE + c;
const onBoard = (r: number, c: number): boolean => r >= 0 && c >= 0 && r < BOARD_SIZE && c < BOARD_SIZE;
const familyOf = (p: Piece): string => p.id.replace(/-\d+$/, '');
const NEIGHBOURS = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const;

function holeCells(h: Hole): Coord[] {
  return h.piece.cells.map((p) => ({ r: h.r + p.r, c: h.c + p.c }));
}

/** Every catalog shape as a set-of-cells key, to tell "fits in one piece". */
const SHAPE_KEYS = new Set(PIECES.map((p) => shapeKey(p.cells)));

function shapeKey(cells: readonly Coord[]): string {
  const minR = Math.min(...cells.map((p) => p.r));
  const minC = Math.min(...cells.map((p) => p.c));
  return cells
    .map((p) => (p.r - minR) * BOARD_SIZE + (p.c - minC))
    .sort((a, b) => a - b)
    .join(',');
}

/** `k` distinct lines; with `block`, a run of adjacent ones. */
function pickLines(k: number, block: boolean, rng: Rng): number[] {
  if (block) {
    const first = rng.int(0, BOARD_SIZE - k);
    return Array.from({ length: k }, (_, j) => first + j);
  }
  return rng.shuffle([...Array(BOARD_SIZE).keys()]).slice(0, k).sort((a, b) => a - b);
}

function pickTargets(params: LevelParams, rng: Rng): ClearedLines {
  const main = pickLines(params.targetLines - params.crossLines, rng.next() < 0.5, rng);
  const cross = pickLines(params.crossLines, false, rng);
  return rng.next() < 0.5 ? { rows: main, cols: cross } : { rows: cross, cols: main };
}

/**
 * Try once to carve the holes. Returns the single-piece holes plus the big
 * gap's two pieces (if any), or null when this attempt's choices don't work.
 */
function tryCarve(
  targets: ClearedLines,
  families: ReadonlyArray<readonly Piece[]>,
  params: LevelParams,
  rng: Rng,
): { holes: Hole[]; gap: Hole[] } | null {
  const onTarget = (p: Coord) => targets.rows.includes(p.r) || targets.cols.includes(p.c);
  const taken = new Set<number>(); // hole cells
  const near = new Set<number>(); // hole cells plus their 4-neighbours
  const fits = (h: Hole, ok: (i: number) => boolean) =>
    holeCells(h).every((p) => onTarget(p) && ok(idx(p.r, p.c)));
  const spotsFor = (piece: Piece, ok: (i: number) => boolean): Hole[] => {
    const out: Hole[] = [];
    for (let r = 0; r <= BOARD_SIZE - piece.h; r++) {
      for (let c = 0; c <= BOARD_SIZE - piece.w; c++) if (fits({ piece, r, c }, ok)) out.push({ piece, r, c });
    }
    return out;
  };
  const claim = (hs: readonly Hole[]) => {
    for (const p of hs.flatMap(holeCells)) {
      taken.add(idx(p.r, p.c));
      for (const [dr, dc] of NEIGHBOURS) {
        const r = p.r + dr;
        const c = p.c + dc;
        if (onBoard(r, c)) near.add(idx(r, c));
      }
    }
  };
  /** A random spot for a random piece: family first (so bars don't swamp L/T), then shape. */
  const randomSpot = (ok: (i: number) => boolean, extra: (h: Hole) => boolean = () => true): Hole | null => {
    const options = families
      .map((fam) => fam.map((piece) => spotsFor(piece, ok).filter(extra)).filter((s) => s.length > 0))
      .filter((fam) => fam.length > 0);
    return options.length === 0 ? null : rng.pick(rng.pick(rng.pick(options)));
  };

  const gap: Hole[] = [];
  if (params.bigGap) {
    // Two touching pieces whose union is no single catalog shape.
    const a = randomSpot(() => true);
    if (!a) return null;
    const aCells = new Set(holeCells(a).map((p) => idx(p.r, p.c)));
    // (Bounds-checked: idx() of an off-board neighbour would wrap to another row.)
    const touches = (h: Hole) =>
      holeCells(h).some((p) =>
        NEIGHBOURS.some(([dr, dc]) => onBoard(p.r + dr, p.c + dc) && aCells.has(idx(p.r + dr, p.c + dc))),
      );
    const b = randomSpot((i) => !aCells.has(i), touches);
    if (!b) return null;
    if (SHAPE_KEYS.has(shapeKey([...holeCells(a), ...holeCells(b)]))) return null;
    gap.push(a, b);
    claim(gap);
  }

  const holes: Hole[] = [];
  const count = rng.int(params.minHoles, params.maxHoles);
  for (let k = 0; k < count; k++) {
    const h = randomSpot((i) => !near.has(i));
    if (!h) return null;
    holes.push(h);
    claim([h]);
  }

  // Every target line needs a hole (so it isn't complete) and a tile (for a goal).
  const lines = [
    ...targets.rows.map((r) => (p: Coord) => p.r === r),
    ...targets.cols.map((c) => (p: Coord) => p.c === c),
  ];
  for (const inLine of lines) {
    const cells = [...Array(BOARD_SIZE * BOARD_SIZE).keys()]
      .map((i) => ({ r: Math.floor(i / BOARD_SIZE), c: i % BOARD_SIZE }))
      .filter(inLine);
    const holesIn = cells.filter((p) => taken.has(idx(p.r, p.c))).length;
    if (holesIn === 0 || holesIn === BOARD_SIZE) return null;
  }
  return { holes, gap };
}

/** Goal and filler tiles on every non-hole cell of the target lines. */
function fillTiles(targets: ClearedLines, holeSet: ReadonlySet<number>, rng: Rng): Cell[] {
  const board: Cell[] = emptyBoard().slice();
  const lines = [
    ...targets.rows.map((r) => Array.from({ length: BOARD_SIZE }, (_, j) => idx(r, j))),
    ...targets.cols.map((c) => Array.from({ length: BOARD_SIZE }, (_, j) => idx(j, c))),
  ];
  const goals = new Set<number>();
  const tiles = new Set<number>();
  for (const line of lines) {
    const free = line.filter((i) => !holeSet.has(i));
    free.forEach((i) => tiles.add(i));
    const n = rng.int(1, Math.min(3, free.length));
    rng.shuffle(free).slice(0, n).forEach((i) => goals.add(i));
  }
  for (const i of [...tiles].sort((a, b) => a - b)) board[i] = goals.has(i) ? GOAL : rng.int(1, PALETTE_SIZE);
  return board;
}

/**
 * Generate level `n`: deterministic in `n`, solvable by construction (its
 * perfect-play solution is found and recorded), and stamped with
 * {@link LEVEL_GEN_VERSION}. Throws on an invalid level number (or,
 * defensively, if construction ever failed its own guarantees).
 */
export function createLevel(n: number): Level {
  const { stage, level } = levelPosition(n);
  const params = levelParams(stage, level);
  const gen = levelGenOptions(params);
  const seed = levelSeed(n);
  const rng = createRng(seed);
  const families = params.holeFamilies.map((f) => PIECES.filter((p) => familyOf(p) === f));

  for (let tries = 0; tries < MAX_CANDIDATES; ) {
    const targets = pickTargets(params, rng);
    for (let a = 0; a < CARVE_ATTEMPTS && tries < MAX_CANDIDATES; a++, tries++) {
      const carved = tryCarve(targets, families, params, rng);
      if (!carved) continue;
      const { holes, gap } = carved;
      const holeSet = new Set([...holes, ...gap].flatMap(holeCells).map((p) => idx(p.r, p.c)));
      const board = fillTiles(targets, holeSet, rng);

      // First tray: `scripted` hole pieces, the rest drawn by the generator.
      const drawn = drawTray(board, rng, gen);
      const scripted = rng.shuffle(holes.slice()).slice(0, params.scripted).map((h) => h.piece);
      const tray: TraySlot[] = rng.shuffle([...scripted, ...drawn.slice(scripted.length)]);
      if (tray.length !== TRAY_SIZE) throw new Error('tray size');

      const start: GameState = { board, tray, score: 0, seed, rngState: rng.getState() };
      const solution = solveLevel(start, gen, targets, params.maxMoves);
      if (!solution || solution.length < params.minMoves) continue;
      if (!playsBriskly(start, gen, seed)) continue;

      assertFreshBoard(n, board);
      return { levelNumber: n, genVersion: LEVEL_GEN_VERSION, params, gen, targets, start, solution };
    }
  }
  throw new Error(`level ${n}: no layout met its difficulty`);
}

/** A level must start with goals to clear and NO complete line (it would auto-clear). */
function assertFreshBoard(n: number, board: Board): void {
  const full = findFullLines(board);
  if (full.rows.length > 0 || full.cols.length > 0) throw new Error(`level ${n} starts with a complete line`);
  if (!board.includes(GOAL)) throw new Error(`level ${n} has no goal tiles`);
}
