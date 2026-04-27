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

  // Build adjacency: territories share a full edge (2+ common point IDs)
  const adjacency: Record<string, string[]> = {};
  const tList = mapDef.territories;
  for (const t of tList) {
    adjacency[t.id] = [];
  }

  for (let i = 0; i < tList.length; i++) {
    for (let j = i + 1; j < tList.length; j++) {
      const a = tList[i]!;
      const b = tList[j]!;
      const aSet = new Set(a.pointIds);
      const shared = b.pointIds.filter(pid => aSet.has(pid));
      if (shared.length >= 2) {
        // They share a full edge — adjacent (even if one is mountain, we record it)
        // But for movement adjacency we only include passable territories
        if (a.state !== 'mountain' && b.state !== 'mountain') {
          adjacency[a.id]!.push(b.id);
          adjacency[b.id]!.push(a.id);
        }
      }
    }
  }

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

/** SVG `points` string for the territory polygon at virtual (col,row), for move-path preview outline. */
export function territoryPolygonPointsForVirtualHex(
  graph: TerritoryGraphData,
  col: number,
  row: number,
): string | null {
  const tid = graph.keyToId[`${col},${row}`];
  if (!tid) return null;
  const t = graph.mapDef.territories.find(x => x.id === tid);
  if (!t) return null;
  return t.pointIds
    .map(pid => graph.points[pid])
    .filter((p): p is { x: number; y: number } => !!p)
    .map(p => `${p.x},${p.y}`)
    .join(' ');
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
