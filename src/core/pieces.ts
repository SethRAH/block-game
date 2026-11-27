/**
 * pieces.ts — the catalog of placeable shapes (1–5 cells).
 *
 * Shapes: dot, lines of 2/3/4/5, 2×2 square, L/J, T, S/Z. No 3×3 for now.
 * The PLAYER NEVER ROTATES a piece; instead the catalog lists each distinct
 * orientation as its own pre-oriented piece (e.g. a horizontal and a vertical
 * line). Orientations are generated here once, at module load, so the catalog
 * is fixed and identical on every run (required for reproducible seeds).
 *
 * `color` is a cosmetic palette index derived from the shape FAMILY (all L
 * orientations share one), so it is stable for a given `id`. The UI maps it to
 * an actual color, so a future color theme only changes the palette.
 */
import type { Coord, Piece } from './game.ts';

/** Shape families, each with a fixed palette index (1-based; 0 = empty cell). */
const FAMILIES: ReadonlyArray<{
  readonly name: string;
  readonly color: number;
  /** Base shape drawn as rows of '#' (filled) and '.' (empty). */
  readonly art: readonly string[];
  /** How many distinct 90° orientations to include (1, 2 or 4). */
  readonly orientations: 1 | 2 | 4;
}> = [
  { name: 'dot', color: 1, art: ['#'], orientations: 1 },
  { name: 'line2', color: 2, art: ['##'], orientations: 2 },
  { name: 'line3', color: 2, art: ['###'], orientations: 2 },
  { name: 'line4', color: 2, art: ['####'], orientations: 2 },
  { name: 'line5', color: 2, art: ['#####'], orientations: 2 },
  { name: 'square', color: 3, art: ['##', '##'], orientations: 1 },
  { name: 'L', color: 4, art: ['#.', '#.', '##'], orientations: 4 },
  { name: 'J', color: 5, art: ['.#', '.#', '##'], orientations: 4 },
  { name: 'T', color: 6, art: ['###', '.#.'], orientations: 4 },
  { name: 'S', color: 7, art: ['.##', '##.'], orientations: 2 },
  { name: 'Z', color: 8, art: ['##.', '.##'], orientations: 2 },
];

/** Number of distinct palette indices used by pieces (1..PALETTE_SIZE). */
export const PALETTE_SIZE = 8;

/**
 * The reserved board-cell value for a level's GOAL tile (a pre-placed tile the
 * player must clear). It sits just past the piece palette, so it can never
 * collide with a placed piece's color. To the rules it is an ordinary filled
 * cell: nothing can be placed on it, it counts toward a full line, and
 * clearing that line zeroes it like any other cell.
 */
export const GOAL = PALETTE_SIZE + 1;

function parseArt(art: readonly string[]): Coord[] {
  const cells: Coord[] = [];
  art.forEach((row, r) => {
    [...row].forEach((ch, c) => {
      if (ch === '#') cells.push({ r, c });
    });
  });
  return cells;
}

/** Shift cells so the bounding box starts at (0,0) and sort them row-major. */
function normalize(cells: readonly Coord[]): Coord[] {
  const minR = Math.min(...cells.map((p) => p.r));
  const minC = Math.min(...cells.map((p) => p.c));
  return cells
    .map((p) => ({ r: p.r - minR, c: p.c - minC }))
    .sort((a, b) => a.r - b.r || a.c - b.c);
}

/** Rotate 90° clockwise (catalog generation only — never during play). */
function rotate(cells: readonly Coord[]): Coord[] {
  return normalize(cells.map((p) => ({ r: p.c, c: -p.r })));
}

function makePiece(id: string, cells: readonly Coord[], color: number): Piece {
  const norm = normalize(cells);
  return {
    id,
    cells: norm,
    w: Math.max(...norm.map((p) => p.c)) + 1,
    h: Math.max(...norm.map((p) => p.r)) + 1,
    color,
  };
}

function buildCatalog(): Piece[] {
  const out: Piece[] = [];
  for (const fam of FAMILIES) {
    let cells = normalize(parseArt(fam.art));
    for (let i = 0; i < fam.orientations; i++) {
      out.push(makePiece(`${fam.name}-${i}`, cells, fam.color));
      cells = rotate(cells);
    }
  }
  return out;
}

/** Every piece the generator can hand out, in a fixed order. */
export const PIECES: readonly Piece[] = buildCatalog();

const BY_ID: ReadonlyMap<string, Piece> = new Map(PIECES.map((p) => [p.id, p]));

/** Look up a catalog piece by id (used to validate/rehydrate saved games). */
export function pieceById(id: string): Piece | undefined {
  return BY_ID.get(id);
}

/** The 1×1 dot — the always-placeable fallback. */
export const DOT: Piece = PIECES[0]!;
