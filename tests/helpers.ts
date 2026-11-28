/** Shared test helpers: board builders and a seeded random "player". */
import {
  applyMove,
  createLevel,
  BOARD_SIZE,
  canUndo,
  commit,
  createHistory,
  createRng,
  isStuck,
  swapTray,
  undo,
  type GameState,
  type GeneratorOptions,
  type History,
  type Level,
  type Piece,
  type Rng,
  type Tray,
} from '../src/core/index.ts';
import { fitsAnywhere, placements } from '../src/core/grid.ts';
import { pieceById } from '../src/core/pieces.ts';

export function piece(id: string): Piece {
  const p = pieceById(id);
  if (!p) throw new Error(`no piece ${id}`);
  return p;
}

/** Build a board from 8 strings of '#' (filled, palette 1) and '.' (empty). */
export function boardFrom(rows: readonly string[]): number[] {
  if (rows.length !== BOARD_SIZE) throw new Error('need 8 rows');
  return rows.flatMap((row) => {
    if (row.length !== BOARD_SIZE) throw new Error('need 8 cols');
    return [...row].map((ch) => (ch === '#' ? 1 : 0));
  });
}

export function stateWith(board: number[], tray: Tray, extra: Partial<GameState> = {}): GameState {
  return { board, tray, score: 0, seed: 1, rngState: 12345, ...extra };
}

/** Whether some remaining tray piece fits somewhere. */
export function anyFits(s: GameState): boolean {
  return s.tray.some((p) => p !== null && fitsAnywhere(s.board, p));
}

export type Action =
  | { readonly kind: 'place'; readonly slot: number; readonly r: number; readonly c: number }
  | { readonly kind: 'swap' }
  | { readonly kind: 'undo' };

/**
 * Apply one action to a history (throws if a placement is rejected). `gen` is
 * the game's generator options, threaded into every move (omit for endless).
 */
export function act(h: History, a: Action, gen?: GeneratorOptions): History {
  if (a.kind === 'undo') return undo(h);
  if (a.kind === 'swap') return commit(h, swapTray(h.present, gen));
  const res = applyMove(h.present, a.slot, a.r, a.c, gen);
  if (!res.ok) throw new Error(`rejected ${JSON.stringify(a)}: ${res.error}`);
  return commit(h, res.result.state);
}

/**
 * Choose the next action with a SEPARATE seeded rng: mostly random legal
 * placements, sometimes an undo or a voluntary swap, and always a swap or an
 * undo when stuck.
 */
export function chooseAction(h: History, pick: Rng): Action {
  const s = h.present;
  if (isStuck(s)) {
    return canUndo(h) && pick.next() < 0.3 ? { kind: 'undo' } : { kind: 'swap' };
  }
  const roll = pick.next();
  if (roll < 0.08 && canUndo(h)) return { kind: 'undo' };
  if (roll < 0.12) return { kind: 'swap' };
  const moves: Action[] = [];
  s.tray.forEach((p, slot) => {
    if (p) for (const { r, c } of placements(s.board, p)) moves.push({ kind: 'place', slot, r, c });
  });
  return pick.pick(moves);
}

/** Play `steps` random actions from `start`; returns the recorded script. */
export function randomScript(
  start: GameState,
  steps: number,
  driverSeed: number,
  gen?: GeneratorOptions,
): Action[] {
  const pick = createRng(driverSeed);
  let h = createHistory(start);
  const script: Action[] = [];
  for (let i = 0; i < steps; i++) {
    const a = chooseAction(h, pick);
    script.push(a);
    h = act(h, a, gen);
  }
  return script;
}

/** 32-bit FNV-1a of a string, as 8 hex digits — the one hash for every golden snapshot. */
export function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Golden hash of a whole level (every field). */
export const levelHash = (level: Level): string => fnv(JSON.stringify(level));

const levelCache = new Map<number, Level>();

/**
 * createLevel(n), memoized per test file (generating a level runs the perfect
 * player and playtests, ~tens of ms). Returns a deep copy, so a test that
 * mutates it can't affect another. Tests about createLevel itself call it
 * directly.
 */
export function cachedLevel(n: number): Level {
  let level = levelCache.get(n);
  if (!level) {
    level = createLevel(n);
    levelCache.set(n, level);
  }
  return structuredClone(level);
}
