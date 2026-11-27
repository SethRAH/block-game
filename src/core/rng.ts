/**
 * Seeded, deterministic pseudo-random number generator.
 *
 * The whole game's randomness (level layout, tray pieces) must flow through a
 * seeded RNG so that a given level number is perfectly reproducible — for
 * debugging and for letting her replay a favorite level. Never call Math.random
 * in game logic; take an Rng instead.
 *
 * Algorithm: mulberry32 — tiny, fast, good enough for a puzzle game.
 */
export interface Rng {
  /** Next float in [0, 1). */
  next(): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Uniformly pick one element. Throws on empty array. */
  pick<T>(items: readonly T[]): T;
  /** In-place Fisher–Yates shuffle; returns the same array for convenience. */
  shuffle<T>(items: T[]): T[];
}

export function createRng(seed: number): Rng {
  // Mix the seed so small/zero seeds still behave well.
  let state = (seed ^ 0x9e3779b9) >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number =>
    min + Math.floor(next() * (max - min + 1));

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error('pick() on empty array');
    return items[int(0, items.length - 1)]!;
  };

  const shuffle = <T>(items: T[]): T[] => {
    for (let i = items.length - 1; i > 0; i--) {
      const j = int(0, i);
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  };

  return { next, int, pick, shuffle };
}
