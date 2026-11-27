# Child Puzzle Game — Design Doc (v0.1)

**Goal:** An ad-free, kid-friendly block puzzle game for a 6-year-old to replace ad-heavy mobile puzzle games. No ads, no accounts, no links out, no social features. Single player only.

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

## Platform: PWA (decided)
- Static site, installable as a PWA on a phone: home-screen install gives full screen, no address bar, offline play.
- Progress saved locally on the device (no accounts).
- The Fire tablet is out of scope (too little use to justify the extra work).

## Theme and art
Deferred. Prototype and core functionality come first; theming (possibly chosen with her) comes later.

## Open questions
1. Endless "relax" mode (no level goal, just place pieces and clear lines for as long as you like): include it later or skip it?
2. Tech stack: plain canvas/DOM vs a small game framework.
3. Stage length (5 levels?) and what the stage-end reward actually is.

## Next step
Build a rough prototype (grid + drag-and-drop + row/column clear + undo, no art) as a PWA and test it on the phone:
- Does dragging feel right at phone size (finger covering the piece, needing an offset)?
- Watch her play it: what makes her smile, get frustrated or quit?
