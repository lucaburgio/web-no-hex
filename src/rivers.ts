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
 * Optional `river-hex-inverted/` holds the same `{side}-{side}-{NN}.png` keys for Y-flipped boards
 * (multiplayer guest); see {@link riverSegmentDisplay}.
 *
 * Neighbor delta table (odd-r offset, same parity rules as hex.ts):
 *
 *   Even rows:  A=[0,-1]  B=[1,0]  C=[0,1]  D=[-1,1]  E=[-1,0]  F=[-1,-1]
 *   Odd  rows:  A=[1,-1]  B=[1,0]  C=[1,1]  D=[0,1]   E=[-1,0]  F=[0,-1]
 */

import type { HexSide, RiverHex } from './types';

// ── Image imports (ES module — required for Tauri/Vite asset bundling) ─────────
// All PNGs under river-hex/ are bundled; filenames must be {side}-{side}-{NN}.png (see header).

const RIVER_HEX_URLS = import.meta.glob<string>(
  '../public/images/misc/river-hex/*.png',
  { eager: true, import: 'default' },
);

/** Same segment keys as `river-hex/`; used when the board is Y-flipped (guest / mirrored view) instead of mirroring the standard texture. */
const RIVER_HEX_INVERTED_URLS = import.meta.glob<string>(
  '../public/images/misc/river-hex-inverted/*.png',
  { eager: true, import: 'default' },
);

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

const SEGMENT_FILE_RE = /^([A-F])-([A-F])-(\d{2})\.png$/;

function buildRiverSegmentDefs(urlMap: Record<string, string>): RiverSegmentDef[] {
  const defs: RiverSegmentDef[] = [];
  for (const [path, url] of Object.entries(urlMap)) {
    const base = path.split('/').pop() ?? '';
    const m = base.match(SEGMENT_FILE_RE);
    if (!m) continue;
    const s1 = m[1] as HexSide;
    const s2 = m[2] as HexSide;
    const key = `${s1}-${s2}-${m[3]}`;
    defs.push({ key, sides: [s1, s2], url });
  }
  defs.sort((a, b) => a.key.localeCompare(b.key));
  return defs;
}

/**
 * All registered river segment images (every matching PNG under `river-hex/`).
 * Drop new `{side1}-{side2}-{NN}.png` files into that folder to extend the set.
 */
const RIVER_SEGMENT_DEFS: RiverSegmentDef[] = buildRiverSegmentDefs(RIVER_HEX_URLS);

/** Map from segment key → resolved image URL. */
const SEGMENT_URL_MAP: Record<string, string> = {};
for (const def of RIVER_SEGMENT_DEFS) {
  SEGMENT_URL_MAP[def.key] = def.url;
}

const RIVER_SEGMENT_DEFS_INVERTED: RiverSegmentDef[] = buildRiverSegmentDefs(RIVER_HEX_INVERTED_URLS);

/** Inverted-board variants (same keys as {@link SEGMENT_URL_MAP}). */
const SEGMENT_URL_MAP_INVERTED: Record<string, string> = {};
for (const def of RIVER_SEGMENT_DEFS_INVERTED) {
  SEGMENT_URL_MAP_INVERTED[def.key] = def.url;
}

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
  return SEGMENT_URL_MAP[key] ?? '';
}

/**
 * River art for the main board when it may be Y-flipped (see `flipBoardY` in `initRenderer`).
 * Prefer hand-authored `river-hex-inverted/` assets so the stream reads correctly; if a key is missing
 * there, fall back to the standard PNG plus the same counter-flip used for mountains/units.
 */
export function riverSegmentDisplay(
  segmentKey: string,
  boardFlippedY: boolean,
): { url: string; counterFlipUpright: boolean } {
  const normal = SEGMENT_URL_MAP[segmentKey] ?? '';
  if (!boardFlippedY) {
    return { url: normal, counterFlipUpright: false };
  }
  const inverted = SEGMENT_URL_MAP_INVERTED[segmentKey];
  if (inverted) {
    return { url: inverted, counterFlipUpright: false };
  }
  return { url: normal, counterFlipUpright: true };
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

/**
 * Map editor export fallback: one generic catalog segment per cell (junctions / non-path shapes).
 */
function placeholderRiverHexesFromKeys(keys: Iterable<string>): RiverHex[] {
  const def = RIVER_SEGMENT_DEFS[0];
  if (!def) return [];
  const [entrySide, exitSide] = def.sides;
  const out: RiverHex[] = [];
  for (const key of keys) {
    const [cs, rs] = key.split(',');
    const col = Number(cs);
    const row = Number(rs);
    if (!Number.isInteger(col) || !Number.isInteger(row)) continue;
    out.push({ col, row, segment: def.key, entrySide, exitSide });
  }
  out.sort((a, b) => a.row - b.row || a.col - b.col);
  return out;
}

function parseKey(k: string): { col: number; row: number } | null {
  const [cs, rs] = k.split(',');
  const col = Number(cs);
  const row = Number(rs);
  if (!Number.isInteger(col) || !Number.isInteger(row)) return null;
  return { col, row };
}

function keyOf(col: number, row: number): string {
  return `${col},${row}`;
}

/** Which side from (col, row) points toward adjacent hex (ncol, nrow), or null if not neighbors. */
function findSideTowardNeighbor(
  col: number, row: number, ncol: number, nrow: number,
): HexSide | null {
  const parity = Math.abs(row) % 2 === 0 ? 'even' : 'odd';
  for (const side of HEX_SIDES) {
    const [dc, dr] = SIDE_DELTA[parity][side];
    if (col + dc === ncol && row + dr === nrow) return side;
  }
  return null;
}

function buildAdjacencyInKeys(component: Set<string>, cols: number, rows: number): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const k of component) adj.set(k, new Set());
  for (const k of component) {
    const p = parseKey(k);
    if (!p) continue;
    for (const side of HEX_SIDES) {
      const n = getNeighborBySide(p.col, p.row, side, cols, rows);
      if (!n) continue;
      const nk = keyOf(n[0], n[1]);
      if (component.has(nk)) {
        adj.get(k)!.add(nk);
        adj.get(nk)!.add(k);
      }
    }
  }
  return adj;
}

/** Try to order a component as a simple path or cycle (each vertex degree ≤ 2). */
function tryLinearHexOrder(component: Set<string>, cols: number, rows: number): { col: number; row: number }[] | null {
  const n = component.size;
  if (n === 0) return null;
  const adj = buildAdjacencyInKeys(component, cols, rows);
  if (n === 1) {
    const k = [...component][0]!;
    const p = parseKey(k);
    return p ? [p] : null;
  }

  const endpoints = [...component].filter(k => (adj.get(k)?.size ?? 0) === 1);

  if (endpoints.length === 2) {
    const start = endpoints[0]!;
    const order: string[] = [];
    let prev: string | null = null;
    let cur: string | null = start;
    while (cur && order.length < n) {
      order.push(cur);
      const nextOpts: string[] = [...adj.get(cur)!].filter(x => x !== prev);
      if (order.length === n) break;
      if (nextOpts.length !== 1) return null;
      prev = cur;
      cur = nextOpts[0]!;
    }
    if (order.length !== n) return null;
    return order.map(k => parseKey(k)!);
  }

  if (endpoints.length === 0) {
    const start = [...component].sort((a, b) => a.localeCompare(b))[0]!;
    const neigh = [...adj.get(start)!].sort((a, b) => a.localeCompare(b));
    if (neigh.length !== 2) return null;

    for (const first of neigh) {
      const order: string[] = [start];
      let prev = start;
      let cur = first;
      for (let i = 1; i < n; i++) {
        order.push(cur);
        if (i < n - 1) {
          const candidates = [...adj.get(cur)!].filter(x => x !== prev);
          if (candidates.length !== 1) {
            order.length = 0;
            break;
          }
          prev = cur;
          cur = candidates[0]!;
        } else {
          const last = cur;
          if (!adj.get(last)!.has(start)) {
            order.length = 0;
            break;
          }
        }
      }
      if (order.length === n) return order.map(k => parseKey(k)!);
    }
    return null;
  }

  return null;
}

function pathCoordsSeed(coords: Array<{ col: number; row: number }>): number {
  let h = 2166136261;
  for (const p of coords) {
    h ^= p.col + 0x9E3779B9;
    h = Math.imul(h, 16777619);
    h ^= p.row + 0x9E3779B9;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickSegmentVariant(entry: HexSide, exit: HexSide, rng: () => number): string | null {
  const matches = CATALOG[entry].filter(e => e.exitSide === exit);
  if (matches.length === 0) return null;
  return matches[Math.floor(rng() * matches.length)]!.segmentKey;
}

function pickLastExitForPathEnd(
  col: number,
  row: number,
  entry: HexSide,
  coords: Array<{ col: number; row: number }>,
  cols: number,
  rows: number,
  rng: () => number,
): HexSide | null {
  const pathSet = new Set(coords.map(c => `${c.col},${c.row}`));
  const prev = coords.length >= 2 ? coords[coords.length - 2]! : null;
  const backSide = prev ? findSideTowardNeighbor(col, row, prev.col, prev.row) : null;

  const candidates = CATALOG[entry].filter(e => backSide === null || e.exitSide !== backSide);
  if (candidates.length === 0) return null;

  const scored = candidates.map(e => {
    const nb = getNeighborBySide(col, row, e.exitSide, cols, rows);
    let score = 0;
    if (nb === null) score = 4;
    else if (!pathSet.has(`${nb[0]},${nb[1]}`)) score = 3;
    else score = 0;
    return { exitSide: e.exitSide, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]!.score;
  const pool = scored.filter(s => s.score === best);
  return pool[Math.floor(rng() * pool.length)]!.exitSide;
}

/**
 * Build story-style {@link RiverHex} rows for an ordered path (grid-adjacent steps).
 */
function riverHexesAlongLinearPath(
  coords: Array<{ col: number; row: number }>,
  cols: number,
  rows: number,
  /** XOR’d with topology seed so repeated generation can vary segment picks. */
  variantSeed?: number,
): RiverHex[] | null {
  if (coords.length === 0) return null;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i]!;
    const b = coords[i + 1]!;
    if (findSideTowardNeighbor(a.col, a.row, b.col, b.row) === null) return null;
  }

  const baseSeed = pathCoordsSeed(coords);
  const rngSeed = variantSeed !== undefined ? (baseSeed ^ variantSeed) >>> 0 : baseSeed;
  const rng = mkRng(rngSeed);
  const out: RiverHex[] = [];

  if (coords.length === 1) {
    const p = coords[0]!;
    const sides = [...HEX_SIDES];
    for (let i = sides.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [sides[i], sides[j]] = [sides[j]!, sides[i]!];
    }
    for (const entry of sides) {
      const exit = pickLastExitForPathEnd(p.col, p.row, entry, coords, cols, rows, rng);
      if (exit === null) continue;
      const segment = pickSegmentVariant(entry, exit, rng);
      if (segment === null) continue;
      out.push({ col: p.col, row: p.row, segment, entrySide: entry, exitSide: exit });
      return out;
    }
    return null;
  }

  const exit0 = findSideTowardNeighbor(coords[0]!.col, coords[0]!.row, coords[1]!.col, coords[1]!.row);
  if (exit0 === null) return null;
  const entry0 = SIDE_OPPOSITE[exit0];
  const seg0 = pickSegmentVariant(entry0, exit0, rng);
  if (seg0 === null) return null;
  out.push({
    col: coords[0]!.col,
    row: coords[0]!.row,
    segment: seg0,
    entrySide: entry0,
    exitSide: exit0,
  });

  let prevExit: HexSide = exit0;

  for (let i = 1; i < coords.length; i++) {
    const p = coords[i]!;
    const entry = SIDE_OPPOSITE[prevExit];
    let exit: HexSide;
    if (i < coords.length - 1) {
      const towardNext = findSideTowardNeighbor(p.col, p.row, coords[i + 1]!.col, coords[i + 1]!.row);
      if (towardNext === null) return null;
      exit = towardNext;
    } else {
      const last = pickLastExitForPathEnd(p.col, p.row, entry, coords, cols, rows, rng);
      if (last === null) return null;
      exit = last;
    }
    const segment = pickSegmentVariant(entry, exit, rng);
    if (segment === null) return null;
    out.push({ col: p.col, row: p.row, segment, entrySide: entry, exitSide: exit });
    prevExit = exit;
  }

  return out;
}

function partitionKeyComponents(keys: Set<string>, cols: number, rows: number): Set<string>[] {
  const unseen = new Set(keys);
  const comps: Set<string>[] = [];
  while (unseen.size > 0) {
    const start = unseen.values().next().value as string;
    const comp = new Set<string>();
    const q: string[] = [start];
    while (q.length > 0) {
      const k = q.pop()!;
      if (!unseen.has(k)) continue;
      unseen.delete(k);
      comp.add(k);
      const p = parseKey(k);
      if (!p) continue;
      for (const side of HEX_SIDES) {
        const n = getNeighborBySide(p.col, p.row, side, cols, rows);
        if (!n) continue;
        const nk = keyOf(n[0], n[1]);
        if (unseen.has(nk)) q.push(nk);
      }
    }
    comps.push(comp);
  }
  return comps;
}

/**
 * Map editor / copy export: painted `"col,row"` keys → {@link RiverHex} rows like `stories.ts` `map.rivers`.
 * Linear chains and simple cycles get proper entry/exit/segment keys; T-junctions or branches fall back
 * to a generic segment per hex.
 *
 * @param variantSeed When set, combined with path topology so repeated calls can produce different
 *   segment variants for the same painted hexes (map editor “regenerate” button).
 */
export function riverHexesFromPaintedKeys(
  keys: Set<string>,
  cols: number,
  rows: number,
  variantSeed?: number,
): RiverHex[] {
  const out: RiverHex[] = [];
  const comps = partitionKeyComponents(keys, cols, rows)
    .sort((a, b) => ([...a].sort()[0] ?? '').localeCompare([...b].sort()[0] ?? ''));

  for (const comp of comps) {
    const ordered = tryLinearHexOrder(comp, cols, rows);
    if (ordered && ordered.length === comp.size) {
      const built = riverHexesAlongLinearPath(ordered, cols, rows, variantSeed);
      if (built && built.length === ordered.length) {
        out.push(...built);
        continue;
      }
    }
    out.push(...placeholderRiverHexesFromKeys(comp));
  }

  out.sort((a, b) => a.row - b.row || a.col - b.col);
  return out;
}
