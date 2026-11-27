/**
 * Edge-case coverage complementing game.test.ts / invariants.test.ts:
 * multi-line clears + combo scoring, nearly-full boards, isStuck boundaries
 * (pieces that fit only at the last legal row/column), long undo chains
 * through swaps and refills, and save-validation edge cases.
 */
import { describe, it, expect } from 'vitest';
import {
  applyMove,
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
  BOARD_SIZE,
  COMBO_STEP,
  POINTS_PER_CELL,
  POINTS_PER_LINE,
  type GameState,
  type History,
} from '../src/core/index.ts';
import { act, anyFits, boardFrom, chooseAction, piece, stateWith, type Action } from './helpers.ts';
import { createRng } from '../src/core/rng.ts';
import { drawTray } from '../src/core/generator.ts';
import { emptyBoard } from '../src/core/grid.ts';

function ok(res: ReturnType<typeof applyMove>) {
  if (!res.ok) throw new Error(`move failed: ${res.error}`);
  return res.result;
}

/** (r + c) even → filled. No full lines, and nothing larger than a dot fits. */
function checkerboard(): number[] {
  return Array.from({ length: BOARD_SIZE * BOARD_SIZE }, (_, i) =>
    (Math.floor(i / BOARD_SIZE) + (i % BOARD_SIZE)) % 2 === 0 ? 1 : 0,
  );
}

function transpose(board: readonly number[]): number[] {
  return board.map((_, i) => board[(i % BOARD_SIZE) * BOARD_SIZE + Math.floor(i / BOARD_SIZE)]!);
}

// ── Multi-line clears & combo scoring ───────────────────────────────────────

describe('multi-line clears and combo scoring', () => {
  it('scoreFor matches its documented formula for every cell/line count', () => {
    // Arrange
    const cases: Array<[number, number]> = [];
    for (let cells = 1; cells <= 5; cells++) for (let lines = 0; lines <= 16; lines++) cases.push([cells, lines]);

    for (const [cells, lines] of cases) {
      // Act
      const got = scoreFor(cells, lines);
      // Assert
      const expected =
        cells * POINTS_PER_CELL + lines * POINTS_PER_LINE + COMBO_STEP * lines * Math.max(0, lines - 1);
      expect(got).toBe(expected);
    }
  });

  it('combo bonus is strictly superadditive: each extra line is worth more than the previous one', () => {
    for (let cells = 1; cells <= 5; cells++) {
      for (let lines = 2; lines <= 16; lines++) {
        // Arrange
        const prevStep = scoreFor(cells, lines - 1) - scoreFor(cells, lines - 2);
        // Act
        const step = scoreFor(cells, lines) - scoreFor(cells, lines - 1);
        // Assert
        expect(step).toBeGreaterThan(prevStep);
      }
    }
  });

  it('a horizontal line5 clears 1 row + 5 columns (6 lines) and scores the combo', () => {
    // Arrange
    const board = boardFrom(['.....###', ...Array<string>(7).fill('#####...')]);
    const s = stateWith(board, [piece('line5-0'), piece('dot-0'), null], { score: 100 });

    // Act
    const r = ok(applyMove(s, 0, 0, 0));

    // Assert
    expect(r.cleared).toEqual({ rows: [0], cols: [0, 1, 2, 3, 4] });
    expect(r.scoreDelta).toBe(scoreFor(5, 6));
    expect(r.state.score).toBe(100 + scoreFor(5, 6));
    expect(r.state.board.every((v) => v === 0)).toBe(true);
  });

  it('an L clears 3 rows + 2 columns at once (5 lines)', () => {
    // Arrange: L-0 = (0,0),(1,0),(2,0),(2,1)
    const L = piece('L-0');
    expect(L.cells).toEqual([
      { r: 0, c: 0 },
      { r: 1, c: 0 },
      { r: 2, c: 0 },
      { r: 2, c: 1 },
    ]);
    const board = boardFrom([
      '.#######',
      '.#######',
      '..######',
      '##......',
      '##......',
      '##......',
      '##......',
      '##......',
    ]);
    const s = stateWith(board, [null, L, piece('dot-0')]);

    // Act
    const r = ok(applyMove(s, 1, 0, 0));

    // Assert
    expect(r.cleared).toEqual({ rows: [0, 1, 2], cols: [0, 1] });
    expect(r.scoreDelta).toBe(scoreFor(4, 5));
    expect(r.state.board.every((v) => v === 0)).toBe(true);
  });

  it('on a nearly-full board (only the anti-diagonal empty) each dot clears exactly its row + column', () => {
    // Arrange: 56 filled cells, no full line.
    const rows = ['#######.', '######.#', '#####.##', '####.###', '###.####', '##.#####', '#.######', '.#######'];
    const s = stateWith(boardFrom(rows), [piece('dot-0'), piece('dot-0'), piece('square-0')]);

    // Act
    const r = ok(applyMove(s, 0, 0, 7));

    // Assert
    expect(r.cleared).toEqual({ rows: [0], cols: [7] });
    expect(r.scoreDelta).toBe(scoreFor(1, 2));
    // Everything not in row 0 / col 7 is untouched; the other 7 holes remain.
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const v = r.state.board[row * BOARD_SIZE + col];
        if (row === 0 || col === 7) expect(v).toBe(0);
        else expect(v).toBe(row + col === 7 ? 0 : 1);
      }
    }
    // The clear opened up space: the leftover square now fits at (0,6) — (1,6) was a hole.
    expect(applyMove(r.state, 2, 0, 6).ok).toBe(true);
    expect(isStuck(r.state)).toBe(false);
  });

  it('cells outside the cleared lines keep their palette colours', () => {
    // Arrange: row 0 full except (0,7); col 7 otherwise empty; some coloured debris elsewhere.
    const board = boardFrom(['#######.', ...Array<string>(7).fill('........')]);
    board[2 * BOARD_SIZE + 3] = 5;
    board[6 * BOARD_SIZE + 1] = 8;
    const s = stateWith(board, [piece('dot-0'), null, piece('square-0')]);

    // Act
    const r = ok(applyMove(s, 0, 0, 7));

    // Assert
    expect(r.cleared).toEqual({ rows: [0], cols: [] });
    const expected = new Array<number>(64).fill(0);
    expected[2 * BOARD_SIZE + 3] = 5;
    expected[6 * BOARD_SIZE + 1] = 8;
    expect(r.state.board).toEqual(expected);
  });

  it('previewClears reports the same multi-line set the move then clears', () => {
    // Arrange
    const board = boardFrom(['.....###', ...Array<string>(7).fill('#####...')]);
    const s = stateWith(board, [piece('line5-0'), null, null]);

    // Act
    const preview = previewClears(s, 0, 0, 0);
    const r = ok(applyMove(s, 0, 0, 0));

    // Assert
    expect(preview).toEqual(r.cleared);
  });

  it('placing the last piece and clearing lines in the same move refills from the CLEARED board', () => {
    // Arrange: the dot completes row 0, leaving an empty board; generosity weights depend on
    // the board, so drawing against the pre-clear board would give a different tray.
    const board = boardFrom(['#######.', ...Array<string>(7).fill('........')]);
    const s = stateWith(board, [null, piece('dot-0'), null]);
    const expectedRng = createRng(s.seed, s.rngState);
    const expectedTray = drawTray(emptyBoard(), expectedRng);

    // Act
    const r = ok(applyMove(s, 1, 0, 7));

    // Assert
    expect(r.cleared.rows).toEqual([0]);
    expect(r.state.board.every((v) => v === 0)).toBe(true);
    expect(r.state.tray).toEqual(expectedTray);
    expect(r.state.rngState).toBe(expectedRng.getState());
    expect(anyFits(r.state)).toBe(true);
  });
});

// ── isStuck boundaries ──────────────────────────────────────────────────────

describe('isStuck boundary conditions', () => {
  it('an all-empty tray is never stuck, even on a dot-only board', () => {
    // Arrange
    const s = stateWith(checkerboard(), [null, null, null]);
    // Act / Assert
    expect(isStuck(s)).toBe(false);
  });

  it('on a checkerboard only the dot fits: any tray without a dot is stuck', () => {
    // Arrange
    const board = checkerboard();
    const big = stateWith(board, [piece('line2-0'), piece('line2-1'), piece('square-0')]);
    const withDotLast = stateWith(board, [piece('line2-0'), piece('square-0'), piece('dot-0')]);

    // Act / Assert
    expect(isStuck(big)).toBe(true);
    expect(isStuck(withDotLast)).toBe(false); // the fitting piece is in the LAST slot
  });

  it('a horizontal line5 that fits only flush against the bottom-right corner is not stuck', () => {
    // Arrange: checkerboard rows 0–6; row 7 has a single run of 5 empties at cols 3–7.
    const board = checkerboard();
    for (let c = 0; c < BOARD_SIZE; c++) board[7 * BOARD_SIZE + c] = c >= 3 || c === 1 ? 0 : 1;
    const line5h = piece('line5-0');
    expect([line5h.w, line5h.h]).toEqual([5, 1]);
    const s = stateWith(board.slice(), [line5h, null, null]);
    const closed = board.slice();
    closed[7 * BOARD_SIZE + 7] = 1; // shorten the run by one cell

    // Act
    const stuckBefore = isStuck(s);
    const stuckAfter = isStuck(stateWith(closed, [line5h, null, null]));

    // Assert
    expect(stuckBefore).toBe(false);
    expect(applyMove(s, 0, 7, 3).ok).toBe(true);
    expect(stuckAfter).toBe(true);
  });

  it('a vertical line5 that fits only in the last column / bottom rows is not stuck', () => {
    // Arrange: the transpose of the previous board — an empty run at col 7, rows 3–7.
    const rowBoard = checkerboard();
    for (let c = 0; c < BOARD_SIZE; c++) rowBoard[7 * BOARD_SIZE + c] = c >= 3 || c === 1 ? 0 : 1;
    const board = transpose(rowBoard);
    const line5v = piece('line5-1');
    expect([line5v.w, line5v.h]).toEqual([1, 5]);
    const s = stateWith(board, [null, line5v, null]);

    // Act
    const stuck = isStuck(s);
    const placed = applyMove(s, 1, 3, 7);

    // Assert
    expect(stuck).toBe(false);
    expect(placed.ok).toBe(true);
    // ...and the horizontal orientation (no rotation!) does not fit there.
    expect(isStuck(stateWith(board, [piece('line5-0'), null, null]))).toBe(true);
  });

  it('a single empty cell: stuck for every multi-cell piece, never for the dot', () => {
    for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
      // Arrange: every cell filled except i (not a reachable state, but isStuck must still hold).
      const board = new Array<number>(64).fill(1);
      board[i] = 0;
      const bigTray = stateWith(board, [piece('line2-0'), piece('line2-1'), piece('square-0')]);
      const dotTray = stateWith(board, [piece('line2-0'), piece('dot-0'), null]);

      // Act / Assert
      expect(isStuck(bigTray)).toBe(true);
      expect(isStuck(dotTray)).toBe(false);
    }
  });
});

// ── Long undo chains ────────────────────────────────────────────────────────

describe('long undo chains', () => {
  /** Play `steps` non-undo actions, returning the history and every visited state. */
  function playForward(seed: number, steps: number): { h: History; states: GameState[]; script: Action[] } {
    const pick = createRng(70_000 + seed);
    let h = createHistory(newGame(seed));
    const states = [h.present];
    const script: Action[] = [];
    while (script.length < steps) {
      let a = chooseAction(h, pick);
      if (a.kind === 'undo') a = isStuck(h.present) ? { kind: 'swap' } : chooseAction(h, pick);
      if (a.kind === 'undo') continue;
      h = act(h, a);
      script.push(a);
      states.push(h.present);
    }
    return { h, states, script };
  }

  it('undoing 300 moves (incl. swaps and refills) walks back through every state to the start', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      // Arrange
      const { h: end, states, script } = playForward(seed, 300);
      expect(script.some((a) => a.kind === 'swap')).toBe(true);
      const refills = states.filter((s, i) => i > 0 && s.tray.every((p) => p !== null) && script[i - 1]!.kind === 'place');
      expect(refills.length).toBeGreaterThan(10);

      // Act
      let h = end;
      const visited = [h.present];
      while (canUndo(h)) {
        h = undo(h);
        visited.push(h.present);
      }

      // Assert
      expect(visited).toEqual([...states].reverse());
      expect(h.present).toEqual(newGame(seed));
      expect(undo(h)).toBe(h);
    }
  });

  it('undo of a refill, then replaying the same placement, reproduces the identical refill', () => {
    // Arrange: find the first refill in a scripted game.
    const { states, script } = playForward(8, 120);
    const idx = script.findIndex(
      (a, i) => a.kind === 'place' && states[i]!.tray.filter((p) => p !== null).length === 1,
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    let h = createHistory(states[0]!);
    for (let i = 0; i <= idx; i++) h = act(h, script[i]!);
    const refilled = h.present;

    // Act
    h = undo(h);
    const beforeRefill = h.present;
    h = act(h, script[idx]!);

    // Assert
    expect(beforeRefill.tray.filter((p) => p !== null)).toHaveLength(1);
    expect(h.present).toEqual(refilled);
  });

  it('undo of swapTray restores the tray AND rngState, so swapping again gives the same tray', () => {
    // Arrange
    const s0 = newGame(21);
    let h = commit(createHistory(s0), swapTray(s0));
    const firstSwap = h.present;

    // Act
    h = undo(h);
    const restored = h.present;
    const secondSwap = swapTray(restored);

    // Assert
    expect(restored).toEqual(s0);
    expect(secondSwap).toEqual(firstSwap);
  });

  it('many consecutive swaps each undo one at a time, in order', () => {
    // Arrange
    const s0 = newGame(33);
    let h = createHistory(s0);
    const chain = [s0];
    for (let i = 0; i < 50; i++) {
      h = commit(h, swapTray(h.present));
      chain.push(h.present);
    }
    // Consecutive swaps actually change something (rng advances every time).
    expect(new Set(chain.map((s) => s.rngState)).size).toBe(chain.length);

    // Act / Assert
    for (let i = chain.length - 1; i >= 0; i--) {
      expect(h.present).toEqual(chain[i]);
      h = undo(h);
    }
    expect(h.present).toEqual(s0);
  });

  it('a 300-deep history survives save/reload intact', () => {
    // Arrange
    const { h } = playForward(9, 300);

    // Act
    const restored = parseHistory(JSON.parse(JSON.stringify(h)));

    // Assert
    expect(restored).toEqual(h);
    expect(restored?.past).toHaveLength(300);
  });
});

// ── Save validation edge cases ──────────────────────────────────────────────

describe('parseGameState / parseHistory edge cases', () => {
  const valid = (): GameState => ok(applyMove(newGame(4), 0, 0, 0)).state;

  it('accepts boundary-valid values: rngState 0 and 0xffffffff, negative seed, max palette index', () => {
    // Arrange
    const s = valid();
    const board = s.board.slice();
    board[63] = 8; // PALETTE_SIZE
    const cases = [
      { ...s, rngState: 0 },
      { ...s, rngState: 0xffffffff },
      { ...s, seed: -5 },
      { ...s, board },
      { ...s, tray: [null, null, s.tray[2]] },
    ];

    for (const c of cases) {
      // Act
      const parsed = parseGameState(JSON.parse(JSON.stringify(c)));
      // Assert
      expect(parsed).toEqual(c);
    }
  });

  it('rejects values just past each boundary', () => {
    // Arrange
    const s = valid();
    const withCell = (v: unknown) => s.board.map((x, i) => (i === 0 ? v : x));
    const bad: unknown[] = [
      { ...s, rngState: -1 },
      { ...s, rngState: 0x100000000 },
      { ...s, board: withCell(9) }, // PALETTE_SIZE + 1
      { ...s, board: withCell(-1) },
      { ...s, board: withCell(0.5) },
      { ...s, board: withCell('1') },
      { ...s, board: withCell(null) },
      { ...s, board: [...s.board, 0] }, // 65 cells
      { ...s, score: 1.5 },
      { ...s, score: Number.POSITIVE_INFINITY },
      { ...s, seed: 1.5 },
      { ...s, tray: [...s.tray, null] }, // 4 slots
    ];

    for (const b of bad) {
      // Act / Assert
      expect(parseGameState(b)).toBeNull();
    }
  });

  it('rejects old-format / foreign-shaped saves instead of crashing', () => {
    // Arrange: shapes an older or different build might have written.
    const s = valid();
    const { rngState: _r, ...noRng } = s;
    const { seed: _s, ...noSeed } = s;
    const rows: number[][] = [];
    for (let r = 0; r < BOARD_SIZE; r++) rows.push(s.board.slice(r * BOARD_SIZE, (r + 1) * BOARD_SIZE));
    const old: unknown[] = [
      noRng, // pre-rngState save
      noSeed,
      { ...s, board: rows }, // 2-D board
      { ...s, board: s.board.map((v) => (v ? '#ff0000' : 0)) }, // CSS colours instead of palette indices
      { ...s, tray: s.tray.map((p) => (p ? p.id : null)) }, // bare id strings
      { ...s, tray: [{ id: 'L4-0' }, { id: 'line3-v' }, null] }, // ids from an older catalog naming
      { stage: 1, level: 1, unlocked: [] }, // the pwa SaveData shape
      [s], // wrapped in an array
      JSON.stringify(s), // double-encoded string
      { version: 1, state: s }, // envelope
    ];

    for (const o of old) {
      // Act / Assert
      expect(() => parseGameState(o)).not.toThrow();
      expect(parseGameState(o)).toBeNull();
    }
  });

  it('strips unknown extra fields rather than carrying them into game state', () => {
    // Arrange
    const s = valid();
    // Act
    const parsed = parseGameState({ ...s, extra: 'x', __proto__hack: 1 });
    // Assert
    expect(parsed).toEqual(s);
    expect(Object.keys(parsed!).sort()).toEqual(['board', 'rngState', 'score', 'seed', 'tray']);
  });

  it('rejects tray entries whose id is a prototype key, not a catalog id', () => {
    // Arrange
    const s = valid();
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '']) {
      // Act / Assert
      expect(parseGameState({ ...s, tray: [{ id }, null, null] })).toBeNull();
    }
  });

  it('parseHistory rejects a history if ANY past state is corrupt, and accepts an empty past', () => {
    // Arrange
    const s = valid();
    const past = [newGame(4), s, s];
    const corrupt = [newGame(4), { ...s, score: -1 }, s];

    // Act / Assert
    expect(parseHistory({ past: [], present: s })).toEqual({ past: [], present: s });
    expect(parseHistory({ past, present: s })).toEqual({ past, present: s });
    expect(parseHistory({ past: corrupt, present: s })).toBeNull();
    expect(parseHistory({ past: 'nope', present: s })).toBeNull();
    expect(parseHistory({ past: [], present: null })).toBeNull();
    expect(parseHistory(null)).toBeNull();
  });

  it('a parsed save is a fresh copy: mutating the input afterwards does not change it', () => {
    // Arrange
    const raw = JSON.parse(JSON.stringify(valid())) as { board: number[] };
    // Act
    const parsed = parseGameState(raw)!;
    raw.board[5] = 7;
    // Assert
    expect(parsed.board[5]).not.toBe(7);
  });
});
