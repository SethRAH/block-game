# 2026-11-27: Block Game prototype, idea to ship

**Status:** shipped. Endless mode is live at https://sethrah.github.io/block-game/
**Team:** Plan bot (design) · Full Stack Dev Bot (build) · Test Automation Bot (tests) · Code Review Bot (review). The owner merged everything.
**PRs:** [#1](https://github.com/SethRAH/block-game/pull/1) → [#2](https://github.com/SethRAH/block-game/pull/2) → [#3](https://github.com/SethRAH/block-game/pull/3)

## TL;DR

In about two and a half hours (evening of Nov 26 to just after midnight, US
Eastern), we went from an empty repo to a touch-first, offline, ad-free block
puzzle for a 6-year-old. It has an 8×8 board, a tray of 3, row and column
clears, unlimited undo and no game over. It ships with 84 automated tests,
including fuzzed checks of the design doc's promises.

## The goal

The owner wanted to replace ad-heavy phone puzzle games with one that has no
ads, no accounts, no links out and nothing that phones home. It is built for a
6-year-old who gets frustrated easily, so there can be **no punishing fail
state**. The design doc (`docs/design.md`, v0.1) set the genre: a block
*placement* puzzle like Block Blast, 1010! or Woodoku.

## Timeline

Times are US Eastern; commits are on `main`.

| When | What |
|---|---|
| Nov 26, 23:21 | Scaffold: Vite + strict TypeScript + vite-plugin-pwa, with the `core/` / `ui/` / `pwa/` split, a seeded RNG, and the design-doc invariants stubbed as `it.todo` (`27d323b`). |
| 23:24 | GitHub Pages deploy pipeline (`acd14c7`). |
| 23:34 | `CLAUDE.md` with stack and architecture rules (`ab10b28`). |
| 23:59 | CI workflow, so every PR gets typecheck + test (`6e65fab`). |
| Nov 27, 00:03 | First `game.ts` API surface: types and signatures only, for review (`005e8fe`). |
| 00:09 | Owner's design doc added as `docs/design.md` (`49663a9`). |
| 00:10 | API revised for a **visible** rescue (`isStuck` + `swapTray`), then **frozen** (`2bc2dae`). |
| 00:19 | Core rules implemented on the frozen API, with fuzzed invariants (`7d94d18`). |
| 00:24 | **#1 merged**: CI for PRs + design doc. |
| 00:29 | Test hardening: edge cases and seeded fuzz (`4adbb14`). Touch UI (`976e18d`). |
| 00:44 | **#2 merged**: core logic + tests. |
| 00:45 | **#3 merged**: touch UI. The Pages deploy for `796c8fa` succeeded, and the game went live. |

## What happened

### 1. Design pivot: placement, not falling blocks
Early in planning, the brief was misread as a Tetris-style falling-block game.
That was corrected against the design doc before any game code was written. The game is a **placement** puzzle: drag pieces from a tray onto a
grid, and full rows *and* columns clear. Nothing falls, there is no timer, and
pieces are never rotated. Nothing from the misread reached git; `game.ts` names
the genre at the top of the file so it stays clear.

### 2. API freeze gate on `game.ts`
Before writing any logic, Full Stack Dev Bot put up `src/core/game.ts` as
signatures only. It is the contract the UI and tests build against. Review led
to one important change: instead of quietly swapping pieces when the player is
stuck, the rescue became **visible**. `isStuck(state)` tells the UI, and the UI
shows a calm "Swap pieces?" button that calls `swapTray`. The coordinator and
Code Review Bot then **froze** the API, with one last tweak folded into the
implementation (a single shared `ClearedLines` type). After the freeze, the UI
and the tests could be built in parallel against a stable surface.

Key API properties: `GameState` is plain JSON, so it can be saved and
snapshotted for undo. Every function returns new state. All randomness comes
from a seeded RNG whose state is stored in the game state. Score only goes up.
The API was also shaped so seeded levels can be added later without changing
any existing signature.

### 3. Core logic + fuzzed invariants (PR #2)
Pure TypeScript in `src/core/`, with no DOM:
- a pre-oriented piece catalog (dot, lines of 2–5, 2×2, L, J, T, S, Z), with no rotation
- placement and clearing of rows and columns, both in one move when they fill together
- a **fair generator**: every refill and swap has a piece that fits, and a tunable
  `generosity` setting favours pieces that complete or nearly complete lines
- unlimited undo as an immutable snapshot stack, where a swap counts as a move
- validation of saved games, so a corrupt save starts a new game instead of crashing

The design doc's "no game over" promise became an invariant test, fuzzed over
150 seeds × 150 random actions (placements, swaps, undos). After every action
it checks that a piece fits or `isStuck` is true, that every swap gives a fit,
that the board is never completely full (so the dot always fits), and that the
score never drops. Reproducibility is fuzzed over 60 seeds, including a JSON
save and reload every 7 moves. "Every level is solvable" stays `it.todo` until
levels exist.

### 4. Touch UI (PR #3)
Built Android/Chrome first, for a phone held in portrait:
- **Finger-offset drag:** the piece floats above the finger at board-cell size,
  so the finger never covers it. (This was the design doc's main open question
  about game feel.)
- a **ghost** landing preview (green if it fits, red if not), and a glow on the
  rows and columns **about to clear**
- a **snap** animation and click when a piece lands, and a **sweep/pop** clear
  with a rising sound (synthesized with Web Audio, no audio files)
- **"Swap pieces?"** when stuck, with no game-over screen, and Undo always available
- a **saved game**: the full undo history is written to localStorage after every
  move, so a reload restores both the board and undo

The UI uses only the frozen core API. The board is a CSS grid of DOM cells;
there is no canvas and no game framework.

### 5. Test hardening
Test Automation Bot added edge-case and seeded fuzz suites (`4adbb14`, about
900 lines, test-only). They cover:
- multi-line and combo clears
- `isStuck` at its boundaries
- 300-move undo chains through swaps and refills
- `applyMove` checked against a brute-force oracle
- `swapTray` on near-full boards, down to the dot fallback
- mutation fuzzing of saves

They also include a **statistical test of the generosity bias**. At
generosity 0 the draw is uniform. The bias grows as generosity goes up. Drawn
piece frequencies match the weights `1 + generosity × helpfulness`. A fit is
guaranteed even at generosity 0.

**Result:** `npm test` gives **84 passing, 1 todo** across 8 test files,
covering core rules and the save layer. Separately, the UI PR was checked with
38 end-to-end checks in Chrome phone emulation (390×844) using real touch input.
These covered drag/place, clears, the second finger being ignored, cancel,
stuck → swap, undo, reload/save and bad saves. Offline was checked with a
production build under `vite preview`. Those checks were run for the PR and are
not in the repo's test suite.

### 6. Ship
The owner merged the PRs in order: #1 (CI + design doc), #2 (core), #3 (UI; it
was stacked on #2's branch). CI passed on each merge. `deploy.yml` ran
typecheck → test → build → GitHub Pages and went live at
https://sethrah.github.io/block-game/. The game installs as a PWA and plays offline.

GitHub's numbers and the PR titles don't match. The titles say "PR 0 / PR 1 /
PR 2", but on GitHub they are #1 / #2 / #3. This log uses the GitHub numbers.

## Credits

- **Plan bot**: design and planning, including the pivot to a placement puzzle.
- **Full Stack Dev Bot**: the build: the core API and logic, and the touch UI.
- **Test Automation Bot**: invariant fuzzing, edge cases, the generosity statistics test.
- **Code Review Bot**: review and the `game.ts` API freeze.

## What's next

1. Watch her play the prototype on the phone. What makes her smile, get frustrated or quit?
2. **Levels and stages**: seeded starting boards to clear, a solver or backward
   generation so every level is solvable (turning invariant 1 into a real
   test), stages of about 5 levels, and a visible level map.
3. More game feel: particles, bigger combo effects, haptics on Android.
4. Theming, possibly chosen with her.
