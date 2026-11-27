import { describe, it, expect } from 'vitest';
import { canPlace, cellAt, clearLines, emptyBoard, findFullLines, place } from '../src/core/grid.ts';
import { boardFrom, piece } from './helpers.ts';

describe('grid', () => {
  it('canPlace respects bounds and occupied cells', () => {
    const b = emptyBoard();
    const line = piece('line3-0'); // horizontal, 3 wide
    expect(canPlace(b, line, 0, 0)).toBe(true);
    expect(canPlace(b, line, 0, 5)).toBe(true);
    expect(canPlace(b, line, 0, 6)).toBe(false);
    expect(canPlace(b, line, -1, 0)).toBe(false);
    expect(canPlace(b, line, 0.5, 0)).toBe(false);
    const filled = place(b, piece('dot-0'), 0, 1);
    expect(canPlace(filled, line, 0, 0)).toBe(false);
  });

  it('place writes the piece palette index and does not mutate', () => {
    const b = emptyBoard();
    const sq = piece('square-0');
    const next = place(b, sq, 2, 3);
    expect(b.every((v) => v === 0)).toBe(true);
    expect(cellAt(next, 2, 3)).toBe(sq.color);
    expect(cellAt(next, 3, 4)).toBe(sq.color);
    expect(cellAt(next, 4, 4)).toBe(0);
    expect(cellAt(next, 8, 0)).toBeUndefined();
  });

  it('finds and clears full rows AND columns together, without mutating', () => {
    const b = boardFrom([
      '########',
      '#.......',
      '#.......',
      '#.......',
      '#.......',
      '#.......',
      '#.......',
      '#......#',
    ]);
    const lines = findFullLines(b);
    expect(lines).toEqual({ rows: [0], cols: [0] });
    const cleared = clearLines(b, lines);
    expect(cleared.filter((v) => v !== 0).length).toBe(1); // only (7,7) remains
    expect(cellAt(cleared, 7, 7)).toBe(1);
    expect(cellAt(b, 0, 0)).toBe(1);
  });
});
