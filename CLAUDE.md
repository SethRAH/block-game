# Block Game

An ad-free, kid-friendly block-placement puzzle PWA (genre: Block Blast / 1010! /
Woodoku), built for a 6-year-old. No ads, no accounts, no links out, no social
features, single player, offline. See the design doc (`docs/design.md`) for product detail.

## Stack

- **Vite + TypeScript**, vanilla DOM (the board is a CSS grid of DOM cells, no
  canvas) — no game framework.
- **vite-plugin-pwa** for the manifest + offline service worker.
- **Vitest** for unit tests.
- Node 22 (`.nvmrc`). Package manager: npm.

## Commands

- `npm run dev` — dev server. `npm run dev:host` — expose on the LAN to test on a phone.
- `npm test` / `npm run test:watch` — unit tests.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run build` — typecheck + production build to `dist/`.
- The service worker is OFF under `npm run dev` (so phone testing never serves stale
  code). To check install/offline behaviour: `npm run build && npm run preview`.

## Architecture: keep logic pure, away from the DOM

The single most important rule. Three layers:

- **`src/core/`** — pure game rules. **No DOM, no rendering, no storage, no timers.**
  Must run and be unit-tested in plain Node. This is where grid state, piece
  placement, line clearing, the generator, undo, and level generation
  (`levels.ts`) live. `src/core/game.ts` is the public API the UI and tests
  build against; change its existing signatures only deliberately, and add
  level support additively.
- **`src/ui/`** — the only layer allowed to touch the DOM: rendering, drag input,
  animations, sound (and haptics, later). Reads from and drives `core`.
- **`src/pwa/`** — local persistence (localStorage). The service worker and
  manifest come from vite-plugin-pwa (`vite.config.ts`), not from code here.

Shipped today: endless mode only. Levels/stages are the planned next step (level
generation is in core; the level UI isn't built yet); see `docs/design.md` ("Status").

Why: the design doc (`docs/design.md`) makes three promises that are only enforceable if the logic is
isolated and tested (see `tests/invariants.test.ts`):
1. every generated level is solvable (by construction, in `src/core/levels.ts`) and
   short (a simulated player finishes levels 1–30 quickly),
2. every refilled or swapped tray contains at least one piece that fits (the "no
   game over" guarantee),
3. a level number reproduces the exact same level (golden snapshots in
   `tests/level-gen.test.ts`; changing a level means bumping `LEVEL_GEN_VERSION`
   and regenerating them on purpose).

## Conventions

- **Never call `Math.random` in game logic.** All randomness flows through the seeded
  RNG in `src/core/rng.ts` so levels are reproducible from a seed. Pass an `Rng` in.
- Strict TypeScript, including `noUncheckedIndexedAccess` — handle out-of-bounds grid
  cells explicitly; don't fight the compiler by disabling it.
- When a `core` module lands, convert its matching `it.todo` in
  `tests/invariants.test.ts` into a real test.
- No new runtime dependencies without a clear reason — this is a small offline game.
  No analytics, accounts, backend, or anything that phones home.

## Docs

- `README.md` — what the game is, how to run it, project layout.
- `docs/design.md` — the owner's product design, plus a "Status" section saying
  what has shipped. Update that section when a feature ships.
- `dev-log/` — dated team dev-log entries, one per milestone (see `dev-log/README.md`).

## CI and deploy

Every pull request runs `.github/workflows/ci.yml` (typecheck → test). Pushing to `main` runs `.github/workflows/deploy.yml` (typecheck → test → build →
GitHub Pages). Live at https://sethrah.github.io/block-game/. A failing typecheck or
test blocks the deploy.

The Vite `base` is `/block-game/` to match the Pages path. For another host, set
`BASE_PATH=/` (the manifest `start_url`/`scope` follow it) — see `vite.config.ts`.
