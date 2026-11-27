/**
 * Pure game logic — the rules of the game, with NO dependency on the DOM,
 * rendering, sound, or storage. Everything here must be unit-testable in a
 * plain Node environment.
 *
 * This boundary is deliberate: the three promises in the design doc
 * (docs/design.md):
 *   1. generated levels are always solvable,
 *   2. every refilled tray always contains at least one fitting piece,
 *   3. a level number reproduces the exact same level,
 * are only enforceable if the logic lives here, away from the UI, and is
 * covered by tests in tests/.
 *
 * Modules:
 *   - game.ts       public contract: GameState, applyMove, isStuck, swapTray…
 *   - grid.ts       board state, piece placement, row/column clear
 *   - pieces.ts     piece/shape catalog (pre-oriented; no rotation)
 *   - generator.ts  fair tray generator (generosity bias)
 *   - undo.ts       unlimited undo stack
 *   - serialize.ts  validate saved data back into a GameState
 *   - solver.ts     (later) solvability check for generated levels
 */
export * from './game.ts';
export { createRng } from './rng.ts';
export type { Rng } from './rng.ts';
export { PIECES, PALETTE_SIZE, pieceById } from './pieces.ts';
export { cellAt } from './grid.ts';
export { createHistory, commit, undo, canUndo } from './undo.ts';
export type { History } from './undo.ts';
export { parseGameState, parseHistory } from './serialize.ts';
