import { describe, it, expect } from 'vitest';
import { createRng } from '../src/core/rng.ts';

describe('seeded rng', () => {
  it('is deterministic: same seed → same sequence', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('different seeds → different sequences', () => {
    const a = Array.from({ length: 20 }, () => createRng(1).next());
    const b = Array.from({ length: 20 }, () => createRng(2).next());
    expect(a).not.toEqual(b);
  });

  it('next() stays within [0, 1)', () => {
    const r = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('int() stays within inclusive bounds', () => {
    const r = createRng(123);
    for (let i = 0; i < 1000; i++) {
      const v = r.int(3, 8);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(8);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('shuffle is a permutation and deterministic by seed', () => {
    const base = [1, 2, 3, 4, 5, 6, 7, 8];
    const s1 = createRng(99).shuffle([...base]);
    const s2 = createRng(99).shuffle([...base]);
    expect(s1).toEqual(s2);
    expect([...s1].sort((x, y) => x - y)).toEqual(base);
  });
});

describe('seeded rng state', () => {
  it('getState + createRng(seed, state) resumes the exact sequence', () => {
    const a = createRng(5);
    for (let i = 0; i < 10; i++) a.next();
    const saved = a.getState();
    const expected = Array.from({ length: 20 }, () => a.next());
    const b = createRng(5, saved);
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(expected);
  });

  it('a fresh rng and one resumed from its initial state agree', () => {
    const a = createRng(77);
    const b = createRng(77, a.getState());
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(Array.from({ length: 5 }, () => b.next()));
  });

  it('getState is a uint32 (the saved-game format)', () => {
    const a = createRng(3);
    for (let i = 0; i < 100; i++) {
      a.next();
      const s = a.getState();
      expect(Number.isInteger(s) && s >= 0 && s <= 0xffffffff).toBe(true);
    }
  });
});
