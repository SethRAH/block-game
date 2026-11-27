/**
 * Seeded fuzz + statistical checks complementing invariants.test.ts:
 *  • applyMove vs an independent brute-force oracle on random dense boards,
 *  • swapTray on random pathological (near-full) boards and live-slot masks,
 *  • the generator's `generosity` really biasing toward line-completing pieces,
 *  • save-validation mutation fuzz (corrupt saves → null, never a throw).
 * Every source of randomness is a seeded Rng, so failures reproduce exactly.
 */
import { describe, it, expect } from 'vitest';
import {
  applyMove,
  isStuck,
  newGame,
  parseGameState,
  scoreFor,
  swapTray,
  BOARD_SIZE,
  CELL_COUNT,
  PIECES,
  type GameState,
  type Piece,
  type TraySlot,
} from '../src/core/index.ts';
import { createRng, type Rng } from '../src/core/rng.ts';
import { drawTray, helpfulness, redrawTray } from '../src/core/generator.ts';
import { emptyBoard, fitsAnywhere, placements } from '../src/core/grid.ts';
import { anyFits, boardFrom, piece, randomScript, act, stateWith } from './helpers.ts';
import { createHistory } from '../src/core/undo.ts';

const FUZZ_TIMEOUT_MS = 30_000;

/** Brute-force: indices of full rows and full columns. Independent of grid.ts. */
function oracleFullLines(board: readonly number[]): { rows: number[]; cols: number[] } {
  const rows: number[] = [];
  const cols: number[] = [];
  for (let i = 0; i < BOARD_SIZE; i++) {
    const row = board.slice(i * BOARD_SIZE, (i + 1) * BOARD_SIZE);
    const col = Array.from({ length: BOARD_SIZE }, (_, r) => board[r * BOARD_SIZE + i]);
    if (row.every((v) => v !== 0)) rows.push(i);
    if (col.every((v) => v !== 0)) cols.push(i);
  }
  return { rows, cols };
}

/**
 * A random board at the given fill density with no full lines and at least one
 * empty cell — i.e. a state the game could actually be in.
 */
function randomBoard(rng: Rng, density: number): number[] {
  const b = Array.from({ length: CELL_COUNT }, () => (rng.next() < density ? rng.int(1, 8) : 0));
  const { rows, cols } = oracleFullLines(b);
  for (const r of rows) b[r * BOARD_SIZE + rng.int(0, BOARD_SIZE - 1)] = 0;
  for (const c of cols) b[rng.int(0, BOARD_SIZE - 1) * BOARD_SIZE + c] = 0;
  return b;
}

function randomTray(rng: Rng, minLive = 1): TraySlot[] {
  for (;;) {
    const t: TraySlot[] = [0, 1, 2].map(() => (rng.next() < 0.6 ? rng.pick(PIECES) : null));
    if (t.filter((p) => p !== null).length >= minLive) return t;
  }
}

// ── applyMove oracle fuzz ───────────────────────────────────────────────────

describe('applyMove vs a brute-force oracle (random dense boards)', () => {
  it('clears exactly the full lines, keeps every other cell, and scores scoreFor(cells, lines)', () => {
    let multiLine = 0;
    for (let seed = 0; seed < 400; seed++) {
      // Arrange
      const rng = createRng(90_000 + seed);
      const board = randomBoard(rng, 0.55 + 0.4 * rng.next());
      const tray = randomTray(rng);
      const s = stateWith(board, tray, { score: rng.int(0, 1000) });
      const slots = tray.flatMap((p, i) => (p && fitsAnywhere(board, p) ? [i] : []));
      if (slots.length === 0) continue;
      const slot = rng.pick(slots);
      const p = tray[slot]!;
      const { r, c } = rng.pick(placements(board, p));

      // Act
      const res = applyMove(s, slot, r, c);

      // Assert
      if (!res.ok) throw new Error(`seed ${seed}: legal move rejected (${res.error})`);
      const afterPlace = board.slice();
      for (const cell of p.cells) afterPlace[(r + cell.r) * BOARD_SIZE + (c + cell.c)] = p.color;
      const full = oracleFullLines(afterPlace);
      const nLines = full.rows.length + full.cols.length;
      if (nLines >= 2) multiLine++;
      expect(res.result.cleared).toEqual(full);
      expect(res.result.scoreDelta).toBe(scoreFor(p.cells.length, nLines));
      expect(res.result.state.score).toBe(s.score + res.result.scoreDelta);
      for (let i = 0; i < CELL_COUNT; i++) {
        const inCleared = full.rows.includes(Math.floor(i / BOARD_SIZE)) || full.cols.includes(i % BOARD_SIZE);
        expect(res.result.state.board[i]).toBe(inCleared ? 0 : afterPlace[i]);
      }
      expect(oracleFullLines(res.result.state.board)).toEqual({ rows: [], cols: [] });
      expect(res.result.state.board.some((v) => v === 0)).toBe(true);
      expect(s.board).toEqual(board); // input not mutated
    }
    // Sanity: the fuzz really hit multi-line clears.
    expect(multiLine).toBeGreaterThan(0);
  }, FUZZ_TIMEOUT_MS);

  it('every illegal (slot, r, c) is rejected and leaves the state untouched', () => {
    for (let seed = 0; seed < 60; seed++) {
      // Arrange
      const rng = createRng(91_000 + seed);
      const s = stateWith(randomBoard(rng, 0.7), randomTray(rng));
      const snapshot = JSON.stringify(s);
      for (let slot = 0; slot < 3; slot++) {
        const p = s.tray[slot];
        for (let r = -5; r < BOARD_SIZE + 1; r++) {
          for (let c = -5; c < BOARD_SIZE + 1; c++) {
            // Act
            const res = applyMove(s, slot, r, c);
            // Assert
            const legal = !!p && placements(s.board, p).some((q) => q.r === r && q.c === c);
            expect(res.ok).toBe(legal);
          }
        }
      }
      expect(JSON.stringify(s)).toBe(snapshot);
    }
  }, FUZZ_TIMEOUT_MS);
});

// ── swapTray on pathological boards ─────────────────────────────────────────

describe('swapTray on pathological boards', () => {
  function onlyDotFits(board: readonly number[]): boolean {
    return PIECES.every((p) => (p.id === 'dot-0') === fitsAnywhere(board, p));
  }

  it('random near-full boards × random live-slot masks: swap always yields a fit and keeps used slots empty', () => {
    let dotOnly = 0;
    for (let seed = 0; seed < 1500; seed++) {
      // Arrange
      const rng = createRng(92_000 + seed);
      const board = randomBoard(rng, 0.8 + 0.19 * rng.next());
      const tray = randomTray(rng);
      const s = stateWith(board, tray, { score: 7, seed });

      // Act
      const out = swapTray(s);

      // Assert
      expect(anyFits(out)).toBe(true);
      expect(isStuck(out)).toBe(false);
      out.tray.forEach((p, i) => expect(p === null).toBe(tray[i] === null));
      expect(out.board).toEqual(board);
      expect(out.score).toBe(7);
      expect(out.seed).toBe(seed);
      expect(swapTray(s)).toEqual(out); // deterministic
      if (onlyDotFits(board)) {
        dotOnly++;
        expect(out.tray.some((p) => p?.id === 'dot-0')).toBe(true);
      }
    }
    // Sanity: the fuzz reached the dot-fallback regime.
    expect(dotOnly).toBeGreaterThan(20);
  }, FUZZ_TIMEOUT_MS);

  it('a single live slot on a checkerboard is always replaced by the 1x1 dot', () => {
    // Arrange: on a checkerboard nothing but the dot fits.
    const board = Array.from({ length: CELL_COUNT }, (_, i) =>
      (Math.floor(i / BOARD_SIZE) + (i % BOARD_SIZE)) % 2 === 0 ? 1 : 0,
    );
    for (let slot = 0; slot < 3; slot++) {
      for (let rngState = 0; rngState < 200; rngState++) {
        const tray: TraySlot[] = [null, null, null];
        tray[slot] = piece('square-0');
        const s = stateWith(board, tray, { rngState });

        // Act
        const out = swapTray(s);

        // Assert
        const expected: TraySlot[] = [null, null, null];
        expected[slot] = piece('dot-0');
        expect(out.tray).toEqual(expected);
      }
    }
  });

  it('with exactly one empty cell anywhere on the board, the swap still produces a placeable dot', () => {
    for (let i = 0; i < CELL_COUNT; i++) {
      // Arrange: unreachable in play (other rows are full), but swapTray must still never fail.
      const board = new Array<number>(CELL_COUNT).fill(3);
      board[i] = 0;
      const s = stateWith(board, [piece('line5-0'), piece('T-0'), piece('square-0')], { rngState: i * 7919 });

      // Act
      const out = swapTray(s);

      // Assert
      expect(out.tray.some((p) => p?.id === 'dot-0')).toBe(true);
      expect(applyMove(out, out.tray.findIndex((p) => p?.id === 'dot-0'), Math.floor(i / 8), i % 8).ok).toBe(true);
    }
  });

  it('an all-null tray passed to swapTray gets a full, fitting tray', () => {
    // Arrange
    const s = stateWith(boardFrom(Array.from({ length: 8 }, (_, r) => (r % 2 ? '.#.#.#.#' : '#.#.#.#.'))), [
      null,
      null,
      null,
    ]);
    // Act
    const out = swapTray(s);
    // Assert
    expect(out.tray.every((p) => p !== null)).toBe(true);
    expect(anyFits(out)).toBe(true);
  });
});

// ── Generator generosity ────────────────────────────────────────────────────

describe('generator generosity biases toward near-line-completing pieces', () => {
  /** Row 0 is full except its last two cells; the rest of the board is empty. */
  const NEAR_LINE = boardFrom(['######..', ...Array<string>(7).fill('........')]);

  function frequencies(board: readonly number[], generosity: number, trays: number, seed: number) {
    const rng = createRng(seed);
    const counts = new Map<string, number>();
    for (let t = 0; t < trays; t++) {
      for (const p of drawTray(board, rng, { generosity })) {
        if (p) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
      }
    }
    return (id: string) => (counts.get(id) ?? 0) / (trays * 3);
  }

  it('helpfulness scores hand-checked placements on a near-complete row', () => {
    // Arrange / Act / Assert
    // line2 horizontal at (0,6) completes row 0: 1 + 1 line.
    expect(helpfulness(NEAR_LINE, piece('line2-0'))).toBe(2);
    // The dot at (0,6) leaves row 0 one short: 1 + 0.25.
    expect(helpfulness(NEAR_LINE, piece('dot-0'))).toBe(1.25);
    // A horizontal line5 can't reach row 0's gap; best is plain fit.
    expect(helpfulness(NEAR_LINE, piece('line5-0'))).toBe(1);
    // Nothing fits on a full-but-one board for a 2-cell piece → 0.
    const oneHole = new Array<number>(CELL_COUNT).fill(1);
    oneHole[0] = 0;
    expect(helpfulness(oneHole, piece('line2-0'))).toBe(0);
  });

  it('generosity 0 is uniform over the catalog even when some pieces would complete a line', () => {
    // Arrange / Act
    const f = frequencies(NEAR_LINE, 0, 4000, 1);
    // Assert: uniform over the catalog, within ~4 sigma.
    const expected = 1 / PIECES.length;
    const sigma = Math.sqrt((expected * (1 - expected)) / 12_000);
    for (const p of PIECES) expect(Math.abs(f(p.id) - expected)).toBeLessThan(4 * sigma);
  }, FUZZ_TIMEOUT_MS);

  it('default generosity draws the row-completing line2-0 more often than line2-1, and more with higher generosity', () => {
    // Arrange / Act
    const f0 = frequencies(NEAR_LINE, 0, 4000, 2);
    const f1 = frequencies(NEAR_LINE, 1, 4000, 2);
    const f4 = frequencies(NEAR_LINE, 4, 4000, 2);

    // Assert
    expect(f1('line2-0')).toBeGreaterThan(f1('line2-1') * 1.1);
    expect(f1('line2-0')).toBeGreaterThan(f0('line2-0'));
    expect(f4('line2-0')).toBeGreaterThan(f1('line2-0'));
  }, FUZZ_TIMEOUT_MS);

  it('empirical draw frequencies match the weights 1 + generosity × helpfulness', () => {
    // Arrange: everything fits on NEAR_LINE, so the fit fallback never alters a draw.
    expect(PIECES.every((p) => fitsAnywhere(NEAR_LINE, p))).toBe(true);
    const g = 2;
    const w = PIECES.map((p) => 1 + g * helpfulness(NEAR_LINE, p));
    const total = w.reduce((a, b) => a + b, 0);
    const n = 12_000;

    // Act
    const f = frequencies(NEAR_LINE, g, n / 3, 3);

    // Assert
    PIECES.forEach((p, i) => {
      const expected = w[i]! / total;
      const sigma = Math.sqrt((expected * (1 - expected)) / n);
      expect(Math.abs(f(p.id) - expected)).toBeLessThan(4.5 * sigma);
    });
  }, FUZZ_TIMEOUT_MS);

  it('across random boards, mean helpfulness of drawn pieces rises with generosity', () => {
    // Arrange
    const boards = Array.from({ length: 60 }, (_, i) => randomBoard(createRng(93_000 + i), 0.5));
    const meanHelp = (generosity: number): number => {
      let sum = 0;
      let n = 0;
      boards.forEach((b, i) => {
        const rng = createRng(94_000 + i);
        for (let t = 0; t < 10; t++) {
          for (const p of drawTray(b, rng, { generosity })) {
            sum += helpfulness(b, p as Piece);
            n++;
          }
        }
      });
      return sum / n;
    };

    // Act
    const h0 = meanHelp(0);
    const h1 = meanHelp(1);
    const h4 = meanHelp(4);

    // Assert
    expect(h1).toBeGreaterThan(h0);
    expect(h4).toBeGreaterThan(h1);
  }, FUZZ_TIMEOUT_MS);

  it('redrawTray at generosity 0 still guarantees a fit (the guarantee does not depend on the bias)', () => {
    for (let seed = 0; seed < 500; seed++) {
      // Arrange
      const rng = createRng(95_000 + seed);
      const board = randomBoard(rng, 0.85 + 0.14 * rng.next());
      const tray = randomTray(rng);

      // Act
      const out = redrawTray(board, tray, rng, { generosity: 0 });
      const full = drawTray(board, rng, { generosity: 0 });

      // Assert
      expect(out.some((p) => p !== null && fitsAnywhere(board, p))).toBe(true);
      expect(full.some((p) => p !== null && fitsAnywhere(board, p))).toBe(true);
    }
  });

  it('drawTray on an empty board is reproducible per rng state and never contains null', () => {
    for (let s = 0; s < 50; s++) {
      // Arrange / Act
      const a = drawTray(emptyBoard(), createRng(0, s * 101));
      const b = drawTray(emptyBoard(), createRng(0, s * 101));
      // Assert
      expect(a).toEqual(b);
      expect(a.every((p) => p !== null)).toBe(true);
    }
  });
});

// ── Save-validation mutation fuzz ───────────────────────────────────────────

describe('parseGameState mutation fuzz', () => {
  /** Real mid-game states reached by random play. */
  function realStates(): GameState[] {
    const out: GameState[] = [];
    for (let seed = 0; seed < 20; seed++) {
      const script = randomScript(newGame(seed), 40, 96_000 + seed);
      let h = createHistory(newGame(seed));
      for (const a of script) {
        h = act(h, a);
        out.push(h.present);
      }
    }
    return out;
  }

  const JUNK: unknown[] = [undefined, null, NaN, -1, 1.5, 1e40, '', 'x', true, [], {}, [1, 2], { id: 'dot-0' }];

  it('every real state round-trips through JSON unchanged', () => {
    for (const s of realStates()) {
      // Act
      const parsed = parseGameState(JSON.parse(JSON.stringify(s)));
      // Assert
      expect(parsed).toEqual(s);
    }
  });

  it('replacing any top-level field with junk → null (never throws)', () => {
    const rng = createRng(97_000);
    const fields = ['board', 'tray', 'score', 'seed', 'rngState'] as const;
    for (const s of realStates().slice(0, 100)) {
      for (const field of fields) {
        // Arrange
        const junk = rng.pick(JUNK);
        const mutated: Record<string, unknown> = { ...s, [field]: junk };
        // Junk that happens to be a valid value for that field is not corruption
        // (any integer is a valid seed; 1e40 is a valid, if absurd, score).
        if (field === 'seed' && Number.isInteger(junk)) continue;
        if (field === 'score' && Number.isInteger(junk) && (junk as number) >= 0) continue;

        // Act / Assert
        expect(() => parseGameState(mutated)).not.toThrow();
        expect(parseGameState(mutated)).toBeNull();
      }
      // Deleting any field is also corruption.
      for (const field of fields) {
        const { [field]: _gone, ...rest } = s;
        expect(parseGameState(rest)).toBeNull();
      }
    }
  });

  it('corrupting one board cell or one tray slot with junk → null', () => {
    const rng = createRng(98_000);
    for (const s of realStates().slice(0, 200)) {
      // Arrange
      const board: unknown[] = s.board.slice();
      board[rng.int(0, CELL_COUNT - 1)] = rng.pick([10, -1, 0.5, '1', null, true, 1e9, NaN]);
      const tray: unknown[] = s.tray.slice();
      tray[rng.int(0, 2)] = rng.pick([{ id: 'nope' }, { id: 7 }, 'dot-0', 3, [], { cells: [] }]);

      // Act / Assert
      expect(parseGameState({ ...s, board })).toBeNull();
      expect(parseGameState({ ...s, tray })).toBeNull();
    }
  });
});
