// Territory map types and graph building for polygon-based maps

export interface TerritoryMapPoint {
  id: string;
  x: number;
  y: number;
}

export interface TerritoryMapEdge {
  id: string;
  a: string;
  b: string;
}

export type TerritoryState = 'neutral' | 'allied' | 'enemy' | 'mountain';

export interface TerritoryMapTerritory {
  id: string;
  pointIds: string[];
  state: TerritoryState;
}

export interface TerritoryMapControlPoint {
  id: string;
  territoryId: string;
  name: string;
}

/** Where the note is shown in a match (map editor always shows all notes for editing). */
export type TerritoryMapNoteVisibility = 'always' | 'breakthroughOnly';

export interface TerritoryMapNote {
  id: string;
  x: number;
  y: number;
  text: string;
  align?: string;
  maxWidth?: number;
  /** Omit or `always`: visible in every game mode. `breakthroughOnly`: hidden except in Breakthrough. */
  visibility?: TerritoryMapNoteVisibility;
}

export interface TerritoryMapSector {
  id: string;
  name: string;
  territoryIds: string[];
}

export interface TerritoryMapDef {
  version?: number;
  pts: TerritoryMapPoint[];
  edges: TerritoryMapEdge[];
  territories: TerritoryMapTerritory[];
  controlPoints: TerritoryMapControlPoint[];
  notes?: TerritoryMapNote[];
  sectors?: TerritoryMapSector[];
  /**
   * Optional pairs of territory IDs that must **not** be graph-adjacent even when their
   * polygons share edges (e.g. overlapping strip fragments). Removes both directions from
   * the adjacency built from shared polygon edges.
   */
  adjacencyBlockPairs?: Array<[string, string]>;
}

/** A territory node in the processed graph */
export interface TerritoryNode {
  id: string;
  state: TerritoryState;
  pointIds: string[];
  virtualCol: number;
  virtualRow: number;
  virtualKey: string;
  centroid: { x: number; y: number };
}

/** A processed control point */
export interface TerritoryControlPoint {
  id: string;
  territoryId: string;
  name: string;
}

/** A processed sector */
export interface TerritoryMapSectorData {
  id: string;
  name: string;
  territoryIds: string[];
}

export interface TerritoryGraphData {
  /** Map from territory id → node */
  territories: Record<string, TerritoryNode>;
  /** Map from virtual key ("col,row") → territory id */
  keyToId: Record<string, string>;
  /** Adjacency: territory id → adjacent territory ids (passable only) */
  adjacency: Record<string, string[]>;
  /** Virtual grid dimensions */
  virtualCols: number;
  virtualRows: number;
  /** Territory IDs for player (allied) home territories */
  playerHomeTerritoryIds: string[];
  /** Territory IDs for AI (enemy) home territories */
  aiHomeTerritoryIds: string[];
  /** Territory IDs for mountain (impassable) territories */
  mountainTerritoryIds: string[];
  /** Territory IDs for all passable territories */
  passableTerritoryIds: string[];
  /** Control points from the JSON */
  controlPoints: Record<string, TerritoryControlPoint>;
  /** Sectors from the JSON */
  sectors: TerritoryMapSectorData[];
  /** Original map definition (for rendering) */
  mapDef: TerritoryMapDef;
  /** Map from point id → {x, y} */
  points: Record<string, { x: number; y: number }>;
  /**
   * Mean pixel distance between centroids of adjacent territories (shared-border neighbors).
   * Used with straight-line centroid distance so ranged min/max range tracks map geometry, not
   * only abstract graph hop count (which can be short on irregular polygon layouts).
   */
  avgAdjacentCentroidPx: number;
}

function undirectedTerritoryEdgeKey(aId: string, bId: string): string {
  return aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
}

/**
 * Adjacency from shared **polygon edges** only: the same undirected edge (two consecutive
 * vertices on a territory boundary) must appear in both polygons. Sharing two vertices that
 * are not a common side — e.g. meeting at a corner only, or non-consecutive verts — does not
 * count. Matches {@link buildEdgeTerritoryIndex} in territoryRenderer.ts and polygonEdgePairs in mapEditor.
 */
export function buildTerritoryAdjacency(mapDef: TerritoryMapDef): Record<string, string[]> {
  const adjacency: Record<string, string[]> = {};
  for (const t of mapDef.territories) {
    adjacency[t.id] = [];
  }

  const byId = new Map(mapDef.territories.map(t => [t.id, t]));
  const edgeKeyToTerritoryIds = new Map<string, string[]>();
  for (const t of mapDef.territories) {
    const n = t.pointIds.length;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const a = t.pointIds[i]!;
      const b = t.pointIds[(i + 1) % n]!;
      if (a === b) continue;
      const key = undirectedTerritoryEdgeKey(a, b);
      let list = edgeKeyToTerritoryIds.get(key);
      if (!list) {
        list = [];
        edgeKeyToTerritoryIds.set(key, list);
      }
      if (!list.includes(t.id)) list.push(t.id);
    }
  }

  for (const tids of edgeKeyToTerritoryIds.values()) {
    if (tids.length < 2) continue;
    for (let i = 0; i < tids.length; i++) {
      for (let j = i + 1; j < tids.length; j++) {
        const idA = tids[i]!;
        const idB = tids[j]!;
        const ta = byId.get(idA);
        const tb = byId.get(idB);
        if (!ta || !tb) continue;
        if (ta.state === 'mountain' || tb.state === 'mountain') continue;
        if (!adjacency[idA]!.includes(idB)) adjacency[idA]!.push(idB);
        if (!adjacency[idB]!.includes(idA)) adjacency[idB]!.push(idA);
      }
    }
  }

  applyAdjacencyBlockPairs(adjacency, mapDef.adjacencyBlockPairs);

  return adjacency;
}

function applyAdjacencyBlockPairs(
  adjacency: Record<string, string[]>,
  pairs: Array<[string, string]> | undefined,
): void {
  if (!pairs?.length) return;
  for (const [a, b] of pairs) {
    const la = adjacency[a];
    const lb = adjacency[b];
    if (!la || !lb) continue;
    adjacency[a] = la.filter(id => id !== b);
    adjacency[b] = lb.filter(id => id !== a);
  }
}

function computeAvgAdjacentCentroidPx(
  territories: Record<string, TerritoryNode>,
  adjacency: Record<string, string[]>,
): number {
  let sum = 0;
  let count = 0;
  for (const id of Object.keys(adjacency)) {
    for (const nid of adjacency[id] ?? []) {
      if (id >= nid) continue;
      const ta = territories[id];
      const tb = territories[nid];
      if (!ta || !tb) continue;
      sum += Math.hypot(tb.centroid.x - ta.centroid.x, tb.centroid.y - ta.centroid.y);
      count++;
    }
  }
  return count > 0 ? sum / count : 1;
}

/** Pixel-area tolerance when checking whether child territories partition a parent polygon. */
const PARTITION_AREA_EPS = 1;

function shoelaceAbsArea(
  pointIds: string[],
  pts: Record<string, { x: number; y: number }>,
): number {
  const n = pointIds.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[pointIds[i]!];
    const q = pts[pointIds[(i + 1) % n]!];
    if (!p || !q) continue;
    sum += p.x * q.y - q.x * p.y;
  }
  return Math.abs(sum / 2);
}

function vertexCentroid(
  pointIds: string[],
  pts: Record<string, { x: number; y: number }>,
): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  let c = 0;
  for (const id of pointIds) {
    const p = pts[id];
    if (p) {
      sx += p.x;
      sy += p.y;
      c++;
    }
  }
  return c > 0 ? { x: sx / c, y: sy / c } : { x: 0, y: 0 };
}

function territoryPolyPoints(
  pointIds: string[],
  pts: Record<string, { x: number; y: number }>,
): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const id of pointIds) {
    const p = pts[id];
    if (p) out.push({ x: p.x, y: p.y });
  }
  return out;
}

/** Ray-cast point-in-polygon (SVG y-down coords). */
function pointInPolygon(px: number, py: number, poly: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]!.x;
    const yi = poly[i]!.y;
    const xj = poly[j]!.x;
    const yj = poly[j]!.y;
    const denom = yj - yi;
    if (Math.abs(denom) < 1e-12) continue;
    if ((yi > py) === (yj > py)) continue;
    const xCross = ((xj - xi) * (py - yi)) / denom + xi;
    if (px < xCross) inside = !inside;
  }
  return inside;
}

const MAX_PARTITION_SUBSET = 22;

/** Undirected edge keys for a closed territory ring (consecutive point pairs). */
function territoryUndirectedEdgeKeys(t: TerritoryMapTerritory): Set<string> {
  const keys = new Set<string>();
  const n = t.pointIds.length;
  if (n < 2) return keys;
  for (let i = 0; i < n; i++) {
    const a = t.pointIds[i]!;
    const b = t.pointIds[(i + 1) % n]!;
    if (a === b) continue;
    keys.add(undirectedTerritoryEdgeKey(a, b));
  }
  return keys;
}

/**
 * True if every boundary segment of `parent` appears on at least one territory in `subsetIds`.
 * Guards against false “partition” matches from area-sum coincidence alone.
 */
function partitionSubsetCoversParentEdges(
  parent: TerritoryMapTerritory,
  subsetIds: string[],
  byId: Map<string, TerritoryMapTerritory>,
): boolean {
  const parentKeys = territoryUndirectedEdgeKeys(parent);
  if (parentKeys.size === 0) return false;
  const union = new Set<string>();
  for (const id of subsetIds) {
    const t = byId.get(id);
    if (!t) return false;
    for (const k of territoryUndirectedEdgeKeys(t)) union.add(k);
  }
  for (const k of parentKeys) {
    if (!union.has(k)) return false;
  }
  return true;
}

function findSubsetSummingToArea(
  items: Array<{ id: string; area: number }>,
  target: number,
  eps: number,
): string[] | null {
  const n = items.length;
  if (n > MAX_PARTITION_SUBSET) return null;
  let best: string[] | null = null;
  function dfs(i: number, remaining: number, chosen: string[]): void {
    if (best) return;
    if (chosen.length >= 2 && Math.abs(remaining) < eps) {
      best = [...chosen];
      return;
    }
    if (i === n) return;
    if (remaining < -eps) return;
    dfs(i + 1, remaining, chosen);
    const it = items[i]!;
    dfs(i + 1, remaining - it.area, [...chosen, it.id]);
  }
  dfs(0, target, []);
  return best;
}

/**
 * Territory ids that {@link sanitizeTerritoryMapDef} would strip: an enclosing polygon whose
 * interior is fully tiled by smaller same-`state` faces (same area sum **and** every parent
 * boundary segment appears on some child in that subset). While those shells still exist in
 * the editor, they share every map-boundary edge with a child face, so edge counts for “outer
 * perimeter” must ignore these ids.
 */
export function computeRedundantPartitionParentIds(mapDef: TerritoryMapDef): Set<string> {
  const pts: Record<string, { x: number; y: number }> = {};
  for (const p of mapDef.pts) pts[p.id] = { x: p.x, y: p.y };

  const areas = new Map<string, number>();
  const polys = new Map<string, Array<{ x: number; y: number }>>();
  for (const t of mapDef.territories) {
    areas.set(t.id, shoelaceAbsArea(t.pointIds, pts));
    polys.set(t.id, territoryPolyPoints(t.pointIds, pts));
  }

  const sortedByAreaDesc = [...mapDef.territories].sort(
    (a, b) => (areas.get(b.id) ?? 0) - (areas.get(a.id) ?? 0),
  );

  const toRemove = new Set<string>();
  const byId = new Map(mapDef.territories.map(t => [t.id, t] as [string, TerritoryMapTerritory]));

  for (const P of sortedByAreaDesc) {
    if (toRemove.has(P.id)) continue;
    const areaP = areas.get(P.id);
    if (areaP === undefined || areaP < PARTITION_AREA_EPS) continue;

    const polyP = polys.get(P.id);
    if (!polyP || polyP.length < 3) continue;

    const candidates = mapDef.territories.filter(T => {
      if (T.id === P.id || toRemove.has(T.id)) return false;
      if (T.state !== P.state) return false;
      const aT = areas.get(T.id) ?? 0;
      if (aT >= areaP - PARTITION_AREA_EPS) return false;
      const c = vertexCentroid(T.pointIds, pts);
      return pointInPolygon(c.x, c.y, polyP);
    });

    if (candidates.length < 2) continue;

    const subset = findSubsetSummingToArea(
      candidates.map(t => ({ id: t.id, area: areas.get(t.id) ?? 0 })),
      areaP,
      PARTITION_AREA_EPS,
    );
    if (
      subset &&
      subset.length >= 2 &&
      partitionSubsetCoversParentEdges(P, subset, byId)
    ) {
      toRemove.add(P.id);
    }
  }

  return toRemove;
}

/**
 * Removes territories that duplicate an outer boundary after a **split without deleting the
 * original**: smaller territories lie inside the parent polygon, have the same `state`, their
 * areas sum to the parent's area, and **every edge of the parent boundary appears on at least
 * one** of those faces (planar partition). Common when auto-detect or "save as new" adds faces
 * **t63/t64** but leaves **t50** as the old enclosing ring. Runs multiple passes so nested
 * obsolete shells are removed in one call.
 *
 * **Note:** dropping entries changes neutral/mountain **virtual column** indices (see
 * `assignTerritories` in {@link buildTerritoryGraph}); embedded saves for the same map id may
 * need a fresh match if the territory list was edited.
 */
export function sanitizeTerritoryMapDef(mapDef: TerritoryMapDef): TerritoryMapDef {
  const MAX_SANITIZE_PASSES = 48;
  let cur: TerritoryMapDef = mapDef;

  for (let pass = 0; pass < MAX_SANITIZE_PASSES; pass++) {
    const toRemove = computeRedundantPartitionParentIds(cur);
    if (toRemove.size === 0) return cur;

    for (const id of toRemove) {
      console.warn(
        `[sanitizeTerritoryMapDef] Removed redundant territory "${id}" (obsolete enclosing ring after interior partition).`,
      );
    }

    const territories = cur.territories.filter(t => !toRemove.has(t.id));
    const controlPoints = cur.controlPoints.filter(cp => !toRemove.has(cp.territoryId));
    const sectors = (cur.sectors ?? [])
      .map(s => ({
        ...s,
        territoryIds: s.territoryIds.filter(id => !toRemove.has(id)),
      }))
      .filter(s => s.territoryIds.length > 0);

    let adjacencyBlockPairsFiltered = cur.adjacencyBlockPairs;
    if (adjacencyBlockPairsFiltered?.length) {
      adjacencyBlockPairsFiltered = adjacencyBlockPairsFiltered.filter(
        ([a, b]) => !toRemove.has(a) && !toRemove.has(b),
      );
      if (adjacencyBlockPairsFiltered.length === 0) adjacencyBlockPairsFiltered = undefined;
    }

    const { adjacencyBlockPairs: _removedAbp, ...mapDefRest } = cur;
    cur = {
      ...mapDefRest,
      territories,
      controlPoints,
      sectors,
      ...(adjacencyBlockPairsFiltered?.length ? { adjacencyBlockPairs: adjacencyBlockPairsFiltered } : {}),
    };
  }

  return cur;
}

/**
 * Build a territory graph from a map definition.
 * - Allied territories → player home row (ROWS-1 = 2)
 * - Enemy territories → AI home row (row 0)
 * - Others (neutral + mountain) → row 1
 * - Virtual ROWS = 3, COLS = max count of any group (minimum 4)
 */
export function buildTerritoryGraph(mapDef: TerritoryMapDef): TerritoryGraphData {
  const cleanMapDef = sanitizeTerritoryMapDef(mapDef);
  const points: Record<string, { x: number; y: number }> = {};
  for (const p of cleanMapDef.pts) {
    points[p.id] = { x: p.x, y: p.y };
  }

  const allied: TerritoryMapTerritory[] = [];
  const enemy: TerritoryMapTerritory[] = [];
  const others: TerritoryMapTerritory[] = []; // neutral + mountain

  for (const t of cleanMapDef.territories) {
    if (t.state === 'allied') allied.push(t);
    else if (t.state === 'enemy') enemy.push(t);
    else others.push(t);
  }

  const virtualCols = Math.max(allied.length, enemy.length, others.length, 4);
  const virtualRows = 3;

  const territories: Record<string, TerritoryNode> = {};
  const keyToId: Record<string, string> = {};

  function assignTerritories(list: TerritoryMapTerritory[], row: number): void {
    list.forEach((t, i) => {
      const col = i;
      const key = `${col},${row}`;
      const centroid = computeCentroid(t.pointIds, points);
      const node: TerritoryNode = {
        id: t.id,
        state: t.state,
        pointIds: t.pointIds,
        virtualCol: col,
        virtualRow: row,
        virtualKey: key,
        centroid,
      };
      territories[t.id] = node;
      keyToId[key] = t.id;
    });
  }

  // Player home = row 2 (ROWS-1), AI home = row 0
  assignTerritories(allied, 2);
  assignTerritories(enemy, 0);
  assignTerritories(others, 1);

  const adjacency = buildTerritoryAdjacency(cleanMapDef);

  const playerHomeTerritoryIds = allied.map(t => t.id);
  const aiHomeTerritoryIds = enemy.map(t => t.id);
  const mountainTerritoryIds = others.filter(t => t.state === 'mountain').map(t => t.id);
  const passableTerritoryIds = [...allied, ...enemy, ...others.filter(t => t.state !== 'mountain')].map(t => t.id);

  const controlPoints: Record<string, TerritoryControlPoint> = {};
  for (const cp of cleanMapDef.controlPoints) {
    controlPoints[cp.id] = {
      id: cp.id,
      territoryId: cp.territoryId,
      name: cp.name,
    };
  }

  const sectors: TerritoryMapSectorData[] = (cleanMapDef.sectors ?? []).map(s => ({
    id: s.id,
    name: s.name,
    territoryIds: s.territoryIds,
  }));

  const avgAdjacentCentroidPx = computeAvgAdjacentCentroidPx(territories, adjacency);

  return {
    territories,
    keyToId,
    adjacency,
    virtualCols,
    virtualRows,
    playerHomeTerritoryIds,
    aiHomeTerritoryIds,
    mountainTerritoryIds,
    passableTerritoryIds,
    controlPoints,
    sectors,
    mapDef: cleanMapDef,
    points,
    avgAdjacentCentroidPx,
  };
}

/** Board-space pixel center for a virtual (col,row) cell — same as static unit placement (territory centroid). */
export function boardPixelForVirtualHex(
  graph: TerritoryGraphData,
  col: number,
  row: number,
): { x: number; y: number } | null {
  const tid = graph.keyToId[`${col},${row}`];
  if (!tid) return null;
  const node = graph.territories[tid];
  return node ? { x: node.centroid.x, y: node.centroid.y } : null;
}

function computeCentroid(
  pointIds: string[],
  points: Record<string, { x: number; y: number }>,
): { x: number; y: number } {
  let sx = 0, sy = 0, count = 0;
  for (const pid of pointIds) {
    const p = points[pid];
    if (p) { sx += p.x; sy += p.y; count++; }
  }
  return count > 0 ? { x: sx / count, y: sy / count } : { x: 0, y: 0 };
}
