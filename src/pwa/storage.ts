/**
 * Local, account-free persistence. All progress lives on the device in
 * localStorage (no backend, no accounts — per the design doc).
 *
 * Wrapped in try/catch because storage can be unavailable (private mode,
 * blocked site data) — the game must still run, just without saved progress.
 */
import {
  isLevelComplete,
  LEVEL_GEN_VERSION,
  parseGameState,
  parseHistory,
  type GameState,
  type History,
} from '../core/index.ts';

// ── Shared helpers ───────────────────────────────────────────────────────────

/** The parsed JSON stored under `key`, or `null` if absent / unreadable. */
function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** Store `value` as JSON; `false` if storage refused (quota / unavailable). */
function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Save a record that embeds an undo history. Undo is unlimited, so the history
 * can grow large; if the browser's storage quota is hit, the OLDEST undo steps
 * are dropped (the current game is always kept) until it fits.
 */
function writeWithHistory(key: string, history: History, wrap: (h: History) => unknown): void {
  let past = history.past;
  while (!writeJson(key, wrap({ past, present: history.present }))) {
    if (past.length === 0) return; // storage unavailable: play on unsaved
    past = past.slice(Math.ceil(past.length / 2));
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isIntIn(x: unknown, min: number, max: number): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;
}

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
  const data = readJson(ENDLESS_KEY);
  if (typeof data !== 'object' || data === null) return null;
  const o = data as Record<string, unknown>;
  if (o.v !== ENDLESS_VERSION) return null;
  return parseHistory(o.history);
}

/**
 * Save the endless game. Undo is unlimited, so the history can grow large; if
 * the browser's storage quota is hit, the OLDEST undo steps are dropped (the
 * current game is always kept) until it fits.
 */
export function saveEndless(history: History): void {
  writeWithHistory(ENDLESS_KEY, history, (h): EndlessSave => ({ v: ENDLESS_VERSION, history: h }));
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

/** Upper bound on level numbers accepted from storage (far beyond real play). */
export const MAX_LEVEL = 100_000;
/** Most stars one level can award. */
export const MAX_STARS_PER_LEVEL = 3;
/** Bounds on untrusted saves, so a tampered one can't balloon parsing. */
const MAX_LEVEL_UNDO = 50_000;
const MAX_REWARDS = 1_000;
const MAX_REWARD_ID_LENGTH = 64;
/** A canonical level-number key: a positive integer with no leading zero. */
const LEVEL_KEY_RE = /^[1-9][0-9]*$/;

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
export function parseLevelSave(x: unknown): LevelSave | null {
  if (!isRecord(x)) return null;
  const { levelNumber, genVersion, start, history } = x;
  if (!isIntIn(levelNumber, 1, MAX_LEVEL)) return null;
  if (genVersion !== LEVEL_GEN_VERSION) return null;
  if (!isRecord(history) || !Array.isArray(history.past) || history.past.length > MAX_LEVEL_UNDO) return null;

  const startState = parseGameState(start);
  const h = parseHistory(history);
  if (!startState || !h) return null;
  // A level always starts with goal tiles, and every state of one game shares its seed.
  if (isLevelComplete(startState)) return null;
  if (![h.present, ...h.past].every((s) => s.seed === startState.seed)) return null;

  return { levelNumber, genVersion, start: startState, history: h };
}

/** The saved in-progress level, or `null` if none / corrupt / old format. */
export function loadLevel(): LevelSave | null {
  return parseLevelSave(readJson(LEVEL_KEY));
}

/**
 * Save the in-progress level. Like {@link saveEndless}, if the quota is hit
 * the OLDEST undo steps are dropped (the current game and `start` are kept).
 */
export function saveLevel(save: LevelSave): void {
  writeWithHistory(LEVEL_KEY, save.history, (history): LevelSave => ({ ...save, history }));
}

/** Forget the in-progress level (it was won, or abandoned for another). */
export function clearLevel(): void {
  try {
    localStorage.removeItem(LEVEL_KEY);
  } catch {
    // Storage unavailable: nothing was saved anyway.
  }
}

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
export function totalStars(data: SaveData): number {
  return Object.values(data.bestStars).reduce((a, b) => a + b, 0);
}

/**
 * Validate untrusted data into {@link SaveData}: shape, integer ranges, and a
 * bounded list of short string ids. Anything unexpected → `null`.
 */
export function parseSaveData(x: unknown): SaveData | null {
  if (!isRecord(x)) return null;
  const { level, bestStars, unlocked } = x;
  if (!isIntIn(level, 1, MAX_LEVEL)) return null;

  if (!isRecord(bestStars)) return null;
  const entries = Object.entries(bestStars);
  if (entries.length > MAX_LEVEL) return null;
  const best: Record<string, number> = {};
  for (const [k, v] of entries) {
    if (!LEVEL_KEY_RE.test(k) || Number(k) > MAX_LEVEL) return null;
    if (!isIntIn(v, 0, MAX_STARS_PER_LEVEL)) return null;
    best[k] = v;
  }

  if (!Array.isArray(unlocked) || unlocked.length > MAX_REWARDS) return null;
  const ids: string[] = [];
  for (const id of unlocked) {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_REWARD_ID_LENGTH) return null;
    if (!ids.includes(id)) ids.push(id); // tolerate a duplicate rather than lose progress
  }

  return { level, bestStars: best, unlocked: ids };
}

/**
 * The player's progress. Missing or corrupt data → a fresh
 * {@link DEFAULT_SAVE} (never throws, never returns unchecked JSON).
 */
export function loadSave(): SaveData {
  return parseSaveData(readJson(PROGRESS_KEY)) ?? { ...DEFAULT_SAVE, bestStars: {}, unlocked: [] };
}

/** Save the player's progress (a no-op if storage is unavailable). */
export function writeSave(data: SaveData): void {
  writeJson(PROGRESS_KEY, data); // a no-op failure: play continues without persistence
}
