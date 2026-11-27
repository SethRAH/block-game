import { describe, it } from 'vitest';

/**
 * The design doc's three fail-safe promises, written as pending tests so they
 * stay visible on every run until the game logic makes them real. Convert each
 * `it.todo` to a real `it(...)` as the corresponding module lands.
 */
describe('generator invariants (design-doc promises)', () => {
  // Build levels backward from a solved board, or verify with the solver, so a
  // generated level always has at least one solution.
  it.todo('every generated level is solvable');

  // The fair generator must never hand the player a tray where no piece fits
  // the current board — that is the "no game over" guarantee.
  it.todo('every refilled tray contains at least one piece that fits');

  // Reproducibility: level N always produces the identical starting board and
  // the identical sequence of tray pieces.
  it.todo('a level number reproduces the exact same level');
});
