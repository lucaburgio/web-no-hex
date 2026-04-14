/**
 * River generation system for hex boards.
 *
 * Hex side labeling — pointy-top orientation, clockwise from top-right:
 *
 *         F _____ A
 *        /         \
 *   E --+   center  +-- B
 *        \         /
 *         D ‾‾‾‾‾ C
 *
 *   A = top-right    B = right         C = bottom-right
 *   D = bottom-left  E = left          F = top-left
 *
 * River image naming convention: {side1}-{side2}-{variant}.png
 * The image connects the two named sides (direction-agnostic).
 * Multiple variants of the same pair (e.g. A-D-01, A-D-02) can coexist
 * and are selected randomly during generation.
 *
 * Neighbor delta table (odd-r offset, same parity rules as hex.ts):
 *
 *   Even rows:  A=[0,-1]  B=[1,0]  C=[0,1]  D=[-1,1]  E=[-1,0]  F=[-1,-1]
 *   Odd  rows:  A=[1,-1]  B=[1,0]  C=[1,1]  D=[0,1]   E=[-1,0]  F=[0,-1]
 */

import type { HexSide, RiverHex } from './types';

// ── Image imports (ES module — required for Tauri/Vite asset bundling) ─────────

import riverAC01 from '../public/images/misc/river-hex/A-C-01.png';
import riverAC02 from '../public/images/misc/river-hex/A-C-02.png';
import riverDA01 from '../public/images/misc/river-hex/D-A-01.png';
import riverDA02 from '../public/images/misc/river-hex/D-A-02.png';
import riverDB01 from '../public/images/misc/river-hex/D-B-01.png';
import riverDB02 from '../public/images/misc/river-hex/D-B-02.png';
import riverEA01 from '../public/images/misc/river-hex/E-A-01.png';
import riverEA02 from '../public/images/misc/river-hex/E-A-02.png';
import riverEB01 from '../public/images/misc/river-hex/E-B-01.png';
import riverEB02 from '../public/images/misc/river-hex/E-B-02.png';
import riverEC01 from '../public/images/misc/river-hex/E-C-01.png';
import riverEC02 from '../public/images/misc/river-hex/E-C-02.png';
import riverFB01 from '../public/images/misc/river-hex/F-B-01.png';
import riverFB02 from '../public/images/misc/river-hex/F-B-02.png';
import riverFC02 from '../public/images/misc/river-hex/F-C-02.png';
import riverFC03 from '../public/images/misc/river-hex/F-C-03.png';
import riverFD01 from '../public/images/misc/river-hex/F-D-01.png';
import riverFD02 from '../public/images/misc/river-hex/F-D-02.png';

// ── Side metadata ──────────────────────────────────────────────────────────────

export const HEX_SIDES: HexSide[] = ['A', 'B', 'C', 'D', 'E', 'F'];

/** Which side is directly opposite (the entry side into the next hex). */
export const SIDE_OPPOSITE: Record<HexSide, HexSide> = {
  A: 'D', B: 'E', C: 'F',
  D: 'A', E: 'B', F: 'C',
};

/**
 * [dc, dr] delta from (col, row) to its neighbor through side S.
 * Matches the NEIGHBOR_DIRS parity rules in hex.ts.
 */
export const SIDE_DELTA: Record<'even' | 'odd', Record<HexSide, [number, number]>> = {
  even: { A: [0, -1], B: [1,  0], C: [0,  1], D: [-1,  1], E: [-1, 0], F: [-1, -1] },
  odd:  { A: [1, -1], B: [1,  0], C: [1,  1], D: [ 0,  1], E: [-1, 0], F: [ 0, -1] },
};

// ── Segment catalog ────────────────────────────────────────────────────────────

interface RiverSegmentDef {
  /** Canonical segment key used in RiverHex.segment (e.g. 'F-B-01'). */
  key: string;
  /** The two sides this image connects. */
  sides: [HexSide, HexSide];
  /** Resolved asset URL from the ES module import. */
  url: string;
}

/**
 * All registered river segment images.
 * To add new art, import the PNG above and append an entry here.
 */
const RIVER_SEGMENT_DEFS: RiverSegmentDef[] = [
  { key: 'A-C-01', sides: ['A', 'C'], url: riverAC01 },
  { key: 'A-C-02', sides: ['A', 'C'], url: riverAC02 },
  { key: 'D-A-01', sides: ['D', 'A'], url: riverDA01 },
  { key: 'D-A-02', sides: ['D', 'A'], url: riverDA02 },
  { key: 'D-B-01', sides: ['D', 'B'], url: riverDB01 },
  { key: 'D-B-02', sides: ['D', 'B'], url: riverDB02 },
  { key: 'E-A-01', sides: ['E', 'A'], url: riverEA01 },
  { key: 'E-A-02', sides: ['E', 'A'], url: riverEA02 },
  { key: 'E-B-01', sides: ['E', 'B'], url: riverEB01 },
  { key: 'E-B-02', sides: ['E', 'B'], url: riverEB02 },
  { key: 'E-C-01', sides: ['E', 'C'], url: riverEC01 },
  { key: 'E-C-02', sides: ['E', 'C'], url: riverEC02 },
  { key: 'F-B-01', sides: ['F', 'B'], url: riverFB01 },
  { key: 'F-B-02', sides: ['F', 'B'], url: riverFB02 },
  { key: 'F-C-02', sides: ['F', 'C'], url: riverFC02 },
  { key: 'F-C-03', sides: ['F', 'C'], url: riverFC03 },
  { key: 'F-D-01', sides: ['F', 'D'], url: riverFD01 },
  { key: 'F-D-02', sides: ['F', 'D'], url: riverFD02 },
];

/** Map from segment key → resolved image URL. */
const SEGMENT_URL_MAP: Record<string, string> = {};
for (const def of RIVER_SEGMENT_DEFS) {
  SEGMENT_URL_MAP[def.key] = def.url;
}

/** Old map saves may reference removed asset keys; resolve to a current variant. */
const LEGACY_SEGMENT_KEYS: Record<string, string> = {
  'F-C-01': 'F-C-02',
};

/**
 * Per-entry-side index: for a river arriving through side S, which exits are
 * available and which image should be used?
 */
const CATALOG: Record<HexSide, Array<{ exitSide: HexSide; segmentKey: string }>> = {
  A: [], B: [], C: [], D: [], E: [], F: [],
};
for (const def of RIVER_SEGMENT_DEFS) {
  const [s1, s2] = def.sides;
  CATALOG[s1].push({ exitSide: s2, segmentKey: def.key });
  CATALOG[s2].push({ exitSide: s1, segmentKey: def.key });
}

/** Resolve a stored segment key to its bundled image URL. Returns empty string if unknown. */
export function riverSegmentUrl(key: string): string {
  const k = LEGACY_SEGMENT_KEYS[key] ?? key;
  return SEGMENT_URL_MAP[k] ?? '';
}

// ── Coordinate helpers ─────────────────────────────────────────────────────────

/** Returns the board neighbor through a given side, or null if out of bounds. */
export function getNeighborBySide(
  col: number, row: number, side: HexSide, cols: number, rows: number,
): [number, number] | null {
  const parity = Math.abs(row) % 2 === 0 ? 'even' : 'odd';
  const [dc, dr] = SIDE_DELTA[parity][side];
  const nc = col + dc;
  const nr = row + dr;
  if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) return null;
  return [nc, nr];
}

/** Returns the sides of a hex that face outside the board (neighbor is out of bounds). */
export function getOutwardSides(col: number, row: number, cols: number, rows: number): HexSide[] {
  return HEX_SIDES.filter(s => getNeighborBySide(col, row, s, cols, rows) === null);
}

/** Rectangular board edge crossed when leaving through an outward hex face (row 0 = north). */
export type BoardEdge = 'N' | 'S' | 'E' | 'W';

/**
 * Which map edge you cross by stepping out through `side` from (col, row).
 * Returns null if `side` is not outward (neighbor in bounds).
 */
export function boardEdgeForOutwardSide(
  col: number, row: number, side: HexSide, cols: number, rows: number,
): BoardEdge | null {
  const parity = Math.abs(row) % 2 === 0 ? 'even' : 'odd';
  const [dc, dr] = SIDE_DELTA[parity][side];
  const nc = col + dc;
  const nr = row + dr;
  if (nc >= 0 && nc < cols && nr >= 0 && nr < rows) return null;
  if (nr < 0) return 'N';
  if (nr >= rows) return 'S';
  if (nc < 0) return 'W';
  if (nc >= cols) return 'E';
  return null;
}

function riverPathBorderQuality(
  path: RiverHex[],
  startCol: number,
  startRow: number,
  entrySide: HexSide,
  cols: number,
  rows: number,
): { tier: number; length: number } {
  if (path.length === 0) return { tier: 0, length: 0 };
  const last = path[path.length - 1]!;
  const outwardStart = getOutwardSides(startCol, startRow, cols, rows).includes(entrySide);
  const outwardEnd = getOutwardSides(last.col, last.row, cols, rows).includes(last.exitSide);
  if (!outwardStart || !outwardEnd) return { tier: 1, length: path.length };
  const e0 = boardEdgeForOutwardSide(startCol, startRow, entrySide, cols, rows);
  const e1 = boardEdgeForOutwardSide(last.col, last.row, last.exitSide, cols, rows);
  if (!e0 || !e1) return { tier: 1, length: path.length };
  if (e0 === e1) return { tier: 2, length: path.length };
  return { tier: 3, length: path.length };
}

function isBetterRiverPath(
  a: { tier: number; length: number },
  b: { tier: number; length: number },
): boolean {
  if (a.tier !== b.tier) return a.tier > b.tier;
  return a.length > b.length;
}

/**
 * All border hexes with at least one outward side that has a matching catalog entry.
 * These are the valid starting points for river generation.
 */
export function getAllBorderEntries(
  cols: number, rows: number,
): Array<{ col: number; row: number; side: HexSide }> {
  const out: Array<{ col: number; row: number; side: HexSide }> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c > 0 && c < cols - 1 && r > 0 && r < rows - 1) continue; // skip interior
      for (const side of getOutwardSides(c, r, cols, rows)) {
        if (CATALOG[side].length > 0) {
          out.push({ col: c, row: r, side });
        }
      }
    }
  }
  return out;
}

/** Max hexes allowed in a generated river for board width `cols` and length multiplier from config. */
export function riverMaxHexesFromBoardWidth(cols: number, lengthMultVsBoardWidth: number): number {
  return Math.max(1, Math.floor(cols * lengthMultVsBoardWidth));
}

// ── Seeded PRNG (mulberry32) ───────────────────────────────────────────────────

function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0xFFFFFFFF;
  };
}

// ── River generation ───────────────────────────────────────────────────────────

export interface GenerateRiverOptions {
  startCol: number;
  startRow: number;
  /**
   * The side through which the river enters the start hex from **off the board**.
   * Must be an outward face (see `getOutwardSides`); invalid values yield an empty path.
   */
  entrySide: HexSide;
  cols: number;
  rows: number;
  /** Optional seed for reproducibility. Random if omitted. */
  seed?: number;
  /** Hard cap on hex count in this river (default: cols × rows). Use {@link riverMaxHexesFromBoardWidth}. */
  maxSteps?: number;
  /**
   * Retries with different RNG streams until the path ends on a different map edge than
   * it started (or `maxAttempts` is reached). Default 64.
   */
  maxAttempts?: number;
}

/**
 * One random walk (single RNG stream). Prefer `generateRiver()` for border rules.
 */
function generateRiverWalk(opts: GenerateRiverOptions & { seed: number }): RiverHex[] {
  const { startCol, startRow, entrySide, cols, rows, seed } = opts;
  if (!getOutwardSides(startCol, startRow, cols, rows).includes(entrySide)) return [];

  const rng = mkRng(seed);
  const maxSteps = opts.maxSteps ?? cols * rows;

  const result: RiverHex[] = [];
  const visited = new Set<string>();

  let col = startCol;
  let row = startRow;
  let entry: HexSide = entrySide;

  for (let step = 0; step < maxSteps; step++) {
    const key = `${col},${row}`;
    if (visited.has(key)) break; // loop guard
    visited.add(key);

    const exits = CATALOG[entry];
    if (exits.length === 0) break;

    // Exits that continue in-bounds to an unvisited hex
    const continuing = exits.filter(e => {
      const n = getNeighborBySide(col, row, e.exitSide, cols, rows);
      return n !== null && !visited.has(`${n[0]},${n[1]}`);
    });

    // Terminus: step off the board through a face that is actually outward (off-map)
    const terminating = exits.filter(e =>
      boardEdgeForOutwardSide(col, row, e.exitSide, cols, rows) !== null,
    );

    const pool = continuing.length > 0 ? continuing : terminating;
    if (pool.length === 0) break;

    const chosen = pool[Math.floor(rng() * pool.length)]!;
    result.push({ col, row, segment: chosen.segmentKey, entrySide: entry, exitSide: chosen.exitSide });

    const next = getNeighborBySide(col, row, chosen.exitSide, cols, rows);
    if (next === null) break; // exited the board — done

    [col, row] = next;
    entry = SIDE_OPPOSITE[chosen.exitSide];
  }

  return result;
}

/**
 * Generate a river path starting from a border hex.
 *
 * The algorithm performs a random walk:
 *  1. Enter the start hex from `entrySide` (must be an **outward** face so the river
 *     visibly comes in from off the board).
 *  2. Look up all catalog exits for the current entry side.
 *  3. Prefer exits that lead to an unvisited in-bounds hex; fall back to
 *     an exit that leaves the board through another **outward** face.
 *  4. Repeat until the river exits the board or no valid continuation exists.
 *
 * Retries with independent RNG streams (see `maxAttempts`) until the path **starts and
 * ends on different map edges** (north / south / east / west), when possible; otherwise
 * returns the best attempt (prefers outward entry/exit, then longer paths).
 */
export function generateRiver(opts: GenerateRiverOptions): RiverHex[] {
  const maxAttempts = opts.maxAttempts ?? 64;
  const baseSeed = opts.seed !== undefined ? opts.seed >>> 0 : (Math.random() * 0xFFFFFFFF) >>> 0;

  let bestMeta = { tier: 0, length: 0 };
  let best: RiverHex[] = [];

  for (let a = 0; a < maxAttempts; a++) {
    const seed = (baseSeed + Math.imul(a, 193_496_63)) >>> 0;
    const path = generateRiverWalk({ ...opts, seed });
    const meta = riverPathBorderQuality(
      path, opts.startCol, opts.startRow, opts.entrySide, opts.cols, opts.rows,
    );
    if (meta.tier === 3 && path.length > 0) return path;
    if (isBetterRiverPath(meta, bestMeta)) {
      bestMeta = meta;
      best = path;
    }
  }

  return best;
}
