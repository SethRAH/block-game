import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyMove,
  commit,
  createHistory,
  GOAL,
  LEVEL_GEN_VERSION,
  newGame,
  type GameState,
  type History,
} from '../src/core/index.ts';
import {
  clearLevel,
  DEFAULT_SAVE,
  ENDLESS_KEY,
  LEVEL_KEY,
  loadEndless,
  loadLevel,
  loadSave,
  parseLevelSave,
  parseSaveData,
  PROGRESS_KEY,
  saveEndless,
  saveLevel,
  totalStars,
  writeSave,
  type LevelSave,
  type SaveData,
} from '../src/pwa/storage.ts';

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

function playedHistory(moves: number, start: GameState = newGame(8)): History {
  let h = createHistory(start);
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

// ── Levels and progress (additive keys) ─────────────────────────────────────

/** A level-like start: game 8 with goal tiles down the diagonal. */
function levelStart(): GameState {
  const s = newGame(8);
  return { ...s, board: s.board.map((v, i) => (i % 9 === 0 ? GOAL : v)) };
}

function levelSave(moves: number): LevelSave {
  const start = levelStart();
  return { levelNumber: 7, genVersion: LEVEL_GEN_VERSION, start, history: playedHistory(moves, start) };
}

const goalsOf = (s: GameState) => s.board.flatMap((v, i) => (v === GOAL ? [i] : []));
const allStates = (h: History) => [...h.past, h.present];

describe('level save (block-game:level:v1)', () => {
  it('uses its own keys, distinct from the endless save', () => {
    expect(LEVEL_KEY).toBe('block-game:level:v1');
    expect(PROGRESS_KEY).toBe('block-game:progress:v1');
    expect(new Set([ENDLESS_KEY, LEVEL_KEY, PROGRESS_KEY]).size).toBe(3);
  });

  it('round-trips, keeping every goal tile in the start and in every history state', () => {
    const save = levelSave(5);
    expect(goalsOf(save.start)).toHaveLength(8);
    saveLevel(save);
    const loaded = loadLevel();
    expect(loaded).toEqual(save);
    expect(goalsOf(loaded!.start)).toEqual(goalsOf(save.start));
    expect(allStates(loaded!.history).map(goalsOf)).toEqual(allStates(save.history).map(goalsOf));
  });

  it('when over quota, drops the oldest undo steps but keeps the start and the current game', () => {
    const save = levelSave(20);
    store.quota = Math.floor(JSON.stringify(save).length * 0.6);
    saveLevel(save);
    const loaded = loadLevel()!;
    expect(loaded.start).toEqual(save.start);
    expect(loaded.history.present).toEqual(save.history.present);
    expect(loaded.history.past.length).toBeLessThan(save.history.past.length);
    expect(loaded.history.past).toEqual(save.history.past.slice(save.history.past.length - loaded.history.past.length));
  });

  it('clearLevel forgets the level only', () => {
    saveEndless(playedHistory(3));
    const endlessRaw = store.data.get(ENDLESS_KEY);
    saveLevel(levelSave(2));
    clearLevel();
    expect(loadLevel()).toBeNull();
    expect(store.data.get(ENDLESS_KEY)).toBe(endlessRaw);
  });

  it('rejects corrupt, old-format and inconsistent saves (→ null, never throws)', () => {
    const good = levelSave(3);
    const plain = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
    const otherSeed = { ...good.history.present, seed: good.start.seed + 1 };
    const bad: unknown[] = [
      null,
      42,
      'level',
      [plain],
      {},
      { ...plain, genVersion: LEVEL_GEN_VERSION + 1 }, // a different generator version
      { ...plain, genVersion: undefined },
      { ...plain, levelNumber: 0 },
      { ...plain, levelNumber: 1.5 },
      { ...plain, levelNumber: '7' },
      { ...plain, levelNumber: 1e9 },
      { ...plain, start: undefined },
      { ...plain, start: { ...good.start, board: [] } },
      { ...plain, start: newGame(8) }, // a level always starts with goal tiles
      { ...plain, history: undefined },
      { ...plain, history: { past: [], present: { board: [] } } },
      { ...plain, history: { past: 'x', present: good.history.present } },
      { ...plain, history: { past: [], present: otherSeed } }, // not the same game
      { ...plain, history: { past: new Array(50_001).fill(null), present: good.history.present } }, // bounded
      createHistory(newGame(1)), // an endless-shaped record
      { v: 1, history: good.history }, // the endless envelope
    ];
    for (const b of bad) {
      expect(() => parseLevelSave(b)).not.toThrow();
      expect(parseLevelSave(b)).toBeNull();
    }
    expect(parseLevelSave(plain)).toEqual(good);
  });

  it('loadLevel returns null for missing or garbled storage', () => {
    expect(loadLevel()).toBeNull();
    for (const raw of ['{oops', 'null', '[]', '"x"', JSON.stringify({ levelNumber: 1 })]) {
      store.data.set(LEVEL_KEY, raw);
      expect(loadLevel()).toBeNull();
    }
  });
});

describe('player progress (block-game:progress:v1)', () => {
  const sample: SaveData = { level: 4, bestStars: { '1': 3, '2': 1, '3': 2 }, unlocked: ['sticker-star', 'theme-sea'] };

  it('defaults for a new player, as a fresh copy each time', () => {
    const a = loadSave();
    expect(a).toEqual({ level: 1, bestStars: {}, unlocked: [] });
    expect(a).toEqual(DEFAULT_SAVE);
    expect(a.bestStars).not.toBe(DEFAULT_SAVE.bestStars);
    expect(a.unlocked).not.toBe(DEFAULT_SAVE.unlocked);
  });

  it('round-trips, and derives cumulative stars from the per-level best', () => {
    writeSave(sample);
    expect(loadSave()).toEqual(sample);
    expect(totalStars(loadSave())).toBe(6);
    expect(totalStars(DEFAULT_SAVE)).toBe(0);
  });

  it('rejects corrupt, out-of-range and old-format data (→ a fresh default, never throws)', () => {
    const bad: unknown[] = [
      null,
      [],
      'x',
      { stage: 1, level: 1, unlocked: [] }, // the old pre-levels placeholder shape
      { level: 2, stars: 5, unlocked: [] }, // a cumulative-total shape
      { ...sample, level: 0 },
      { ...sample, level: 2.5 },
      { ...sample, level: '3' },
      { ...sample, bestStars: [3, 1] },
      { ...sample, bestStars: null },
      { ...sample, bestStars: { '0': 1 } },
      { ...sample, bestStars: { '01': 1 } },
      { ...sample, bestStars: { abc: 1 } },
      { ...sample, bestStars: { '1': 4 } },
      { ...sample, bestStars: { '1': -1 } },
      { ...sample, bestStars: { '1': 1.5 } },
      { ...sample, bestStars: { '1': '3' } },
      { ...sample, unlocked: 'theme-sea' },
      { ...sample, unlocked: [7] },
      { ...sample, unlocked: [''] },
      { ...sample, unlocked: ['x'.repeat(65)] },
      { ...sample, unlocked: Array.from({ length: 1001 }, (_, i) => `r${i}`) },
    ];
    for (const b of bad) {
      expect(() => parseSaveData(b)).not.toThrow();
      expect(parseSaveData(b)).toBeNull();
      store.data.set(PROGRESS_KEY, JSON.stringify(b));
      expect(loadSave()).toEqual(DEFAULT_SAVE);
    }
    // A prototype-pollution key is just an invalid level key.
    expect(parseSaveData(JSON.parse('{"level":1,"bestStars":{"__proto__":1},"unlocked":[]}'))).toBeNull();
    store.data.set(PROGRESS_KEY, '{oops');
    expect(loadSave()).toEqual(DEFAULT_SAVE);
  });

  it('strips unknown fields and tolerates duplicate reward ids', () => {
    const parsed = parseSaveData({ ...sample, unlocked: ['a', 'b', 'a'], extra: true });
    expect(parsed).toEqual({ ...sample, unlocked: ['a', 'b'] });
  });
});

describe('the endless save survives the levels update', () => {
  it('a save in the pre-levels format still loads, and no level/progress operation touches it', () => {
    // Exactly what the shipped build writes: { v: 1, history }.
    const h = playedHistory(8);
    const raw = JSON.stringify({ v: 1, history: h });
    store.data.set(ENDLESS_KEY, raw);

    expect(loadEndless()).toEqual(h);
    saveLevel(levelSave(4));
    writeSave({ level: 3, bestStars: { '1': 2 }, unlocked: ['x'] });
    loadLevel();
    loadSave();
    clearLevel();

    expect(store.data.get(ENDLESS_KEY)).toBe(raw);
    expect(loadEndless()).toEqual(h);
  });

  it('saveEndless still writes the exact pre-levels format', () => {
    const h = playedHistory(4);
    saveEndless(h);
    expect(store.data.get(ENDLESS_KEY)).toBe(JSON.stringify({ v: 1, history: h }));
  });

  it('the new functions never throw when storage itself is unavailable', () => {
    const fail = () => {
      throw new Error('SecurityError');
    };
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: fail, setItem: fail, removeItem: fail };
    expect(loadLevel()).toBeNull();
    expect(loadSave()).toEqual(DEFAULT_SAVE);
    expect(() => saveLevel(levelSave(1))).not.toThrow();
    expect(() => writeSave(DEFAULT_SAVE)).not.toThrow();
    expect(() => clearLevel()).not.toThrow();
  });
});
