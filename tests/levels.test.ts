/**
 * Level support in core (PR B1): GOAL tiles, isLevelComplete, the per-game
 * generator options (goal-line bias), and the guarantee that endless mode is
 * unchanged when no options are passed.
 */
import { describe, it, expect } from 'vitest';
import {
  applyMove,
  BOARD_SIZE,
  canPlaceAt,
  CELL_COUNT,
  createHistory,
  createRng,
  GOAL,
  isLevelComplete,
  isStuck,
  newGame,
  PALETTE_SIZE,
  parseHistory,
  PIECES,
  previewClears,
  swapTray,
  type GameState,
  type GeneratorOptions,
  type History,
  type Rng,
} from '../src/core/index.ts';
import { drawTray, helpfulness, redrawTray } from '../src/core/generator.ts';
import { act, anyFits, chooseAction, piece, randomScript, stateWith } from './helpers.ts';

/** Build a board from 8 strings: 'G' goal tile, '#' palette 1, '.' empty. */
function goalBoard(rows: readonly string[]): number[] {
  if (rows.length !== BOARD_SIZE) throw new Error('need 8 rows');
  return rows.flatMap((row) => {
    if (row.length !== BOARD_SIZE) throw new Error('need 8 cols');
    return [...row].map((ch) => (ch === 'G' ? GOAL : ch === '#' ? 1 : 0));
  });
}

const EMPTY_ROWS = Array<string>(8).fill('........');

/** Statistical / fuzz tests take a few seconds; give slow CI runners headroom. */
const SLOW = { timeout: 30_000 };

const goalCount = (s: GameState) => s.board.filter((v) => v === GOAL).length;

function ok(res: ReturnType<typeof applyMove>) {
  if (!res.ok) throw new Error(`move failed: ${res.error}`);
  return res.result;
}

/**
 * A level-like start: a fresh game whose board gets `n` scattered goal tiles,
 * with no line already complete (a level never starts with one).
 */
function levelStart(seed: number, n: number): GameState {
  const base = newGame(seed);
  const rng: Rng = createRng(77_000 + seed);
  const board = base.board.slice();
  let placed = 0;
  while (placed < n) {
    const i = rng.int(0, CELL_COUNT - 1);
    if (board[i] !== 0) continue;
    board[i] = GOAL;
    const r = Math.floor(i / BOARD_SIZE);
    const c = i % BOARD_SIZE;
    const rowFull = [...Array(BOARD_SIZE).keys()].every((j) => board[r * BOARD_SIZE + j] !== 0);
    const colFull = [...Array(BOARD_SIZE).keys()].every((j) => board[j * BOARD_SIZE + c] !== 0);
    if (rowFull || colFull) board[i] = 0;
    else placed++;
  }
  return { ...base, board };
}

describe('GOAL tile value', () => {
  it('is reserved just past the piece palette, so no piece color can collide', () => {
    expect(GOAL).toBe(PALETTE_SIZE + 1);
    for (const p of PIECES) expect(p.color).not.toBe(GOAL);
  });

  it('is occupied: nothing can be placed on it, and canPlaceAt / previewClears / applyMove agree', () => {
    const s = stateWith(goalBoard(['G.......', ...EMPTY_ROWS.slice(1)]), [piece('dot-0'), piece('square-0'), null]);
    expect(canPlaceAt(s, 0, 0, 0)).toBe(false);
    expect(previewClears(s, 0, 0, 0)).toBeNull();
    expect(applyMove(s, 0, 0, 0)).toEqual({ ok: false, error: 'overlap' });
    // The 2×2 at (0,0) would overlap the goal too; one column over it fits.
    expect(canPlaceAt(s, 1, 0, 0)).toBe(false);
    expect(canPlaceAt(s, 1, 0, 1)).toBe(true);
  });

  it('counts toward a full row and clears with it (back to empty)', () => {
    const s = stateWith(goalBoard(['GGGGGGG.', ...EMPTY_ROWS.slice(1)]), [piece('dot-0'), piece('square-0'), null]);
    expect(previewClears(s, 0, 0, 7)).toEqual({ rows: [0], cols: [] });
    const res = ok(applyMove(s, 0, 0, 7));
    expect(res.cleared).toEqual({ rows: [0], cols: [] });
    expect(res.state.board.every((v) => v === 0)).toBe(true);
    expect(isLevelComplete(res.state)).toBe(true);
  });

  it('counts toward a full column, mixed with placed blocks', () => {
    const rows = ['G.......', '#.......', 'G.......', '#.......', 'G.......', 'G.......', '#.......', '........'];
    const s = stateWith(goalBoard(rows), [piece('dot-0'), piece('square-0'), null]);
    const res = ok(applyMove(s, 0, 7, 0));
    expect(res.cleared).toEqual({ rows: [], cols: [0] });
    expect(goalCount(res.state)).toBe(0);
  });
});

describe('isLevelComplete', () => {
  it('is false while any goal tile remains, true once none do', () => {
    expect(isLevelComplete(stateWith(goalBoard(EMPTY_ROWS), [null, null, piece('dot-0')]))).toBe(true);
    // Placed blocks alone never block completion.
    expect(isLevelComplete(stateWith(goalBoard(['####....', ...EMPTY_ROWS.slice(1)]), [piece('dot-0'), null, null]))).toBe(
      true,
    );
    expect(isLevelComplete(stateWith(goalBoard([...EMPTY_ROWS.slice(1), '.......G']), [piece('dot-0'), null, null]))).toBe(
      false,
    );
  });

  it('stays false after clearing only one of two goal lines', () => {
    const rows = ['GGGGGGG.', '........', '........', 'G.......', ...EMPTY_ROWS.slice(4)];
    const s = stateWith(goalBoard(rows), [piece('dot-0'), piece('square-0'), null]);
    const after = ok(applyMove(s, 0, 0, 7)).state;
    expect(goalCount(after)).toBe(1);
    expect(isLevelComplete(after)).toBe(false);
  });

  it('a fresh endless game is trivially complete (no goals)', () => {
    expect(isLevelComplete(newGame(3))).toBe(true);
  });
});

describe('goal tiles survive reload and undo', () => {
  it('a reload (JSON round-trip of the full history) keeps every goal tile in place, at every step', () => {
    const gen: GeneratorOptions = { goalBias: 2 };
    for (let seed = 0; seed < 10; seed++) {
      const start = levelStart(seed, 14);
      let h: History = createHistory(start);
      for (const a of randomScript(start, 60, 31_000 + seed, gen)) {
        h = act(h, a, gen);
        const restored = parseHistory(JSON.parse(JSON.stringify(h)));
        expect(restored).toEqual(h);
        // Goals only ever disappear by clearing; none is ever added.
        expect(goalCount(restored!.present)).toBeLessThanOrEqual(goalCount(start));
      }
    }
  });
});

// ── Generator: goal-line bias ───────────────────────────────────────────────

describe('generator goal-line bias', () => {
  /** Row 0 is goal tiles except its last two cells. */
  const GOAL_ROW = goalBoard(['GGGGGG..', ...EMPTY_ROWS.slice(1)]);
  /** The same shape of board, but with plain placed blocks instead of goals. */
  const PLAIN_ROW = goalBoard(['######..', ...EMPTY_ROWS.slice(1)]);

  it('helpfulness adds goalBias for each completed line containing a goal tile', () => {
    // line2 at (0,6) completes the goal row: 1 + 1 line + goalBias.
    expect(helpfulness(GOAL_ROW, piece('line2-0'))).toBe(2);
    expect(helpfulness(GOAL_ROW, piece('line2-0'), 3)).toBe(5);
    // A placement that only leaves the goal row one short gets no goal bonus.
    expect(helpfulness(GOAL_ROW, piece('dot-0'), 3)).toBe(1.25);
    // No goals on the board → goalBias changes nothing.
    expect(helpfulness(PLAIN_ROW, piece('line2-0'), 3)).toBe(2);
    // Completing a row AND a column that both hold goals earns the bonus twice.
    const corner = goalBoard([
      'GGGGGGG.',
      '.......G',
      '.......G',
      '.......G',
      '.......G',
      '.......G',
      '.......G',
      '.......G',
    ]);
    expect(helpfulness(corner, piece('dot-0'), 3)).toBe(1 + 2 + 2 * 3);
  });

  function frequencies(board: readonly number[], gen: GeneratorOptions, trays: number, seed: number) {
    const rng = createRng(seed);
    const counts = new Map<string, number>();
    for (let t = 0; t < trays; t++) {
      for (const p of drawTray(board, rng, gen)) if (p) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
    }
    return (id: string) => (counts.get(id) ?? 0) / (trays * 3);
  }

  it('draws the goal-row-completing piece more often as goalBias rises (statistical)', SLOW, () => {
    const f0 = frequencies(GOAL_ROW, { goalBias: 0 }, 2000, 5);
    const f2 = frequencies(GOAL_ROW, { goalBias: 2 }, 2000, 5);
    const f6 = frequencies(GOAL_ROW, { goalBias: 6 }, 2000, 5);
    // line2-0 is the only piece completing the goal row. Its weight goes
    // 3 → 5 → 9, i.e. roughly ×1.6 and ×1.7 in share; demand ×1.25 each
    // (each frequency has sigma ≈ 0.004 over 6000 draws).
    expect(f2('line2-0')).toBeGreaterThan(f0('line2-0') * 1.25);
    expect(f6('line2-0')).toBeGreaterThan(f2('line2-0') * 1.25);
    // The vertical domino can't complete row 0; the bias must not favor it.
    expect(f6('line2-1')).toBeLessThan(f0('line2-1'));
  });

  it('prefers a goal line over an equally good plain line', SLOW, () => {
    // The same gap, once in a goal row and once in a plain row: line3-0
    // completes either, but only the goal row earns the bias.
    const goalGap = goalBoard(['GGGGG...', ...EMPTY_ROWS.slice(1)]);
    const plainGap = goalBoard(['#####...', ...EMPTY_ROWS.slice(1)]);
    const fg = frequencies(goalGap, { goalBias: 3 }, 2000, 6);
    const fp = frequencies(plainGap, { goalBias: 3 }, 2000, 6);
    expect(fg('line3-0')).toBeGreaterThan(fp('line3-0') * 1.5);
  });

  it('empirical draw frequencies match the weights 1 + generosity × helpfulness(goalBias)', SLOW, () => {
    const gen = { generosity: 1, goalBias: 4 };
    const w = PIECES.map((p) => 1 + helpfulness(GOAL_ROW, p, gen.goalBias));
    const total = w.reduce((a, b) => a + b, 0);
    const n = 6_000;
    const f = frequencies(GOAL_ROW, gen, n / 3, 7);
    PIECES.forEach((p, i) => {
      const expected = w[i]! / total;
      const sigma = Math.sqrt((expected * (1 - expected)) / n);
      expect(Math.abs(f(p.id) - expected)).toBeLessThan(4.5 * sigma);
    });
  });

  it('generosity 0 stays uniform even with a goal bias', () => {
    const a = drawTray(GOAL_ROW, createRng(8), { generosity: 0, goalBias: 9 });
    const b = drawTray(GOAL_ROW, createRng(8), { generosity: 0 });
    expect(a).toEqual(b);
  });
});

// ── Endless unchanged ───────────────────────────────────────────────────────

/** FNV-1a of a string, for compact golden snapshots. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

describe('endless mode is unchanged by level support', () => {
  it('reproduces the exact pre-levels game for 8 seeds × 120 random moves (golden, captured on main)', SLOW, () => {
    // Captured by running this exact play on main before levels landed. If
    // this ever changes, endless draws changed and a player's saved game
    // would continue differently.
    const GOLDEN = ['ac6dbbf5', 'eb89fca8', '49166997', 'a82b9dc8', '2fd8b7ca', '009373fa', '6edf449e', '325c2cec'];
    const got: string[] = [];
    for (let seed = 0; seed < 8; seed++) {
      let h = createHistory(newGame(seed));
      const states = [h.present];
      for (const a of randomScript(h.present, 120, 70_000 + seed)) {
        h = act(h, a);
        states.push(h.present);
      }
      got.push(fnv(JSON.stringify(states)));
    }
    expect(got).toEqual(GOLDEN);
  });

  it('on goal-free boards, goalBias never changes a draw, a refill or a swap', SLOW, () => {
    for (let seed = 0; seed < 12; seed++) {
      const start = newGame(seed);
      const script = randomScript(start, 40, 60_000 + seed);
      let plain = createHistory(start);
      let biased = createHistory(start);
      for (const a of script) {
        plain = act(plain, a);
        biased = act(biased, a, { goalBias: 7 });
        expect(biased.present).toEqual(plain.present);
        const tray = plain.present.tray;
        expect(redrawTray(plain.present.board, tray, createRng(seed), { goalBias: 7 })).toEqual(
          redrawTray(plain.present.board, tray, createRng(seed)),
        );
      }
    }
  });
});

// ── Level-mode invariants, with gen threaded through ────────────────────────

describe('design-doc promises hold on goal boards with level options', () => {
  const gen: GeneratorOptions = { generosity: 1.5, goalBias: 3 };

  it('no game over: after every move a piece fits OR isStuck, and swapTray(gen) always fits', SLOW, () => {
    for (let seed = 0; seed < 25; seed++) {
      const pick = createRng(12_000 + seed);
      let h: History = createHistory(levelStart(seed, 18));
      for (let step = 0; step < 80; step++) {
        const a = chooseAction(h, pick);
        h = act(h, a, gen);
        const s = h.present;
        expect(isStuck(s)).toBe(!anyFits(s));
        expect(s.board.some((v) => v === 0)).toBe(true);
        if (a.kind === 'swap') expect(anyFits(s)).toBe(true);
        if (isStuck(s)) expect(anyFits(swapTray(s, gen))).toBe(true);
      }
    }
  });

  it('same start + same moves + same gen reproduce the same states, across reloads', SLOW, () => {
    for (let seed = 0; seed < 10; seed++) {
      const start = levelStart(seed, 12);
      const script = randomScript(start, 80, 41_000 + seed, gen);
      const run = (reloadEvery: number) => {
        let h = createHistory(start);
        const states = [h.present];
        script.forEach((a, i) => {
          h = act(h, a, gen);
          if (reloadEvery > 0 && i % reloadEvery === 0) h = parseHistory(JSON.parse(JSON.stringify(h)))!;
          states.push(h.present);
        });
        return states;
      };
      const a = run(0);
      expect(run(5)).toEqual(a);
    }
  });
});
