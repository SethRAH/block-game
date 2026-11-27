/**
 * Presentation layer — rendering, drag-and-drop input, animations, sound.
 * This is the ONLY layer allowed to touch the DOM. It reads from and drives
 * the pure logic in src/core, and persists via src/pwa.
 *
 * Layout (portrait, 100dvh): a top bar (big score, Undo, New), the 8×8 board
 * as a CSS grid of DOM cells (no canvas), and the tray of 3 slots below it.
 */
import {
  applyMove,
  BOARD_SIZE,
  canPlaceAt,
  canUndo,
  cellAt,
  commit,
  createHistory,
  isStuck,
  newGame,
  previewClears,
  swapTray,
  TRAY_SIZE,
  undo,
  type ClearedLines,
  type History,
  type Piece,
} from '../core/index.ts';
import { loadEndless, saveEndless } from '../pwa/storage.ts';
import { el, replayClass } from './dom.ts';
import { playClear, playSnap, unlockAudio } from './sound.ts';

/** How far above the finger the dragged piece floats, in board cells. */
const LIFT_CELLS = 1.4;
/** Minimum lift in CSS px, so small cells still clear a fingertip. */
const MIN_LIFT_PX = 48;

/** A fresh random seed for a new endless game (UI choice, not game logic). */
function randomSeed(): number {
  try {
    return crypto.getRandomValues(new Uint32Array(1))[0]!;
  } catch {
    return Date.now() >>> 0;
  }
}

interface Drag {
  readonly pointerId: number;
  readonly slot: number;
  readonly piece: Piece;
  readonly slotEl: HTMLElement;
  readonly floatEl: HTMLElement;
  /** Board geometry captured at drag start. */
  readonly boardLeft: number;
  readonly boardTop: number;
  readonly pitch: number;
  /** Current snapped target (top-left cell), or null when off the board. */
  target: { r: number; c: number; ok: boolean } | null;
}

export function mount(root: HTMLElement): void {
  let history: History = loadEndless() ?? createHistory(newGame(randomSeed()));
  let drag: Drag | null = null;

  // ── Build the DOM once ─────────────────────────────────────────────────────
  const app = el('main', 'app');

  const bar = el('header', 'bar');
  const scoreWrap = el('div', 'score-wrap');
  const scoreEl = el('div', 'score', '0');
  const scorePop = el('div', 'score-pop');
  scoreWrap.append(scoreEl, scorePop);
  const actions = el('div', 'actions');
  const undoBtn = el('button', 'btn', 'Undo');
  const newBtn = el('button', 'btn', 'New');
  actions.append(undoBtn, newBtn);
  const confirmEl = el('div', 'confirm');
  const confirmText = el('span', 'confirm-text', 'New game?');
  const yesBtn = el('button', 'btn btn-yes', 'Yes');
  const noBtn = el('button', 'btn', 'No');
  confirmEl.append(confirmText, yesBtn, noBtn);
  confirmEl.hidden = true;
  bar.append(scoreWrap, actions, confirmEl);

  const boardEl = el('div', 'board');
  const cells: HTMLElement[] = [];
  for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
    const cell = el('div', 'cell');
    cells.push(cell);
    boardEl.append(cell);
  }

  const trayWrap = el('div', 'tray-wrap');
  const trayEl = el('div', 'tray');
  const slotEls: HTMLElement[] = [];
  for (let i = 0; i < TRAY_SIZE; i++) {
    const slot = el('div', 'slot');
    slot.dataset.slot = String(i);
    slotEls.push(slot);
    trayEl.append(slot);
  }
  const swapBtn = el('button', 'btn btn-swap', 'Swap pieces?');
  swapBtn.hidden = true;
  trayWrap.append(trayEl, swapBtn);

  app.append(bar, boardEl, trayWrap);
  root.replaceChildren(app);

  // ── Rendering ──────────────────────────────────────────────────────────────
  function pieceGrid(piece: Piece, cls: string): HTMLElement {
    const grid = el('div', cls);
    grid.style.setProperty('--w', String(piece.w));
    grid.style.setProperty('--h', String(piece.h));
    for (const p of piece.cells) {
      const b = el('div', 'block');
      b.dataset.c = String(piece.color);
      b.style.gridRow = String(p.r + 1);
      b.style.gridColumn = String(p.c + 1);
      grid.append(b);
    }
    return grid;
  }

  function renderBoard(): void {
    const board = history.present.board;
    for (let i = 0; i < cells.length; i++) cells[i]!.dataset.c = String(board[i] ?? 0);
  }

  function renderTray(): void {
    const stuck = isStuck(history.present);
    history.present.tray.forEach((piece, i) => {
      const slot = slotEls[i]!;
      slot.replaceChildren();
      slot.classList.toggle('empty', piece === null);
      slot.classList.toggle('dim', stuck);
      if (piece) slot.append(pieceGrid(piece, 'mini'));
    });
    swapBtn.hidden = !stuck;
    trayWrap.classList.toggle('stuck', stuck);
  }

  function renderBar(): void {
    scoreEl.textContent = String(history.present.score);
    undoBtn.disabled = !canUndo(history);
  }

  function render(): void {
    renderBoard();
    renderTray();
    renderBar();
  }

  // ── Persistence ────────────────────────────────────────────────────────────
  const save = (): void => saveEndless(history);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });
  window.addEventListener('pagehide', save);

  // ── Ghost preview ──────────────────────────────────────────────────────────
  function clearGhost(): void {
    for (const cell of cells) cell.classList.remove('ghost-ok', 'ghost-bad', 'will-clear');
  }

  function showGhost(piece: Piece, r: number, c: number, ok: boolean, lines: ClearedLines | null): void {
    clearGhost();
    for (const p of piece.cells) {
      const rr = r + p.r;
      const cc = c + p.c;
      if (cellAt(history.present.board, rr, cc) === undefined) continue;
      cells[rr * BOARD_SIZE + cc]!.classList.add(ok ? 'ghost-ok' : 'ghost-bad');
    }
    if (lines) {
      for (const row of lines.rows)
        for (let j = 0; j < BOARD_SIZE; j++) cells[row * BOARD_SIZE + j]!.classList.add('will-clear');
      for (const col of lines.cols)
        for (let j = 0; j < BOARD_SIZE; j++) cells[j * BOARD_SIZE + col]!.classList.add('will-clear');
    }
  }

  // ── Drag ───────────────────────────────────────────────────────────────────
  function positionFloat(d: Drag, x: number, y: number): void {
    const w = d.piece.w * d.pitch;
    const h = d.piece.h * d.pitch;
    const lift = Math.max(MIN_LIFT_PX, LIFT_CELLS * d.pitch);
    // Piece centered horizontally on the finger, floating ABOVE it.
    const left = x - w / 2;
    const top = y - h - lift;
    d.floatEl.style.transform = `translate(${left}px, ${top}px)`;

    // Snap from the PIECE position (not the finger) to the nearest cell.
    const r = Math.round((top - d.boardTop) / d.pitch);
    const c = Math.round((left - d.boardLeft) / d.pitch);
    const overlapsBoard = r > -d.piece.h && r < BOARD_SIZE && c > -d.piece.w && c < BOARD_SIZE;
    if (!overlapsBoard) {
      d.target = null;
      clearGhost();
      return;
    }
    const ok = canPlaceAt(history.present, d.slot, r, c);
    d.target = { r, c, ok };
    showGhost(d.piece, r, c, ok, ok ? previewClears(history.present, d.slot, r, c) : null);
  }

  function startDrag(e: PointerEvent, slot: number): void {
    const piece = history.present.tray[slot];
    if (!piece || drag || !confirmEl.hidden) return;
    const slotEl = slotEls[slot]!;
    const rect = boardEl.getBoundingClientRect();
    const pitch = rect.width / BOARD_SIZE;

    const floatEl = pieceGrid(piece, 'float');
    floatEl.style.setProperty('--pitch', `${pitch}px`);
    document.body.append(floatEl);
    slotEl.classList.add('lifted');

    try {
      slotEl.setPointerCapture(e.pointerId);
    } catch {
      // Capture is best-effort; we still track by pointerId.
    }
    drag = {
      pointerId: e.pointerId,
      slot,
      piece,
      slotEl,
      floatEl,
      boardLeft: rect.left,
      boardTop: rect.top,
      pitch,
      target: null,
    };
    positionFloat(drag, e.clientX, e.clientY);
  }

  function endDrag(drop: boolean): void {
    const d = drag;
    if (!d) return;
    drag = null;
    clearGhost();
    d.floatEl.remove();
    d.slotEl.classList.remove('lifted');
    try {
      if (d.slotEl.hasPointerCapture(d.pointerId)) d.slotEl.releasePointerCapture(d.pointerId);
    } catch {
      // ignore
    }
    if (drop && d.target?.ok) place(d.slot, d.piece, d.target.r, d.target.c);
    else if (drop && d.target) replayClass(d.slotEl, 'bounce'); // invalid drop → back to tray
  }

  slotEls.forEach((slotEl, slot) => {
    slotEl.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      unlockAudio();
      if (drag) return; // a second finger is ignored
      startDrag(e, slot);
    });
    slotEl.addEventListener('pointermove', (e) => {
      if (drag && e.pointerId === drag.pointerId) {
        e.preventDefault();
        positionFloat(drag, e.clientX, e.clientY);
      }
    });
    slotEl.addEventListener('pointerup', (e) => {
      if (drag && e.pointerId === drag.pointerId) endDrag(true);
    });
    slotEl.addEventListener('pointercancel', (e) => {
      if (drag && e.pointerId === drag.pointerId) endDrag(false);
    });
    slotEl.addEventListener('lostpointercapture', (e) => {
      if (drag && e.pointerId === drag.pointerId) endDrag(false);
    });
  });
  // Losing the page mid-drag (app switch, call) sends the piece back.
  window.addEventListener('blur', () => endDrag(false));

  // ── Moves ──────────────────────────────────────────────────────────────────
  function place(slot: number, piece: Piece, r: number, c: number): void {
    const before = history.present.board;
    const res = applyMove(history.present, slot, r, c);
    if (!res.ok) return;
    const { state, cleared, scoreDelta } = res.result;
    history = commit(history, state);
    save();
    render();
    animatePlacement(before, piece, r, c, cleared);
    showScorePop(scoreDelta);
    playSnap();
    const lines = cleared.rows.length + cleared.cols.length;
    if (lines > 0) playClear(lines);
  }

  function animatePlacement(
    before: readonly number[],
    piece: Piece,
    r: number,
    c: number,
    cleared: ClearedLines,
  ): void {
    const clearing = new Set<number>();
    for (const row of cleared.rows) for (let j = 0; j < BOARD_SIZE; j++) clearing.add(row * BOARD_SIZE + j);
    for (const col of cleared.cols) for (let j = 0; j < BOARD_SIZE; j++) clearing.add(j * BOARD_SIZE + col);

    const placed = new Set(piece.cells.map((p) => (r + p.r) * BOARD_SIZE + (c + p.c)));
    for (const i of placed) if (!clearing.has(i)) replayClass(cells[i]!, 'snap');

    // Cleared cells: a brief pop of the color that was there, then empty.
    for (const i of clearing) {
      const color = placed.has(i) ? piece.color : (before[i] ?? 0);
      const pop = el('div', 'pop');
      pop.dataset.c = String(color);
      // Sweep outward from the placed piece, so the clear reads as a wave.
      const rr = Math.floor(i / BOARD_SIZE);
      const cc = i % BOARD_SIZE;
      const dist = Math.abs(rr - (r + piece.h / 2)) + Math.abs(cc - (c + piece.w / 2));
      pop.style.animationDelay = `${Math.round(dist * 25)}ms`;
      pop.addEventListener('animationend', () => pop.remove(), { once: true });
      cells[i]!.append(pop);
    }
  }

  function showScorePop(delta: number): void {
    if (delta <= 0) return;
    scorePop.textContent = `+${delta}`;
    replayClass(scorePop, 'show');
    replayClass(scoreEl, 'bump');
  }

  swapBtn.addEventListener('click', () => {
    if (drag) return;
    history = commit(history, swapTray(history.present));
    save();
    render();
    for (const s of slotEls) replayClass(s, 'swapped');
  });

  undoBtn.addEventListener('click', () => {
    if (drag || !canUndo(history)) return;
    history = undo(history);
    save();
    render();
  });

  // New game, with a confirm step so a stray tap doesn't lose the board.
  let confirmTimer = 0;
  function setConfirm(open: boolean): void {
    confirmEl.hidden = !open;
    actions.hidden = open;
    window.clearTimeout(confirmTimer);
    if (open) confirmTimer = window.setTimeout(() => setConfirm(false), 5000);
  }
  newBtn.addEventListener('click', () => {
    if (!drag) setConfirm(true);
  });
  noBtn.addEventListener('click', () => setConfirm(false));
  yesBtn.addEventListener('click', () => {
    setConfirm(false);
    history = createHistory(newGame(randomSeed())); // new game clears undo
    save();
    render();
  });

  render();
  save();
}

/**
 * Block browser zoom gestures that fight with dragging: iOS pinch
 * (gesturestart) and double-tap zoom. touch-action in CSS covers Android.
 */
export function blockZoomGestures(): void {
  const stop = (e: Event): void => e.preventDefault();
  document.addEventListener('gesturestart', stop, { passive: false });
  document.addEventListener('dblclick', stop, { passive: false });
}
