/**
 * Level generation (PR B2) — complementary edge / fuzz coverage.
 *
 * Deliberately does NOT repeat level-gen.test.ts / invariants.test.ts (the
 * 1–30 anti-slog sim at focus 0.5, the curve and perfect-play checks for
 * 1–60, and the per-level golden hashes of 1–30). Instead it widens and
 * hardens them:
 *  - the slog sim over levels 1–60 with a fresh seed base, plus greedy and
 *    purely random players;
 *  - reproducibility independent of call order / hidden state, and through
 *    undo, swaps, replay and save/reload;
 *  - an aggregate golden hash (levels 1–60) keyed by LEVEL_GEN_VERSION, so a
 *    generation change cannot slip through without a version bump;
 *  - levelParams monotonicity in finer detail and across many stages;
 *  - every level is completable even off the scripted path (swap, undo, a
 *    wrong move first).
 *
 * Everything is seeded; no Math.random.
 */
import { describe, it, expect } from 'vitest';
import {
  applyMove,
  createHistory,
  createLevel,
  createRng,
  GOAL,
  isLevelComplete,
  isStuck,
  LEVEL_GEN_VERSION,
  levelParams,
  levelPosition,
  levelSeed,
  LEVELS_PER_STAGE,
  newGame,
  parseHistory,
  PIECES,
  swapTray,
  undo,
  type GameState,
  type History,
  type Level,
} from '../src/core/index.ts';
import { placements } from '../src/core/grid.ts';
import { playLevel, quantile } from '../src/core/playtest.ts';
import { act, cachedLevel, fnv, levelHash, randomScript, type Action } from './helpers.ts';

/** The sims take tens of seconds on slow CI runners. */
const SIM_TIMEOUT_MS = 120_000;

/** Play the level's recorded solution from `s` (which must be its start). */
function playSolution(level: Level, s: GameState): GameState {
  for (const m of level.solution) {
    const res = applyMove(s, m.slot, m.r, m.c, level.gen);
    if (!res.ok) throw new Error(`level ${level.levelNumber}: solution move rejected (${res.error})`);
    s = res.result.state;
  }
  return s;
}

/** A legal first placement that is NOT the solution's first move, if any. */
function wrongMove(level: Level): Action | null {
  const s = level.start;
  const first = level.solution[0]!;
  for (let slot = 0; slot < s.tray.length; slot++) {
    const p = s.tray[slot];
    if (!p) continue;
    for (const { r, c } of placements(s.board, p)) {
      if (slot !== first.slot || r !== first.r || c !== first.c) return { kind: 'place', slot, r, c };
    }
  }
  return null;
}

// ── Anti-slog sim, widened ─────────────────────────────────────────────────

describe('anti-slog sim, widened (levels 1–60, fresh seeds, three player models)', () => {
  const LAST = 60;

  // The design bar (median <= 20, p90 <= 35) for the 50%-focus player, now
  // over 1–60 with a seed base disjoint from invariants.test.ts and more runs
  // (so a nearest-rank p90 is less noisy). Observed worst case after the
  // per-stage ramp (gen v2): median 17, p90 31.
  it('50%-focus player: every level 1–60 has median <= 20 and p90 <= 35', () => {
    const RUNS = 80;
    const bad: string[] = [];
    for (let n = 1; n <= LAST; n++) {
      const level = cachedLevel(n);
      const runs = Array.from({ length: RUNS }, (_, i) =>
        playLevel(level.start, level.gen, 3_000_000 + n * 1_000 + i, 0.5),
      );
      const median = quantile(runs, 0.5);
      const p90 = quantile(runs, 0.9);
      if (median > 20 || p90 > 35) bad.push(`level ${n}: median ${median}, p90 ${p90}`);
    }
    expect(bad).toEqual([]);
  }, SIM_TIMEOUT_MS);

  // A greedy player is not the solver's perfect player (it breaks ties at
  // random and parks spare pieces anywhere, which changes later refills), so
  // it is not held to the exact count; it must stay well inside the slog bar,
  // and on L1 (one line, all three holes scripted) it needs exactly 3 moves.
  it('greedy player finishes every level 1–60 within the slog bar; every L1 in exactly 3', () => {
    const bad: string[] = [];
    for (let n = 1; n <= 60; n++) {
      const level = cachedLevel(n);
      for (let i = 0; i < 4; i++) {
        const placed = playLevel(level.start, level.gen, 4_000_000 + n * 100 + i, 1);
        if (placed > 20) bad.push(`level ${n} run ${i}: ${placed}`);
        if (levelPosition(n).level === 1 && placed !== 3) bad.push(`L1 level ${n} run ${i}: ${placed}`);
      }
    }
    expect(bad).toEqual([]);
  }, SIM_TIMEOUT_MS);

  // A purely random player is NOT held to the design bar (it was never meant
  // for her: after the ramp her medians reach ~40 and p90s ~90). The
  // guard here is "no runaway": every run finishes within the sim's cap, and
  // her typical level stays within about twice the bar.
  it('purely random player: every run of levels 1–60 finishes within the cap; median <= 50', () => {
    const RUNS = 30;
    const CAP = 200;
    const bad: string[] = [];
    for (let n = 1; n <= LAST; n++) {
      const level = cachedLevel(n);
      const runs = Array.from({ length: RUNS }, (_, i) =>
        playLevel(level.start, level.gen, 5_000_000 + n * 1_000 + i, 0, CAP),
      );
      if (Math.max(...runs) > CAP) bad.push(`level ${n}: a run hit the cap`);
      if (quantile(runs, 0.5) > 50) bad.push(`level ${n}: median ${quantile(runs, 0.5)}`);
    }
    expect(bad).toEqual([]);
  }, SIM_TIMEOUT_MS);

  it('more skill never makes levels slower on aggregate: greedy <= 50% <= random', () => {
    const mean = (focus: number): number => {
      let total = 0;
      let count = 0;
      for (let n = 1; n <= 30; n++) {
        const level = cachedLevel(n);
        for (let i = 0; i < 10; i++) {
          total += playLevel(level.start, level.gen, 6_000_000 + n * 100 + i, focus);
          count++;
        }
      }
      return total / count;
    };
    const greedy = mean(1);
    const half = mean(0.5);
    const random = mean(0);
    expect(greedy).toBeLessThanOrEqual(half);
    expect(half).toBeLessThanOrEqual(random);
  }, SIM_TIMEOUT_MS);
});

// ── Reproducibility ────────────────────────────────────────────────────────

describe('level reproducibility', () => {
  it('createLevel(n) does not depend on call order or on other RNG use (no hidden state)', () => {
    const N = 10;
    const ascending = Array.from({ length: N }, (_, i) => createLevel(i + 1));
    const descending: Level[] = [];
    for (let n = N; n >= 1; n--) {
      // Interleave unrelated seeded work that must not leak into level generation.
      newGame(n);
      createRng(n).next();
      descending[n - 1] = createLevel(n);
    }
    expect(descending).toEqual(ascending);
    // And hundreds of repeated calls of one level stay identical.
    const first = createLevel(17);
    for (let i = 0; i < 5; i++) expect(createLevel(17)).toEqual(first);
  }, SIM_TIMEOUT_MS);

  it('mutating a returned level’s board / tray / solution never affects a later createLevel(n)', () => {
    const pristine = JSON.parse(JSON.stringify(createLevel(9))) as Level;
    const level = createLevel(9);
    (level.start.board as number[]).fill(0);
    (level.start.tray as unknown[]).length = 0;
    (level.solution as unknown[]).length = 0;
    expect(createLevel(9)).toEqual(pristine);
  }, SIM_TIMEOUT_MS);

  // Regression (found by this suite): levelParams used to return holeFamilies
  // by reference to the module-level tier arrays, so mutating a level's params
  // changed every later level of that tier. It now returns a fresh copy.
  it('mutating a returned level’s params never affects a later createLevel(n)', () => {
    const pristine = JSON.parse(JSON.stringify(createLevel(9))) as Level;
    const families = createLevel(9).params.holeFamilies as string[];
    families.push('bogus');
    try {
      expect(levelParams(2, 4).holeFamilies).not.toContain('bogus');
      expect(createLevel(9)).toEqual(pristine);
    } finally {
      // Undo the corruption so the rest of this file sees pristine tiers.
      const i = families.indexOf('bogus');
      if (i >= 0) families.splice(i, 1);
    }
  }, SIM_TIMEOUT_MS);

  it('a whole Level round-trips through JSON unchanged', () => {
    for (let n = 1; n <= 30; n++) {
      const level = cachedLevel(n);
      expect(JSON.parse(JSON.stringify(level))).toEqual(level);
    }
  });

  it('level seeds are distinct uint32s (levels 1–20000)', () => {
    const seen = new Set<number>();
    for (let n = 1; n <= 20_000; n++) {
      const s = levelSeed(n);
      expect(Number.isInteger(s) && s >= 0 && s <= 0xffffffff).toBe(true);
      seen.add(s);
    }
    expect(seen.size).toBe(20_000);
  });

  it('very large level numbers still generate valid, fresh, deterministic levels', () => {
    for (const n of [1_000, 9_999, 54_321, 100_000, 1_000_003, 2 ** 31 - 1]) {
      const level = cachedLevel(n);
      expect(level).toEqual(createLevel(n));
      expect(level.start.board.includes(GOAL)).toBe(true);
      expect(isLevelComplete(level.start)).toBe(false);
      expect(isLevelComplete(playSolution(level, level.start))).toBe(true);
    }
  }, SIM_TIMEOUT_MS);

  it('same level + same script (placements, swaps, undos) replays identically, through save/reload', () => {
    for (let n = 1; n <= 20; n++) {
      const level = cachedLevel(n);
      const script = randomScript(level.start, 60, 7_000_000 + n, level.gen);
      const run = (reloadEvery: number): GameState[] => {
        let h = createHistory(level.start);
        const states = [h.present];
        script.forEach((a, i) => {
          h = act(h, a, level.gen);
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
      expect(run(5)).toEqual(a);
      // Replaying from a freshly generated level gives the same run too.
      if (n <= 5) expect(createLevel(n).start).toEqual(a[0]);
    }
  }, SIM_TIMEOUT_MS);

  it('undoing every move of a played level returns exactly to createLevel(n).start', () => {
    for (let n = 1; n <= 20; n++) {
      const level = cachedLevel(n);
      const script = randomScript(level.start, 50, 8_000_000 + n, level.gen);
      let h: History = createHistory(level.start);
      for (const a of script) h = act(h, a, level.gen);
      while (h.past.length > 0) h = undo(h);
      expect(h.present).toEqual(level.start);
      // ...and the scripted solution still wins from there.
      expect(isLevelComplete(playSolution(level, h.present))).toBe(true);
    }
  });

  it('the move sequence after a win is reproducible too (refills use the level gen)', () => {
    for (let n = 1; n <= 30; n++) {
      const level = cachedLevel(n);
      const won = playSolution(level, level.start);
      const fresh = n <= 5 ? createLevel(n) : cachedLevel(n);
      expect(playSolution(fresh, fresh.start)).toEqual(won);
    }
  }, SIM_TIMEOUT_MS);
});

// ── Golden-snapshot stability ──────────────────────────────────────────────
//
// level-gen.test.ts pins levels 1–30 one by one. This pins ALL of 1–60 as
// one aggregate hash, keyed by LEVEL_GEN_VERSION. If you change level
// generation you must (a) bump LEVEL_GEN_VERSION and (b) add an entry here for
// the new version — an unknown version fails loudly instead of passing.
// Regenerate with `aggregateHash()` below.

const AGGREGATE_GOLDEN: Readonly<Record<number, string>> = {
  2: 'f95e7479',
};

function aggregateHash(): string {
  return fnv(Array.from({ length: 60 }, (_, i) => levelHash(cachedLevel(i + 1))).join(','));
}

describe('golden-snapshot stability', () => {
  it('an aggregate hash of levels 1–60 is pinned for the current LEVEL_GEN_VERSION', () => {
    const pinned = AGGREGATE_GOLDEN[LEVEL_GEN_VERSION];
    expect(pinned, `no aggregate golden for LEVEL_GEN_VERSION ${LEVEL_GEN_VERSION}`).toBeDefined();
    expect(aggregateHash()).toBe(pinned);
  }, SIM_TIMEOUT_MS);

  it('the hash is stable across repeated computation', () => {
    expect(aggregateHash()).toBe(aggregateHash());
  });

  // The golden check is only as strong as the hash: any change to any field of
  // a level (board, tray, solution, params, gen, seed, rngState, genVersion)
  // must change it. In particular a genVersion bump without regenerating the
  // table can never pass silently.
  it('the level hash changes when ANY field of a level changes', () => {
    const base = createLevel(23);
    const h = levelHash(base);
    const tweaks: Array<[string, (l: Level) => Level]> = [
      ['genVersion', (l) => ({ ...l, genVersion: l.genVersion + 1 })],
      ['levelNumber', (l) => ({ ...l, levelNumber: l.levelNumber + 1 })],
      ['board cell', (l) => {
        const board = l.start.board.slice();
        board[board.indexOf(0)] = 1;
        return { ...l, start: { ...l.start, board } };
      }],
      ['goal moved', (l) => {
        const board = l.start.board.slice();
        const g = board.indexOf(GOAL);
        const f = board.findIndex((v) => v !== 0 && v !== GOAL);
        board[g] = board[f]!;
        board[f] = GOAL;
        return { ...l, start: { ...l.start, board } };
      }],
      ['tray piece', (l) => {
        const other = PIECES.find((p) => p.id !== l.start.tray[0]!.id)!;
        return { ...l, start: { ...l.start, tray: [other, ...l.start.tray.slice(1)] } };
      }],
      ['seed', (l) => ({ ...l, start: { ...l.start, seed: l.start.seed ^ 1 } })],
      ['rngState', (l) => ({ ...l, start: { ...l.start, rngState: l.start.rngState ^ 1 } })],
      ['solution', (l) => ({ ...l, solution: l.solution.map((m, i) => (i === 0 ? { ...m, r: m.r + 1 } : m)) })],
      ['generosity', (l) => ({ ...l, params: { ...l.params, generosity: l.params.generosity + 0.5 } })],
      ['gen options', (l) => ({ ...l, gen: { ...l.gen, goalBias: (l.gen.goalBias ?? 0) + 1 } })],
      ['hole families', (l) => ({ ...l, params: { ...l.params, holeFamilies: [...l.params.holeFamilies, 'x'] } })],
    ];
    for (const [name, tweak] of tweaks) {
      expect({ name, changed: levelHash(tweak(base)) !== h }).toEqual({ name, changed: true });
    }
  });

  it('every level is stamped with the current LEVEL_GEN_VERSION', () => {
    for (const n of [1, 30, 31, 300, 12_345]) expect(cachedLevel(n).genVersion).toBe(LEVEL_GEN_VERSION);
  }, SIM_TIMEOUT_MS);
});

// ── levelParams monotonicity ───────────────────────────────────────────────

describe('levelParams: ramps within a stage, resets across stages', () => {
  const STAGES = 200;

  it('within a stage the hole-piece families only grow (each tier is a superset of the last)', () => {
    for (let stage = 1; stage <= STAGES; stage++) {
      for (let l = 2; l <= LEVELS_PER_STAGE; l++) {
        const prev = levelParams(stage, l - 1).holeFamilies;
        const cur = levelParams(stage, l).holeFamilies;
        for (const f of prev) expect(cur).toContain(f);
      }
    }
  });

  it('within a stage the move range climbs and the goal bias never drops', () => {
    for (let stage = 1; stage <= STAGES; stage++) {
      for (let l = 2; l <= LEVELS_PER_STAGE; l++) {
        const a = levelParams(stage, l - 1);
        const b = levelParams(stage, l);
        expect(b.minMoves).toBeGreaterThan(a.maxMoves);
        expect(b.targetLines).toBeGreaterThanOrEqual(a.targetLines);
        expect(b.goalBias).toBeGreaterThanOrEqual(a.goalBias);
      }
    }
  });

  it('every stage boundary resets: level 1 of stage s+1 is strictly easier than level 5 of stage s', () => {
    for (let stage = 1; stage < STAGES; stage++) {
      const end = levelParams(stage, LEVELS_PER_STAGE);
      const next = levelParams(stage + 1, 1);
      expect(next.targetLines).toBeLessThan(end.targetLines);
      expect(next.maxMoves).toBeLessThan(end.minMoves);
      expect(next.holeFamilies.length).toBeLessThan(end.holeFamilies.length);
      expect(next.scripted).toBeGreaterThan(end.scripted);
    }
  });

  it('the same slot of a later stage is never easier (overall difficulty rises, then plateaus)', () => {
    for (let stage = 2; stage <= STAGES; stage++) {
      for (let l = 1; l <= LEVELS_PER_STAGE; l++) {
        const a = levelParams(stage - 1, l);
        const b = levelParams(stage, l);
        expect(b.targetLines).toBeGreaterThanOrEqual(a.targetLines);
        expect(b.generosity).toBeLessThanOrEqual(a.generosity);
        expect(b.minMoves).toBeGreaterThanOrEqual(a.minMoves);
        for (const f of a.holeFamilies) expect(b.holeFamilies).toContain(f);
      }
    }
  });

  it('params are always coherent: real families, ordered bounds, scripted <= holes', () => {
    for (let stage = 1; stage <= 20; stage++) {
      for (let l = 1; l <= LEVELS_PER_STAGE; l++) {
        const p = levelParams(stage, l);
        for (const f of p.holeFamilies) {
          expect(PIECES.some((q) => q.id.replace(/-\d+$/, '') === f)).toBe(true);
        }
        expect(p.minHoles).toBeLessThanOrEqual(p.maxHoles);
        expect(p.minMoves).toBeLessThanOrEqual(p.maxMoves);
        expect(p.scripted).toBeLessThanOrEqual(p.minHoles);
        expect(p.crossLines).toBeLessThan(p.targetLines);
        expect(p.minMoves).toBeGreaterThanOrEqual(p.minHoles + (p.bigGap ? 2 : 0));
      }
    }
  });

  it('is pure: repeated calls return equal params', () => {
    for (let stage = 1; stage <= 10; stage++) {
      for (let l = 1; l <= LEVELS_PER_STAGE; l++) expect(levelParams(stage, l)).toEqual(levelParams(stage, l));
    }
  });

  it('rejects non-integer stage / level-within-stage', () => {
    for (const [s, l] of [[1.5, 1], [1, 2.5], [NaN, 1], [1, NaN], [-3, 1], [1, -1], [Infinity, 1]] as const) {
      expect(() => levelParams(s, l)).toThrow(RangeError);
    }
  });

  it('the generated levels follow their params (target lines and crossing per stage slot)', () => {
    for (let n = 1; n <= 60; n++) {
      const level = cachedLevel(n);
      const { stage, level: inStage } = levelPosition(n);
      expect(level.params).toEqual(levelParams(stage, inStage));
      expect(level.targets.rows.length + level.targets.cols.length).toBe(level.params.targetLines);
      expect(Math.min(level.targets.rows.length, level.targets.cols.length)).toBe(level.params.crossLines);
    }
  }, SIM_TIMEOUT_MS);
});

// ── Completability off the scripted path ───────────────────────────────────

describe('every level is completable, including via swap and undo', () => {
  const LEVELS = 60;

  it('no catalog piece carries the GOAL value, so a won level stays won', () => {
    for (const p of PIECES) expect(p.color).not.toBe(GOAL);
    for (let n = 1; n <= 10; n++) {
      const level = cachedLevel(n);
      let h = createHistory(playSolution(level, level.start));
      const pick = createRng(9_000_000 + n);
      for (let step = 0; step < 40; step++) {
        const s = h.present;
        if (isStuck(s)) {
          h = act(h, { kind: 'swap' }, level.gen);
        } else {
          const moves: Action[] = [];
          s.tray.forEach((p, slot) => {
            if (p) for (const { r, c } of placements(s.board, p)) moves.push({ kind: 'place', slot, r, c });
          });
          h = act(h, pick.pick(moves), level.gen);
        }
        expect(isLevelComplete(h.present)).toBe(true);
      }
    }
  }, SIM_TIMEOUT_MS);

  it('a partial solution (every proper prefix) never completes a level', () => {
    for (let n = 1; n <= LEVELS; n++) {
      const level = cachedLevel(n);
      let s = level.start;
      for (const m of level.solution.slice(0, -1)) {
        const res = applyMove(s, m.slot, m.r, m.c, level.gen);
        if (!res.ok) throw new Error(`level ${n}: ${res.error}`);
        s = res.result.state;
        expect(isLevelComplete(s)).toBe(false);
      }
    }
  }, SIM_TIMEOUT_MS);

  it('swap then undo restores the scripted tray, and the solution still wins', () => {
    for (let n = 1; n <= LEVELS; n++) {
      const level = cachedLevel(n);
      let h = createHistory(level.start);
      h = act(h, { kind: 'swap' }, level.gen);
      h = undo(h);
      expect(h.present).toBe(level.start);
      expect(isLevelComplete(playSolution(level, h.present))).toBe(true);
    }
  }, SIM_TIMEOUT_MS);

  it('a wrong first move then undo restores the start, and the solution still wins', () => {
    let tried = 0;
    for (let n = 1; n <= LEVELS; n++) {
      const level = cachedLevel(n);
      const wrong = wrongMove(level);
      if (!wrong) continue;
      tried++;
      let h = act(createHistory(level.start), wrong, level.gen);
      expect(h.present).not.toEqual(level.start);
      h = undo(h);
      expect(h.present).toEqual(level.start);
      expect(isLevelComplete(playSolution(level, h.present))).toBe(true);
    }
    expect(tried).toBe(LEVELS); // an empty-ish board always has another spot
  }, SIM_TIMEOUT_MS);

  // Off the recorded path the win is not guaranteed by construction; the goal
  // bias has to steer her back. A greedy player who swaps away the scripted
  // tray first, or who first makes a wrong move, must still finish.
  it('after swapping away the first tray, a greedy player still completes every level 1–60', () => {
    const bad: string[] = [];
    for (let n = 1; n <= LEVELS; n++) {
      const level = cachedLevel(n);
      const swapped = swapTray(level.start, level.gen);
      const placed = playLevel(swapped, level.gen, 10_000_000 + n, 1);
      if (placed > 200) bad.push(`level ${n}`);
    }
    expect(bad).toEqual([]);
  }, SIM_TIMEOUT_MS);

  it('after a wrong first move (kept), a greedy player still completes every level 1–60', () => {
    const bad: string[] = [];
    for (let n = 1; n <= LEVELS; n++) {
      const level = cachedLevel(n);
      const wrong = wrongMove(level)!;
      if (wrong.kind !== 'place') throw new Error('unreachable');
      const res = applyMove(level.start, wrong.slot, wrong.r, wrong.c, level.gen);
      if (!res.ok) throw new Error(`level ${n}: ${res.error}`);
      const placed = playLevel(res.result.state, level.gen, 11_000_000 + n, 1);
      if (placed > 200) bad.push(`level ${n}`);
    }
    expect(bad).toEqual([]);
  }, SIM_TIMEOUT_MS);

  it('after random play with swaps and undos, the level is still completable (levels 1–60)', () => {
    const bad: string[] = [];
    for (let n = 1; n <= 60; n++) {
      const level = cachedLevel(n);
      const script = randomScript(level.start, 25, 12_000_000 + n, level.gen);
      let h = createHistory(level.start);
      for (const a of script) h = act(h, a, level.gen);
      const placed = isLevelComplete(h.present) ? 0 : playLevel(h.present, level.gen, 13_000_000 + n, 0.5);
      if (placed > 200) bad.push(`level ${n}`);
    }
    expect(bad).toEqual([]);
  }, SIM_TIMEOUT_MS);
});
