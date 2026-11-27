# Child Puzzle Game — Design Doc (v0.1)

**Goal:** An ad-free, kid-friendly block puzzle game for a 6-year-old to replace ad-heavy mobile puzzle games. No ads, no accounts, no links out, no social features. Single player only.

## Status (as of 2026-11-27)
The prototype from "Next step" below has shipped as **endless mode**, live at
https://sethrah.github.io/block-game/. What it does today:

| Design point | Shipped behaviour |
|---|---|
| Board | 8×8. Tray of 3; refills when all 3 are placed. |
| Pieces | Dot, lines of 2–5, 2×2, L, J, T, S, Z, each in fixed orientations. **No rotation.** No 3×3. |
| Clearing | Full rows **and** columns clear, both in one move if they fill together. |
| No game over | When no tray piece fits, the tray dims and a big, calm **"Swap pieces?"** button appears. It redraws the unused pieces and always gives at least one that fits (falling back to the 1×1 dot). There is no game-over screen. |
| Undo | Unlimited, one move at a time. A swap counts as a move, so it can be undone too. "New" asks *New game? Yes / No* first. |
| Fair generator | Every refilled or swapped tray has at least one piece that fits. A tunable `generosity` setting favours pieces that complete or nearly complete lines (default 1; this is the future difficulty lever). |
| Score | Only goes up: 1 per cell, 10 per line, plus a combo bonus of 5·n·(n−1) for n lines at once. |
| Drag | The piece floats above the finger (finger offset), at board-cell size. A ghost on the board shows the landing spot, green if it fits and red if not. Rows/columns about to clear glow. A bad drop sends the piece back to the tray. |
| Game feel | A snap animation and synthesized click on placement. Cleared cells pop away in a wave with a short rising sound; more lines play more notes. `prefers-reduced-motion` is respected. |
| Saving | The game and its full undo history are saved on the device (localStorage) after every move. A corrupt save starts a new game instead of crashing. |
| PWA | Installable, full screen (`standalone`), works offline, updates automatically. |

**Not built yet:**
- **Levels and stages, the planned next step.** The core API was shaped so a seeded level (a starting board of pre-placed tiles) can be added without rewriting existing code. The "every level is solvable" test is a placeholder (`it.todo`) until then.
- Stage rewards, the level map, haptics, particles, bigger combo effects, full sound design, and theming.

The sections below are the original design (v0.1), kept as written. Notes in
*italics* mark where the shipped prototype answers or differs from them.

## Player
- 6 years old, a confident and proud early reader → short text on buttons is fine, but no long instructions.
- Drags comfortably.
- Gets frustrated easily → no punishing fail states.
- The appeal is the mechanic plus satisfying clear animations and sounds, not social play.

## Core mechanic
Block-placement puzzle (genre: Block Blast / 1010! / Woodoku).
- Square grid (start with 8×8).
- A tray of 3 pieces; drag each onto the grid. When all 3 are placed, the tray refills.
- A full **row or column** clears.
- **Level goal:** the board starts with pre-placed tiles; clear them all to win.

*Shipped: the 8×8 board, tray of 3 and row/column clears, with pre-oriented pieces and no rotation. The level goal is not built yet; the prototype starts from an empty board (endless mode).*

## Fail-state rules (no game over)
- **Undo: unlimited.** Take back placements one at a time.
- **Rescue:** if no piece fits, offer a friendly "Swap pieces?" instead of ending the level.
- **Fair generator:** each tray always has at least one piece that fits, with a bias toward pieces that nearly complete lines.
- No lives, no timers, no score to lose.

## Levels and stages
- **Levels are generated**, not handmade. Each one generates a starting tile pattern to clear.
- Generated levels should be solvable. One approach: build a level backward from a finished board, or check it with a simple solver before showing it.
- Seed each level so a given level number can be reproduced (handy for debugging and for replaying a favorite).
- **Levels are short** (about 1–3 min).
- **Stages:** about 5 levels each, ending in a bigger celebration and a reward (sticker, new block color theme, new background).
- **Difficulty ramps up within a stage, then resets** at the start of the next. Each stage goes easy → harder, and a new stage starts easy again, possibly a little harder overall than the last.
- Difficulty levers: number and spread of starting tiles, piece sizes and shapes in the tray, how generous the fair generator is.
- **Visible level map/path** so "3 more levels" or "finish this stage" is concrete for her.
- Rewards should feel satisfying without being compulsive: no streaks, daily login rewards or "one more" nags.
- **Stopping points are enforced by verbal rules only.** No built-in parent controls.

## Game feel (top priority)
- Piece snaps into place with a click; ghost preview of the landing spot while dragging.
- Highlight rows/columns that are about to clear.
- Clear: sweep/pop animation, particles, rising sound.
- Bigger effects for combos (several lines at once, back-to-back clears).
- Haptics where supported (Android browsers yes, iOS Safari no).

*Shipped: ghost preview, about-to-clear highlight, snap with click, and a sweep/pop clear with a rising sound. Not yet: particles, bigger combo effects (combos score a bonus but look the same), haptics.*

## Platform: PWA (decided)
- Static site, installable as a PWA on a phone: home-screen install gives full screen, no address bar, offline play.
- Progress saved locally on the device (no accounts).
- The Fire tablet is out of scope (too little use to justify the extra work).

## Theme and art
Deferred. Prototype and core functionality come first; theming (possibly chosen with her) comes later.

## Open questions
1. Endless "relax" mode (no level goal, just place pieces and clear lines for as long as you like): include it later or skip it?
   *Endless mode is what shipped first, as the prototype. Whether it stays alongside levels is still open.*
2. Tech stack: plain canvas/DOM vs a small game framework.
   *Decided: plain DOM (the board is a CSS grid, no canvas), Vite + TypeScript, no game framework.*
3. Stage length (5 levels?) and what the stage-end reward actually is.

## Next step
Build a rough prototype (grid + drag-and-drop + row/column clear + undo, no art) as a PWA and test it on the phone:
- Does dragging feel right at phone size (finger covering the piece, needing an offset)?
- Watch her play it: what makes her smile, get frustrated or quit?

*Done: the prototype is live (see Status). It drags with a finger offset (the piece floats above the finger). Next: watch her play it, then build levels and stages.*
