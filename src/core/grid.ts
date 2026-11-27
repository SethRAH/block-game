/**
 * grid.ts — pure board operations. Every function returns a NEW board; none
 * mutates its input.
 */
import { BOARD_SIZE, CELL_COUNT } from './constants.ts';
import type { Board, Cell, ClearedLines, Piece } from './game.ts';

export function emptyBoard(): Board {
  return new Array<Cell>(CELL_COUNT).fill(0);
}

export function inBounds(r: number, c: number): boolean {
  return (
    Number.isInteger(r) && Number.isInteger(c) && r >= 0 && c >= 0 && r < BOARD_SIZE && c < BOARD_SIZE
  );
}

/** The cell at (r, c), or `undefined` when out of bounds. */
export function cellAt(board: Board, r: number, c: number): Cell | undefined {
  return inBounds(r, c) ? board[r * BOARD_SIZE + c] : undefined;
}

/** Whether every cell of `piece` (top-left at r, c) lies on the board. */
export function pieceInBounds(piece: Piece, r: number, c: number): boolean {
  return piece.cells.every((p) => inBounds(r + p.r, c + p.c));
}

/** Whether `piece` can be placed with its top-left at (r, c). */
export function canPlace(board: Board, piece: Piece, r: number, c: number): boolean {
  return piece.cells.every((p) => cellAt(board, r + p.r, c + p.c) === 0);
}

/** Write `piece` onto the board. Caller must check `canPlace` first. */
export function place(board: Board, piece: Piece, r: number, c: number): Board {
  const next = board.slice();
  for (const p of piece.cells) next[(r + p.r) * BOARD_SIZE + (c + p.c)] = piece.color;
  return next;
}

/** Every row and column that is completely filled. */
export function findFullLines(board: Board): ClearedLines {
  const rows: number[] = [];
  const cols: number[] = [];
  for (let i = 0; i < BOARD_SIZE; i++) {
    let rowFull = true;
    let colFull = true;
    for (let j = 0; j < BOARD_SIZE; j++) {
      if (board[i * BOARD_SIZE + j] === 0) rowFull = false;
      if (board[j * BOARD_SIZE + i] === 0) colFull = false;
    }
    if (rowFull) rows.push(i);
    if (colFull) cols.push(i);
  }
  return { rows, cols };
}

/** Empty the given rows and columns (rows and columns clear together). */
export function clearLines(board: Board, lines: ClearedLines): Board {
  if (lines.rows.length === 0 && lines.cols.length === 0) return board.slice();
  const next = board.slice();
  for (const r of lines.rows) for (let c = 0; c < BOARD_SIZE; c++) next[r * BOARD_SIZE + c] = 0;
  for (const c of lines.cols) for (let r = 0; r < BOARD_SIZE; r++) next[r * BOARD_SIZE + c] = 0;
  return next;
}

/** All top-left positions where `piece` fits. */
export function placements(board: Board, piece: Piece): Array<{ r: number; c: number }> {
  const out: Array<{ r: number; c: number }> = [];
  for (let r = 0; r <= BOARD_SIZE - piece.h; r++) {
    for (let c = 0; c <= BOARD_SIZE - piece.w; c++) {
      if (canPlace(board, piece, r, c)) out.push({ r, c });
    }
  }
  return out;
}

/** Whether `piece` fits anywhere on the board. */
export function fitsAnywhere(board: Board, piece: Piece): boolean {
  for (let r = 0; r <= BOARD_SIZE - piece.h; r++) {
    for (let c = 0; c <= BOARD_SIZE - piece.w; c++) {
      if (canPlace(board, piece, r, c)) return true;
    }
  }
  return false;
}
