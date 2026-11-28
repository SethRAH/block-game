/**
 * Level generation (PR B2): the per-stage difficulty curve, construction
 * guarantees, the perfect-play move count, and GOLDEN SNAPSHOTS of levels 1–30.
 *
 * Solvability and the anti-slog check live in invariants.test.ts; wider
 * edge/fuzz coverage in level-gen-edge.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  applyMove,
  BOARD_SIZE,
  createHistory,
  createLevel,
  GOAL,
  isLevelComplete,
  LEVEL_GEN_VERSION,
  levelGenOptions,
  levelParams,
  levelPosition,
  levelSeed,
  LEVELS_PER_STAGE,
  parseGameState,
  PIECES,
  solveLevel,
  type Level,
} from '../src/core/index.ts';
import { findFullLines } from '../src/core/grid.ts';
import { parseLevelSave } from '../src/pwa/storage.ts';
import { cachedLevel, levelHash } from './helpers.ts';

/** Levels checked structurally (each takes tens of ms to generate). */
const LEVELS = 60;
const STAGES = LEVELS / LEVELS_PER_STAGE;
const SLOW = { timeout: 60_000 };

const familyOf = (id: string) => id.replace(/-\d+$/, '');
const shapeKey = (cells: ReadonlyArray<{ r: number; c: number }>) => {
  const minR = Math.min(...cells.map((p) => p.r));
  const minC = Math.min(...cells.map((p) => p.c));
  return cells
    .map((p) => (p.r - minR) * BOARD_SIZE + (p.c - minC))
    .sort((a, b) => a - b)
    .join(',');
};
const CATALOG_SHAPES = new Set(PIECES.map((p) => shapeKey(p.cells)));

/** Which lines hold any tile at the start. */
function tiledLines(board: readonly number[], rows: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < BOARD_SIZE; i++) {
    for (let j = 0; j < BOARD_SIZE; j++) {
      if (board[rows ? i * BOARD_SIZE + j : j * BOARD_SIZE + i] !== 0) {
        out.push(i);
        break;
      }
    }
  }
  return out;
}

/** The 4-connected regions of empty cells that lie on target lines (the holes). */
function holeRegions(level: Level): Array<Array<{ r: number; c: number }>> {
  const onTarget = (r: number, c: number) => level.targets.rows.includes(r) || level.targets.cols.includes(c);
  const seen = new Set<number>();
  const regions: Array<Array<{ r: number; c: number }>> = [];
  for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
    const r0 = Math.floor(i / BOARD_SIZE);
    const c0 = i % BOARD_SIZE;
    if (seen.has(i) || level.start.board[i] !== 0 || !onTarget(r0, c0)) continue;
    const region: Array<{ r: number; c: number }> = [];
    const stack = [i];
    seen.add(i);
    while (stack.length > 0) {
      const j = stack.pop()!;
      const r = Math.floor(j / BOARD_SIZE);
      const c = j % BOARD_SIZE;
      region.push({ r, c });
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const y = r + dr;
        const x = c + dc;
        const k = y * BOARD_SIZE + x;
        if (y < 0 || x < 0 || y >= BOARD_SIZE || x >= BOARD_SIZE || seen.has(k)) continue;
        if (level.start.board[k] !== 0 || !onTarget(y, x)) continue;
        seen.add(k);
        stack.push(k);
      }
    }
    regions.push(region);
  }
  return regions;
}

/** Play a level's built-in perfect solution from its start. */
function playSolution(level: Level) {
  let s = level.start;
  for (const m of level.solution) {
    const res = applyMove(s, m.slot, m.r, m.c, level.gen);
    if (!res.ok) throw new Error(`level ${level.levelNumber}: solution move rejected (${res.error})`);
    s = res.result.state;
  }
  return s;
}

// ── The curve ────────────────────────────────────────────────────────────────

describe('levelPosition / levelParams', () => {
  it('maps level numbers to stages of LEVELS_PER_STAGE', () => {
    expect(LEVELS_PER_STAGE).toBe(5);
    expect(levelPosition(1)).toEqual({ stage: 1, level: 1 });
    expect(levelPosition(5)).toEqual({ stage: 1, level: 5 });
    expect(levelPosition(6)).toEqual({ stage: 2, level: 1 });
    expect(levelPosition(30)).toEqual({ stage: 6, level: 5 });
  });

  it('rejects invalid level numbers', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => levelPosition(bad)).toThrow(RangeError);
      expect(() => createLevel(bad)).toThrow(RangeError);
    }
    expect(() => levelParams(1, 0)).toThrow(RangeError);
    expect(() => levelParams(1, LEVELS_PER_STAGE + 1)).toThrow(RangeError);
    expect(() => levelParams(0, 1)).toThrow(RangeError);
  });

  it('every stage follows the owner curve: lines, crossing, scripting, the split gap', () => {
    for (let stage = 1; stage <= 50; stage++) {
      const ps = [1, 2, 3, 4, 5].map((l) => levelParams(stage, l));
      expect(ps.map((p) => p.targetLines)).toEqual([1, 2, 2, 3, 3]);
      expect(ps.map((p) => p.crossLines)).toEqual([0, 0, 1, 1, 1]); // L3+: a row crosses a column
      expect(ps.map((p) => p.scripted)).toEqual([3, 3, 3, 2, 0]); // fully → partly → generator
      expect(ps.map((p) => p.bigGap)).toEqual([false, false, false, false, true]);
      expect(ps.map((p) => [p.minMoves, p.maxMoves])).toEqual([[3, 3], [4, 4], [5, 5], [6, 7], [8, 9]]);
    }
  });

  it('within a stage, move ranges rise strictly and the help (generosity, goal bias) rises too', () => {
    for (let stage = 1; stage <= 50; stage++) {
      for (let l = 2; l <= LEVELS_PER_STAGE; l++) {
        const a = levelParams(stage, l - 1);
        const b = levelParams(stage, l);
        expect(b.minMoves).toBeGreaterThan(a.maxMoves);
        expect(b.generosity).toBeGreaterThanOrEqual(a.generosity);
        expect(b.goalBias).toBeGreaterThanOrEqual(a.goalBias);
        for (const f of a.holeFamilies) expect(b.holeFamilies).toContain(f);
      }
    }
  });

  it('holes are always VARIED shapes (L, T, 2×2 and bars, never just dots and short bars)', () => {
    for (let stage = 1; stage <= 50; stage++) {
      for (let l = 1; l <= LEVELS_PER_STAGE; l++) {
        const fams = levelParams(stage, l).holeFamilies;
        for (const f of ['L', 'T', 'square', 'line3']) expect(fams).toContain(f);
        for (const f of fams) expect(PIECES.some((p) => familyOf(p.id) === f)).toBe(true);
      }
    }
  });

  it('later stages are a little harder overall (never easier in the same slot)', () => {
    for (let stage = 2; stage <= 50; stage++) {
      for (let l = 1; l <= LEVELS_PER_STAGE; l++) {
        const a = levelParams(stage - 1, l);
        const b = levelParams(stage, l);
        for (const f of a.holeFamilies) expect(b.holeFamilies).toContain(f);
        expect(b.generosity).toBeLessThanOrEqual(a.generosity);
      }
    }
    // Piece variety follows EFFECTIVE difficulty: a later stage's L1 already
    // draws the longer bars that stage 1 saves for its second half.
    expect(levelParams(1, 1).holeFamilies).not.toContain('line4');
    expect(levelParams(3, 1).holeFamilies).toContain('line4');
    expect(levelParams(3, 1).generosity).toBeLessThan(levelParams(1, 1).generosity);
  });

  it('returns fresh params: mutating one never leaks into another call', () => {
    const a = levelParams(2, 4);
    (a.holeFamilies as string[]).push('bogus');
    expect(levelParams(2, 4).holeFamilies).not.toContain('bogus');
    expect(levelParams(3, 4).holeFamilies).not.toContain('bogus');
  });

  it('the level plays with its own generator options', () => {
    const p = levelParams(2, 3);
    expect(levelGenOptions(p)).toEqual({ generosity: p.generosity, goalBias: p.goalBias });
  });
});

// ── Construction ────────────────────────────────────────────────────────────

describe('createLevel', () => {
  const levels: Level[] = Array.from({ length: LEVELS }, (_, i) => cachedLevel(i + 1));

  it('is deterministic in the level number and stamped with LEVEL_GEN_VERSION', SLOW, () => {
    for (const level of levels.slice(0, 15)) {
      expect(createLevel(level.levelNumber)).toEqual(level);
      expect(level.genVersion).toBe(LEVEL_GEN_VERSION);
      expect(level.start.seed).toBe(levelSeed(level.levelNumber));
      const { stage, level: inStage } = levelPosition(level.levelNumber);
      expect(level.params).toEqual(levelParams(stage, inStage));
      expect(level.gen).toEqual(levelGenOptions(level.params));
    }
  });

  // (Two one-line L1 boards can coincide — a single row with three holes has
  // few layouts — but the level as a whole, tray included, still differs.)
  it('different level numbers give different levels', () => {
    expect(new Set(levels.map((l) => JSON.stringify(l.start))).size).toBe(LEVELS);
    expect(new Set(levels.map((l) => JSON.stringify(l.start.board))).size).toBeGreaterThanOrEqual(LEVELS - 3);
  });

  it('NEVER starts with a complete line, and always has goals to clear', () => {
    for (const { start } of levels) {
      expect(findFullLines(start.board)).toEqual({ rows: [], cols: [] });
      expect(start.board.includes(GOAL)).toBe(true);
      expect(isLevelComplete(start)).toBe(false);
    }
  });

  it('tiles sit only on its target lines (the curve’s count and crossing), each with 1–3 goals and a hole', () => {
    for (const level of levels) {
      const { start, params, targets } = level;
      for (const r of targets.rows) expect(tiledLines(start.board, true)).toContain(r);
      const lines = [
        ...targets.rows.map((r) => Array.from({ length: BOARD_SIZE }, (_, j) => start.board[r * BOARD_SIZE + j]!)),
        ...targets.cols.map((c) => Array.from({ length: BOARD_SIZE }, (_, j) => start.board[j * BOARD_SIZE + c]!)),
      ];
      expect(lines.length).toBe(params.targetLines);
      const cross = Math.min(targets.rows.length, targets.cols.length);
      expect(cross).toBe(params.crossLines);
      for (const line of lines) {
        expect(line.includes(0)).toBe(true);
        expect(line.filter((v) => v === GOAL).length).toBeGreaterThanOrEqual(1);
      }
      start.board.forEach((v, i) => {
        if (v === 0) return;
        const r = Math.floor(i / BOARD_SIZE);
        const c = i % BOARD_SIZE;
        expect(targets.rows.includes(r) || targets.cols.includes(c)).toBe(true);
      });
    }
  });

  it('holes are catalog shapes (one per hole); on L5 exactly one gap needs more than one piece', () => {
    for (const level of levels) {
      const regions = holeRegions(level);
      const odd = regions.filter((g) => !CATALOG_SHAPES.has(shapeKey(g)));
      expect(odd.length).toBe(level.params.bigGap ? 1 : 0);
      expect(regions.length - odd.length).toBeGreaterThanOrEqual(level.params.minHoles);
      expect(regions.length - odd.length).toBeLessThanOrEqual(level.params.maxHoles);
    }
  });

  it('the first tray holds at least `scripted` hole pieces (the rest come from the generator)', () => {
    for (const level of levels) {
      const holeShapes = holeRegions(level).map(shapeKey);
      const fits = level.start.tray.filter((p) => p && holeShapes.includes(shapeKey(p.cells))).length;
      expect(fits).toBeGreaterThanOrEqual(level.params.scripted);
      expect(level.start.tray.every((p) => p !== null)).toBe(true);
      expect(level.start.score).toBe(0);
    }
  });

  it('its built-in solution wins, in the curve’s move range, and nothing shorter exists', SLOW, () => {
    for (const level of levels) {
      expect(isLevelComplete(playSolution(level))).toBe(true);
      expect(level.solution.length).toBeGreaterThanOrEqual(level.params.minMoves);
      expect(level.solution.length).toBeLessThanOrEqual(level.params.maxMoves);
      // An independent solve one move shorter finds nothing: the count is minimal.
      expect(solveLevel(level.start, level.gen, level.targets, level.solution.length - 1)).toBeNull();
      // And no proper prefix of the solution wins already.
      let s = level.start;
      for (const m of level.solution.slice(0, -1)) {
        const res = applyMove(s, m.slot, m.r, m.c, level.gen);
        if (!res.ok) throw new Error(res.error);
        s = res.result.state;
        expect(isLevelComplete(s)).toBe(false);
      }
    }
  });

  // The owner's ramp, measured: what a PERFECT player needs rises through
  // every stage (3 → 4 → 5 → 6–7 → 8–9) and resets at the next. Fully
  // deterministic: the counts are properties of the seeded levels.
  it('perfect-play moves RISE strictly across each stage, and reset at the next', () => {
    for (let stage = 1; stage <= STAGES; stage++) {
      const moves = [1, 2, 3, 4, 5].map((l) => levels[(stage - 1) * LEVELS_PER_STAGE + l - 1]!.solution.length);
      for (let i = 1; i < moves.length; i++) expect(moves[i]!).toBeGreaterThan(moves[i - 1]!);
      expect(moves[0]).toBe(3);
      expect(moves[4]!).toBeGreaterThanOrEqual(8);
    }
  });

  it('is a valid saved game and a valid level save', () => {
    for (const level of levels.slice(0, 50)) {
      expect(parseGameState(JSON.parse(JSON.stringify(level.start)))).toEqual(level.start);
      const save = {
        levelNumber: level.levelNumber,
        genVersion: level.genVersion,
        start: level.start,
        history: createHistory(level.start),
      };
      expect(parseLevelSave(JSON.parse(JSON.stringify(save)))).toEqual(save);
    }
  });
});

// ── Golden snapshots ─────────────────────────────────────────────────────────
//
// A level number must reproduce the SAME level forever (a saved level, or a
// favorite she replays, must not silently change). These hashes pin every
// field of createLevel(n) for n = 1..30.
//
// If one fails, you changed level generation (the algorithm, levelParams, the
// solver, the playtest filter, the generator, the piece catalog, the order of
// RNG calls...). If that was NOT intended, fix the change. If it WAS intended:
// bump LEVEL_GEN_VERSION in src/core/game.ts (in-progress saves of the old
// version are then discarded), set GOLDEN_VERSION below to match, regenerate
// this table by printing `levelHash(createLevel(n))` for n = 1..30 (helpers.ts),
// and add the new aggregate hash in level-gen-edge.test.ts.

const GOLDEN_VERSION = 2;

const GOLDEN: readonly string[] = [
  '41d32700', 'e1abcf26', 'c17b65dc', '06601f41', 'ca477fe9', // 1–5
  'f634a90b', '1890df3f', '57ecd82b', 'f7281737', '0f5d8fa0', // 6–10
  '1f7b8b42', 'fb1e0352', 'cdc3a28f', 'c74831fb', '601db153', // 11–15
  '1e4df7f9', 'e6728c5a', '3a62903e', '9dfe4fdb', '043c06d5', // 16–20
  '1a488789', 'a31cf8ae', '8ebab7dd', 'b8364830', '5be621cd', // 21–25
  '4d878d6f', '872058c1', 'f2558bc5', 'c61ac9a8', '26f4658d', // 26–30
];

describe('golden snapshots of levels 1–30', () => {
  it('the table is for the current LEVEL_GEN_VERSION', () => {
    expect(LEVEL_GEN_VERSION).toBe(GOLDEN_VERSION);
  });

  it('createLevel(1..30) matches the pinned hashes', () => {
    const actual = Array.from({ length: 30 }, (_, i) => levelHash(cachedLevel(i + 1)));
    expect(actual).toEqual(GOLDEN);
  });

  it('level 1 looks exactly as pinned (a readable spot check)', () => {
    const { start, solution } = cachedLevel(1);
    const rows = Array.from({ length: BOARD_SIZE }, (_, r) =>
      start.board
        .slice(r * BOARD_SIZE, (r + 1) * BOARD_SIZE)
        .map((v) => (v === 0 ? '.' : v === GOAL ? 'G' : '#'))
        .join(''),
    );
    expect({ rows, tray: start.tray.map((p) => p!.id), moves: solution.length }).toEqual(LEVEL_1);
  });
});

/** Level 1: one row, three holes (two dots and a 2-bar), solved in 3 moves. */
const LEVEL_1 = {
  rows: [
    '........',
    '........',
    '........',
    '........',
    '........',
    '........',
    'G.G..G#.',
    '........',
  ],
  tray: ['dot-0', 'dot-0', 'line2-0'],
  moves: 3,
};
