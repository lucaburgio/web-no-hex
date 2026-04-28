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

export interface TerritoryMapNote {
  id: string;
  x: number;
  y: number;
  text: string;
  align?: string;
  maxWidth?: number;
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
}

function undirectedTerritoryEdgeKey(aId: string, bId: string): string {
  return aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
}

/**
 * Adjacency from shared **polygon edges** only: the same undirected edge (two consecutive
 * vertices on a territory boundary) must appear in both polygons. Sharing two vertices that
 * are not a common side — e.g. meeting at a corner only, or non-consecutive verts — does not
 * count. Matches {@link buildEdgeTerritoryIndex} in territoryRenderer.ts and polygonEdgePairs in editorV2.
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

  return adjacency;
}

/**
 * Build a territory graph from a map definition.
 * - Allied territories → player home row (ROWS-1 = 2)
 * - Enemy territories → AI home row (row 0)
 * - Others (neutral + mountain) → row 1
 * - Virtual ROWS = 3, COLS = max count of any group (minimum 4)
 */
export function buildTerritoryGraph(mapDef: TerritoryMapDef): TerritoryGraphData {
  const points: Record<string, { x: number; y: number }> = {};
  for (const p of mapDef.pts) {
    points[p.id] = { x: p.x, y: p.y };
  }

  const allied: TerritoryMapTerritory[] = [];
  const enemy: TerritoryMapTerritory[] = [];
  const others: TerritoryMapTerritory[] = []; // neutral + mountain

  for (const t of mapDef.territories) {
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

  const adjacency = buildTerritoryAdjacency(mapDef);

  const playerHomeTerritoryIds = allied.map(t => t.id);
  const aiHomeTerritoryIds = enemy.map(t => t.id);
  const mountainTerritoryIds = others.filter(t => t.state === 'mountain').map(t => t.id);
  const passableTerritoryIds = [...allied, ...enemy, ...others.filter(t => t.state !== 'mountain')].map(t => t.id);

  const controlPoints: Record<string, TerritoryControlPoint> = {};
  for (const cp of mapDef.controlPoints) {
    controlPoints[cp.id] = {
      id: cp.id,
      territoryId: cp.territoryId,
      name: cp.name,
    };
  }

  const sectors: TerritoryMapSectorData[] = (mapDef.sectors ?? []).map(s => ({
    id: s.id,
    name: s.name,
    territoryIds: s.territoryIds,
  }));

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
    mapDef,
    points,
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
