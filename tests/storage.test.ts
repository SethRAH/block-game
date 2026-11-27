import { describe, it, expect, beforeEach } from 'vitest';
import { applyMove, commit, createHistory, newGame, type History } from '../src/core/index.ts';
import { ENDLESS_KEY, loadEndless, saveEndless } from '../src/pwa/storage.ts';

/** Minimal in-memory localStorage with an optional byte quota. */
class FakeStorage {
  data = new Map<string, string>();
  quota = Infinity;
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (v.length > this.quota) throw new Error('QuotaExceededError');
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

let store: FakeStorage;
beforeEach(() => {
  store = new FakeStorage();
  (globalThis as { localStorage?: unknown }).localStorage = store;
});

function playedHistory(moves: number): History {
  let h = createHistory(newGame(8));
  for (let i = 0; i < moves; i++) {
    const s = h.present;
    let placed = false;
    for (let slot = 0; slot < 3 && !placed; slot++) {
      for (let r = 0; r < 8 && !placed; r++) {
        for (let c = 0; c < 8 && !placed; c++) {
          const res = applyMove(s, slot, r, c);
          if (res.ok) {
            h = commit(h, res.result.state);
            placed = true;
          }
        }
      }
    }
  }
  return h;
}

describe('endless save (block-game:endless:v1)', () => {
  it('uses the agreed key', () => {
    expect(ENDLESS_KEY).toBe('block-game:endless:v1');
  });

  it('round-trips the full undo history', () => {
    const h = playedHistory(6);
    saveEndless(h);
    expect(loadEndless()).toEqual(h);
  });

  it('returns null (→ new game) for missing, corrupt, or mismatched saves', () => {
    expect(loadEndless()).toBeNull();
    for (const bad of [
      '{oops',
      'null',
      '[]',
      JSON.stringify({ v: 2, history: createHistory(newGame(1)) }),
      JSON.stringify({ v: 1 }),
      JSON.stringify({ v: 1, history: { past: [], present: { board: [] } } }),
    ]) {
      store.data.set(ENDLESS_KEY, bad);
      expect(loadEndless()).toBeNull();
    }
  });

  it('never throws when storage itself is unavailable', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('SecurityError');
      },
    };
    expect(loadEndless()).toBeNull();
    expect(() => saveEndless(createHistory(newGame(1)))).not.toThrow();
  });

  it('when over quota, drops the oldest undo steps but keeps the current game', () => {
    const h = playedHistory(20);
    const full = JSON.stringify({ v: 1, history: h }).length;
    store.quota = Math.floor(full * 0.6);
    saveEndless(h);
    const loaded = loadEndless();
    expect(loaded?.present).toEqual(h.present);
    expect(loaded!.past.length).toBeLessThan(h.past.length);
    expect(loaded!.past.length).toBeGreaterThan(0);
    // The kept steps are the most recent ones.
    expect(loaded!.past).toEqual(h.past.slice(h.past.length - loaded!.past.length));
  });
});
