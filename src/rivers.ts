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
// All PNGs under river-hex/ are bundled; filenames must be {side}-{side}-{NN}.png (see header).

const RIVER_HEX_URLS = import.meta.glob<string>(
  '../public/images/misc/river-hex/*.png',
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

function buildRiverSegmentDefs(): RiverSegmentDef[] {
  const defs: RiverSegmentDef[] = [];
  for (const [path, url] of Object.entries(RIVER_HEX_URLS)) {
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
const RIVER_SEGMENT_DEFS: RiverSegmentDef[] = buildRiverSegmentDefs();

/** Map from segment key → resolved image URL. */
const SEGMENT_URL_MAP: Record<string, string> = {};
for (const def of RIVER_SEGMENT_DEFS) {
  SEGMENT_URL_MAP[def.key] = def.url;
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

// ── Editor: paint rivers hex-by-hex (path → segments) ───────────────────────

/**
 * Which side from (col, row) points toward the adjacent hex (ncol, nrow), or null if not neighbors.
 */
export function findSideTowardNeighbor(
  col: number, row: number, ncol: number, nrow: number,
): HexSide | null {
  const parity = Math.abs(row) % 2 === 0 ? 'even' : 'odd';
  for (const side of HEX_SIDES) {
    const [dc, dr] = SIDE_DELTA[parity][side];
    if (col + dc === ncol && row + dr === nrow) return side;
  }
  return null;
}

function mkRngFromSeed(seed: number): () => number {
  return mkRng(seed >>> 0);
}

/** Stable hash for editor path → deterministic segment variants. */
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

function pickSegmentKey(entry: HexSide, exit: HexSide, rng: () => number): string | null {
  const matches = CATALOG[entry].filter(e => e.exitSide === exit);
  if (matches.length === 0) return null;
  return matches[Math.floor(rng() * matches.length)]!.segmentKey;
}

function pickLastExitSide(
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
    const n = getNeighborBySide(col, row, e.exitSide, cols, rows);
    let score = 0;
    if (n === null) score = 4;
    else if (!pathSet.has(`${n[0]},${n[1]}`)) score = 3;
    else score = 0;
    return { exitSide: e.exitSide, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]!.score;
  const pool = scored.filter(s => s.score === best);
  return pool[Math.floor(rng() * pool.length)]!.exitSide;
}

export interface BuildRiverHexesFromPathCoordsOptions {
  cols: number;
  rows: number;
  /**
   * Hex keys blocked for placement (e.g. mountains and other rivers not part of this path).
   * Must not include keys for `coords`.
   */
  blocked: Set<string>;
  /** Defaults to a deterministic seed from `coords`. */
  seed?: number;
}

/**
 * Build {@link RiverHex} data for a user-painted path (border start, each step a grid neighbor).
 * Chooses segment art and open-tail exit on the last hex for preview / extension in the editor.
 */
export function buildRiverHexesFromPathCoords(
  coords: Array<{ col: number; row: number }>,
  opts: BuildRiverHexesFromPathCoordsOptions,
): RiverHex[] | null {
  const { cols, rows, blocked } = opts;
  if (coords.length === 0) return null;

  const seen = new Set<string>();
  for (const p of coords) {
    const k = `${p.col},${p.row}`;
    if (seen.has(k)) return null;
    seen.add(k);
    if (p.col < 0 || p.row < 0 || p.col >= cols || p.row >= rows) return null;
    if (blocked.has(k)) return null;
  }

  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i]!;
    const b = coords[i + 1]!;
    if (findSideTowardNeighbor(a.col, a.row, b.col, b.row) === null) return null;
  }

  const first = coords[0]!;
  const outward0 = getOutwardSides(first.col, first.row, cols, rows);
  if (outward0.length === 0) return null;

  const rng = mkRngFromSeed(opts.seed ?? pathCoordsSeed(coords));
  const result: RiverHex[] = [];

  if (coords.length === 1) {
    const entry = outward0[Math.floor(rng() * outward0.length)]!;
    const exit = pickLastExitSide(first.col, first.row, entry, coords, cols, rows, rng);
    if (exit === null) return null;
    const segment = pickSegmentKey(entry, exit, rng);
    if (segment === null) return null;
    result.push({ col: first.col, row: first.row, segment, entrySide: entry, exitSide: exit });
    return result;
  }

  const exitTowardSecond = findSideTowardNeighbor(first.col, first.row, coords[1]!.col, coords[1]!.row);
  if (exitTowardSecond === null) return null;

  const entryCandidates = outward0.filter(e0 =>
    CATALOG[e0].some(c => c.exitSide === exitTowardSecond),
  );
  if (entryCandidates.length === 0) return null;
  const entry0 = entryCandidates[Math.floor(rng() * entryCandidates.length)]!;
  const seg0 = pickSegmentKey(entry0, exitTowardSecond, rng);
  if (seg0 === null) return null;
  result.push({
    col: first.col,
    row: first.row,
    segment: seg0,
    entrySide: entry0,
    exitSide: exitTowardSecond,
  });

  let prevExit: HexSide = exitTowardSecond;

  for (let i = 1; i < coords.length; i++) {
    const p = coords[i]!;
    const entry = SIDE_OPPOSITE[prevExit];
    let exit: HexSide;
    if (i < coords.length - 1) {
      const towardNext = findSideTowardNeighbor(p.col, p.row, coords[i + 1]!.col, coords[i + 1]!.row);
      if (towardNext === null) return null;
      exit = towardNext;
    } else {
      const last = pickLastExitSide(p.col, p.row, entry, coords, cols, rows, rng);
      if (last === null) return null;
      exit = last;
    }
    const segment = pickSegmentKey(entry, exit, rng);
    if (segment === null) return null;
    result.push({ col: p.col, row: p.row, segment, entrySide: entry, exitSide: exit });
    prevExit = exit;
  }

  return result;
}

/** Partition river hexes into connected chains (same adjacency rule as the map editor). */
export function partitionRiverComponents(rivers: RiverHex[]): RiverHex[][] {
  const byKey = new Map<string, RiverHex>(rivers.map(rh => [`${rh.col},${rh.row}`, rh]));
  const visited = new Set<string>();
  const out: RiverHex[][] = [];

  for (const startRh of rivers) {
    const sk = `${startRh.col},${startRh.row}`;
    if (visited.has(sk)) continue;

    const comp: RiverHex[] = [];
    const queue: string[] = [sk];
    while (queue.length > 0) {
      const k = queue.pop()!;
      if (visited.has(k)) continue;
      visited.add(k);
      const rh = byKey.get(k);
      if (!rh) continue;
      comp.push(rh);

      const parity = Math.abs(rh.row) % 2 === 0 ? 'even' : 'odd';
      const [fdc, fdr] = SIDE_DELTA[parity][rh.exitSide];
      const fnk = `${rh.col + fdc},${rh.row + fdr}`;
      if (byKey.has(fnk)) queue.push(fnk);

      for (const [nk, nrh] of byKey) {
        if (visited.has(nk)) continue;
        const np = Math.abs(nrh.row) % 2 === 0 ? 'even' : 'odd';
        const [ndc, ndr] = SIDE_DELTA[np][nrh.exitSide];
        if (`${nrh.col + ndc},${nrh.row + ndr}` === k) queue.push(nk);
      }
    }
    out.push(comp);
  }
  return out;
}

/**
 * Recover the ordered path along the flow (border entry → … → tail). Null if not a simple chain.
 */
export function extractOrderedRiverPath(
  hexes: RiverHex[],
  cols: number,
  rows: number,
): { col: number; row: number }[] | null {
  if (hexes.length === 0) return null;
  const byKey = new Map<string, RiverHex>(hexes.map(rh => [`${rh.col},${rh.row}`, rh]));
  const starts = hexes.filter(rh =>
    getOutwardSides(rh.col, rh.row, cols, rows).includes(rh.entrySide),
  );
  if (starts.length !== 1) return null;

  const path: { col: number; row: number }[] = [];
  const seen = new Set<string>();
  let cur: RiverHex | undefined = starts[0];

  while (cur) {
    const k = `${cur.col},${cur.row}`;
    if (seen.has(k)) return null;
    seen.add(k);
    path.push({ col: cur.col, row: cur.row });

    const n = getNeighborBySide(cur.col, cur.row, cur.exitSide, cols, rows);
    if (!n) break;
    const nk = `${n[0]},${n[1]}`;
    const next = byKey.get(nk);
    if (!next) break;
    cur = next;
  }

  if (seen.size !== hexes.length) return null;
  return path;
}
