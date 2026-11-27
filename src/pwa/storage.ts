/**
 * Local, account-free persistence. All progress lives on the device in
 * localStorage (no backend, no accounts — per the design doc).
 *
 * Wrapped in try/catch because storage can be unavailable (private mode,
 * blocked site data) — the game must still run, just without saved progress.
 */
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
