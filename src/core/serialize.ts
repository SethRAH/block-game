/**
 * serialize.ts — validate untrusted data (e.g. a saved game read back from
 * storage) into a well-formed GameState. Pure: no storage access here.
 *
 * Tray pieces are REHYDRATED from the catalog by id, so a tampered or stale
 * save can never inject a malformed shape. Anything unexpected → `null`, and
 * the caller starts a new game instead of crashing.
 */
import { CELL_COUNT, TRAY_SIZE } from './constants.ts';
import type { GameState, TraySlot } from './game.ts';
import { PALETTE_SIZE, pieceById } from './pieces.ts';
import type { History } from './undo.ts';

function isUint32(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 0xffffffff;
}

export function parseGameState(x: unknown): GameState | null {
  if (typeof x !== 'object' || x === null) return null;
  const o = x as Record<string, unknown>;
  const { board, tray, score, seed, rngState } = o;

  if (!Array.isArray(board) || board.length !== CELL_COUNT) return null;
  if (!board.every((v) => Number.isInteger(v) && v >= 0 && v <= PALETTE_SIZE)) return null;
  if (board.every((v) => v !== 0)) return null; // never a full board
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0) return null;
  if (typeof seed !== 'number' || !Number.isInteger(seed)) return null;
  if (!isUint32(rngState)) return null;

  if (!Array.isArray(tray) || tray.length !== TRAY_SIZE) return null;
  const slots: TraySlot[] = [];
  for (const t of tray) {
    if (t === null) {
      slots.push(null);
      continue;
    }
    const id = typeof t === 'object' ? (t as Record<string, unknown>).id : undefined;
    const piece = typeof id === 'string' ? pieceById(id) : undefined;
    if (!piece) return null;
    slots.push(piece);
  }
  if (slots.every((p) => p === null)) return null; // a tray is never all-empty

  return { board: board.slice() as number[], tray: slots, score, seed, rngState };
}

export function parseHistory(x: unknown): History | null {
  if (typeof x !== 'object' || x === null) return null;
  const o = x as Record<string, unknown>;
  const present = parseGameState(o.present);
  if (!present || !Array.isArray(o.past)) return null;
  const past: GameState[] = [];
  for (const p of o.past) {
    const s = parseGameState(p);
    if (!s) return null;
    past.push(s);
  }
  return { past, present };
}
