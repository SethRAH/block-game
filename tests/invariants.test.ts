import { describe, it, expect } from 'vitest';
import {
  applyMove,
  createHistory,
  createRng,
  isLevelComplete,
  isStuck,
  newGame,
  parseHistory,
  swapTray,
  type History,
} from '../src/core/index.ts';
import { playLevel, quantile } from '../src/core/playtest.ts';
import { act, anyFits, cachedLevel, chooseAction, randomScript } from './helpers.ts';

/**
 * The design doc's fail-safe promises (docs/design.md), fuzzed over many seeds
 * with random play: placements, voluntary and forced swaps, and undos.
 */
const SEEDS = 150;
const STEPS = 150;
/** The fuzz runs take a few seconds; give slow CI runners headroom. */
const FUZZ_TIMEOUT_MS = 30_000;

describe('generator invariants (design-doc promises)', () => {
  // Levels are solvable by construction: createLevel keeps a layout only once
  // the perfect player (solver.ts) has won it, and records that win. Replay it.
  it('every generated level is solvable: its recorded perfect solution wins', () => {
    for (let n = 1; n <= 30; n++) {
      const level = cachedLevel(n);
      let s = level.start;
      expect(isLevelComplete(s)).toBe(false);
      for (const m of level.solution) {
        const res = applyMove(s, m.slot, m.r, m.c, level.gen);
        if (!res.ok) throw new Error(`level ${n}: solution move rejected (${res.error})`);
        s = res.result.state;
      }
      expect(isLevelComplete(s)).toBe(true);
    }
  }, FUZZ_TIMEOUT_MS);

  // The real "levels don't drag" guarantee. A simulated young player (half the
  // time she makes the best-looking move, otherwise a random one; swaps when
  // stuck) plays each of levels 1–30 many times; every level must finish in a
  // median of <= 20 placements and <= 35 in 90% of runs. Fully seeded, on
  // seeds createLevel's own playtest filter never uses. (That perfect-play
  // moves rise across each stage is checked in level-gen.test.ts.)
  it('levels 1–30 finish quickly for a simulated player (median <= 20, p90 <= 35)', () => {
    const RUNS = 60;
    const FOCUS = 0.5;
    for (let n = 1; n <= 30; n++) {
      const level = cachedLevel(n);
      const runs = Array.from({ length: RUNS }, (_, i) =>
        playLevel(level.start, level.gen, 90_000 + n * 1_000 + i, FOCUS),
      );
      const median = quantile(runs, 0.5);
      const p90 = quantile(runs, 0.9);
      expect({ n, median: median <= 20, p90: p90 <= 35 }).toEqual({ n, median: true, p90: true });
    }
  }, FUZZ_TIMEOUT_MS);

  // The "no game over" guarantee: the player is never left without a way on.
  it('after every move a piece fits OR isStuck is true, and swapTray always produces a fit', () => {
    let stuckSeen = 0;
    let refills = 0;
    for (let seed = 0; seed < SEEDS; seed++) {
      const pick = createRng(10_000 + seed);
      let h: History = createHistory(newGame(seed));
      expect(anyFits(h.present)).toBe(true);
      for (let step = 0; step < STEPS; step++) {
        const a = chooseAction(h, pick);
        const before = h.present;
        h = act(h, a);
        const s = h.present;

        // Exactly one of: something fits, or we are stuck (and the UI offers a swap).
        expect(isStuck(s)).toBe(!anyFits(s));
        // The board is never left completely full, so a dot always fits.
        expect(s.board.some((v) => v === 0)).toBe(true);
        // Score never drops except by undo.
        if (a.kind !== 'undo') expect(s.score).toBeGreaterThanOrEqual(before.score);

        // A freshly refilled tray always contains a fitting piece.
        if (a.kind === 'place' && before.tray.filter((p) => p !== null).length === 1) {
          refills++;
          expect(s.tray.every((p) => p !== null)).toBe(true);
          expect(anyFits(s)).toBe(true);
        }
        // A swap always yields a fit.
        if (a.kind === 'swap') expect(anyFits(s)).toBe(true);

        if (isStuck(s)) {
          stuckSeen++;
          expect(anyFits(swapTray(s))).toBe(true);
        }
      }
    }
    // Sanity: the fuzz actually exercised refills and the stuck/rescue path.
    expect(refills).toBeGreaterThan(SEEDS);
    expect(stuckSeen).toBeGreaterThan(0);
  }, FUZZ_TIMEOUT_MS);

  // Reproducibility: same seed + same moves (placements, swaps, undos) give the
  // identical sequence of states — and that survives a save/reload mid-game.
  it('same seed + same moves (placements, swaps, undos) reproduce the same trays/state', () => {
    for (let seed = 0; seed < 60; seed++) {
      const script = randomScript(newGame(seed), STEPS, 50_000 + seed);
      expect(script.some((a) => a.kind === 'swap')).toBe(true);
      expect(script.some((a) => a.kind === 'undo')).toBe(true);

      const run = (reloadEvery: number) => {
        let h = createHistory(newGame(seed));
        const states = [h.present];
        script.forEach((a, i) => {
          h = act(h, a);
          if (reloadEvery > 0 && i % reloadEvery === 0) {
            const restored = parseHistory(JSON.parse(JSON.stringify(h)));
            if (!restored) throw new Error('reload failed');
            h = restored;
          }
          states.push(h.present);
        });
        return states;
      };

      const a = run(0);
      expect(run(0)).toEqual(a);
      expect(run(7)).toEqual(a); // save + reload every 7 moves changes nothing
    }
  }, FUZZ_TIMEOUT_MS);
});
