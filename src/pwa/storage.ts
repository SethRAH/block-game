/**
 * Local, account-free persistence. All progress lives on the device in
 * localStorage (no backend, no accounts — per the design doc).
 *
 * Wrapped in try/catch because storage can be unavailable (private mode,
 * blocked site data) — the game must still run, just without saved progress.
 */
import { parseHistory, type GameState, type History } from '../core/index.ts';

// ── Endless mode ─────────────────────────────────────────────────────────────

/** Saved endless game: the full undo history (present + every past state). */
export const ENDLESS_KEY = 'block-game:endless:v1';
const ENDLESS_VERSION = 1;

interface EndlessSave {
  readonly v: typeof ENDLESS_VERSION;
  readonly history: History;
}

/**
 * The saved endless game, or `null` when there is none — or when it is
 * corrupt or from a different format, in which case the caller simply starts
 * a new game (never crash on a bad save).
 */
export function loadEndless(): History | null {
  try {
    const raw = localStorage.getItem(ENDLESS_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as unknown;
    if (typeof data !== 'object' || data === null) return null;
    const o = data as Record<string, unknown>;
    if (o.v !== ENDLESS_VERSION) return null;
    return parseHistory(o.history);
  } catch {
    return null;
  }
}

/**
 * Save the endless game. Undo is unlimited, so the history can grow large; if
 * the browser's storage quota is hit, the OLDEST undo steps are dropped (the
 * current game is always kept) until it fits.
 */
export function saveEndless(history: History): void {
  let past = history.past;
  for (;;) {
    const save: EndlessSave = { v: ENDLESS_VERSION, history: { past, present: history.present } };
    try {
      localStorage.setItem(ENDLESS_KEY, JSON.stringify(save));
      return;
    } catch {
      if (past.length === 0) return; // storage unavailable: play on unsaved
      past = past.slice(Math.ceil(past.length / 2));
    }
  }
}

// ── Levels / stages (additive: the endless save above is never touched) ────

/** The one in-progress level (there is at most one at a time). */
export const LEVEL_KEY = 'block-game:level:v1';

/**
 * Player progress across levels. (The pre-levels placeholder key
 * `block-game:save:v1` was never written by any shipped build, so it is simply
 * left unused rather than migrated.)
 */
export const PROGRESS_KEY = 'block-game:progress:v1';

/**
 * A level being played, saved after every move so a reload resumes it.
 *  • `levelNumber` — which level (1-based); with `genVersion` it identifies
 *                    the exact generated level.
 *  • `genVersion`  — the {@link LEVEL_GEN_VERSION} it was generated with. A
 *                    save from any other version is discarded (the level
 *                    starts fresh) rather than trusted.
 *  • `start`       — the level's starting state, kept separately from
 *                    `history` so "restart level" works even after the
 *                    oldest undo steps were dropped to fit the storage quota.
 *  • `history`     — the full undo history (present + past), as for endless.
 * Goal tiles live in the board cells themselves, so they are carried by
 * `start` and `history` with no extra field.
 */
export interface LevelSave {
  readonly levelNumber: number;
  readonly genVersion: number;
  readonly start: GameState;
  readonly history: History;
}

/**
 * Validate untrusted data into a {@link LevelSave}: shape, integer ranges,
 * `genVersion === LEVEL_GEN_VERSION`, and every game state through
 * `parseGameState`. Anything unexpected → `null` (never throws).
 */
export declare function parseLevelSave(x: unknown): LevelSave | null;

/** The saved in-progress level, or `null` if none / corrupt / old format. */
export declare function loadLevel(): LevelSave | null;

/**
 * Save the in-progress level. Like {@link saveEndless}, if the quota is hit
 * the OLDEST undo steps are dropped (the current game and `start` are kept).
 */
export declare function saveLevel(save: LevelSave): void;

/** Forget the in-progress level (it was won, or abandoned for another). */
export declare function clearLevel(): void;

/**
 * Player progress. Rewards are generic ids so the reward system can grow
 * without a format change.
 *  • `level`     — the highest level unlocked (1-based; the next to play).
 *  • `bestStars` — the BEST star count earned on each level, keyed by level
 *                  number (as a string, so it stays plain JSON). Storing the
 *                  best per level, not a running total, means replaying a
 *                  level can never double-count; the total is derived by
 *                  {@link totalStars}.
 *  • `unlocked`  — ids of rewards earned (stickers, themes, backgrounds…),
 *                  no duplicates.
 */
export interface SaveData {
  readonly level: number;
  readonly bestStars: Readonly<Record<string, number>>;
  readonly unlocked: readonly string[];
}

/** Progress for a brand-new player. */
export const DEFAULT_SAVE: SaveData = { level: 1, bestStars: {}, unlocked: [] };

/** Cumulative stars: the sum of the best stars on every level. */
export declare function totalStars(data: SaveData): number;

/**
 * Validate untrusted data into {@link SaveData}: shape, integer ranges, and a
 * bounded list of short string ids. Anything unexpected → `null`.
 */
export declare function parseSaveData(x: unknown): SaveData | null;

/**
 * The player's progress. Missing or corrupt data → a fresh
 * {@link DEFAULT_SAVE} (never throws, never returns unchecked JSON).
 */
export declare function loadSave(): SaveData;

/** Save the player's progress (a no-op if storage is unavailable). */
export declare function writeSave(data: SaveData): void;
