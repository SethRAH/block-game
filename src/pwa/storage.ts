/**
 * Local, account-free persistence. All progress lives on the device in
 * localStorage (no backend, no accounts — per the design doc).
 *
 * Wrapped in try/catch because storage can be unavailable (private mode,
 * blocked site data) — the game must still run, just without saved progress.
 */
import { parseHistory, type History } from '../core/index.ts';

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

// ── Levels / stages (not built yet; kept for the planned level mode) ────────

const KEY = 'block-game:save:v1';

export interface SaveData {
  stage: number;
  level: number;
  /** Unlocked rewards (theme/background ids), kept simple for now. */
  unlocked: string[];
}

const DEFAULT_SAVE: SaveData = { stage: 1, level: 1, unlocked: [] };

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SAVE };
    return { ...DEFAULT_SAVE, ...(JSON.parse(raw) as Partial<SaveData>) };
  } catch {
    return { ...DEFAULT_SAVE };
  }
}

export function writeSave(data: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // No-op: play continues without persistence.
  }
}
