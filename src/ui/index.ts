/**
 * Presentation layer — rendering, drag-and-drop input, animations, sound,
 * haptics. This is the ONLY layer allowed to touch the DOM. It reads from and
 * drives the pure logic in src/core, and persists via src/pwa.
 *
 * Planned modules (game-code phase):
 *   - render.ts     draw the board + tray (DOM or canvas)
 *   - drag.ts       pointer-based drag with finger offset + ghost preview
 *   - effects.ts    clear sweep/particles, combo effects
 *   - sound.ts      sound effects
 *   - haptics.ts    navigator.vibrate where supported
 */
import { createRng } from '../core/index.ts';
import { loadSave } from '../pwa/storage.ts';

/** Temporary scaffold screen so the dev server shows signs of life. */
export function mount(root: HTMLElement): void {
  const save = loadSave();
  const rng = createRng(save.stage * 1000 + save.level);
  const sample = Array.from({ length: 5 }, () => rng.int(1, 9)).join(' ');

  root.innerHTML = `
    <main class="scaffold">
      <h1>Block Game</h1>
      <p>Scaffold is running.</p>
      <p class="muted">Stage ${save.stage} · Level ${save.level}</p>
      <p class="muted">Seeded RNG sample: ${sample}</p>
    </main>
  `;
}
