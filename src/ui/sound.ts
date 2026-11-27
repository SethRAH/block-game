/**
 * Minimal synthesized feedback sounds (no audio files, works offline). The
 * full sound design is for later; this is only the "snap" click on placement
 * and a short pop when lines clear, so the game feel isn't silent.
 *
 * Browsers only allow audio after a user gesture, so the AudioContext is
 * created lazily from the first pointerdown. Every call is fail-safe.
 */
type Ctx = AudioContext;
let ctx: Ctx | null = null;

/** Call from a user gesture (pointerdown) to unlock audio. */
export function unlockAudio(): void {
  try {
    if (!ctx) {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

function blip(freqStart: number, freqEnd: number, ms: number, volume: number, delay = 0): void {
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freqStart, t0);
    osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + ms / 1000);
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + ms / 1000 + 0.02);
  } catch {
    // Sound is optional.
  }
}

/** The "snap" when a piece lands. */
export function playSnap(): void {
  blip(900, 300, 60, 0.12);
}

/** A short rising pop for a clear; more lines → a few more notes. */
export function playClear(lines: number): void {
  const notes = Math.min(4, Math.max(1, lines));
  for (let i = 0; i < notes; i++) blip(520 * 1.26 ** i, 780 * 1.26 ** i, 120, 0.1, 0.06 + i * 0.07);
}
