/**
 * Level generation (PR B2): difficulty knobs, construction guarantees, and
 * GOLDEN SNAPSHOTS of levels 1–30.
 *
 * Solvability and the anti-slog check live in invariants.test.ts.
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
  type Level,
} from '../src/core/index.ts';
import { findFullLines } from '../src/core/grid.ts';
import { parseLevelSave } from '../src/pwa/storage.ts';

const LEVELS = 300;

/** Every ordering of [0, 1, 2]. */
const ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

/** Indices of the rows (or columns) that hold any tile. */
function linesWithTiles(board: readonly number[], rows: boolean): number[] {
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

/**
 * A level's target lines: whichever direction has exactly `targetLines` lines
 * holding tiles. (Never both: that would need >= 8 - k holes in each of k
 * lines, more than maxHoleCells allows.)
 */
function targetsOf({ start, params }: Level): { byRows: boolean; targets: number[] } {
  const rows = linesWithTiles(start.board, true);
  const byRows = rows.length === params.targetLines;
  return { byRows, targets: byRows ? rows : linesWithTiles(start.board, false) };
}

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

  it('ramps within a stage, resets at the next, and stays in range', () => {
    for (let stage = 1; stage <= 10; stage++) {
      const ps = [1, 2, 3, 4, 5].map((l) => levelParams(stage, l));
      for (const p of ps) {
        expect(p.targetLines).toBeGreaterThanOrEqual(1);
        expect(p.targetLines).toBeLessThanOrEqual(4);
        expect(p.minHoleCells).toBeLessThanOrEqual(p.maxHoleCells);
        expect(p.generosity).toBeGreaterThan(0);
      }
      for (let i = 1; i < ps.length; i++) {
        // Harder (or equal) each level: more lines, a wider piece set, less generosity.
        expect(ps[i]!.targetLines).toBeGreaterThanOrEqual(ps[i - 1]!.targetLines);
        expect(ps[i]!.holeFamilies.length).toBeGreaterThanOrEqual(ps[i - 1]!.holeFamilies.length);
        expect(ps[i]!.generosity).toBeLessThanOrEqual(ps[i - 1]!.generosity);
      }
      // Generosity: high at the start, moderate (but still kind) at the end.
      expect(ps[0]!.generosity).toBeGreaterThan(ps[4]!.generosity);
      expect(ps[4]!.generosity).toBeGreaterThanOrEqual(1);
      // A new stage starts easy again: easier than the previous stage's end,
      // and no easier than the previous stage's start.
      if (stage > 1) {
        const prevStart = levelParams(stage - 1, 1);
        const prevEnd = levelParams(stage - 1, LEVELS_PER_STAGE);
        expect(ps[0]!.targetLines).toBeLessThan(prevEnd.targetLines);
        expect(ps[0]!.targetLines).toBeGreaterThanOrEqual(prevStart.targetLines);
      }
    }
    expect(levelParams(1, 1).targetLines).toBe(1);
  });

  it('the level plays with its own generator options', () => {
    const p = levelParams(2, 3);
    expect(levelGenOptions(p)).toEqual({ generosity: p.generosity, goalBias: p.goalBias });
  });
});

describe('createLevel', () => {
  const levels: Level[] = Array.from({ length: LEVELS }, (_, i) => createLevel(i + 1));

  it('is deterministic in the level number and stamped with LEVEL_GEN_VERSION', () => {
    for (const level of levels.slice(0, 50)) {
      expect(createLevel(level.levelNumber)).toEqual(level);
      expect(level.genVersion).toBe(LEVEL_GEN_VERSION);
      expect(level.start.seed).toBe(levelSeed(level.levelNumber));
      const { stage, level: inStage } = levelPosition(level.levelNumber);
      expect(level.params).toEqual(levelParams(stage, inStage));
      expect(level.gen).toEqual(levelGenOptions(level.params));
    }
  });

  it('different level numbers give different levels', () => {
    const boards = new Set(levels.map((l) => JSON.stringify(l.start.board)));
    expect(boards.size).toBe(LEVELS);
  });

  it('NEVER starts with a complete line, and always has goals to clear', () => {
    for (const { start } of levels) {
      expect(findFullLines(start.board)).toEqual({ rows: [], cols: [] });
      expect(start.board.includes(GOAL)).toBe(true);
      expect(isLevelComplete(start)).toBe(false);
    }
  });

  it('tiles sit only on the parallel target lines, each with a goal and a hole', () => {
    for (const level of levels) {
      const { start, params } = level;
      const { byRows, targets } = targetsOf(level);
      expect(targets.length).toBe(params.targetLines);
      for (const t of targets) {
        const line = Array.from({ length: BOARD_SIZE }, (_, j) =>
          start.board[byRows ? t * BOARD_SIZE + j : j * BOARD_SIZE + t],
        );
        const goals = line.filter((v) => v === GOAL).length;
        expect(goals).toBeGreaterThanOrEqual(1);
        expect(goals).toBeLessThanOrEqual(3);
        expect(line.includes(0)).toBe(true);
      }
    }
  });

  it('the first tray is exactly the hole pieces: three of them, from the allowed families, filling every target-line hole', () => {
    for (const level of levels) {
      const { start, params, solution } = level;
      expect(start.tray.every((p) => p !== null)).toBe(true);
      expect(start.score).toBe(0);
      for (const p of start.tray) expect(params.holeFamilies).toContain(p!.id.replace(/-\d+$/, ''));
      const holeCells = start.tray.reduce((a, p) => a + p!.cells.length, 0);
      expect(holeCells).toBeGreaterThanOrEqual(params.minHoleCells);
      expect(holeCells).toBeLessThanOrEqual(params.maxHoleCells);
      // The holes are exactly the empty cells of the target (tile-holding) lines.
      const { byRows, targets: t } = targetsOf(level);
      const targets = new Set(t);
      const empties = start.board.flatMap((v, i) => {
        const line = byRows ? Math.floor(i / BOARD_SIZE) : i % BOARD_SIZE;
        return v === 0 && targets.has(line) ? [i] : [];
      });
      const covered = solution.flatMap((m) =>
        start.tray[m.slot]!.cells.map((p) => (m.r + p.r) * BOARD_SIZE + (m.c + p.c)),
      );
      expect([...covered].sort((a, b) => a - b)).toEqual(empties);
      expect(new Set(solution.map((m) => m.slot)).size).toBe(3);
    }
  });

  it('its solution wins in ANY order of the three placements', () => {
    for (const level of levels) {
      for (const order of ORDERS) {
        let s = level.start;
        for (const i of order) {
          const m = level.solution[i]!;
          const res = applyMove(s, m.slot, m.r, m.c, level.gen);
          if (!res.ok) throw new Error(`level ${level.levelNumber} order ${order}: ${res.error}`);
          s = res.result.state;
        }
        expect(isLevelComplete(s)).toBe(true);
      }
    }
  });

  it('is a valid saved game and a valid level save', () => {
    for (const level of levels.slice(0, 50)) {
      const json = JSON.parse(JSON.stringify(level.start));
      expect(parseGameState(json)).toEqual(level.start);
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
// piece catalog, the order of RNG calls...). If that was NOT intended, fix the
// change. If it WAS intended: bump LEVEL_GEN_VERSION in src/core/game.ts
// (in-progress saves of the old version are then discarded), set
// GOLDEN_VERSION below to match, and regenerate the table by printing
// `levelHash(createLevel(n))` for n = 1..30.

const GOLDEN_VERSION = 1;

/** 32-bit FNV-1a of the level's JSON, as 8 hex digits. */
function levelHash(level: Level): string {
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify(level)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const GOLDEN: readonly string[] = [
  'bd451a96', '328013c8', '5ef0ab50', 'cbeef456', 'fc438f0e', // 1–5
  '6d80a5f6', '669a74e9', '602cc0f3', '012646d5', 'bc751d1f', // 6–10
  'db309653', 'ae1ca396', '1e452765', '226684fe', 'ef42e5e4', // 11–15
  '870281ba', 'bf43f1e3', '89cbd1c0', '8ad4bd2b', '999a84be', // 16–20
  'dbd6b8cf', '1ff3843d', '43edcefd', 'e325e3e4', '2c32d33b', // 21–25
  '2826b4ff', 'e3f1db0f', 'c0a529d5', '5e252977', '5b5e2aca', // 26–30
];

describe('golden snapshots of levels 1–30', () => {
  it('the table is for the current LEVEL_GEN_VERSION', () => {
    expect(LEVEL_GEN_VERSION).toBe(GOLDEN_VERSION);
  });

  it('createLevel(1..30) matches the pinned hashes', () => {
    const actual = Array.from({ length: 30 }, (_, i) => levelHash(createLevel(i + 1)));
    expect(actual).toEqual(GOLDEN);
  });

  it('level 1 looks exactly as pinned (a readable spot check)', () => {
    const { start } = createLevel(1);
    const rows = Array.from({ length: BOARD_SIZE }, (_, r) =>
      start.board
        .slice(r * BOARD_SIZE, (r + 1) * BOARD_SIZE)
        .map((v) => (v === 0 ? '.' : v === GOAL ? 'G' : '#'))
        .join(''),
    );
    expect(rows).toEqual([
      '........',
      '........',
      '........',
      '.###.G#.',
      '........',
      '........',
      '........',
      '........',
    ]);
    expect(start.tray.map((p) => p!.id)).toEqual(['dot-0', 'dot-0', 'dot-0']);
  });
});
