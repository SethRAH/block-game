/**
 * undo.ts — unlimited undo as an immutable snapshot stack.
 *
 * `GameState` is plain immutable data, so a snapshot is just a reference to an
 * earlier state. Every MOVE (a placement via applyMove, or a swap via
 * swapTray) is recorded with `commit`, so one `undo` goes back exactly one
 * move, including any tray refill or swap that move caused (those are part of
 * the next state). Starting a new game uses a fresh `createHistory`, which
 * clears the stack.
 */
import type { GameState } from './game.ts';

export interface History {
  /** Earlier states, oldest first. Unbounded. */
  readonly past: readonly GameState[];
  /** The state being played now. */
  readonly present: GameState;
}

/** A fresh history with nothing to undo (use for every new game). */
export function createHistory(state: GameState): History {
  return { past: [], present: state };
}

/** Record a move: `next` becomes the present, the old present is undoable. */
export function commit(history: History, next: GameState): History {
  return { past: [...history.past, history.present], present: next };
}

export function canUndo(history: History): boolean {
  return history.past.length > 0;
}

/** Step back exactly one move. A no-op (same object) when nothing to undo. */
export function undo(history: History): History {
  const prev = history.past[history.past.length - 1];
  if (!prev) return history;
  return { past: history.past.slice(0, -1), present: prev };
}
