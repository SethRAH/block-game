/**
 * Level generation (PR B2) — complementary edge / fuzz coverage.
 *
 * Deliberately does NOT repeat level-gen.test.ts / invariants.test.ts (the
 * 1–30 anti-slog sim at focus 0.5, no-level-starts-complete for 1–300, and the
 * per-level golden hashes of 1–30). Instead it widens and hardens them:
 *  - the slog sim over levels 1–60 with a fresh seed base, plus greedy and
 *    purely random players;
 *  - reproducibility independent of call order / hidden state, and through
 *    undo, swaps, replay and save/reload;
 *  - an aggregate golden hash (levels 1–300) keyed by LEVEL_GEN_VERSION, so a
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
  BOARD_SIZE,
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
import { act, randomScript, type Action } from './helpers.ts';
import { playLevel, quantile } from './sim-player.ts';

/** The sims take tens of seconds on slow CI runners. */
const SIM_TIMEOUT_MS = 120_000;

/** 32-bit FNV-1a of a string, as 8 hex digits (same hash as level-gen.test.ts). */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
const levelHash = (level: Level): string => fnv(JSON.stringify(level));

/** Every ordering of [0, 1, 2]. */
const ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

/** Play the level's scripted solution from `s` (which must hold the scripted tray). */
function playSolution(level: Level, s: GameState): GameState {
  for (const m of level.solution) {
    const res = applyMove(s, m.slot, m.r, m.c, level.gen);
    if (!res.ok) throw new Error(`level ${level.levelNumber}: solution move rejected (${res.error})`);
    s = res.result.state;
  }
  return s;
}

/** A legal placement that is NOT the scripted solution move for its slot, if any. */
function wrongMove(level: Level): Action | null {
  const s = level.start;
  for (let slot = 0; slot < s.tray.length; slot++) {
    const p = s.tray[slot];
    if (!p) continue;
    const m = level.solution.find((x) => x.slot === slot)!;
    for (const { r, c } of placements(s.board, p)) {
      if (r !== m.r || c !== m.c) return { kind: 'place', slot, r, c };
    }
  }
  return null;
}

// ── Anti-slog sim, widened ─────────────────────────────────────────────────

describe('anti-slog sim, widened (levels 1–60, fresh seeds, three player models)', () => {
  const LAST = 60;

  // The design bar (median <= 20, p90 <= 35) for the 50%-focus player, now
  // over 1–60 with a seed base disjoint from invariants.test.ts and more runs
  // (so a nearest-rank p90 is less noisy). Observed worst case at the time of
  // writing: median 13, p90 34 — the p90 bar has little headroom.
  it('50%-focus player: every level 1–60 has median <= 20 and p90 <= 35', () => {
    const RUNS = 80;
    const bad: string[] = [];
    for (let n = 1; n <= LAST; n++) {
      const level = createLevel(n);
      const runs = Array.from({ length: RUNS }, (_, i) =>
        playLevel(level.start, level.gen, 3_000_000 + n * 1_000 + i, 0.5),
      );
      const median = quantile(runs, 0.5);
      const p90 = quantile(runs, 0.9);
      if (median > 20 || p90 > 35) bad.push(`level ${n}: median ${median}, p90 ${p90}`);
    }
    expect(bad).toEqual([]);
  }, SIM_TIMEOUT_MS);

  // A greedy player always sees the obvious home of each scripted piece, so
  // she finishes every level in exactly the three scripted placements.
  it('greedy player finishes every level 1–120 in exactly 3 placements', () => {
    const bad: string[] = [];
    for (let n = 1; n <= 120; n++) {
      const level = createLevel(n);
      for (let i = 0; i < 4; i++) {
        const placed = playLevel(level.start, level.gen, 4_000_000 + n * 100 + i, 1);
        if (placed !== 3) bad.push(`level ${n} run ${i}: ${placed}`);
      }
    }
    expect(bad).toEqual([]);
  }, SIM_TIMEOUT_MS);

  // A purely random player is NOT held to the design bar (it was never meant
  // for her: at the time of writing her medians reach ~40 and p90s ~90). The
  // guard here is "no runaway": every run finishes within the sim's cap, and
  // her typical level stays within about twice the bar.
  it('purely random player: every run of levels 1–60 finishes within the cap; median <= 50', () => {
    const RUNS = 30;
    const CAP = 200;
    const bad: string[] = [];
    for (let n = 1; n <= LAST; n++) {
      const level = createLevel(n);
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
        const level = createLevel(n);
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
    const N = 80;
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
    for (let i = 0; i < 200; i++) expect(createLevel(17)).toEqual(first);
  });

  it('mutating a returned level’s board / tray / solution never affects a later createLevel(n)', () => {
    const pristine = JSON.parse(JSON.stringify(createLevel(9))) as Level;
    const level = createLevel(9);
    (level.start.board as number[]).fill(0);
    (level.start.tray as unknown[]).length = 0;
    (level.solution as unknown[]).length = 0;
    expect(createLevel(9)).toEqual(pristine);
  });

  // KNOWN BUG (reported, not fixed here — test-only PR): levelParams returns
  // holeFamilies by reference to the module-level FAMILY_TIERS arrays, which
  // are only compile-time readonly. A caller that mutates level.params
  // .holeFamilies at runtime changes every later level using that tier, so a
  // level number no longer reproduces its level. When levelParams returns a
  // copy (or freezes the tiers), this it.fails will start failing: turn it
  // into a plain it().
  it.fails('mutating a returned level’s params never affects a later createLevel(n)', () => {
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
  });

  it('a whole Level round-trips through JSON unchanged', () => {
    for (let n = 1; n <= 100; n++) {
      const level = createLevel(n);
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
      const level = createLevel(n);
      expect(level).toEqual(createLevel(n));
      expect(level.start.board.includes(GOAL)).toBe(true);
      expect(isLevelComplete(level.start)).toBe(false);
      expect(isLevelComplete(playSolution(level, level.start))).toBe(true);
    }
  });

  it('same level + same script (placements, swaps, undos) replays identically, through save/reload', () => {
    for (let n = 1; n <= 40; n++) {
      const level = createLevel(n);
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
      expect(createLevel(n).start).toEqual(a[0]);
    }
  });

  it('undoing every move of a played level returns exactly to createLevel(n).start', () => {
    for (let n = 1; n <= 40; n++) {
      const level = createLevel(n);
      const script = randomScript(level.start, 50, 8_000_000 + n, level.gen);
      let h: History = createHistory(level.start);
      for (const a of script) h = act(h, a, level.gen);
      while (h.past.length > 0) h = undo(h);
      expect(h.present).toEqual(createLevel(n).start);
      // ...and the scripted solution still wins from there.
      expect(isLevelComplete(playSolution(level, h.present))).toBe(true);
    }
  });

  it('the move sequence after a win is reproducible too (refills use the level gen)', () => {
    for (let n = 1; n <= 30; n++) {
      const level = createLevel(n);
      const won = playSolution(level, level.start);
      const again = playSolution(createLevel(n), createLevel(n).start);
      expect(again).toEqual(won);
      expect(won.tray.every((p) => p !== null)).toBe(true); // refilled after the third placement
    }
  });
});

// ── Golden-snapshot stability ──────────────────────────────────────────────
//
// level-gen.test.ts pins levels 1–30 one by one. This pins ALL of 1–300 as
// one aggregate hash, keyed by LEVEL_GEN_VERSION. If you change level
// generation you must (a) bump LEVEL_GEN_VERSION and (b) add an entry here for
// the new version — an unknown version fails loudly instead of passing.
// Regenerate with `aggregateHash()` below.

const AGGREGATE_GOLDEN: Readonly<Record<number, string>> = {
  1: '5c985533',
};

function aggregateHash(): string {
  return fnv(Array.from({ length: 300 }, (_, i) => levelHash(createLevel(i + 1))).join(','));
}

describe('golden-snapshot stability', () => {
  it('an aggregate hash of levels 1–300 is pinned for the current LEVEL_GEN_VERSION', () => {
    const pinned = AGGREGATE_GOLDEN[LEVEL_GEN_VERSION];
    expect(pinned, `no aggregate golden for LEVEL_GEN_VERSION ${LEVEL_GEN_VERSION}`).toBeDefined();
    expect(aggregateHash()).toBe(pinned);
  });

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
    for (const n of [1, 30, 31, 300, 12_345]) expect(createLevel(n).genVersion).toBe(LEVEL_GEN_VERSION);
  });
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

  it('within a stage the hole-cell bounds never shrink and goal bias is constant', () => {
    for (let stage = 1; stage <= STAGES; stage++) {
      for (let l = 2; l <= LEVELS_PER_STAGE; l++) {
        const a = levelParams(stage, l - 1);
        const b = levelParams(stage, l);
        expect(b.minHoleCells).toBeGreaterThanOrEqual(a.minHoleCells);
        expect(b.maxHoleCells).toBeGreaterThanOrEqual(a.maxHoleCells);
        expect(b.goalBias).toBe(a.goalBias);
      }
    }
  });

  it('every stage boundary resets: level 1 of stage s+1 is strictly easier than level 5 of stage s', () => {
    for (let stage = 1; stage < STAGES; stage++) {
      const end = levelParams(stage, LEVELS_PER_STAGE);
      const next = levelParams(stage + 1, 1);
      expect(next.targetLines).toBeLessThan(end.targetLines);
      expect(next.generosity).toBeGreaterThan(end.generosity);
      expect(next.holeFamilies.length).toBeLessThan(end.holeFamilies.length);
    }
  });

  it('the same slot of a later stage is never easier (overall difficulty rises, then plateaus)', () => {
    for (let stage = 2; stage <= STAGES; stage++) {
      for (let l = 1; l <= LEVELS_PER_STAGE; l++) {
        const a = levelParams(stage - 1, l);
        const b = levelParams(stage, l);
        expect(b.targetLines).toBeGreaterThanOrEqual(a.targetLines);
        expect(b.generosity).toBeLessThanOrEqual(a.generosity);
        expect(b.minHoleCells).toBeGreaterThanOrEqual(a.minHoleCells);
      }
    }
  });

  it('params are always feasible: 3 hole pieces fit the hole-cell bounds, lines never all hole', () => {
    const sizeOf = (fam: string) => PIECES.filter((p) => p.id.replace(/-\d+$/, '') === fam).map((p) => p.cells.length);
    for (let stage = 1; stage <= 20; stage++) {
      for (let l = 1; l <= LEVELS_PER_STAGE; l++) {
        const p = levelParams(stage, l);
        const sizes = p.holeFamilies.flatMap(sizeOf);
        expect(sizes.length).toBeGreaterThan(0); // every family name exists in the catalog
        expect(p.minHoleCells).toBeGreaterThanOrEqual(3);
        expect(3 * Math.min(...sizes)).toBeLessThanOrEqual(p.maxHoleCells);
        expect(3 * Math.max(...sizes)).toBeGreaterThanOrEqual(p.minHoleCells);
        // Each target line keeps at least one tile (a goal).
        expect(p.maxHoleCells).toBeLessThan(p.targetLines * BOARD_SIZE);
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

  it('the generated levels follow their params (observed target lines and families per stage slot)', () => {
    for (let n = 1; n <= 100; n++) {
      const level = createLevel(n);
      const { stage, level: inStage } = levelPosition(n);
      expect(level.params).toEqual(levelParams(stage, inStage));
      for (const p of level.start.tray) {
        expect(level.params.holeFamilies).toContain(p!.id.replace(/-\d+$/, ''));
      }
    }
  });
});

// ── Completability off the scripted path ───────────────────────────────────

describe('every level is completable, including via swap and undo', () => {
  const LEVELS = 300;

  it('no catalog piece carries the GOAL value, so a won level stays won', () => {
    for (const p of PIECES) expect(p.color).not.toBe(GOAL);
    for (let n = 1; n <= 30; n++) {
      const level = createLevel(n);
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
  });

  it('a partial solution (1 or 2 of the 3 holes, any order) never completes a level', () => {
    for (let n = 1; n <= LEVELS; n++) {
      const level = createLevel(n);
      for (const order of ORDERS) {
        let s = level.start;
        for (const i of order.slice(0, 2)) {
          const m = level.solution[i]!;
          const res = applyMove(s, m.slot, m.r, m.c, level.gen);
          if (!res.ok) throw new Error(`level ${n}: ${res.error}`);
          s = res.result.state;
          expect(isLevelComplete(s)).toBe(false);
        }
      }
    }
  });

  it('swap then undo restores the scripted tray, and the solution still wins', () => {
    for (let n = 1; n <= LEVELS; n++) {
      const level = createLevel(n);
      let h = createHistory(level.start);
      h = act(h, { kind: 'swap' }, level.gen);
      h = undo(h);
      expect(h.present).toBe(level.start);
      expect(isLevelComplete(playSolution(level, h.present))).toBe(true);
    }
  });

  it('a wrong first move then undo restores the start, and the solution still wins', () => {
    let tried = 0;
    for (let n = 1; n <= LEVELS; n++) {
      const level = createLevel(n);
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
  });

  // Off the scripted path the win is not guaranteed by construction; the goal
  // bias has to steer her back. A greedy player who swaps away the scripted
  // tray first, or who first makes a wrong move, must still finish.
  it('after swapping away the scripted tray, a greedy player still completes every level 1–300', () => {
    const bad: string[] = [];
    for (let n = 1; n <= LEVELS; n++) {
      const level = createLevel(n);
      const swapped = swapTray(level.start, level.gen);
      const placed = playLevel(swapped, level.gen, 10_000_000 + n, 1);
      if (placed > 200) bad.push(`level ${n}`);
    }
    expect(bad).toEqual([]);
  }, SIM_TIMEOUT_MS);

  it('after a wrong first move (kept), a greedy player still completes every level 1–300', () => {
    const bad: string[] = [];
    for (let n = 1; n <= LEVELS; n++) {
      const level = createLevel(n);
      const wrong = wrongMove(level)!;
      if (wrong.kind !== 'place') throw new Error('unreachable');
      const res = applyMove(level.start, wrong.slot, wrong.r, wrong.c, level.gen);
      if (!res.ok) throw new Error(`level ${n}: ${res.error}`);
      const placed = playLevel(res.result.state, level.gen, 11_000_000 + n, 1);
      if (placed > 200) bad.push(`level ${n}`);
    }
    expect(bad).toEqual([]);
  }, SIM_TIMEOUT_MS);

  it('after random play with swaps and undos, the level is still completable (levels 1–100)', () => {
    const bad: string[] = [];
    for (let n = 1; n <= 100; n++) {
      const level = createLevel(n);
      const script = randomScript(level.start, 25, 12_000_000 + n, level.gen);
      let h = createHistory(level.start);
      for (const a of script) h = act(h, a, level.gen);
      const placed = isLevelComplete(h.present) ? 0 : playLevel(h.present, level.gen, 13_000_000 + n, 0.5);
      if (placed > 200) bad.push(`level ${n}`);
    }
    expect(bad).toEqual([]);
  }, SIM_TIMEOUT_MS);
});
