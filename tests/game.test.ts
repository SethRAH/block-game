import { describe, it, expect } from 'vitest';
import {
  applyMove,
  canPlaceAt,
  canUndo,
  commit,
  createHistory,
  isStuck,
  newGame,
  parseGameState,
  parseHistory,
  previewClears,
  scoreFor,
  swapTray,
  undo,
  CELL_COUNT,
  type GameState,
} from '../src/core/index.ts';
import { anyFits, boardFrom, piece, stateWith } from './helpers.ts';

/** All cells filled except the main diagonal: no line is full, only a dot fits. */
const DIAGONAL_HOLES = boardFrom([
  '.#######',
  '#.######',
  '##.#####',
  '###.####',
  '####.###',
  '#####.##',
  '######.#',
  '#######.',
]);

function ok(res: ReturnType<typeof applyMove>) {
  if (!res.ok) throw new Error(`move failed: ${res.error}`);
  return res.result;
}

describe('newGame', () => {
  it('starts with an empty board, a full tray, score 0', () => {
    const s = newGame(42);
    expect(s.board).toHaveLength(CELL_COUNT);
    expect(s.board.every((v) => v === 0)).toBe(true);
    expect(s.tray.every((p) => p !== null)).toBe(true);
    expect(s.score).toBe(0);
    expect(s.seed).toBe(42);
  });

  it('is plain JSON (round-trips unchanged)', () => {
    const s = newGame(7);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('same seed → same state; different seeds usually differ', () => {
    expect(newGame(9)).toEqual(newGame(9));
    const trays = new Set(Array.from({ length: 20 }, (_, i) => JSON.stringify(newGame(i).tray)));
    expect(trays.size).toBeGreaterThan(1);
  });
});

describe('applyMove', () => {
  const base = stateWith(boardFrom(Array(8).fill('........')), [piece('line3-0'), piece('dot-0'), null]);

  it('rejects with fixed precedence and never mutates', () => {
    const before = JSON.stringify(base);
    expect(applyMove(base, 3, 0, 0)).toEqual({ ok: false, error: 'invalid-slot' });
    expect(applyMove(base, -1, 0, 0)).toEqual({ ok: false, error: 'invalid-slot' });
    expect(applyMove(base, 1.5, 0, 0)).toEqual({ ok: false, error: 'invalid-slot' });
    expect(applyMove(base, 2, 99, 99)).toEqual({ ok: false, error: 'empty-slot' });
    expect(applyMove(base, 0, 0, 6)).toEqual({ ok: false, error: 'out-of-bounds' });
    const blocked = stateWith(boardFrom(['#.......', ...Array(7).fill('........')]), base.tray);
    expect(applyMove(blocked, 0, 0, 0)).toEqual({ ok: false, error: 'overlap' });
    // out-of-bounds beats overlap
    expect(applyMove(blocked, 0, 0, 7)).toEqual({ ok: false, error: 'out-of-bounds' });
    expect(JSON.stringify(base)).toBe(before);
  });

  it('canPlaceAt and previewClears agree with applyMove everywhere', () => {
    const s = newGame(3);
    for (let slot = -1; slot <= 3; slot++) {
      for (let r = -2; r < 10; r++) {
        for (let c = -2; c < 10; c++) {
          const res = applyMove(s, slot, r, c);
          expect(canPlaceAt(s, slot, r, c)).toBe(res.ok);
          const prev = previewClears(s, slot, r, c);
          if (res.ok) expect(prev).toEqual(res.result.cleared);
          else expect(prev).toBeNull();
        }
      }
    }
  });

  it('places a piece, scores per cell, and empties the slot', () => {
    const r = ok(applyMove(base, 0, 4, 2));
    expect(r.state.tray).toEqual([null, piece('dot-0'), null]);
    expect(r.scoreDelta).toBe(scoreFor(3, 0));
    expect(r.state.score).toBe(3);
    expect(r.cleared).toEqual({ rows: [], cols: [] });
    expect(r.state.board.filter((v) => v !== 0)).toHaveLength(3);
  });

  it('clears a full row and a full column in one move, with a combo bonus', () => {
    const board = boardFrom([
      '###.####',
      '...#....',
      '...#....',
      '...#....',
      '...#....',
      '...#....',
      '...#....',
      '...#....',
    ]);
    // The dot at (0,3) completes row 0 and column 3 at once.
    const s = stateWith(board, [piece('dot-0'), piece('line2-0'), null]);
    const r = ok(applyMove(s, 0, 0, 3));
    expect(r.cleared).toEqual({ rows: [0], cols: [3] });
    expect(r.state.board.every((v) => v === 0)).toBe(true);
    expect(r.scoreDelta).toBe(scoreFor(1, 2));
    expect(scoreFor(1, 2)).toBeGreaterThan(1 + 2 * (scoreFor(1, 1) - 1)); // combo > 2 singles
  });

  it('refills the tray when the last piece is placed (advancing the rng)', () => {
    const s = stateWith(boardFrom(Array(8).fill('........')), [null, piece('dot-0'), null]);
    const r = ok(applyMove(s, 1, 0, 0));
    expect(r.state.tray.every((p) => p !== null)).toBe(true);
    expect(r.state.rngState).not.toBe(s.rngState);
    expect(anyFits(r.state)).toBe(true);
  });

  it('never swaps leftover pieces, even when they no longer fit', () => {
    // Placing the dot leaves only diagonal holes; the leftover square can't fit.
    const board = DIAGONAL_HOLES.slice();
    board[1] = 0; // extra hole at (0,1) for the dot
    const s = stateWith(board, [piece('dot-0'), piece('square-0'), null]);
    const r = ok(applyMove(s, 0, 0, 1));
    expect(r.state.tray).toEqual([null, piece('square-0'), null]);
    expect(r.state.rngState).toBe(s.rngState);
    expect(isStuck(r.state)).toBe(true);
  });

  it('filling the last empty cell clears the whole board (so the dot always fits)', () => {
    const board = boardFrom(['.#######', ...Array(7).fill('########')]);
    const s = stateWith(board, [piece('dot-0'), piece('line2-0'), null]);
    const r = ok(applyMove(s, 0, 0, 0));
    expect(r.cleared.rows).toHaveLength(8);
    expect(r.cleared.cols).toHaveLength(8);
    expect(r.state.board.every((v) => v === 0)).toBe(true);
  });

  it('score never goes down', () => {
    for (let cells = 1; cells <= 5; cells++) {
      for (let lines = 0; lines <= 16; lines++) expect(scoreFor(cells, lines)).toBeGreaterThan(0);
    }
  });
});

describe('isStuck / swapTray (the visible rescue)', () => {
  const stuck: GameState = stateWith(DIAGONAL_HOLES, [piece('line2-0'), piece('square-0'), null]);

  it('isStuck is true only when no remaining piece fits', () => {
    expect(isStuck(stuck)).toBe(true);
    expect(isStuck(stateWith(DIAGONAL_HOLES, [piece('line2-0'), piece('dot-0'), null]))).toBe(false);
    expect(isStuck(newGame(1))).toBe(false);
  });

  it('swapTray yields a fit, keeps used slots empty, and leaves board/score alone', () => {
    const s = swapTray({ ...stuck, score: 50 });
    expect(anyFits(s)).toBe(true);
    expect(isStuck(s)).toBe(false);
    expect(s.tray[2]).toBeNull();
    expect(s.tray[0]).not.toBeNull();
    expect(s.tray[1]).not.toBeNull();
    expect(s.board).toEqual(stuck.board);
    expect(s.score).toBe(50);
    expect(s.rngState).not.toBe(stuck.rngState);
  });

  it('swapTray is deterministic', () => {
    expect(swapTray(stuck)).toEqual(swapTray(stuck));
  });

  it('swapTray works at any time, not only when stuck', () => {
    const s = swapTray(newGame(5));
    expect(s.tray.every((p) => p !== null)).toBe(true);
    expect(anyFits(s)).toBe(true);
  });
});

describe('undo history', () => {
  it('each undo goes back exactly one move, including refills and swaps', () => {
    const s0 = newGame(11);
    let h = createHistory(s0);
    expect(canUndo(h)).toBe(false);
    const s1 = swapTray(s0);
    h = commit(h, s1);
    const r = ok(applyMove(s1, 0, 0, 0));
    h = commit(h, r.state);
    expect(h.present).toEqual(r.state);
    h = undo(h);
    expect(h.present).toEqual(s1);
    h = undo(h);
    expect(h.present).toEqual(s0);
    expect(canUndo(h)).toBe(false);
    expect(undo(h)).toBe(h); // no-op
  });

  it('a new game starts with an empty history', () => {
    expect(createHistory(newGame(2)).past).toEqual([]);
  });
});

describe('serialize (save validation)', () => {
  it('round-trips a real game and a history', () => {
    const s = ok(applyMove(newGame(4), 0, 0, 0)).state;
    expect(parseGameState(JSON.parse(JSON.stringify(s)))).toEqual(s);
    const h = commit(createHistory(newGame(4)), s);
    expect(parseHistory(JSON.parse(JSON.stringify(h)))).toEqual(h);
  });

  it('rejects corrupt or mismatched data instead of throwing', () => {
    const s = newGame(4);
    const bad: unknown[] = [
      null,
      42,
      'x',
      {},
      { ...s, board: s.board.slice(1) },
      { ...s, board: s.board.map(() => 1) },
      { ...s, board: s.board.map((_, i) => (i === 0 ? 99 : 0)) },
      { ...s, tray: [{ id: 'nope' }, null, null] },
      { ...s, tray: [null, null, null] },
      { ...s, tray: s.tray.slice(0, 2) },
      { ...s, score: -1 },
      { ...s, rngState: 1.5 },
      { ...s, seed: 'a' },
    ];
    for (const b of bad) expect(parseGameState(b)).toBeNull();
    expect(parseHistory({ past: [{}], present: s })).toBeNull();
    expect(parseHistory({ present: s })).toBeNull();
  });

  it('rehydrates tray pieces from the catalog by id', () => {
    const s = newGame(4);
    const tampered = { ...s, tray: s.tray.map((p) => (p ? { ...p, cells: [] } : p)) };
    expect(parseGameState(tampered)?.tray).toEqual(s.tray);
  });
});
