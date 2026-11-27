import { describe, it, expect } from 'vitest';
import { createHistory, createRng, isStuck, newGame, parseHistory, swapTray, type History } from '../src/core/index.ts';
import { act, anyFits, chooseAction, randomScript } from './helpers.ts';

/**
 * The design doc's fail-safe promises (docs/design.md), fuzzed over many seeds
 * with random play: placements, voluntary and forced swaps, and undos.
 */
const SEEDS = 150;
const STEPS = 150;
/** The fuzz runs take a few seconds; give slow CI runners headroom. */
const FUZZ_TIMEOUT_MS = 30_000;

describe('generator invariants (design-doc promises)', () => {
  // Build levels backward from a solved board, or verify with the solver, so a
  // generated level always has at least one solution. Levels don't exist yet.
  it.todo('every generated level is solvable');

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
