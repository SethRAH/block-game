# Block Game

An ad-free, kid-friendly block-placement puzzle (genre: Block Blast / 1010! /
Woodoku), built for a 6-year-old. Drag pieces from a tray onto an 8×8 board;
full rows and columns clear. There is no game over: if no piece fits, a calm
**"Swap pieces?"** button appears, and Undo is always there.

No ads, no accounts, no links out, no social features, no analytics. Single
player, and it works offline.

**Play it:** https://sethrah.github.io/block-game/

## What's in it today

Endless mode, touch-first (built and tested Android/Chrome first):

- 8×8 board and a tray of 3 pieces. The tray refills once all 3 are placed.
- Pieces come pre-oriented. There is no rotation.
- Full rows **and** columns clear, including both in one move.
- The score only goes up: 1 point per cell, 10 per line, and a combo bonus for
  several lines at once.
- Drag with a finger offset: the piece floats above your finger. A ghost shows
  where it will land (green if it fits, red if not), and the rows and columns
  that are about to clear light up.
- A snap animation and click when a piece lands. Cleared cells pop away in a
  wave, with a short rising sound. The sounds are synthesized, so there are no
  audio files.
- Never losable. If nothing fits, the tray dims and **"Swap pieces?"** redraws
  the unused pieces, always giving at least one that fits.
- Unlimited undo, including undoing a swap.
- The game, including its full undo history, is saved on the device after
  every move, so a reload or app switch picks up where you left off.

Not built yet: levels and stages (the planned next step), rewards, haptics,
particles, full sound design and theming. See [`docs/design.md`](docs/design.md).

## Install on a phone (PWA)

Open the live URL in the phone's browser and use **Add to Home screen** (on
Android Chrome it may also offer **Install app**). It then opens full screen with
no address bar and works offline. New versions are picked up automatically when
it's opened while online.

## Development

Requires Node 22 (see `.nvmrc`) and npm.

```sh
npm ci              # install dependencies
npm run dev         # dev server at http://localhost:5173/block-game/
npm run dev:host    # same, exposed on your LAN to test on a phone
npm test            # unit tests (Vitest)
npm run test:watch  # tests in watch mode
npm run typecheck   # tsc --noEmit
npm run build       # typecheck + production build to dist/
npm run preview     # serve the production build locally
```

**Phone testing:** run `npm run dev:host`, then on a phone on the same Wi-Fi
open the `Network:` URL Vite prints (it ends in `/block-game/`).

**Offline / install testing:** the service worker is turned **off** under
`npm run dev`, so a phone never gets served stale code. To check offline and
install behaviour, use `npm run build && npm run preview`.

## Project structure

The main rule is that game logic stays pure and away from the DOM.

```
src/
  core/      Pure game rules: no DOM, no storage, no timers. Runs in plain Node.
    game.ts        Public API: GameState, newGame, applyMove, canPlaceAt,
                   previewClears, isStuck, swapTray, scoring
    grid.ts        Board, placement, row/column clearing
    pieces.ts      Pre-oriented piece catalog (dot, lines 2–5, 2×2, L, J, T, S, Z)
    generator.ts   Fair tray generator ("generosity" bias, fit guarantee)
    undo.ts        Unlimited undo (immutable snapshot stack)
    serialize.ts   Validates saved data back into a GameState
    levels.ts      Seeded level generation (stages, difficulty, solvable by construction)
    rng.ts         Seeded RNG (the only source of randomness)
  ui/        The only layer that touches the DOM: rendering, drag, animation, sound
  pwa/       Local persistence (localStorage)
  main.ts    Entry point
tests/       Vitest suites, including fuzzed invariant tests
docs/        Design doc
dev-log/     Team dev-log entries
```

All randomness goes through the seeded RNG in `src/core/rng.ts`, so the same
seed and the same moves always replay to the same game. The tests check three
promises from the design doc: every refilled or swapped tray has a piece that
fits, a seed reproduces the exact same game, and every generated level is
solvable (and short: a simulated player finishes levels 1–30 quickly).

Contributor and agent conventions are in [`CLAUDE.md`](CLAUDE.md).

## CI and deploy

- **Pull requests:** `.github/workflows/ci.yml` runs typecheck and tests.
- **Push to `main`:** `.github/workflows/deploy.yml` runs typecheck, tests and
  the build, then deploys `dist/` to GitHub Pages. A failure blocks the deploy.

The Vite `base` is `/block-game/` to match the Pages path. To host somewhere that
serves from the root, build with `BASE_PATH=/` (see `vite.config.ts`).
