/**
 * Pure game logic — the rules of the game, with NO dependency on the DOM,
 * rendering, sound, or storage. Everything here must be unit-testable in a
 * plain Node environment.
 *
 * This boundary is deliberate: the three promises in the design doc —
 *   1. generated levels are always solvable,
 *   2. every refilled tray always contains at least one fitting piece,
 *   3. a level number reproduces the exact same level,
 * are only enforceable if the logic lives here, away from the UI, and is
 * covered by tests in tests/.
 *
 * Planned modules (to be built in the game-code phase):
 *   - grid.ts       board state, piece placement, row/column clear
 *   - pieces.ts     piece/shape definitions
 *   - generator.ts  fair tray generator + backward level generator
 *   - solver.ts     solvability check used to validate generated levels
 *   - undo.ts       unlimited undo stack
 */
export { createRng } from './rng.ts';
export type { Rng } from './rng.ts';
