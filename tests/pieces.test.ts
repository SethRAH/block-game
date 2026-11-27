import { describe, it, expect } from 'vitest';
import { PIECES, DOT, PALETTE_SIZE, pieceById } from '../src/core/pieces.ts';

describe('piece catalog', () => {
  it('every piece has 1–5 cells and none is a 3×3', () => {
    for (const p of PIECES) {
      expect(p.cells.length).toBeGreaterThanOrEqual(1);
      expect(p.cells.length).toBeLessThanOrEqual(5);
      expect(p.w === 3 && p.h === 3).toBe(false);
    }
  });

  it('cells are normalized to their bounding box and unique', () => {
    for (const p of PIECES) {
      expect(Math.min(...p.cells.map((q) => q.r))).toBe(0);
      expect(Math.min(...p.cells.map((q) => q.c))).toBe(0);
      expect(Math.max(...p.cells.map((q) => q.r)) + 1).toBe(p.h);
      expect(Math.max(...p.cells.map((q) => q.c)) + 1).toBe(p.w);
      expect(new Set(p.cells.map((q) => `${q.r},${q.c}`)).size).toBe(p.cells.length);
    }
  });

  it('ids and shapes are unique; colors are palette indices', () => {
    expect(new Set(PIECES.map((p) => p.id)).size).toBe(PIECES.length);
    expect(new Set(PIECES.map((p) => JSON.stringify(p.cells))).size).toBe(PIECES.length);
    for (const p of PIECES) {
      expect(Number.isInteger(p.color)).toBe(true);
      expect(p.color).toBeGreaterThanOrEqual(1);
      expect(p.color).toBeLessThanOrEqual(PALETTE_SIZE);
    }
  });

  it('includes every required family, with both line orientations', () => {
    const families = new Set(PIECES.map((p) => p.id.split('-')[0]));
    for (const f of ['dot', 'line2', 'line3', 'line4', 'line5', 'square', 'L', 'J', 'T', 'S', 'Z']) {
      expect(families.has(f)).toBe(true);
    }
    expect(pieceById('line5-0')).toMatchObject({ w: 5, h: 1 });
    expect(pieceById('line5-1')).toMatchObject({ w: 1, h: 5 });
  });

  it('the dot is a single cell', () => {
    expect(DOT.cells).toEqual([{ r: 0, c: 0 }]);
  });
});
