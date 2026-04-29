import { getNeighbors, hexDistance } from './hex';
import config, {
  BOARD_HEX_DIM_MAX,
  BOARD_HEX_DIM_MIN,
  getAvailableUnitTypes,
  snapshotActiveUnitPackagesForSave,
  updateConfig,
} from './gameconfig';
import type { RiverHex } from './types';
import type {
  Unit,
  UnitType,
  HexState,
  GameState,
  CombatForecast,
  CombatVfxPayload,
  Owner,
  AiAnimStep,
  GameMode,
  StoryDef,
  UnitUpgradeKind,
  BattleStatsSide,
  WinReason,
} from './types';
import { boardPixelForVirtualHex, buildTerritoryGraph } from './territoryMap';
import type { TerritoryGraphData, TerritoryMapDef } from './territoryMap';

function perfEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const qs = new URLSearchParams(window.location.search);
  return qs.get('perf') === '1';
}

function perfLog(section: string, ms: number): void {
  if (!perfEnabled()) return;
  console.log(`[perf] ${section}: ${ms.toFixed(2)}ms`);
}

export const PLAYER = 1 as const;
export const AI     = 2 as const;

/** Breakthrough: which side is the attacker this match (old saves omit → south / PLAYER). */
export function getBreakthroughAttackerOwner(state: GameState): Owner {
  if (state.gameMode !== 'breakthrough') return PLAYER;
  return state.breakthroughAttackerOwner ?? PLAYER;
}

export function getBreakthroughDefenderOwner(state: GameState): Owner {
  const a = getBreakthroughAttackerOwner(state);
  return a === PLAYER ? AI : PLAYER;
}

export let COLS = config.boardCols;
export let ROWS = config.boardRows;

export function syncDimensions(): void {
  COLS = config.boardCols;
  ROWS = config.boardRows;
}

// ── Territory graph (polygon maps) ────────────────────────────────────────────

let _activeTerritoryGraph: TerritoryGraphData | null = null;

export function setActiveTerritoryGraph(graph: TerritoryGraphData | null): void {
  _activeTerritoryGraph = graph;
}

export function getActiveTerritoryGraph(): TerritoryGraphData | null {
  return _activeTerritoryGraph;
}

/** When territory graph is active, return neighbors via graph adjacency; else use hex neighbors. */
function effectiveGetNeighbors(col: number, row: number, cols: number, rows: number): [number, number][] {
  if (_activeTerritoryGraph) {
    const key = `${col},${row}`;
    const tid = _activeTerritoryGraph.keyToId[key];
    if (!tid) return [];
    const neighborIds = _activeTerritoryGraph.adjacency[tid] ?? [];
    return neighborIds.map(nid => {
      const t = _activeTerritoryGraph!.territories[nid];
      return t ? [t.virtualCol, t.virtualRow] as [number, number] : null;
    }).filter((x): x is [number, number] => x !== null);
  }
  return getNeighbors(col, row, cols, rows);
}

/** When territory graph is active, use BFS through adjacency; else use hex distance formula. */
function effectiveHexDistance(c1: number, r1: number, c2: number, r2: number): number {
  if (_activeTerritoryGraph) {
    if (c1 === c2 && r1 === r2) return 0;
    const visited = new Set<string>();
    let frontier: [number, number][] = [[c1, r1]];
    let dist = 0;
    while (frontier.length > 0) {
      dist++;
      const next: [number, number][] = [];
      for (const [c, r] of frontier) {
        for (const [nc, nr] of effectiveGetNeighbors(c, r, COLS, ROWS)) {
          if (nc === c2 && nr === r2) return dist;
          const k = `${nc},${nr}`;
          if (!visited.has(k)) { visited.add(k); next.push([nc, nr]); }
        }
      }
      frontier = next;
    }
    return Infinity;
  }
  return hexDistance(c1, r1, c2, r2, COLS, ROWS);
}

/**
 * Artillery range uses integer “hex steps”. On polygon maps, {@link effectiveHexDistance} is graph
 * BFS only — hop count can be small while territory centroids are far apart. Blend in pixel steps
 * (straight-line centroid distance / average neighbor spacing) so ranged bands match the map.
 */
function rangedCombatHexDistance(c1: number, r1: number, c2: number, r2: number): number {
  const graphSteps = effectiveHexDistance(c1, r1, c2, r2);
  const g = _activeTerritoryGraph;
  const avg = g?.avgAdjacentCentroidPx;
  if (!g || avg === undefined || avg <= 0) return graphSteps;
  const p1 = boardPixelForVirtualHex(g, c1, r1);
  const p2 = boardPixelForVirtualHex(g, c2, r2);
  if (!p1 || !p2) return graphSteps;
  const px = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const pixelSteps = Math.ceil(px / avg);
  return Math.max(graphSteps, pixelSteps);
}

const HEX_KEY_RE = /^(\d+),(\d+)$/;

function considerHexKey(key: string, acc: { maxC: number; maxR: number }): void {
  const m = key.match(HEX_KEY_RE);
  if (!m) return;
  const c = Number(m[1]);
  const r = Number(m[2]);
  if (c > acc.maxC) acc.maxC = c;
  if (r > acc.maxR) acc.maxR = r;
}

/** Infer width/height from every hex position referenced in a save (for older JSON without `boardCols` / `boardRows`). */
export function inferBoardDimensionsFromState(state: GameState): { boardCols: number; boardRows: number } {
  const acc = { maxC: -1, maxR: -1 };
  for (const u of state.units) {
    if (u.col > acc.maxC) acc.maxC = u.col;
    if (u.row > acc.maxR) acc.maxR = u.row;
  }
  for (const k of Object.keys(state.hexStates)) considerHexKey(k, acc);
  for (const k of state.mountainHexes) considerHexKey(k, acc);
  for (const rh of state.riverHexes) {
    if (rh.col > acc.maxC) acc.maxC = rh.col;
    if (rh.row > acc.maxR) acc.maxR = rh.row;
  }
  for (const k of state.controlPointHexes) considerHexKey(k, acc);
  for (const entry of state.sectorControlPointHex ?? []) {
    if (typeof entry === 'string') {
      if (entry) considerHexKey(entry, acc);
    } else if (Array.isArray(entry)) {
      for (const k of entry) considerHexKey(k, acc);
    }
  }
  for (const group of state.sectorHexes) {
    for (const k of group) considerHexKey(k, acc);
  }
  for (const k of Object.keys(state.sectorIndexByHex)) considerHexKey(k, acc);
  if (acc.maxC < 0 || acc.maxR < 0) {
    return { boardCols: config.boardCols, boardRows: config.boardRows };
  }
  return { boardCols: acc.maxC + 1, boardRows: acc.maxR + 1 };
}

/**
 * Migrate legacy saves where `sectorControlPointHex` was `string[]` (one hex or '' per sector)
 * to `string[][]` (all CP hex keys per sector; empty = none).
 */
export function migrateSectorControlPointHexLoaded(state: GameState): void {
  const nSec = state.sectorOwners?.length ?? 0;
  const raw = state.sectorControlPointHex as unknown;
  if (nSec === 0) {
    state.sectorControlPointHex = [];
    return;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    state.sectorControlPointHex = Array.from({ length: nSec }, () => []);
    return;
  }
  const first = raw[0];
  const isLegacy = !Array.isArray(first);
  let rows: string[][];
  if (isLegacy) {
    rows = (raw as string[]).map(cell => (typeof cell === 'string' && cell ? [cell] : []));
  } else {
    rows = (raw as unknown[]).map(row =>
      Array.isArray(row)
        ? row.filter((k): k is string => typeof k === 'string' && k.length > 0)
        : [],
    );
  }
  while (rows.length < nSec) rows.push([]);
  if (rows.length > nSec) rows = rows.slice(0, nSec);
  state.sectorControlPointHex = rows;
}

function isValidBoardDim(n: number): boolean {
  return Number.isInteger(n) && n >= BOARD_HEX_DIM_MIN && n <= BOARD_HEX_DIM_MAX;
}

/** Use persisted `boardCols` / `boardRows` when present and valid; else infer; clamp to allowed range. */
export function resolveBoardDimensionsForState(state: GameState): { boardCols: number; boardRows: number } {
  if (
    state.boardCols != null &&
    state.boardRows != null &&
    isValidBoardDim(state.boardCols) &&
    isValidBoardDim(state.boardRows)
  ) {
    return { boardCols: state.boardCols, boardRows: state.boardRows };
  }
  const inf = inferBoardDimensionsFromState(state);
  return {
    boardCols: Math.min(BOARD_HEX_DIM_MAX, Math.max(BOARD_HEX_DIM_MIN, inf.boardCols)),
    boardRows: Math.min(BOARD_HEX_DIM_MAX, Math.max(BOARD_HEX_DIM_MIN, inf.boardRows)),
  };
}

/** Align global `config`, `COLS`/`ROWS`, and optional fields on `state` with the match map size. */
export function applyGameStateBoardDimensions(state: GameState): void {
  if (state.gameMode === 'breakthrough' && state.sectorOwners?.length) {
    migrateSectorControlPointHexLoaded(state);
  }
  // For territory map games, restore the graph and use stored dimensions directly.
  if (state.customMapGraph) {
    if (state.customMapGraph.mapDef) {
      const graph = buildTerritoryGraph(state.customMapGraph.mapDef);
      state.customMapGraph = graph;
    }
    setActiveTerritoryGraph(state.customMapGraph);
    const boardCols = state.boardCols ?? state.customMapGraph.virtualCols;
    const boardRows = state.boardRows ?? state.customMapGraph.virtualRows;
    state.boardCols = boardCols;
    state.boardRows = boardRows;
    updateConfig({ boardCols, boardRows });
    syncDimensions();
    if (state.gameMode === 'breakthrough') {
      repairTerritoryBreakthroughLayoutFromGraph(state);
      breakthroughRefreshActiveControlPoint(state);
    }
    return;
  }
  const { boardCols, boardRows } = resolveBoardDimensionsForState(state);
  state.boardCols = boardCols;
  state.boardRows = boardRows;
  updateConfig({ boardCols, boardRows });
  syncDimensions();
}

let unitIdCounter = 0;
const bfsDistanceCache = new Map<string, number>();
const minHomeStepsCache = new Map<string, number>();
const mountainKeyCache = new WeakMap<GameState, string>();
const PATH_CACHE_LIMIT = 200000;

function getMountainKey(state: GameState): string {
  const cached = mountainKeyCache.get(state);
  if (cached) return cached;
  const key = (state.mountainHexes ?? []).slice().sort().join('|');
  mountainKeyCache.set(state, key);
  return key;
}

function maybeTrimPathCaches(): void {
  if (bfsDistanceCache.size > PATH_CACHE_LIMIT) bfsDistanceCache.clear();
  if (minHomeStepsCache.size > PATH_CACHE_LIMIT) minHomeStepsCache.clear();
}

function emptyBattleStatsSide(): BattleStatsSide {
  return {
    damageDealt: 0,
    damageTaken: 0,
    rangedDamageDealt: 0,
    attacksInitiated: 0,
    enemyUnitsDestroyed: 0,
    unitsLost: 0,
    unitsDeployed: 0,
  };
}

function initBattleStatsFromUnits(units: Unit[]): Record<Owner, BattleStatsSide> {
  const out: Record<Owner, BattleStatsSide> = {
    1: emptyBattleStatsSide(),
    2: emptyBattleStatsSide(),
  };
  for (const u of units) {
    out[u.owner].unitsDeployed++;
  }
  return out;
}

/** Normalize stats for older saves or missing field. */
export function normalizeBattleStats(state: GameState): Record<Owner, BattleStatsSide> {
  if (!state.battleStats) {
    state.battleStats = initBattleStatsFromUnits(state.units);
  } else {
    for (const o of [1, 2] as Owner[]) {
      const s = state.battleStats[o];
      if (s.rangedDamageDealt == null) s.rangedDamageDealt = 0;
      if (s.attacksInitiated == null) s.attacksInitiated = 0;
    }
  }
  return state.battleStats;
}

function recordCombatBattleStats(
  state: GameState,
  attacker: Unit,
  defender: Unit,
  res: CombatResolveResult,
): void {
  const bs = normalizeBattleStats(state);
  const a = attacker.owner;
  const d = defender.owner;
  bs[a].attacksInitiated++;
  if (res.ranged) {
    bs[a].damageDealt += res.dmgToDefender;
    bs[a].rangedDamageDealt += res.dmgToDefender;
    bs[d].damageTaken += res.dmgToDefender;
    if (res.defenderDied) {
      bs[a].enemyUnitsDestroyed++;
      bs[d].unitsLost++;
    }
    return;
  }
  bs[a].damageDealt += res.dmgToDefender;
  bs[a].damageTaken += res.dmgToAttacker;
  bs[d].damageDealt += res.dmgToAttacker;
  bs[d].damageTaken += res.dmgToDefender;
  if (res.defenderDied) {
    bs[a].enemyUnitsDestroyed++;
    bs[d].unitsLost++;
  }
  if (res.attackerDied) {
    bs[d].enemyUnitsDestroyed++;
    bs[a].unitsLost++;
  }
}

function makeUnit(owner: Owner, col: number, row: number, unitTypeId = 'infantry'): Unit {
  const unitType = getAvailableUnitTypes(owner).find(u => u.id === unitTypeId)
    ?? config.unitTypes.find(u => u.id === unitTypeId)
    ?? config.unitTypes[0];
  return {
    id: unitIdCounter++,
    owner,
    unitTypeId,
    icon: unitType.icon,
    col,
    row,
    movesUsed: 0,
    attackedThisTurn: false,
    hp: unitType.maxHp,
    maxHp: unitType.maxHp,
    strength: unitType.strength,
    movement: unitType.movement,
    upgradePoints: 0,
    upgradeFlanking: 0,
    upgradeAttack: 0,
    upgradeDefense: 0,
    upgradeHeal: 0,
  };
}

/** Which home-territory slots receive starting units (evenly spread across available slots). */
function spreadHomeTerritorySlotIndices(n: number, slotCount: number): number[] {
  const L = slotCount;
  if (L === 0 || n <= 0) return [];
  const slots = Array.from({ length: L }, (_, i) => i);
  const m = Math.min(n, L);
  if (m === 1) return [slots[Math.floor(L / 2)]!];
  return Array.from({ length: m }, (_, i) =>
    slots[Math.round((L - 1) * i / (m - 1))]!,
  );
}

function sortTerritoryIdsByVirtualPosition(graph: TerritoryGraphData, ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const ta = graph.territories[a];
    const tb = graph.territories[b];
    if (!ta || !tb) return 0;
    if (ta.virtualRow !== tb.virtualRow) return ta.virtualRow - tb.virtualRow;
    return ta.virtualCol - tb.virtualCol;
  });
}

/**
 * Breakthrough: attacker starts in the sector that has no control point; defender homes are
 * home territories (allied or enemy) in all other sectors. Settings `startingUnitsAttacker` /
 * `startingUnitsDefender` apply to those map regions; owners follow the configured role.
 */
function computeBreakthroughTerritoryRoleHomes(graph: TerritoryGraphData): {
  attackerHomeIds: string[];
  defenderHomeIds: string[];
} {
  const cpTids = new Set(Object.values(graph.controlPoints).map(cp => cp.territoryId));
  let attackerSectorIdx = graph.sectors.findIndex(sec => !sec.territoryIds.some(tid => cpTids.has(tid)));
  if (attackerSectorIdx < 0) attackerSectorIdx = 0;
  const sector = graph.sectors[attackerSectorIdx];
  const attackerSectorTids = new Set(sector?.territoryIds ?? []);
  const allHome = [...new Set([...graph.playerHomeTerritoryIds, ...graph.aiHomeTerritoryIds])];
  const ah = allHome.filter(id => attackerSectorTids.has(id));
  const dh = allHome.filter(id => !attackerSectorTids.has(id));
  return {
    attackerHomeIds: sortTerritoryIdsByVirtualPosition(graph, ah),
    defenderHomeIds: sortTerritoryIdsByVirtualPosition(graph, dh),
  };
}

/** For settings UI: number of home territories per breakthrough role (one unit per territory max). */
export function getBreakthroughTerritoryStartingSlotCounts(mapDef: TerritoryMapDef): {
  attacker: number;
  defender: number;
} {
  const graph = buildTerritoryGraph(mapDef);
  const { attackerHomeIds, defenderHomeIds } = computeBreakthroughTerritoryRoleHomes(graph);
  return {
    attacker: attackerHomeIds.length,
    defender: defenderHomeIds.length,
  };
}

/** Breakthrough: sort south → north, split into `sectorCount` contiguous chunks of ~equal size. */
function partitionBreakthroughSectors(assignableKeys: string[], sectorCount: number): string[][] {
  const sorted = [...assignableKeys].sort((a, b) => {
    const [ac, ar] = a.split(',').map(Number);
    const [bc, br] = b.split(',').map(Number);
    if (br !== ar) return br - ar;
    return ac - bc;
  });
  if (sorted.length === 0) return [];
  const n = Math.min(sectorCount, sorted.length);
  const base = Math.floor(sorted.length / n);
  const rem = sorted.length % n;
  const out: string[][] = [];
  let idx = 0;
  for (let s = 0; s < n; s++) {
    const size = base + (s < rem ? 1 : 0);
    out.push(sorted.slice(idx, idx + size));
    idx += size;
  }
  return out;
}

function pickBreakthroughSectorControlPoint(sectorKeys: string[], cols: number, rows: number): string {
  if (sectorKeys.length === 1) return sectorKeys[0]!;
  let sumC = 0;
  let sumR = 0;
  for (const k of sectorKeys) {
    const [c, r] = k.split(',').map(Number);
    sumC += c;
    sumR += r;
  }
  const tc = Math.round(sumC / sectorKeys.length);
  const tr = Math.round(sumR / sectorKeys.length);
  let best = sectorKeys[0]!;
  let bestD = Infinity;
  for (const k of sectorKeys) {
    const [c, r] = k.split(',').map(Number);
    const d = hexDistance(c, r, tc, tr, cols, rows);
    if (d < bestD) {
      bestD = d;
      best = k;
    } else if (d === bestD) {
      const [bc, br] = best.split(',').map(Number);
      if (r < br || (r === br && c < bc)) best = k;
    }
  }
  return best;
}

function territoryBonusForHexCount(hexCount: number): number {
  // Breakthrough can disable territory income (quota/points set to 0).
  if (config.territoryQuota <= 0 || config.pointsPerQuota <= 0) return 0;
  return Math.floor(hexCount / config.territoryQuota) * config.pointsPerQuota;
}

/** Breakthrough: defender sector currently on the border with attacker-held sectors (frontline objective). */
export function breakthroughActiveFrontlineSectorIndex(state: GameState): number | null {
  if (state.gameMode !== 'breakthrough' || !state.sectorOwners?.length) return null;
  const att = getBreakthroughAttackerOwner(state);
  const n = state.sectorOwners.length;
  if (n === 0) return null;

  if (att === PLAYER) {
    for (let i = 0; i < n; i++) {
      if (state.sectorOwners[i] !== att) return i;
    }
    return null;
  }
  for (let i = n - 1; i >= 0; i--) {
    if (state.sectorOwners[i] !== att) return i;
  }
  return null;
}

/** Breakthrough: only the current frontline sector’s control point(s) are active for markers and capture checks. */
function breakthroughRefreshActiveControlPoint(state: GameState): void {
  if (state.gameMode !== 'breakthrough') return;
  state.controlPointHexes = breakthroughFrontlineCpKeys(state);
}

/** Active frontline sector CP hex keys (may be multiple per sector); empty if none or all sectors captured. */
function breakthroughFrontlineCpKeys(state: GameState): string[] {
  if (state.gameMode !== 'breakthrough' || !state.sectorOwners?.length) return [];
  const sid = breakthroughActiveFrontlineSectorIndex(state);
  if (sid === null) return [];
  return [...(state.sectorControlPointHex[sid] ?? [])];
}

/**
 * Map editors often omit neutral/interior territories from sector lists; those tiles would be missing
 * from {@link GameState.sectorIndexByHex}, breaking breakthrough malus, CP progression, and capture ownership.
 * Assign every passable territory to a sector via multi-source BFS along adjacency (deterministic first wave),
 * then assign any disconnected leftovers to the first defender sector.
 */
function expandBreakthroughSectorHexesForTerritoryMap(
  graph: TerritoryGraphData,
  sectorHexes: string[][],
  attackerSectorIdx: number,
): string[][] {
  const nSec = graph.sectors.length;
  if (nSec === 0) return sectorHexes.map(s => [...s]);
  const out = sectorHexes.map(s => [...s]);
  const tidToSectorIdx = new Map<string, number>();
  for (let s = 0; s < nSec; s++) {
    for (const tid of graph.sectors[s]!.territoryIds) {
      const node = graph.territories[tid];
      if (!node || node.state === 'mountain' || node.state === 'offmap') continue;
      tidToSectorIdx.set(tid, s);
    }
  }
  const visited = new Set(tidToSectorIdx.keys());
  const queue: { tid: string; sid: number }[] = [...tidToSectorIdx.entries()].map(([tid, sid]) => ({ tid, sid }));
  while (queue.length) {
    const { tid, sid } = queue.shift()!;
    for (const nb of graph.adjacency[tid] ?? []) {
      if (visited.has(nb)) continue;
      const nbNode = graph.territories[nb];
      if (!nbNode || nbNode.state === 'mountain' || nbNode.state === 'offmap') continue;
      visited.add(nb);
      tidToSectorIdx.set(nb, sid);
      out[sid]!.push(nbNode.virtualKey);
      queue.push({ tid: nb, sid });
    }
  }
  const fallbackSid = graph.sectors.findIndex((_, i) => i !== attackerSectorIdx);
  const orphanSid = fallbackSid >= 0 ? fallbackSid : 0;
  for (const tid of graph.passableTerritoryIds) {
    if (tidToSectorIdx.has(tid)) continue;
    const node = graph.territories[tid];
    if (!node || node.state === 'mountain' || node.state === 'offmap') continue;
    tidToSectorIdx.set(tid, orphanSid);
    out[orphanSid]!.push(node.virtualKey);
  }
  return out;
}

/**
 * Older saves / migrations set `sectorControlPointHex` to [] when the field was missing, which made
 * {@link applyBreakthroughEndOfRound} bail out (`!.length` on []). Rebuild CP keys and sector hex
 * lists from the embedded graph so breakthrough rounds and UI stay functional.
 */
function repairTerritoryBreakthroughLayoutFromGraph(state: GameState): void {
  const graph = state.customMapGraph;
  if (!graph || state.gameMode !== 'breakthrough') return;
  const nSec = graph.sectors?.length ?? 0;
  if (nSec === 0 || !state.sectorOwners?.length || state.sectorOwners.length !== nSec) return;

  const cpTids = new Set(Object.values(graph.controlPoints).map(cp => cp.territoryId));
  const attackerSectorIdx = graph.sectors.findIndex(sec => !sec.territoryIds.some(tid => cpTids.has(tid)));
  if (attackerSectorIdx < 0) return;

  const sch = state.sectorControlPointHex;
  const needsCpRepair = !sch || sch.length !== nSec;
  if (needsCpRepair) {
    state.sectorControlPointHex = graph.sectors.map((sec, i) => {
      if (i === attackerSectorIdx) return [];
      const keys: string[] = [];
      for (const cp of Object.values(graph.controlPoints)) {
        if (!sec.territoryIds.includes(cp.territoryId)) continue;
        const t = graph.territories[cp.territoryId];
        if (t) keys.push(t.virtualKey);
      }
      keys.sort();
      return keys;
    });
  }

  const sh = state.sectorHexes;
  if (!sh?.length || sh.length !== nSec) {
    let sectorHexes = graph.sectors.map(sec =>
      sec.territoryIds
        .map(id => graph.territories[id])
        .filter(t => t && t.state !== 'mountain' && t.state !== 'offmap')
        .map(t => t!.virtualKey),
    );
    sectorHexes = expandBreakthroughSectorHexesForTerritoryMap(graph, sectorHexes, attackerSectorIdx);
    state.sectorHexes = sectorHexes;
    state.sectorIndexByHex = {};
    sectorHexes.forEach((hexes, sid) => {
      for (const k of hexes) state.sectorIndexByHex[k] = sid;
    });
  }

  const occ = state.breakthroughCpOccupation ?? [];
  if (!state.breakthroughCpOccupation || state.breakthroughCpOccupation.length !== nSec) {
    state.breakthroughCpOccupation = Array.from({ length: nSec }, (_, i) => occ[i] ?? 0);
  }
}

// ── Hex territory ─────────────────────────────────────────────────────────────

/** Breakthrough: sector politically captured by the attacker — defender cannot change hex ownership there. */
function breakthroughHexLockedToAttacker(state: GameState, col: number, row: number): boolean {
  if (state.gameMode !== 'breakthrough' || !state.sectorOwners?.length) return false;
  const sid = state.sectorIndexByHex[`${col},${row}`];
  if (sid === undefined) return false;
  return state.sectorOwners[sid] === getBreakthroughAttackerOwner(state);
}

function conquerHex(state: GameState, col: number, row: number, owner: Owner): void {
  const att = getBreakthroughAttackerOwner(state);
  const def = getBreakthroughDefenderOwner(state);
  if (state.gameMode === 'breakthrough' && owner === def && breakthroughHexLockedToAttacker(state, col, row)) {
    owner = att;
  }
  const key = `${col},${row}`;
  if ((state.mountainHexes ?? []).includes(key)) return;
  const existing = state.hexStates[key];
  if (existing) {
    if (existing.owner !== owner) {
      existing.owner = owner;
      existing.stableFor = 0;
      existing.isProduction = false;
    }
  } else {
    state.hexStates[key] = { owner, stableFor: 0, isProduction: false };
  }
}

/**
 * Map edge (north vs south) — which side is "at home" on that border row. Interior rows: undefined.
 * Used to decide who holds an empty home-border hex when it is cleared without a unit moving in
 * (ranged kill or mutual kill), so a border garrison can no longer count for supply/respawn until
 * the native side reclaims the edge (when applicable).
 */
function borderRowNativeOwner(row: number): Owner | undefined {
  if (row === 0) return AI;
  if (row === ROWS - 1) return PLAYER;
  return undefined;
}

/**
 * Domination/Conquest: we only add hexStates for cells with starting units, so other home-row
 * cells were missing from the map (looked "neutral") and were invalid for production. Seed
 * empty, non-mountain border cells to the native owner for that edge.
 * Breakthrough already assigns every playable hex via sectors — skip.
 */
function seedEmptyHomeRowHexStates(hexStates: Record<string, HexState>, mountainHexes: string[]): void {
  const mountains = new Set(mountainHexes);
  for (let c = 0; c < COLS; c++) {
    for (const [row, owner] of [
      [0, AI] as const,
      [ROWS - 1, PLAYER] as const,
    ]) {
      const key = `${c},${row}`;
      if (mountains.has(key)) continue;
      if (!hexStates[key]) {
        hexStates[key] = { owner, stableFor: 0, isProduction: false };
      }
    }
  }
}

/**
 * When a border-row hex is cleared and the attacker survives, who should own the empty cell?
 * — Native garrison lost: killer's side (attacker) takes the border.
 * — Invader on the opposite home row: the edge reverts to that map side's owner (melee; ranged
 *   skips this revert — see skipRangedBorderRevertToNative).
 * Interior rows: undefined (use normal conquest: attacker when they survive).
 * Melee mutual kill: caller does not use this — ownership is left unchanged.
 */
function ownerForEmptyBorderAfterDefenderRemoved(
  defRow: number,
  defOwner: Owner,
  attackerOwner: Owner,
): Owner | undefined {
  const native = borderRowNativeOwner(defRow);
  if (native === undefined) return undefined;
  return defOwner === native ? attackerOwner : native;
}

/** Ranged: do not auto-flip a home-border hex to the native side when the invader dies — reconquer by moving a unit in. */
function skipRangedBorderRevertToNative(defRow: number, defOwner: Owner, borderOwner: Owner): boolean {
  const native = borderRowNativeOwner(defRow);
  return native !== undefined && defOwner !== native && borderOwner === native;
}

function getHexesWithinDistance(col: number, row: number, dist: number, cols: number, rows: number): [number, number][] {
  const visited = new Set<string>([`${col},${row}`]);
  let frontier: [number, number][] = [[col, row]];
  const result: [number, number][] = [];
  for (let d = 0; d < dist; d++) {
    const next: [number, number][] = [];
    for (const [c, r] of frontier) {
      for (const [nc, nr] of getNeighbors(c, r, cols, rows)) {
        const key = `${nc},${nr}`;
        if (!visited.has(key)) {
          visited.add(key);
          result.push([nc, nr]);
          next.push([nc, nr]);
        }
      }
    }
    frontier = next;
  }
  return result;
}

function updateHexStability(state: GameState): void {
  const mountains = new Set(state.mountainHexes ?? []);
  for (const [key, hex] of Object.entries(state.hexStates)) {
    if (hex.owner === null) continue;
    const [col, row] = key.split(',').map(Number);
    const nearby = getHexesWithinDistance(col, row, config.productionSafeDistance, COLS, ROWS);

    const isStable = nearby.every(([nc, nr]) => {
      const nk = `${nc},${nr}`;
      // Mountains are never in hexStates (unconquerable); treat as secure for this rule — not neutral/enemy holes.
      if (mountains.has(nk)) return true;
      const nhex = state.hexStates[nk];
      return nhex && nhex.owner === hex.owner;
    });

    if (isStable) {
      hex.stableFor++;
      if (hex.stableFor >= config.productionTurns) hex.isProduction = true;
    } else {
      hex.stableFor = 0;
      hex.isProduction = false;
    }
  }
}

function primeInitialBreakthroughProductionHexes(
  hexStates: Record<string, HexState>,
  mountainHexes: string[],
): void {
  const mountains = new Set(mountainHexes);
  for (const [key, hex] of Object.entries(hexStates)) {
    if (hex.owner === null) continue;
    const [col, row] = key.split(',').map(Number);
    const nearby = getHexesWithinDistance(col, row, config.productionSafeDistance, COLS, ROWS);
    const isStable = nearby.every(([nc, nr]) => {
      const nk = `${nc},${nr}`;
      if (mountains.has(nk)) return true;
      const nhex = hexStates[nk];
      return nhex && nhex.owner === hex.owner;
    });
    hex.stableFor = isStable ? config.productionTurns : 0;
    hex.isProduction = isStable;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getUnit(state: GameState, col: number, row: number): Unit | null {
  return state.units.find(u => u.col === col && u.row === row) ?? null;
}

export function getUnitById(state: GameState, id: number): Unit | null {
  return state.units.find(u => u.id === id) ?? null;
}

/**
 * Territory maps lay hexes in a rectangle; {@link TerritoryGraphData.virtualCols} / virtualRows can
 * pad the bbox with slots that have no polygon — those must not count for production or supply.
 */
function isVirtualHexOnTerritory(state: GameState, col: number, row: number): boolean {
  const g = state.customMapGraph;
  if (!g) return true;
  return g.keyToId[`${col},${row}`] !== undefined;
}

/** Map sector with no CP — attacker's starting home blob (same index as {@link createInitialStateFromTerritoryMap}). */
function breakthroughTerritoryAttackerHomeSectorIndex(state: GameState): number | null {
  const g = state.customMapGraph;
  if (!g || state.gameMode !== 'breakthrough') return null;
  const cpTids = new Set(Object.values(g.controlPoints).map(cp => cp.territoryId));
  const i = g.sectors.findIndex(sec => !sec.territoryIds.some(tid => cpTids.has(tid)));
  return i >= 0 ? i : null;
}

/** Breakthrough on a territory map: “home supply” follows sector layout, not the virtual grid's north/south border rows (spawn swap can leave the attacker with no hex on row 0 / ROWS−1). */
function isBreakthroughTerritoryHomeSupplyVirtualKey(state: GameState, key: string, localPlayer: Owner): boolean {
  const attHome = breakthroughTerritoryAttackerHomeSectorIndex(state);
  if (attHome === null || !state.sectorHexes?.length || !state.sectorOwners?.length) return false;
  const att = getBreakthroughAttackerOwner(state);
  const def = getBreakthroughDefenderOwner(state);
  if (localPlayer === att) return (state.sectorHexes[attHome] ?? []).includes(key);
  if (localPlayer === def) {
    for (let i = 0; i < state.sectorOwners.length; i++) {
      if (state.sectorOwners[i] === def && (state.sectorHexes[i] ?? []).includes(key)) return true;
    }
  }
  return false;
}

/** True if the player controls at least one non-mountain hex on their home row (supply from the border). */
export function hasHomeProductionAccess(state: GameState, localPlayer: Owner): boolean {
  if (state.gameMode === 'breakthrough' && state.customMapGraph && state.sectorHexes?.length) {
    const attHome = breakthroughTerritoryAttackerHomeSectorIndex(state);
    if (attHome !== null) {
      const att = getBreakthroughAttackerOwner(state);
      const def = getBreakthroughDefenderOwner(state);
      const mountains = state.mountainHexes ?? [];
      if (localPlayer === att) {
        for (const key of state.sectorHexes[attHome] ?? []) {
          if (mountains.includes(key)) continue;
          const [c, r] = key.split(',').map(Number);
          if (!isVirtualHexOnTerritory(state, c, r)) continue;
          const hex = state.hexStates[key];
          if (hex?.owner === localPlayer) return true;
        }
        return false;
      }
      if (localPlayer === def) {
        for (let i = 0; i < state.sectorOwners.length; i++) {
          if (state.sectorOwners[i] !== def) continue;
          for (const key of state.sectorHexes[i] ?? []) {
            if (mountains.includes(key)) continue;
            const [c, r] = key.split(',').map(Number);
            if (!isVirtualHexOnTerritory(state, c, r)) continue;
            const hex = state.hexStates[key];
            if (hex?.owner === localPlayer) return true;
          }
        }
        return false;
      }
    }
  }

  const homeRow = localPlayer === PLAYER ? ROWS - 1 : 0;
  const mountains = state.mountainHexes ?? [];
  for (let c = 0; c < COLS; c++) {
    if (mountains.includes(`${c},${homeRow}`)) continue;
    if (!isVirtualHexOnTerritory(state, c, homeRow)) continue;
    const key = `${c},${homeRow}`;
    const hex = state.hexStates[key];
    if (hex) {
      if (hex.owner === localPlayer) return true;
    } else if (borderRowNativeOwner(homeRow) === localPlayer) {
      // Unseeded home cell (e.g. old save): still your map edge
      return true;
    }
  }
  return false;
}

export function isValidProductionPlacement(state: GameState, col: number, row: number, localPlayer: Owner = PLAYER): boolean {
  if ((state.mountainHexes ?? []).includes(`${col},${row}`)) return false;
  if (!isVirtualHexOnTerritory(state, col, row)) return false;
  if (getUnit(state, col, row)) return false;
  if (!hasHomeProductionAccess(state, localPlayer)) return false;
  const key = `${col},${row}`;

  if (state.gameMode === 'breakthrough' && state.customMapGraph && state.sectorHexes?.length) {
    const attHome = breakthroughTerritoryAttackerHomeSectorIndex(state);
    if (attHome !== null) {
      if (isBreakthroughTerritoryHomeSupplyVirtualKey(state, key, localPlayer)) {
        const hex = state.hexStates[key];
        if (hex) return hex.owner === localPlayer;
        return false;
      }
      const hex = state.hexStates[key];
      return !!(hex && hex.isProduction && hex.owner === localPlayer);
    }
  }

  const homeRow = localPlayer === PLAYER ? ROWS - 1 : 0;
  if (row === homeRow) {
    const hex = state.hexStates[key];
    if (hex) return hex.owner === localPlayer;
    // Unseeded empty home border (legacy) — only the native side may build here
    return borderRowNativeOwner(homeRow) === localPlayer;
  }
  const hex = state.hexStates[key];
  return !!(hex && hex.isProduction && hex.owner === localPlayer);
}

/** True if there is at least one empty hex where `localPlayer` may produce (home row / owned production hex). */
export function hasAnyValidProductionPlacement(state: GameState, localPlayer: Owner): boolean {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (isValidProductionPlacement(state, c, r, localPlayer)) return true;
    }
  }
  return false;
}

export type EndProductionOptions = { skipReason?: 'no-placements' };

// Returns true if (col,row) is under ZoC from any unit belonging to `enemyOwner`
export function isInEnemyZoC(state: GameState, col: number, row: number, enemyOwner: Owner): boolean {
  if (!config.zoneOfControl) return false;
  // Must match {@link computeBaseValidMoves}: same neighbor relation as movement.
  // On polygon maps, virtual (col,row) can be geometric hex-neighbors without sharing a map border —
  // ZoC must use {@link effectiveGetNeighbors} (territory graph) so lock matches melee adjacency.
  const neighbors = effectiveGetNeighbors(col, row, COLS, ROWS);
  return neighbors.some(([nc, nr]) => {
    const u = getUnit(state, nc, nr);
    return u && u.owner === enemyOwner;
  });
}

/** Neighbors for movement, ZoC, and combat adjacency (hex grid or active territory graph). */
export function getBoardNeighbors(col: number, row: number): [number, number][] {
  return effectiveGetNeighbors(col, row, COLS, ROWS);
}

/**
 * Domination + ZoC: cannot *blitz* onto an empty opponent home-row hex — i.e. reach it in 2+ movement
 * steps in one turn — if that hex is in enemy ZoC. A single step from an adjacent hex (infantry, etc.)
 * is not blocked. Stops fast units from using multi-hex movement to the win row while skipping adjacency
 * to a defender. Moving onto an enemy on that row (melee) is still allowed.
 */
export function isOpponentHomeEntryBlocked(state: GameState, unit: Unit, destCol: number, destRow: number): boolean {
  if (_activeTerritoryGraph) return false; // territory maps use a different win condition
  if (!config.zoneOfControl || state.gameMode !== 'domination') return false;
  const enemy: Owner = unit.owner === PLAYER ? AI : PLAYER;
  const opponentHomeRow = unit.owner === PLAYER ? 0 : ROWS - 1;
  if (destRow !== opponentHomeRow) return false;
  const occupant = getUnit(state, destCol, destRow);
  if (occupant && occupant.owner === enemy) return false;
  const oneStepToDest = effectiveGetNeighbors(unit.col, unit.row, COLS, ROWS).some(
    ([c, r]) => c === destCol && r === destRow,
  );
  if (oneStepToDest) return false;
  return isInEnemyZoC(state, destCol, destRow, enemy);
}

/** True if this hex would be a legal destination except for `isOpponentHomeEntryBlocked` (for UI feedback). */
export function isHexBlockedByOpponentHomeGuardOnly(
  state: GameState,
  unit: Unit,
  destCol: number,
  destRow: number,
): boolean {
  if (!isOpponentHomeEntryBlocked(state, unit, destCol, destRow)) return false;
  return computeBaseValidMoves(state, unit).some(([c, r]) => c === destCol && r === destRow);
}

/** Base movement destinations before Domination home-row guard; supports multi-hex movement and ZoC lock. */
function computeBaseValidMoves(state: GameState, unit: Unit): [number, number][] {
  const enemy: Owner = unit.owner === PLAYER ? AI : PLAYER;
  const mountains = new Set(state.mountainHexes ?? []);
  // ZoC is checked on the SOURCE hex, not the destination.
  // If this unit is already adjacent to an enemy it is "locked":
  // it may only attack an adjacent enemy or retreat to a non-ZoC hex.
  const inZoC = isInEnemyZoC(state, unit.col, unit.row, enemy);
  const remainingMoves = unit.movement - unit.movesUsed;

  if (inZoC) {
    return effectiveGetNeighbors(unit.col, unit.row, COLS, ROWS).filter(([c, r]) => {
      if (mountains.has(`${c},${r}`)) return false;
      const occupant = getUnit(state, c, r);
      if (occupant && occupant.owner === unit.owner) return false;
      if (occupant && occupant.owner === enemy) return true;
      if (isInEnemyZoC(state, c, r, enemy)) return false;
      return true;
    });
  }

  // BFS up to remaining movement steps; enemy hexes are valid destinations but block further passage
  const visited = new Set<string>([`${unit.col},${unit.row}`]);
  const reachable = new Set<string>();
  let frontier: [number, number][] = [[unit.col, unit.row]];

  for (let step = 0; step < remainingMoves; step++) {
    const nextFrontier: [number, number][] = [];
    for (const [c, r] of frontier) {
      for (const [nc, nr] of effectiveGetNeighbors(c, r, COLS, ROWS)) {
        const key = `${nc},${nr}`;
        if (visited.has(key)) continue;
        if (mountains.has(key)) continue; // impassable
        visited.add(key);
        const occupant = getUnit(state, nc, nr);
        if (occupant && occupant.owner === unit.owner) continue; // blocked by own unit
        reachable.add(key);
        if (!occupant) nextFrontier.push([nc, nr]); // empty: can continue through
        // enemy: valid destination (attack) but can't pass through
      }
    }
    frontier = nextFrontier;
  }

  return [...reachable].map(key => {
    const [c, r] = key.split(',').map(Number);
    return [c, r] as [number, number];
  });
}

// Valid destination hexes for a unit (respects ZoC, supports multi-hex movement, Domination home guard)
export function getValidMoves(state: GameState, unit: Unit): [number, number][] {
  return computeBaseValidMoves(state, unit).filter(
    ([c, r]) => !isOpponentHomeEntryBlocked(state, unit, c, r),
  );
}

/** Empty opponent home hexes blocked by Domination home guard — use same board tint as ZoC. */
export function getOpponentHomeGuardBlockedHexes(state: GameState, unit: Unit): [number, number][] {
  return computeBaseValidMoves(state, unit).filter(([c, r]) =>
    isOpponentHomeEntryBlocked(state, unit, c, r),
  );
}

// BFS path from unit's position to (toCol,toRow), respecting movement rules (no mountains,
// no friendly units, enemy units are valid destinations but block further passage).
// Returns the full path including the start hex, or [] if unreachable.
export function getMovePath(state: GameState, unit: Unit, toCol: number, toRow: number): [number, number][] {
  if (unit.col === toCol && unit.row === toRow) return [[toCol, toRow]];
  const mountains = new Set(state.mountainHexes ?? []);
  const enemy: Owner = unit.owner === PLAYER ? AI : PLAYER;

  const predecessors = new Map<string, string | null>();
  const start = `${unit.col},${unit.row}`;
  const targetKey = `${toCol},${toRow}`;
  predecessors.set(start, null);
  let frontier: [number, number][] = [[unit.col, unit.row]];
  let found = false;

  outer: while (frontier.length > 0) {
    const next: [number, number][] = [];
    for (const [c, r] of frontier) {
      for (const [nc, nr] of effectiveGetNeighbors(c, r, COLS, ROWS)) {
        const key = `${nc},${nr}`;
        if (predecessors.has(key)) continue;
        if (mountains.has(key)) continue;
        const occupant = getUnit(state, nc, nr);
        if (occupant && occupant.owner === unit.owner) continue; // blocked by own unit
        predecessors.set(key, `${c},${r}`);
        if (key === targetKey) { found = true; break outer; }
        if (!occupant) next.push([nc, nr]); // only traverse through empty hexes
        // enemy occupant: valid destination but can't pass through — already recorded above
      }
    }
    frontier = next;
  }

  if (!found) return [];

  const path: [number, number][] = [];
  let cur: string | null = targetKey;
  while (cur !== null) {
    const [c, r] = cur.split(',').map(Number);
    path.unshift([c, r]);
    cur = predecessors.get(cur) ?? null;
  }
  return path;
}

// Move attacker along path to the hex adjacent to the defender (multi-hex attacks).
function advanceAlongPathBeforeCombat(
  state: GameState,
  unit: Unit,
  path: [number, number][],
  owner: Owner
): void {
  if (path.length < 3) return;
  for (const [pc, pr] of path.slice(1, -1)) {
    conquerHex(state, pc, pr, owner);
    unit.col = pc;
    unit.row = pr;
  }
}

// BFS distance from (fromCol,fromRow) to (toCol,toRow), ignoring units/ZoC.
// Used to count how many movement points a move actually costs (one per graph/hop step).
export function bfsDistance(state: GameState, fromCol: number, fromRow: number, toCol: number, toRow: number): number {
  const mk = getMountainKey(state);
  const a = `${fromCol},${fromRow}`;
  const b = `${toCol},${toRow}`;
  const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
  const cacheKey = `${mk}|${pair}`;
  const cached = bfsDistanceCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const mountains = new Set(state.mountainHexes ?? []);
  const visited = new Set<string>([`${fromCol},${fromRow}`]);
  let frontier: [number, number][] = [[fromCol, fromRow]];
  let dist = 0;
  while (frontier.length > 0) {
    const next: [number, number][] = [];
    for (const [c, r] of frontier) {
      if (c === toCol && r === toRow) {
        bfsDistanceCache.set(cacheKey, dist);
        maybeTrimPathCaches();
        return dist;
      }
      for (const [nc, nr] of effectiveGetNeighbors(c, r, COLS, ROWS)) {
        const key = `${nc},${nr}`;
        if (visited.has(key) || mountains.has(key)) continue;
        visited.add(key);
        next.push([nc, nr]);
      }
    }
    dist++;
    frontier = next;
  }
  bfsDistanceCache.set(cacheKey, Infinity);
  maybeTrimPathCaches();
  return Infinity;
}

/** Minimum BFS steps through passable hexes (mountains only) to any cell on the opponent's home row. */
export function minHexStepsToOpponentHomeRow(state: GameState, col: number, row: number, mover: Owner): number {
  const mk = getMountainKey(state);
  const cacheKey = `${mk}|${mover}|${col},${row}`;
  const cached = minHomeStepsCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const goalRow = mover === AI ? ROWS - 1 : 0;
  const mountains = new Set(state.mountainHexes ?? []);
  let min = Infinity;
  for (let c = 0; c < COLS; c++) {
    if (mountains.has(`${c},${goalRow}`)) continue;
    min = Math.min(min, bfsDistance(state, col, row, c, goalRow));
  }
  const out = Number.isFinite(min) ? min : 999;
  minHomeStepsCache.set(cacheKey, out);
  maybeTrimPathCaches();
  return out;
}

// ── AI helpers — Conquest (capture & defend control points) ───────────────────

function cpNotOwnedByAi(state: GameState, key: string): boolean {
  const h = state.hexStates[key];
  return !h || h.owner !== AI;
}

function minBfsToCpWhere(
  state: GameState,
  col: number,
  row: number,
  pred: (key: string) => boolean,
  /** When set (e.g. Breakthrough), use only these keys — not {@link GameState.controlPointHexes}. */
  cpKeyList?: string[] | null,
): number {
  const keys = cpKeyList != null ? cpKeyList : (state.controlPointHexes ?? []);
  let min = Infinity;
  for (const key of keys) {
    if (!pred(key)) continue;
    const [c, r] = key.split(',').map(Number);
    min = Math.min(min, bfsDistance(state, col, row, c, r));
  }
  return Number.isFinite(min) ? min : 999;
}

function minPlayerBfsToHex(state: GameState, tcol: number, trow: number): number {
  let min = Infinity;
  for (const u of state.units) {
    if (u.owner !== PLAYER) continue;
    min = Math.min(min, bfsDistance(state, u.col, u.row, tcol, trow));
  }
  return Number.isFinite(min) ? min : 999;
}

function defenderOnPlayerControlPoint(state: GameState, defender: Unit): boolean {
  if (defender.owner !== PLAYER) return false;
  const k = `${defender.col},${defender.row}`;
  return (state.controlPointHexes ?? []).includes(k);
}

/** Lower = higher priority (act earlier). */
function aiConquestUnitPriority(
  state: GameState,
  u: Unit,
  minBfsToCpWhereFn: (col: number, row: number, pred: (key: string) => boolean) => number,
  minPlayerBfsToHexFn: (tcol: number, trow: number) => number,
): number {
  const toCapture = minBfsToCpWhereFn(u.col, u.row, key => cpNotOwnedByAi(state, key));
  let defend = 999;
  for (const key of state.controlPointHexes ?? []) {
    const hx = state.hexStates[key];
    if (hx?.owner !== AI) continue;
    const [cc, cr] = key.split(',').map(Number);
    const pd = minPlayerBfsToHexFn(cc, cr);
    if (pd > 5) continue;
    const dist = bfsDistance(state, u.col, u.row, cc, cr);
    defend = Math.min(defend, dist - pd * 2.5);
  }
  return Math.min(toCapture, defend);
}

/**
 * When every active frontline control point is currently held by the AI attacker, any empty
 * move that would leave a CP without an attacker unit (cannot happen with a legal "stay").
 */
function breakthroughAttackerBreaksFullCpCoverage(
  state: GameState,
  unit: Unit,
  toCol: number,
  toRow: number,
): boolean {
  if (state.gameMode !== 'breakthrough' || getBreakthroughAttackerOwner(state) !== AI) return false;
  if (unit.owner !== AI) return false;
  const cps = breakthroughFrontlineCpKeys(state);
  if (!cps.length) return false;
  const att = getBreakthroughAttackerOwner(state);
  const allCoveredNow = cps.every(k => state.units.some(u => u.owner === att && `${u.col},${u.row}` === k));
  if (!allCoveredNow) return false;
  for (const k of cps) {
    let n = 0;
    for (const u of state.units) {
      if (u.id === unit.id) {
        if (`${toCol},${toRow}` === k) n++;
        continue;
      }
      if (u.owner !== att) continue;
      if (`${u.col},${u.row}` === k) n++;
    }
    if (n === 0) return true;
  }
  return false;
}

/** When AI is the sole unit on a frontline breakthrough CP, stepping off (empty move) is heavily penalized. */
function breakthroughLoneCpVacatePenalty(state: GameState, unit: Unit, toCol: number, toRow: number): number {
  if (state.gameMode !== 'breakthrough' || !state.sectorOwners?.length) return 0;
  if (unit.owner !== AI) return 0;
  if (toCol === unit.col && toRow === unit.row) return 0;
  const fromK = `${unit.col},${unit.row}`;
  if (!breakthroughFrontlineCpKeys(state).includes(fromK)) return 0;
  const others = state.units.filter(
    o => o.owner === AI && o.id !== unit.id && `${o.col},${o.row}` === fromK,
  );
  if (others.length > 0) return 0;
  return -2800;
}

/**
 * Breakthrough: lower = act earlier.
 * Attacker: first empty out toward unstaffed frontline CPs, then act flex units, then hold CPs.
 * Defender: last man on a CP defends; otherwise pressure toward frontline CPs and threats.
 */
function aiBreakthroughUnitPriority(
  state: GameState,
  u: Unit,
  minPlayerBfsToHexFn: (tcol: number, trow: number) => number,
): number {
  const isAiAttacker = getBreakthroughAttackerOwner(state) === AI;
  const def = getBreakthroughDefenderOwner(state);
  const active = breakthroughFrontlineCpKeys(state);
  const uk = `${u.col},${u.row}`;

  if (isAiAttacker) {
    const unstaffed = active.filter(
      k => !state.units.some(ut => ut.owner === AI && `${ut.col},${ut.row}` === k),
    );
    if (unstaffed.length) {
      let toReach = 999;
      for (const k of unstaffed) {
        const [c, r] = k.split(',').map(Number);
        toReach = Math.min(toReach, bfsDistance(state, u.col, u.row, c, r));
      }
      return toReach;
    }
    if (active.length && active.includes(uk)) {
      return 700;
    }
    return 300;
  }

  if (active.includes(uk)) {
    const n = state.units.filter(ut => ut.owner === AI && `${ut.col},${ut.row}` === uk).length;
    if (n <= 1) return 700;
  }

  const sid = breakthroughActiveFrontlineSectorIndex(state);
  if (sid !== null && state.sectorOwners[sid] === def) {
    let best = 999;
    for (const cp of state.sectorControlPointHex[sid] ?? []) {
      const [cc, cr] = cp.split(',').map(Number);
      const dist = bfsDistance(state, u.col, u.row, cc, cr);
      const pd = minPlayerBfsToHexFn(cc, cr);
      best = Math.min(best, dist - Math.min(pd, 6) * 2.5);
    }
    const thr = criticalThreatPlayerUnit(state);
    if (thr) best = Math.min(best, bfsDistance(state, u.col, u.row, thr.col, thr.row));
    return best;
  }
  const thr2 = criticalThreatPlayerUnit(state);
  if (thr2) return bfsDistance(state, u.col, u.row, thr2.col, thr2.row);
  return 999;
}

function removeUnit(state: GameState, id: number): void {
  state.units = state.units.filter(u => u.id !== id);
}

function drainConquestPointForKill(state: GameState, killedOwner: Owner): void {
  if (state.gameMode !== 'conquest' || !state.conquestPoints) return;
  state.conquestPoints[killedOwner] = Math.max(0, state.conquestPoints[killedOwner] - 1);
  log(state, `Conquest: ${killedOwner === PLAYER ? 'South' : 'North'} loses 1 CP for unit lost (now ${state.conquestPoints[killedOwner]}).`);
}

function log(state: GameState, msg: string): void {
  state.log = [msg, ...state.log.slice(0, 49)];
}

// ── Combat ────────────────────────────────────────────────────────────────────

/** Resolve config row for a unit; prefer the owner's active package when ids repeat across packages. */
export function unitTypeForUnit(unit: Unit): UnitType {
  return (
    getAvailableUnitTypes(unit.owner).find(u => u.id === unit.unitTypeId) ??
    config.unitTypes.find(u => u.id === unit.unitTypeId) ??
    config.unitTypes[0]
  );
}

/** Behavioral class of a unit type: unitClass when set, otherwise falls back to id. */
function unitClassOf(ut: UnitType): string {
  return ut.unitClass ?? ut.id;
}

/** Total upgrade stacks chosen for a unit (each level-up picks one stack). */
export function totalUnitUpgradeStacks(unit: Unit): number {
  return (
    (unit.upgradeFlanking ?? 0) +
    (unit.upgradeAttack ?? 0) +
    (unit.upgradeDefense ?? 0) +
    (unit.upgradeHeal ?? 0)
  );
}

/** Upgrade points for a unit that dealt damage in combat (attacker or defender in melee). */
function awardUpgradePointsForCombatDamage(
  dealer: Unit,
  targetHpBefore: number,
  dmgToTarget: number,
  targetDied: boolean,
): void {
  if (totalUnitUpgradeStacks(dealer) >= config.maxUnitUpgradeStacks) return;
  const hpLost = Math.min(dmgToTarget, Math.max(0, targetHpBefore));
  let gain = Math.floor(hpLost * config.upgradePointsPerDamageDealt);
  if (targetDied) gain += config.upgradePointsKillBonus;
  dealer.upgradePoints += gain;
}

// Adjacent friendlies to the defender in neighbor order (excluding the attacker's hex),
// capped to maxFlankingUnits — these provide base flanking and optional extraFlanking.
function analyzeFlanking(state: GameState, attacker: Unit, defender: Unit): {
  count: number;
  extraSum: number;
  extraFlankingFrom: { name: string; bonusPct: number }[];
} {
  const neighbors = effectiveGetNeighbors(defender.col, defender.row, COLS, ROWS);
  const flankers: Unit[] = [];
  for (const [nc, nr] of neighbors) {
    if (nc === attacker.col && nr === attacker.row) continue;
    const u = getUnit(state, nc, nr);
    if (u && u.owner === attacker.owner) flankers.push(u);
  }
  const max = config.maxFlankingUnits;
  const count = Math.min(flankers.length, max);
  const contributing = flankers.slice(0, count);
  const extraFlankingFrom: { name: string; bonusPct: number }[] = [];
  let extraSum = 0;
  for (const u of contributing) {
    const ut = unitTypeForUnit(u);
    const ex = ut.extraFlanking ?? 0;
    if (ex > 0) {
      extraSum += ex;
      extraFlankingFrom.push({ name: ut.name, bonusPct: Math.round(ex * 100) });
    }
  }
  return { count, extraSum, extraFlankingFrom };
}

/** Breakthrough: northern (defender) units in a sector already captured by the attacker fight at reduced strength. */
function breakthroughStrengthMult(state: GameState, unit: Unit): number {
  if (state.gameMode !== 'breakthrough' || !state.sectorOwners?.length) return 1;
  const sid = state.sectorIndexByHex[`${unit.col},${unit.row}`];
  if (sid === undefined) return 1;
  const att = getBreakthroughAttackerOwner(state);
  if (state.sectorOwners[sid] !== att) return 1;
  if (unit.owner === att) return 1;
  return config.breakthroughEnemySectorStrengthMult;
}

function isUnitOnRiver(state: GameState, unit: Unit): boolean {
  const hexes = state.riverHexes;
  if (!hexes?.length) return false;
  return hexes.some(rh => rh.col === unit.col && rh.row === unit.row);
}

/** Rounds effective CS to one decimal for UI and logs; combat resolution uses full precision until this step. */
function roundCombatStrengthForDisplay(cs: number): number {
  return Math.round(cs * 10) / 10;
}

function effectiveCS(
  state: GameState,
  unit: Unit,
  flankingCount: number = 0,
  extraFlankingSum: number = 0,
  combatRole: 'attacker' | 'defender' = 'defender',
  spearhead: boolean = false,
): number {
  const hpRatio = unit.hp / unit.maxHp;
  const woundedMult = 0.5 + 0.5 * hpRatio;
  const flankMult = 1 + flankingCount * config.flankingBonus + extraFlankingSum;
  const brMult = breakthroughStrengthMult(state, unit);
  let upgradeMult = 1;
  const uA = unit.upgradeAttack ?? 0;
  const uF = unit.upgradeFlanking ?? 0;
  const uD = unit.upgradeDefense ?? 0;
  if (combatRole === 'attacker') {
    upgradeMult += uA * config.upgradeBonusAttackPerStack;
    if (flankingCount > 0) {
      upgradeMult += uF * config.upgradeBonusFlankingPerStack * flankingCount;
    }
  } else {
    upgradeMult += uD * config.upgradeBonusDefensePerStack;
  }
  let cs = unit.strength * brMult * woundedMult * flankMult * upgradeMult;
  if (combatRole === 'attacker' && spearhead) {
    cs *= 1 + config.tankSpearheadAttackBonus;
  }
  if (combatRole === 'defender' && isUnitOnRiver(state, unit)) {
    cs *= 1 + config.riverDefenseBonus;
  }
  return cs;
}

/** Melee only: tank charges using full movement allowance in one approach (path steps = movement, started with no MP spent this turn). */
function tankSpearheadFromApproach(unit: Unit, stepsCost: number, movesUsedBefore: number): boolean {
  return unitClassOf(unitTypeForUnit(unit)) === 'tank' && movesUsedBefore === 0 && stepsCost === unit.movement;
}

/** True when limit-artillery mode blocks ranged fire (any enemy adjacent to this ranged unit). */
function limitArtilleryBlocksRanged(state: GameState, unit: Unit): boolean {
  if (!config.limitArtillery) return false;
  const ut = unitTypeForUnit(unit);
  if (!ut.range) return false;
  const enemy: Owner = unit.owner === PLAYER ? AI : PLAYER;
  for (const [c, r] of effectiveGetNeighbors(unit.col, unit.row, COLS, ROWS)) {
    const u = getUnit(state, c, r);
    if (u && u.owner === enemy) return true;
  }
  return false;
}

/** Ranged attack: distance 2..range for unit types that define `range`. */
function isRangedCombat(state: GameState, attacker: Unit, defender: Unit): boolean {
  const ut = unitTypeForUnit(attacker);
  if (!ut.range) return false;
  if (limitArtilleryBlocksRanged(state, attacker)) return false;
  const d = rangedCombatHexDistance(attacker.col, attacker.row, defender.col, defender.row);
  return d >= 2 && d <= ut.range;
}

/** Enemies the unit can shoot without moving (hex distance 2..range). */
export function getRangedAttackTargets(state: GameState, unit: Unit): Unit[] {
  const ut = unitTypeForUnit(unit);
  if (!ut.range || unit.movesUsed >= unit.movement) return [];
  if (limitArtilleryBlocksRanged(state, unit)) return [];
  const enemy: Owner = unit.owner === PLAYER ? AI : PLAYER;
  const out: Unit[] = [];
  for (const u of state.units) {
    if (u.owner !== enemy) continue;
    const d = rangedCombatHexDistance(unit.col, unit.row, u.col, u.row);
    if (d >= 2 && d <= ut.range) out.push(u);
  }
  return out;
}

export interface CombatResolveResult {
  ranged: boolean;
  dmgToAttacker: number;
  dmgToDefender: number;
  meleeBothSurvived: boolean;
  /** Both sides eliminated in melee (simultaneous). */
  mutualKill: boolean;
  attackerDied: boolean;
  defenderDied: boolean;
}

function resolveCombat(
  state: GameState,
  attacker: Unit,
  defender: Unit,
  opts?: { spearhead?: boolean },
): CombatResolveResult {
  const ranged = isRangedCombat(state, attacker, defender);
  const spearhead = !ranged && (opts?.spearhead ?? false);
  const { count: flanking, extraSum } = analyzeFlanking(state, attacker, defender);
  const csA = effectiveCS(state, attacker, flanking, extraSum, 'attacker', spearhead);
  const csD = effectiveCS(state, defender, 0, 0, 'defender');
  const delta = csA - csD;
  const scale = config.combatStrengthScale;
  const base  = config.combatDamageBase;

  const dmgToDefender = Math.max(1, Math.floor(base * Math.exp( delta / scale)));
  const dmgToAttacker = ranged ? 0 : Math.max(1, Math.floor(base * Math.exp(-delta / scale)));

  const flankStr = flanking > 0 ? ` (${flanking} flanker${flanking > 1 ? 's' : ''})` : '';
  const spearStr = spearhead ? ' spearhead' : '';
  const csAS = roundCombatStrengthForDisplay(csA).toFixed(1);
  const csDS = roundCombatStrengthForDisplay(csD).toFixed(1);
  if (ranged) {
    log(state, `Ranged: #${attacker.id} [${csAS}CS] vs #${defender.id} [${csDS}CS]${flankStr} → dealt ${dmgToDefender} dmg (no return fire)`);
  } else {
    log(state, `Combat: #${attacker.id} [${csAS}CS]${spearStr} vs #${defender.id} [${csDS}CS]${flankStr} → dealt ${dmgToDefender}/${dmgToAttacker} dmg`);
  }

  if (ranged) {
    const defenderHpBefore = defender.hp;
    defender.hp -= dmgToDefender;
    attacker.attackedThisTurn = true;
    defender.attackedThisTurn = true;
    const defenderDied = defender.hp <= 0;
    awardUpgradePointsForCombatDamage(attacker, defenderHpBefore, dmgToDefender, defenderDied);
    if (defenderDied) {
      log(state, `Unit #${defender.id} was destroyed.`);
      drainConquestPointForKill(state, defender.owner);
      const dc = defender.col;
      const dr = defender.row;
      const dOwner = defender.owner;
      removeUnit(state, defender.id);
      const borderOwner = ownerForEmptyBorderAfterDefenderRemoved(dr, dOwner, attacker.owner);
      if (borderOwner !== undefined && !skipRangedBorderRevertToNative(dr, dOwner, borderOwner)) {
        conquerHex(state, dc, dr, borderOwner);
      }
      noteDominationBreakthroughIfHomeRowCleared(state, dOwner, dr, attacker.owner, false);
    } else {
      log(state, `Defender has ${defender.hp} HP remaining.`);
    }
    const rangedResult: CombatResolveResult = {
      ranged: true,
      dmgToAttacker: 0,
      dmgToDefender,
      meleeBothSurvived: false,
      mutualKill: false,
      attackerDied: false,
      defenderDied,
    };
    recordCombatBattleStats(state, attacker, defender, rangedResult);
    return rangedResult;
  }

  // Melee: apply damage simultaneously
  const defenderHpBefore = defender.hp;
  const attackerHpBefore = attacker.hp;
  attacker.hp -= dmgToAttacker;
  defender.hp -= dmgToDefender;
  attacker.attackedThisTurn = true;
  defender.attackedThisTurn = true;

  const attackerDied = attacker.hp <= 0;
  const defenderDied = defender.hp <= 0;
  awardUpgradePointsForCombatDamage(attacker, defenderHpBefore, dmgToDefender, defenderDied);
  awardUpgradePointsForCombatDamage(defender, attackerHpBefore, dmgToAttacker, attackerDied);
  const mutualKill = attackerDied && defenderDied;

  if (defenderDied) {
    log(state, `Unit #${defender.id} was destroyed.`);
    drainConquestPointForKill(state, defender.owner);
    const dc = defender.col;
    const dr = defender.row;
    const dOwner = defender.owner;
    const attOwner = attacker.owner;
    removeUnit(state, defender.id);
    if (!attackerDied) {
      attacker.col = dc;
      attacker.row = dr;
      const o = ownerForEmptyBorderAfterDefenderRemoved(dr, dOwner, attOwner) ?? attOwner;
      conquerHex(state, dc, dr, o);
    }
    // Mutual kill: no survivor — do not run border "empty hex" conquest; hex ownership stays as it was
    // (matches interior mutual kills and player experience when defending home).
    noteDominationBreakthroughIfHomeRowCleared(state, dOwner, dr, attOwner, attackerDied);
  }
  if (attackerDied) {
    log(state, `Unit #${attacker.id} was destroyed.`);
    drainConquestPointForKill(state, attacker.owner);
    removeUnit(state, attacker.id);
  }
  if (!attackerDied && !defenderDied) {
    log(state, `Both units survived (${attacker.hp}/${defender.hp} HP remaining).`);
  }

  const meleeResult: CombatResolveResult = {
    ranged: false,
    dmgToAttacker,
    dmgToDefender,
    meleeBothSurvived: !attackerDied && !defenderDied,
    mutualKill,
    attackerDied,
    defenderDied,
  };
  recordCombatBattleStats(state, attacker, defender, meleeResult);
  return meleeResult;
}

/** Hex centers for damage floats (melee). Both-survive: separate tiles; all other fights: both badges on defender hex so they stack. */
function meleeDamageFloatHexes(
  atkCol: number,
  atkRow: number,
  defCol: number,
  defRow: number,
  res: CombatResolveResult,
): { atk: [number, number]; def: [number, number] } {
  if (res.meleeBothSurvived) {
    return { atk: [atkCol, atkRow], def: [defCol, defRow] };
  }
  return { atk: [defCol, defRow], def: [defCol, defRow] };
}

function combatVfxFromResolve(
  attackerId: number,
  atkCol: number,
  atkRow: number,
  defCol: number,
  defRow: number,
  res: CombatResolveResult,
  attackPath?: [number, number][],
): CombatVfxPayload {
  if (res.ranged) {
    return {
      ranged: true,
      meleeAttackerId: attackerId,
      damageFloats: [{ col: defCol, row: defRow, amount: -res.dmgToDefender }],
    };
  }
  const { atk, def: defHex } = meleeDamageFloatHexes(atkCol, atkRow, defCol, defRow, res);
  let attackerAnimAboveUnits = true;
  if (res.attackerDied && !res.defenderDied) {
    attackerAnimAboveUnits = false;
  } else if (res.defenderDied && !res.attackerDied) {
    attackerAnimAboveUnits = true;
  } else if (res.mutualKill) {
    attackerAnimAboveUnits = false;
  } else if (res.meleeBothSurvived) {
    attackerAnimAboveUnits = res.dmgToDefender > res.dmgToAttacker;
  }
  const payload: CombatVfxPayload = {
    attackerAnimAboveUnits,
    meleeAttackerId: attackerId,
    damageFloats: [
      { col: atk[0], row: atk[1], amount: -res.dmgToAttacker },
      { col: defHex[0], row: defHex[1], amount: -res.dmgToDefender },
    ],
  };
  if (res.meleeBothSurvived) {
    payload.strikeReturn = {
      attackerId,
      fromCol: atkCol,
      fromRow: atkRow,
      enemyCol: defCol,
      enemyRow: defRow,
    };
  }
  if (res.mutualKill && attackPath && attackPath.length >= 2) {
    payload.mutualKillLunge = { attackerId, pathHexes: attackPath };
  }
  return payload;
}

// ── Combat forecast (pure — no state mutation) ────────────────────────────────

function attackerUpgradeForecastLines(unit: Unit, flankingCount: number): string[] {
  const lines: string[] = [];
  const uA = unit.upgradeAttack ?? 0;
  const uF = unit.upgradeFlanking ?? 0;
  if (uA > 0) {
    lines.push(
      `Attack upgrade: +${Math.round(uA * config.upgradeBonusAttackPerStack * 100)}%`,
    );
  }
  if (uF > 0 && flankingCount > 0) {
    lines.push(
      `Flanking upgrade (×${flankingCount}): +${Math.round(uF * config.upgradeBonusFlankingPerStack * flankingCount * 100)}%`,
    );
  }
  return lines;
}

function defenderUpgradeForecastLines(unit: Unit): string[] {
  const uD = unit.upgradeDefense ?? 0;
  if (uD === 0) return [];
  return [
    `Defense upgrade: +${Math.round(uD * config.upgradeBonusDefensePerStack * 100)}%`,
  ];
}

export function forecastCombat(state: GameState, attacker: Unit, defender: Unit): CombatForecast {
  const ranged = isRangedCombat(state, attacker, defender);
  const path = getMovePath(state, attacker, defender.col, defender.row);
  const approachSteps =
    path.length > 0 ? path.length - 1 : bfsDistance(state, attacker.col, attacker.row, defender.col, defender.row);
  const attackerForFlank: Unit =
    ranged
      ? attacker
      : path.length >= 3
        ? { ...attacker, col: path[path.length - 2]![0], row: path[path.length - 2]![1] }
        : attacker;
  const spearhead =
    !ranged &&
    unitClassOf(unitTypeForUnit(attacker)) === 'tank' &&
    attacker.movesUsed === 0 &&
    approachSteps === attacker.movement;
  const { count: flanking, extraSum, extraFlankingFrom } = analyzeFlanking(state, attackerForFlank, defender);
  const csA = effectiveCS(state, attacker, flanking, extraSum, 'attacker', spearhead);
  const csD = effectiveCS(state, defender, 0, 0, 'defender');
  const delta = csA - csD;
  const scale = config.combatStrengthScale;
  const base  = config.combatDamageBase;

  const dmgToDefender = Math.max(1, Math.floor(base * Math.exp( delta / scale)));
  const dmgToAttacker = ranged ? 0 : Math.max(1, Math.floor(base * Math.exp(-delta / scale)));

  return {
    isRanged:             ranged,
    attackerCS:           roundCombatStrengthForDisplay(csA),
    defenderCS:           roundCombatStrengthForDisplay(csD),
    dmgToAttacker,
    dmgToDefender,
    attackerHpAfter:      Math.max(0, attacker.hp - dmgToAttacker),
    defenderHpAfter:      Math.max(0, defender.hp - dmgToDefender),
    attackerDies:         ranged ? false : attacker.hp - dmgToAttacker <= 0,
    defenderDies:         defender.hp - dmgToDefender <= 0,
    flankingCount:        flanking,
    flankBonusPct:        Math.round(flanking * config.flankingBonus * 100),
    extraFlankingFrom,
    attackerConditionPct: Math.round((0.5 + 0.5 * (attacker.hp / attacker.maxHp)) * 100),
    defenderConditionPct: Math.round((0.5 + 0.5 * (defender.hp / defender.maxHp)) * 100),
    breakthroughDefenderMalus:
      state.gameMode === 'breakthrough' && breakthroughStrengthMult(state, defender) < 1 ? true : undefined,
    defenderRiverDefenseBonusPct: isUnitOnRiver(state, defender)
      ? Math.round(config.riverDefenseBonus * 100)
      : undefined,
    attackerUpgradeForecastLines: attackerUpgradeForecastLines(attacker, flanking),
    defenderUpgradeForecastLines: defenderUpgradeForecastLines(defender),
    spearheadBonusPct: spearhead ? Math.round(config.tankSpearheadAttackBonus * 100) : undefined,
  };
}

/** Apply a level-up upgrade during movement (local player). */
export function playerApplyUnitUpgrade(
  state: GameState,
  unitId: number,
  kind: UnitUpgradeKind,
  localPlayer: Owner = PLAYER,
): GameState {
  if (state.phase !== 'movement' || state.activePlayer !== localPlayer) return state;
  const unit = getUnitById(state, unitId);
  if (!unit || unit.owner !== localPlayer) return state;
  const ut = unitTypeForUnit(unit);
  if (totalUnitUpgradeStacks(unit) >= config.maxUnitUpgradeStacks) return state;
  if (unit.upgradePoints < ut.upgradePointsToLevel) return state;
  unit.upgradePoints -= ut.upgradePointsToLevel;
  if (kind === 'flanking') unit.upgradeFlanking += 1;
  else if (kind === 'attack') unit.upgradeAttack += 1;
  else if (kind === 'defense') unit.upgradeDefense += 1;
  else unit.upgradeHeal += 1;
  log(state, `Unit #${unit.id} upgraded (${kind}).`);
  return state;
}

/** vs AI: spend AI unit upgrade points without a UI (greedy attack stacks). Call only when gameMode is vsAI. */
export function resolvePendingAiUpgradeChoices(state: GameState): void {
  for (const unit of state.units) {
    if (unit.owner !== AI) continue;
    const ut = unitTypeForUnit(unit);
    while (
      totalUnitUpgradeStacks(unit) < config.maxUnitUpgradeStacks &&
      unit.upgradePoints >= ut.upgradePointsToLevel
    ) {
      unit.upgradePoints -= ut.upgradePointsToLevel;
      unit.upgradeAttack += 1;
      log(state, `AI unit #${unit.id} upgraded (attack).`);
    }
  }
}

// ── Victory check ─────────────────────────────────────────────────────────────

/**
 * Domination: if this kill emptied the defender's home row and the attacker survived, record a
 * breakthrough claim (covers ranged clears without stepping onto the row). Adjacent invaders alone
 * do not count — only occupation or this combat outcome.
 */
function noteDominationBreakthroughIfHomeRowCleared(
  state: GameState,
  defenderOwner: Owner,
  defenderRow: number,
  attackerOwner: Owner,
  attackerDied: boolean,
): void {
  if (state.gameMode !== 'domination' || attackerDied) return;
  if (_activeTerritoryGraph) return; // territory maps don't use home row breakthrough
  const defenderHomeRow = defenderOwner === PLAYER ? ROWS - 1 : 0;
  if (defenderRow !== defenderHomeRow) return;
  if (state.units.some(u => u.owner === defenderOwner && u.row === defenderHomeRow)) return;
  state.dominationBreakthroughClaim = attackerOwner;
}

/** No units and no owned (non-mountain) hexes — used for Conquest map elimination. */
function sideFullyEliminated(state: GameState, owner: Owner): boolean {
  if (state.units.some(u => u.owner === owner)) return false;
  for (const hex of Object.values(state.hexStates)) {
    if (hex.owner === owner) return false;
  }
  return true;
}

function endMatch(state: GameState, winner: Owner, reason: WinReason): void {
  state.winner = winner;
  state.winReason = reason;
  const start = state.matchStartedAtMs;
  state.matchDurationMs = start != null ? Math.max(0, Date.now() - start) : 0;
}

function checkVictory(state: GameState): void {
  if (state.winner) return;

  if (state.gameMode === 'breakthrough' && state.sectorOwners && state.sectorOwners.length > 0) {
    const att = getBreakthroughAttackerOwner(state);
    const def = getBreakthroughDefenderOwner(state);
    if (!state.units.some(u => u.owner === att)) {
      endMatch(state, def, 'bt_attacker_wiped');
      log(state, 'Breakthrough: attacker eliminated — defender wins.');
      return;
    }
    if (state.sectorOwners.length > 0 && state.sectorOwners.every(o => o === att)) {
      endMatch(state, att, 'bt_all_sectors');
      log(state, 'Breakthrough: all sectors captured — attacker wins.');
      return;
    }
    return;
  }

  if (state.gameMode === 'conquest') {
    const cp = state.conquestPoints;
    if (!cp) return;

    const playerGone = sideFullyEliminated(state, PLAYER);
    const aiGone = sideFullyEliminated(state, AI);
    if (playerGone && aiGone) {
      endMatch(state, AI, 'cq_both_eliminated');
      log(state, 'Conquest: both sides wiped from the map — tie goes to the northern player.');
      return;
    }
    if (aiGone) {
      endMatch(state, PLAYER, 'cq_elimination');
      log(state, 'Conquest: opponent has no units and no territory.');
      return;
    }
    if (playerGone) {
      endMatch(state, AI, 'cq_elimination');
      log(state, 'Conquest: you have no units and no territory.');
      return;
    }

    if (cp[AI] <= 0 && cp[PLAYER] <= 0) {
      const playerHexes = Object.values(state.hexStates).filter(h => h.owner === PLAYER).length;
      const aiHexes = Object.values(state.hexStates).filter(h => h.owner === AI).length;
      if (playerHexes > aiHexes) {
        endMatch(state, PLAYER, 'cq_both_cp_depleted');
        log(state, `Both sides reached 0 Conquer Points — player wins on territory (${playerHexes} vs ${aiHexes} hexes).`);
      } else {
        endMatch(state, AI, 'cq_both_cp_depleted');
        log(state, `Both sides reached 0 Conquer Points — northern player wins on territory (${aiHexes} vs ${playerHexes} hexes).`);
      }
      return;
    }
    if (cp[AI] <= 0) endMatch(state, PLAYER, 'cq_cp_depleted');
    else if (cp[PLAYER] <= 0) endMatch(state, AI, 'cq_cp_depleted');
    return;
  }

  // Territory map domination: conquer all non-mountain territories
  if (_activeTerritoryGraph && state.gameMode === 'domination') {
    const g = _activeTerritoryGraph;
    const noAI = !state.units.some(u => u.owner === AI);
    const noHuman = !state.units.some(u => u.owner === PLAYER);
    const allPlayerOwned = g.passableTerritoryIds.every(id => {
      const t = g.territories[id];
      const hs = t ? state.hexStates[t.virtualKey] : undefined;
      return hs && hs.owner === PLAYER;
    });
    const allAiOwned = g.passableTerritoryIds.every(id => {
      const t = g.territories[id];
      const hs = t ? state.hexStates[t.virtualKey] : undefined;
      return hs && hs.owner === AI;
    });
    if (allPlayerOwned) endMatch(state, PLAYER, 'dom_annihilation');
    else if (noAI) endMatch(state, PLAYER, 'dom_annihilation');
    else if (allAiOwned) endMatch(state, AI, 'dom_annihilation');
    else if (noHuman) endMatch(state, AI, 'dom_annihilation');
    return;
  }

  const claim = state.dominationBreakthroughClaim;
  state.dominationBreakthroughClaim = undefined;

  const humanAtNorth = state.units.some(u => u.owner === PLAYER && u.row === 0);
  const aiAtSouth = state.units.some(u => u.owner === AI && u.row === ROWS - 1);
  const playerBreakthrough = humanAtNorth || claim === PLAYER;
  const aiBreakthrough = aiAtSouth || claim === AI;
  const noHuman = !state.units.some(u => u.owner === PLAYER);
  const noAI = !state.units.some(u => u.owner === AI);

  if (playerBreakthrough) endMatch(state, PLAYER, 'dom_breakthrough');
  else if (noAI) endMatch(state, PLAYER, 'dom_annihilation');
  else if (aiBreakthrough) endMatch(state, AI, 'dom_breakthrough');
  else if (noHuman) endMatch(state, AI, 'dom_annihilation');
}

/** Conquest: drain opponent Conquer Points for each control point they do not own. Runs after each side completes movement (fair timing for first/second player). */
function applyConquestDrainAfterMovement(state: GameState): void {
  if (state.gameMode !== 'conquest' || !state.conquestPoints) return;
  const cp = state.conquestPoints;
  let drainToAi = 0;
  let drainToPlayer = 0;
  for (const key of state.controlPointHexes) {
    const hex = state.hexStates[key];
    if (!hex) continue;
    if (hex.owner === PLAYER) drainToAi += 1;
    else if (hex.owner === AI) drainToPlayer += 1;
  }
  if (drainToAi > 0 || drainToPlayer > 0) {
    cp[AI] -= drainToAi;
    cp[PLAYER] -= drainToPlayer;
    log(
      state,
      `Conquer Points — South: ${cp[PLAYER]} (−${drainToPlayer}), North: ${cp[AI]} (−${drainToAi}).`,
    );
  }
  checkVictory(state);
}

/** Breakthrough: remove all sector control point markers from play once the sector is captured. */
function breakthroughRemoveSectorControlPoint(state: GameState, sectorIndex: number): void {
  const cps = state.sectorControlPointHex[sectorIndex];
  if (!cps?.length) return;
  const remove = new Set(cps);
  state.controlPointHexes = state.controlPointHexes.filter(k => !remove.has(k));
  state.sectorControlPointHex[sectorIndex] = [];
  breakthroughRefreshActiveControlPoint(state);
}

/** Breakthrough: when a sector is captured, every playable hex in it becomes attacker territory. */
function breakthroughAssignCapturedSectorHexes(state: GameState, sectorIndex: number): void {
  const keys = state.sectorHexes[sectorIndex];
  if (!keys?.length) return;
  const att = getBreakthroughAttackerOwner(state);
  const mountains = new Set(state.mountainHexes ?? []);
  for (const key of keys) {
    if (mountains.has(key)) continue;
    const existing = state.hexStates[key];
    if (existing) {
      existing.owner = att;
      existing.stableFor = 0;
      existing.isProduction = false;
    } else {
      state.hexStates[key] = { owner: att, stableFor: 0, isProduction: false };
    }
  }
}

/** Breakthrough: after a full round, advance CP occupation; capture sectors after two consecutive rounds. */
function applyBreakthroughEndOfRound(state: GameState): void {
  if (state.gameMode !== 'breakthrough') return;
  if (!state.sectorOwners?.length) return;
  // Do not use `!sectorControlPointHex?.length` — migration uses [] when missing, length 0 wrongly skips logic.
  if (!state.sectorControlPointHex || state.sectorControlPointHex.length !== state.sectorOwners.length) return;
  const att = getBreakthroughAttackerOwner(state);
  const i = breakthroughActiveFrontlineSectorIndex(state);
  if (i !== null) {
    const cps = state.sectorControlPointHex[i] ?? [];
    if (cps.length) {
      const attKeys = new Set(
        state.units.filter(u => u.owner === att).map(u => `${u.col},${u.row}`),
      );
      const allHeld = cps.every(k => attKeys.has(k));
      if (allHeld) {
        state.breakthroughCpOccupation[i] = (state.breakthroughCpOccupation[i] ?? 0) + 1;
        if (state.breakthroughCpOccupation[i] >= 2) {
          state.sectorOwners[i] = att;
          state.breakthroughCpOccupation[i] = 0;
          breakthroughAssignCapturedSectorHexes(state, i);
          breakthroughRemoveSectorControlPoint(state, i);
          const bonus = config.breakthroughSectorCaptureBonusPP;
          if (bonus > 0) {
            state.productionPoints[att] += bonus;
          }
          const cpWord = cps.length > 1 ? 'control points' : 'control point';
          log(
            state,
            bonus > 0
              ? `Breakthrough: sector ${i + 1} captured — attacker territory locked; ${cpWord} cleared. +${bonus} PP.`
              : `Breakthrough: sector ${i + 1} captured — attacker territory locked; ${cpWord} cleared.`,
          );
        }
      } else {
        state.breakthroughCpOccupation[i] = 0;
      }
    }
  }
  breakthroughRefreshActiveControlPoint(state);
  checkVictory(state);
}

// ── Healing ───────────────────────────────────────────────────────────────────

/** Positive HP amounts for floating heal badges (units that did not fight this turn). */
function healUnits(state: GameState): { col: number; row: number; amount: number }[] {
  const floats: { col: number; row: number; amount: number }[] = [];
  for (const unit of state.units) {
    if (unit.attackedThisTurn) {
      unit.attackedThisTurn = false;
      continue;
    }
    const hexState = state.hexStates[`${unit.col},${unit.row}`];
    const owner: Owner | null = hexState ? hexState.owner : null;
    const heal =
      owner === unit.owner
        ? config.healOwnTerritory + (unit.upgradeHeal ?? 0) * config.upgradeBonusHealPerStack
        : 0;
    const before = unit.hp;
    unit.hp = Math.min(unit.maxHp, unit.hp + heal);
    const gained = unit.hp - before;
    if (gained > 0) {
      floats.push({ col: unit.col, row: unit.row, amount: gained });
    }
    unit.attackedThisTurn = false;
  }
  return floats;
}

// ── Initial state ─────────────────────────────────────────────────────────────

/**
 * New match on the same territory map (skirmish / custom match from embedded map JSON).
 * Requires {@link GameState.customMapGraph} with a stored `mapDef`.
 */
export function createInitialStatePreservingTerrain(previous: GameState): GameState {
  const mapDef = previous.customMapGraph?.mapDef;
  if (!mapDef) {
    throw new Error('createInitialStatePreservingTerrain: expected customMapGraph.mapDef (territory map)');
  }
  const next = createInitialStateFromTerritoryMap(mapDef, config.gameMode as GameMode);
  if (previous.unitPackage != null) {
    next.unitPackage = previous.unitPackage;
    next.unitPackagePlayer2 = previous.unitPackagePlayer2 ?? previous.unitPackage;
  }
  return next;
}

// ── Story state ───────────────────────────────────────────────────────────────

/**
 * Creates a GameState from a story using a shipped territory map (`public/maps/<id>.json`).
 * Call {@link updateConfig} with story overrides and unit packages before this.
 */
export function createStoryState(story: StoryDef, mapDef: TerritoryMapDef): GameState {
  const base = createInitialStateFromTerritoryMap(mapDef, story.gameMode);
  if (story.gameMode === 'breakthrough') {
    return {
      ...base,
      log: ['Story mission started — Breakthrough. Your turn — Production phase.'],
    };
  }
  const ppTurnPlayer = story.productionPointsPerTurn ?? config.productionPointsPerTurn;
  const ppTurnAi = story.productionPointsPerTurnAi ?? config.productionPointsPerTurnAi;
  const playerHexCount = Object.values(base.hexStates).filter(h => h.owner === PLAYER).length;
  const aiHexCount = Object.values(base.hexStates).filter(h => h.owner === AI).length;
  return {
    ...base,
    productionPoints: {
      [PLAYER]: ppTurnPlayer + territoryBonusForHexCount(playerHexCount),
      [AI]: ppTurnAi + territoryBonusForHexCount(aiHexCount),
    },
    log: ['Story mission started. Your turn — Production phase.'],
  };
}

// ── Production ────────────────────────────────────────────────────────────────

export function playerPlaceUnit(state: GameState, col: number, row: number, unitTypeId: string, localPlayer: Owner = PLAYER): GameState {
  if (state.phase !== 'production' || state.activePlayer !== localPlayer) return state;

  if (!isValidProductionPlacement(state, col, row, localPlayer)) {
    if (!hasHomeProductionAccess(state, localPlayer)) {
      log(state, 'Cannot produce units — control at least one hex on your home border (reconquer it if the enemy took it).');
    } else {
      log(state, 'Invalid placement hex.');
    }
    return state;
  }

  const unitType =
    getAvailableUnitTypes(localPlayer).find(u => u.id === unitTypeId) ??
    config.unitTypes.find(u => u.id === unitTypeId);
  if (!unitType) return state;

  if (state.productionPoints[localPlayer] < unitType.cost) {
    log(state, `Not enough production points (need ${unitType.cost}, have ${state.productionPoints[localPlayer]}).`);
    return state;
  }

  state.productionPoints[localPlayer] -= unitType.cost;
  state.units.push(makeUnit(localPlayer, col, row, unitType.id));
  normalizeBattleStats(state)[localPlayer].unitsDeployed++;
  conquerHex(state, col, row, localPlayer);
  log(state, `Placed ${unitType.name} at (${col}, ${row}). PP: ${state.productionPoints[localPlayer]}.`);
  return state;
}

export function playerEndProduction(state: GameState, options?: EndProductionOptions): GameState {
  if (state.phase !== 'production' || state.activePlayer !== PLAYER) return state;
  if (options?.skipReason === 'no-placements') {
    log(state, 'No empty hexes for production — movement phase.');
  } else {
    log(state, 'You ended production.');
  }
  return advancePhase(state);
}

function collectAiProductionCandidates(state: GameState, occupied: Set<string>): [number, number][] {
  const candidates: [number, number][] = [];
  const mountains = state.mountainHexes ?? [];
  for (let c = 0; c < COLS; c++) {
    const key = `${c},0`;
    if (mountains.includes(key)) continue;
    if (!isVirtualHexOnTerritory(state, c, 0)) continue;
    if (occupied.has(key)) continue;
    const hex = state.hexStates[key];
    if (hex) {
      if (hex.owner === AI) candidates.push([c, 0]);
    } else {
      if (borderRowNativeOwner(0) === AI) candidates.push([c, 0]);
    }
  }
  for (const [key, hex] of Object.entries(state.hexStates)) {
    if (hex.owner === AI && hex.isProduction) {
      const [c, r] = key.split(',').map(Number);
      if (r !== 0 && !occupied.has(key)) candidates.push([c, r]);
    }
  }
  return candidates;
}

/**
 * How far the northernmost player unit has advanced toward the AI home row, as a fraction of the
 * board height (0 = south / player start row, 1 = north / AI home row). Scales with map size.
 */
function minPlayerRowProgressTowardAiHome(state: GameState): number {
  if (ROWS <= 1) return 0;
  let minRow = Infinity;
  for (const u of state.units) {
    if (u.owner !== PLAYER) continue;
    minRow = Math.min(minRow, u.row);
  }
  if (!Number.isFinite(minRow)) return 0;
  return (ROWS - 1 - minRow) / (ROWS - 1);
}

/**
 * 0 = calm, 1 = player is deep toward the AI home row. Ramps from a mode-specific threshold → 100%
 * progress. Domination uses a later threshold so the AI keeps pushing for the player's home row
 * and map control instead of turtling while the player is still mid-map.
 */
function aiDefensivePressure(state: GameState): number {
  const progress = minPlayerRowProgressTowardAiHome(state);
  const RAMP_START = state.gameMode === 'domination' ? 0.88 : 0.75;
  if (progress <= RAMP_START) return 0;
  return (progress - RAMP_START) / (1 - RAMP_START);
}

/** Player unit closest to reaching the AI home row (primary threat to stop). */
function criticalThreatPlayerUnit(state: GameState): Unit | null {
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const u of state.units) {
    if (u.owner !== PLAYER) continue;
    const d = minHexStepsToOpponentHomeRow(state, u.col, u.row, PLAYER);
    if (d < bestD || (d === bestD && best && u.row < best.row)) {
      bestD = d;
      best = u;
    }
  }
  return best;
}

function aiUnitCountsByType(state: GameState): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const u of state.units) {
    if (u.owner !== AI) continue;
    const cls = unitClassOf(unitTypeForUnit(u));
    counts[cls] = (counts[cls] ?? 0) + 1;
  }
  return counts;
}

function buildDistanceToOpponentHomeRowMap(state: GameState, mover: Owner): Map<string, number> {
  const goalRow = mover === AI ? ROWS - 1 : 0;
  const mountains = new Set(state.mountainHexes ?? []);
  const dist = new Map<string, number>();
  const q: [number, number][] = [];
  for (let c = 0; c < COLS; c++) {
    const key = `${c},${goalRow}`;
    if (mountains.has(key)) continue;
    dist.set(key, 0);
    q.push([c, goalRow]);
  }
  for (let i = 0; i < q.length; i++) {
    const [c, r] = q[i]!;
    const base = dist.get(`${c},${r}`) ?? 0;
    for (const [nc, nr] of effectiveGetNeighbors(c, r, COLS, ROWS)) {
      const nk = `${nc},${nr}`;
      if (mountains.has(nk) || dist.has(nk)) continue;
      dist.set(nk, base + 1);
      q.push([nc, nr]);
    }
  }
  return dist;
}

function scoreAiProductionPlacement(
  state: GameState,
  ut: UnitType,
  col: number,
  row: number,
  pressure: number,
  counts: Record<string, number>,
  distToGoalMap: Map<string, number>,
  occupiedByEnemy: Set<string>,
): number {
  const neighbors = effectiveGetNeighbors(col, row, COLS, ROWS);
  let adjacentEnemy = 0;
  let expandNeighbor = 0;
  for (const [nc, nr] of neighbors) {
    if (occupiedByEnemy.has(`${nc},${nr}`)) adjacentEnemy++;
    const hex = state.hexStates[`${nc},${nr}`];
    if (!hex || hex.owner === null || hex.owner !== AI) expandNeighbor++;
  }
  const distToGoal = distToGoalMap.get(`${col},${row}`) ?? 999;
  const inf = counts.infantry ?? 0;
  const tn = counts.tank ?? 0;
  const ar = counts.artillery ?? 0;
  const total = Math.max(1, inf + tn + ar);
  const domination = state.gameMode === 'domination';
  /** Domination: prioritize placements that march toward the player's home row and grab open ground. */
  const domProd = domination ? 1.28 : 1;

  // Closer to the human home row, more neutral/enemy neighbors to expand territory
  let score =
    -distToGoal * 18 * (1 - pressure * 0.72) * domProd +
    expandNeighbor * 6 * (1 - pressure * 0.55) * domProd +
    row * 5 * (1 - pressure * 0.65) * domProd;
  if (domination && adjacentEnemy > 0) score += adjacentEnemy * 9 * (1 - pressure * 0.5);
  score += pressure * (ROWS - 1 - row) * 18;
  score += pressure * adjacentEnemy * 28;

  const utClass = unitClassOf(ut);
  if (utClass === 'tank') {
    score += row * 6 * (1 - pressure * 0.55) * (domination ? 1.15 : 1);
    if (adjacentEnemy > 0) score -= 55 * (1 - pressure * 0.65) * (domination ? 0.92 : 1);
    if (tn < Math.max(1, inf * 0.25)) score += 45;
  } else if (utClass === 'artillery') {
    score += (ROWS - 1 - row) * 14;
    if (adjacentEnemy > 0) score -= 85 * (1 - pressure * 0.45);
    else score += 35;
    if (ar < Math.max(1, inf * 0.35)) score += 40;
    score += pressure * 22;
  } else {
    score += row * 4 * (1 - pressure * 0.55) * (domination ? 1.2 : 1);
    if (inf / total > 0.65) score -= domination ? 18 : 25;
  }

  if (state.productionPoints[AI] >= 60 && (utClass === 'tank' || utClass === 'artillery')) {
    score += 8;
  }

  if (state.gameMode === 'conquest' && state.conquestPoints) {
    const k = `${col},${row}`;
    const cps = state.controlPointHexes ?? [];
    if (cps.includes(k)) {
      const hx = state.hexStates[k];
      if (!hx || hx.owner !== AI) score += 280;
      else score += 85;
    } else {
      const d = minBfsToCpWhere(state, col, row, key => cpNotOwnedByAi(state, key));
      score += Math.max(0, 24 - Math.min(d, 24)) * 12;
    }
  }

  if (state.gameMode === 'breakthrough' && state.sectorOwners?.length) {
    const isAiAttacker = getBreakthroughAttackerOwner(state) === AI;
    if (isAiAttacker) {
      // Attacker needs mobile punch — tanks strongly preferred, artillery stalls the advance
      if (utClass === 'tank') {
        score += 55;
        if (tn < Math.max(1, inf * 0.6)) score += 40;
      } else if (utClass === 'artillery') {
        score -= 80;
      }
    } else {
      // Defender holds the line — reinforce existing artillery/infantry preference
      if (utClass === 'artillery') score += 20;
    }
  }

  return score;
}

export function aiProduction(state: GameState): GameState {
  const tStart = performance.now();
  if (state.gameMode === 'breakthrough' && state.sectorOwners?.length) {
    breakthroughRefreshActiveControlPoint(state);
  }
  let placed = 0;
  const pressure = aiDefensivePressure(state);
  const distToGoalMap = buildDistanceToOpponentHomeRowMap(state, AI);
  const hasHomeAccess = hasHomeProductionAccess(state, AI);
  while (true) {
    const affordable = getAvailableUnitTypes(AI).filter(t => state.productionPoints[AI] >= t.cost);
    if (affordable.length === 0) {
      if (placed === 0) log(state, 'AI: not enough production points.');
      break;
    }

    if (!hasHomeAccess) {
      if (placed === 0) log(state, 'AI: cannot produce — no home border hex controlled.');
      break;
    }

    const occupiedByAny = new Set<string>(state.units.map(u => `${u.col},${u.row}`));
    const occupiedByEnemy = new Set<string>(
      state.units.filter(u => u.owner === PLAYER).map(u => `${u.col},${u.row}`),
    );
    const candidates = collectAiProductionCandidates(state, occupiedByAny);
    if (candidates.length === 0) {
      if (placed === 0) log(state, 'AI: no space to place a unit.');
      break;
    }
    const counts = aiUnitCountsByType(state);

    let best: { ut: UnitType; col: number; row: number; score: number } | null = null;
    for (const ut of affordable) {
      for (const [col, row] of candidates) {
        const score = scoreAiProductionPlacement(
          state,
          ut,
          col,
          row,
          pressure,
          counts,
          distToGoalMap,
          occupiedByEnemy,
        );
        if (
          !best ||
          score > best.score ||
          (score === best.score && ut.cost < best.ut.cost)
        ) {
          best = { ut, col, row, score };
        }
      }
    }

    if (!best) break;

    state.productionPoints[AI] -= best.ut.cost;
    state.units.push(makeUnit(AI, best.col, best.row, best.ut.id));
    normalizeBattleStats(state)[AI].unitsDeployed++;
    conquerHex(state, best.col, best.row, AI);
    log(state, `AI placed ${best.ut.name} at (${best.col}, ${best.row}). PP: ${state.productionPoints[AI]}.`);
    placed++;
  }

  perfLog('ai.production.total', performance.now() - tStart);
  return state;
}

// ── Movement ──────────────────────────────────────────────────────────────────

export function playerSelectUnit(state: GameState, col: number, row: number, localPlayer: Owner = PLAYER): GameState {
  if (state.phase !== 'movement' || state.activePlayer !== localPlayer) return state;
  const unit = getUnit(state, col, row);
  if (!unit || unit.owner !== localPlayer) {
    state.selectedUnit = null;
    return state;
  }
  if (unit.movesUsed >= unit.movement) {
    log(state, `Unit #${unit.id} has no movement left this turn.`);
    return state;
  }
  state.selectedUnit = unit.id;
  log(state, `Selected unit #${unit.id} at (${col}, ${row}).`);
  return state;
}

/**
 * Whether the board should show pointer-hover emphasis (e.g. chromatic halo) on this unit.
 * Mirrors click affordances: movable friendlies, inspectable / attack-relevant enemies in movement.
 */
export function unitShowsBoardPointerHover(
  state: GameState,
  unit: Unit,
  localPlayer: Owner,
  matchIsVsHuman: boolean,
): boolean {
  if (state.winner) return false;

  const enemyOwner: Owner = localPlayer === PLAYER ? AI : PLAYER;

  if (
    matchIsVsHuman &&
    state.activePlayer !== localPlayer &&
    (state.phase === 'movement' || state.phase === 'production')
  ) {
    return unit.owner === enemyOwner;
  }

  if (state.activePlayer !== localPlayer || state.phase !== 'movement') return false;

  if (unit.owner === localPlayer) {
    return unit.movesUsed < unit.movement;
  }

  if (unit.owner !== enemyOwner) return false;

  if (state.selectedUnit === null) return true;
  const sel = getUnitById(state, state.selectedUnit);
  if (!sel) return false;
  if (sel.owner === enemyOwner) return true;
  if (sel.owner === localPlayer) return true;
  return false;
}

export function playerMoveUnit(
  state: GameState,
  col: number,
  row: number,
  localPlayer: Owner = PLAYER,
): { state: GameState; combatVfx: CombatVfxPayload | null } {
  const enemy: Owner = localPlayer === PLAYER ? AI : PLAYER;
  if (state.phase !== 'movement' || state.activePlayer !== localPlayer) return { state, combatVfx: null };
  if (state.selectedUnit === null) return { state, combatVfx: null };

  const unit = getUnitById(state, state.selectedUnit);
  if (!unit) { state.selectedUnit = null; return { state, combatVfx: null }; }

  const validMoves = getValidMoves(state, unit);
  if (!validMoves.some(([c, r]) => c === col && r === row)) {
    const occupant = getUnit(state, col, row);
    if (occupant && occupant.owner !== localPlayer) {
      log(state, 'Cannot attack: enemy is outside movement range or blocked by ZoC.');
    } else if (isHexBlockedByOpponentHomeGuardOnly(state, unit, col, row)) {
      log(state, 'Blitz not allowed — you cannot blitz to the enemy border when an enemy unit is adjacent.');
    } else {
      log(state, 'Invalid move: blocked by Zone of Control or not adjacent.');
    }
    return { state, combatVfx: null };
  }

  const target = getUnit(state, col, row);
  if (target && target.owner === localPlayer) {
    log(state, 'Cannot move onto your own unit.');
    return { state, combatVfx: null };
  }

  const path = getMovePath(state, unit, col, row);
  const stepsCost = path.length > 0 ? path.length - 1 : bfsDistance(state, unit.col, unit.row, col, row);
  const movesBefore = unit.movesUsed;
  unit.movesUsed += stepsCost;
  state.selectedUnit = null;

  if (target && target.owner === enemy) {
    // Combat exhausts remaining movement
    unit.movesUsed = unit.movement;
    const spearhead = tankSpearheadFromApproach(unit, stepsCost, movesBefore);
    const attackerId = unit.id;
    advanceAlongPathBeforeCombat(state, unit, path, localPlayer);
    const atkCol = unit.col;
    const atkRow = unit.row;
    const res = resolveCombat(state, unit, target, { spearhead });
    checkVictory(state);
    return {
      state,
      combatVfx: combatVfxFromResolve(attackerId, atkCol, atkRow, col, row, res, path),
    };
  }

  // Conquer every neutral/enemy hex along the path (intermediate steps)
  for (const [pc, pr] of path.slice(1)) {
    conquerHex(state, pc, pr, localPlayer);
  }
  unit.col = col;
  unit.row = row;
  log(state, `Moved unit #${unit.id} to (${col}, ${row}).`);
  // Keep the unit selected if it still has movement left
  if (unit.movesUsed < unit.movement) {
    state.selectedUnit = unit.id;
  }

  checkVictory(state);
  return { state, combatVfx: null };
}

export function playerRangedAttack(
  state: GameState,
  col: number,
  row: number,
  localPlayer: Owner = PLAYER,
): { state: GameState; combatVfx: CombatVfxPayload | null } {
  const enemy: Owner = localPlayer === PLAYER ? AI : PLAYER;
  if (state.phase !== 'movement' || state.activePlayer !== localPlayer) return { state, combatVfx: null };
  if (state.selectedUnit === null) return { state, combatVfx: null };

  const unit = getUnitById(state, state.selectedUnit);
  if (!unit) { state.selectedUnit = null; return { state, combatVfx: null }; }

  const target = getUnit(state, col, row);
  if (!target || target.owner !== enemy) {
    log(state, 'No enemy at that hex.');
    return { state, combatVfx: null };
  }

  const rangedOk = getRangedAttackTargets(state, unit).some(t => t.id === target.id);
  if (!rangedOk) {
    log(state, 'Target is out of ranged attack range.');
    return { state, combatVfx: null };
  }

  unit.movesUsed = unit.movement;
  state.selectedUnit = null;
  const attackerId = unit.id;
  const atkCol = unit.col;
  const atkRow = unit.row;
  const res = resolveCombat(state, unit, target);
  checkVictory(state);
  return {
    state,
    combatVfx: combatVfxFromResolve(attackerId, atkCol, atkRow, col, row, res),
  };
}

export function playerEndMovement(state: GameState): GameState {
  if (state.phase !== 'movement' || state.activePlayer !== PLAYER) return state;
  log(state, 'You ended your movement.');
  return advancePhase(state);
}

// ── vsHuman phase transitions ─────────────────────────────────────────────────

// Advance from production to movement without running AI production.
export function vsHumanEndProduction(state: GameState, localPlayer: Owner, options?: EndProductionOptions): GameState {
  if (state.phase !== 'production' || state.activePlayer !== localPlayer) return state;
  if (options?.skipReason === 'no-placements') {
    log(state, 'No empty hexes for production — movement phase.');
  } else {
    log(state, 'You ended production.');
  }
  state.phase = 'movement';
  state.units.forEach(u => { if (u.owner === localPlayer) u.movesUsed = 0; });
  log(state, `Turn ${state.turn} — Movement phase. Click a unit then a hex.`);
  return state;
}

// End movement and pass the turn to the opponent.
export function vsHumanEndMovement(state: GameState, localPlayer: Owner): GameState {
  if (state.phase !== 'movement' || state.activePlayer !== localPlayer) return state;
  const other: Owner = localPlayer === PLAYER ? AI : PLAYER;
  log(state, 'You ended your movement.');
  state.phase = 'production';
  state.activePlayer = other;
  state.selectedUnit = null;
  state.units.forEach(u => { if (u.owner === localPlayer) u.movesUsed = 0; });
  applyConquestDrainAfterMovement(state);
  return state;
}

// Update the unit ID counter after receiving a state from the opponent.
export function syncUnitIdCounter(state: GameState): void {
  const maxId = state.units.reduce((m, u) => Math.max(m, u.id), -1);
  if (maxId >= unitIdCounter) unitIdCounter = maxId + 1;
}

const AI_MOVE_TYPE_ORDER: Record<string, number> = { artillery: 0, tank: 1, infantry: 2 };

function pickBestRangedTarget(
  state: GameState,
  attacker: Unit,
  targets: Unit[],
  pressure: number,
  minHomeStepsFn: (col: number, row: number, mover: Owner) => number,
): Unit {
  let best = targets[0]!;
  let bestScore = -Infinity;
  for (const t of targets) {
    const fc = forecastCombat(state, attacker, t);
    let s = 0;
    if (fc.defenderDies) s += 520;
    else s += fc.dmgToDefender * 3;
    const threatSteps = minHomeStepsFn(t.col, t.row, PLAYER);
    s += pressure * (8 - Math.min(threatSteps, 8)) * 42;
    // Frontline enemies (further south) matter more when not in a defensive crisis
    s += t.row * 22 * (1 - pressure * 0.85);
    const distGoal = minHomeStepsFn(t.col, t.row, AI);
    s -= distGoal * 2 * (1 - pressure * 0.7);
    if (state.gameMode === 'domination') {
      s += t.row * 12 * (1 - pressure * 0.55);
    }
    if (state.gameMode === 'conquest' && state.conquestPoints) {
      const k = `${t.col},${t.row}`;
      if ((state.controlPointHexes ?? []).includes(k)) s += 220;
    }
    if (state.gameMode === 'breakthrough' && state.sectorOwners?.length) {
      const k = `${t.col},${t.row}`;
      if (breakthroughFrontlineCpKeys(state).includes(k)) s += 210;
    }
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  return best;
}

function scoreMeleeAttack(
  state: GameState,
  attacker: Unit,
  defender: Unit,
  pressure: number,
  minHomeStepsFn: (col: number, row: number, mover: Owner) => number,
): number {
  const fc = forecastCombat(state, attacker, defender);
  let s = 0;
  if (fc.defenderDies && !fc.attackerDies) s += 480;
  else if (fc.defenderDies && fc.attackerDies) s += 120;
  else s += fc.dmgToDefender * 2 - fc.dmgToAttacker * 2.2;
  const threatSteps = minHomeStepsFn(defender.col, defender.row, PLAYER);
  s += pressure * (8 - Math.min(threatSteps, 8)) * 38;
  s += defender.row * 18 * (1 - pressure * 0.65);
  s += pressure * (ROWS - 1 - defender.row) * 20;
  if (fc.defenderDies && !fc.attackerDies) {
    const afterGoal = minHomeStepsFn(defender.col, defender.row, AI);
    s -= afterGoal * 8 * (1 - pressure * 0.5);
  }
  const favorable =
    fc.defenderDies ||
    (!fc.attackerDies && fc.dmgToDefender > fc.dmgToAttacker + 1);
  const unfavorablePenalty = state.gameMode === 'domination' ? 68 : 85;
  if (!favorable) s -= unfavorablePenalty * (1 - pressure * 0.35);
  if (state.gameMode === 'domination' && fc.defenderDies && !fc.attackerDies) {
    s += 42;
  }
  if (state.gameMode === 'conquest' && state.conquestPoints && defenderOnPlayerControlPoint(state, defender)) {
    s += 190;
  }
  if (state.gameMode === 'breakthrough' && state.sectorOwners?.length) {
    const dk = `${defender.col},${defender.row}`;
    if (breakthroughFrontlineCpKeys(state).includes(dk)) {
      const defOw = getBreakthroughDefenderOwner(state);
      const sid = state.sectorIndexByHex[dk];
      if (sid !== undefined && state.sectorOwners[sid] === defOw) s += 175;
    }
  }
  return s;
}

function scoreEmptyMove(
  state: GameState,
  unit: Unit,
  toCol: number,
  toRow: number,
  stepsCost: number,
  pressure: number,
  threat: Unit | null,
  minHomeStepsFn: (col: number, row: number, mover: Owner) => number,
  minBfsToCpWhereFn: (col: number, row: number, pred: (key: string) => boolean) => number,
  minPlayerBfsToHexFn: (tcol: number, trow: number) => number,
  bfsFn: (fromCol: number, fromRow: number, toCol: number, toRow: number) => number,
): number {
  if (unit.movesUsed + stepsCost > unit.movement) return -Infinity;
  if (state.gameMode === 'breakthrough' && breakthroughAttackerBreaksFullCpCoverage(state, unit, toCol, toRow)) {
    return -1_000_000_000;
  }
  const before = minHomeStepsFn(unit.col, unit.row, AI);
  const after = minHomeStepsFn(toCol, toRow, AI);
  let s = (before - after) * 28 * (1 - pressure * 0.82);
  const hex = state.hexStates[`${toCol},${toRow}`];
  const terr = !hex || hex.owner !== AI ? 14 : 0;
  s += terr * (1 - pressure * 0.55);
  s += toRow * 1.5 * (1 - pressure * 0.65);
  s += pressure * (ROWS - 1 - toRow) * 10;
  if (state.gameMode === 'domination') {
    s += (before - after) * 11;
    s += terr * 3.2 * (1 - pressure * 0.5);
    if (hex && hex.owner === PLAYER) s += 22 * (1 - pressure * 0.45);
  }
  if (threat && pressure > 0) {
    const beforeT = bfsFn(unit.col, unit.row, threat.col, threat.row);
    const afterT = bfsFn(toCol, toRow, threat.col, threat.row);
    s += (beforeT - afterT) * 52 * pressure;
  }
  if (state.gameMode === 'conquest' && state.conquestPoints) {
    const beforeC = minBfsToCpWhereFn(unit.col, unit.row, key => cpNotOwnedByAi(state, key));
    const afterC = minBfsToCpWhereFn(toCol, toRow, key => cpNotOwnedByAi(state, key));
    s += (beforeC - afterC) * 44;
    const tk = `${toCol},${toRow}`;
    if ((state.controlPointHexes ?? []).includes(tk)) {
      const hx = state.hexStates[tk];
      if (!hx || hx.owner !== AI) s += 260;
    }
    for (const key of state.controlPointHexes ?? []) {
      const hx = state.hexStates[key];
      if (hx?.owner !== AI) continue;
      const [cc, cr] = key.split(',').map(Number);
      const pd = minPlayerBfsToHexFn(cc, cr);
      if (pd > 5) continue;
      const distBefore = bfsFn(unit.col, unit.row, cc, cr);
      const distAfter = bfsFn(toCol, toRow, cc, cr);
      s += (distBefore - distAfter) * (28 + (6 - Math.min(pd, 6)) * 12);
    }
  }
  if (state.gameMode === 'breakthrough' && state.sectorOwners?.length) {
    const defOw = getBreakthroughDefenderOwner(state);
    const isAiAttacker = getBreakthroughAttackerOwner(state) === AI;
    const cpKeys = breakthroughFrontlineCpKeys(state);
    const cpApproachMult = isAiAttacker ? 1.8 : 1.0;
    const beforeC = minBfsToCpWhereFn(unit.col, unit.row, key => {
      const sid = state.sectorIndexByHex[key];
      return sid !== undefined && state.sectorOwners[sid] === defOw;
    });
    const afterC = minBfsToCpWhereFn(toCol, toRow, key => {
      const sid = state.sectorIndexByHex[key];
      return sid !== undefined && state.sectorOwners[sid] === defOw;
    });
    s += (beforeC - afterC) * 40 * cpApproachMult;
    if (isAiAttacker) {
      const allCpsStaffed = cpKeys.length
        ? cpKeys.every(k => state.units.some(ut => ut.owner === AI && `${ut.col},${ut.row}` === k))
        : true;
      const uk = `${unit.col},${unit.row}`;
      const holdStance = allCpsStaffed && cpKeys.includes(uk);
      if (!holdStance) {
        s += (before - after) * 16;
      }
    }
    const tk = `${toCol},${toRow}`;
    if (cpKeys.includes(tk)) {
      const sid = state.sectorIndexByHex[tk];
      if (sid !== undefined && state.sectorOwners[sid] === defOw) {
        const hx = state.hexStates[tk];
        if (!hx || hx.owner !== defOw) s += isAiAttacker ? 340 : 240;
      }
    }
    s += breakthroughLoneCpVacatePenalty(state, unit, toCol, toRow);
  }
  return s;
}

/** Full unit copies for AI anim replay (positions + HP). */
function snapshotUnits(st: GameState): Unit[] {
  return st.units.map(u => ({ ...u }));
}

/** Territory map for AI anim replay (hex fills match the board before each step). */
function snapshotHexStates(st: GameState): Record<string, HexState> {
  const out: Record<string, HexState> = {};
  for (const [k, h] of Object.entries(st.hexStates)) {
    out[k] = { ...h };
  }
  return out;
}

/** AI replay: one unit at a hex (game state keeps attacker on start hex until resolve for path length 2). */
function withUnitAtHex(units: Unit[], unitId: number, col: number, row: number): Unit[] {
  return units.map(u => (u.id === unitId ? { ...u, col, row } : u));
}

export function aiMovement(state: GameState): {
  state: GameState;
  combatVfx: CombatVfxPayload[];
  /** Ordered steps for AI turn animation (one move or combat at a time). */
  animSteps: AiAnimStep[];
  /** Board state immediately before each step (same length as animSteps). */
  animUnitsBefore: Unit[][];
  /** `hexStates` immediately before each step — for replay territory paint (same length as animSteps). */
  animHexStatesBefore: Record<string, HexState>[];
  /** Board state immediately after each step (same length as animSteps). */
  animUnitsAfter: Unit[][];
} {
  const tStart = performance.now();
  const combatVfx: CombatVfxPayload[] = [];
  const animSteps: AiAnimStep[] = [];
  const animUnitsBefore: Unit[][] = [];
  const animHexStatesBefore: Record<string, HexState>[] = [];
  const animUnitsAfter: Unit[][] = [];
  if (state.gameMode === 'breakthrough' && state.sectorOwners?.length) {
    breakthroughRefreshActiveControlPoint(state);
  }
  const breakthroughObjectiveCps: string[] | null =
    state.gameMode === 'breakthrough' && state.sectorOwners?.length
      ? breakthroughFrontlineCpKeys(state)
      : null;
  const pressure = aiDefensivePressure(state);
  const threat = criticalThreatPlayerUnit(state);
  const localBfsCache = new Map<string, number>();
  const localMinHomeCache = new Map<string, number>();
  const localMinCpCache = new Map<string, number>();
  const localMinPlayerHexCache = new Map<string, number>();
  const bfsFn = (fromCol: number, fromRow: number, toCol: number, toRow: number): number => {
    const k = `${fromCol},${fromRow}|${toCol},${toRow}`;
    const v = localBfsCache.get(k);
    if (v !== undefined) return v;
    const d = bfsDistance(state, fromCol, fromRow, toCol, toRow);
    localBfsCache.set(k, d);
    return d;
  };
  const minHomeStepsFn = (col: number, row: number, mover: Owner): number => {
    const k = `${mover}|${col},${row}`;
    const v = localMinHomeCache.get(k);
    if (v !== undefined) return v;
    const d = minHexStepsToOpponentHomeRow(state, col, row, mover);
    localMinHomeCache.set(k, d);
    return d;
  };
  const minBfsToCpWhereFn = (col: number, row: number, pred: (key: string) => boolean): number => {
    const keyList = breakthroughObjectiveCps;
    const cpKeySig = (keyList ?? (state.controlPointHexes ?? [])).filter(pred).join('|');
    const k = `${col},${row}|${cpKeySig}`;
    const v = localMinCpCache.get(k);
    if (v !== undefined) return v;
    const d = minBfsToCpWhere(state, col, row, pred, keyList);
    localMinCpCache.set(k, d);
    return d;
  };
  const minPlayerBfsToHexFn = (tcol: number, trow: number): number => {
    const k = `${tcol},${trow}`;
    const v = localMinPlayerHexCache.get(k);
    if (v !== undefined) return v;
    const d = minPlayerBfsToHex(state, tcol, trow);
    localMinPlayerHexCache.set(k, d);
    return d;
  };
  const aiUnits = state.units.filter(u => u.owner === AI).sort((a, b) => {
    if (state.gameMode === 'conquest' && state.conquestPoints) {
      const pa = aiConquestUnitPriority(state, a, minBfsToCpWhereFn, minPlayerBfsToHexFn);
      const pb = aiConquestUnitPriority(state, b, minBfsToCpWhereFn, minPlayerBfsToHexFn);
      if (pa !== pb) return pa - pb;
    }
    if (state.gameMode === 'breakthrough' && state.sectorOwners?.length) {
      const pa = aiBreakthroughUnitPriority(state, a, minPlayerBfsToHexFn);
      const pb = aiBreakthroughUnitPriority(state, b, minPlayerBfsToHexFn);
      if (pa !== pb) return pa - pb;
    }
    if (pressure > 0.12 && threat) {
      const da = bfsFn(a.col, a.row, threat.col, threat.row);
      const db = bfsFn(b.col, b.row, threat.col, threat.row);
      if (da !== db) return da - db;
    }
    const oa = AI_MOVE_TYPE_ORDER[unitClassOf(unitTypeForUnit(a))] ?? 9;
    const ob = AI_MOVE_TYPE_ORDER[unitClassOf(unitTypeForUnit(b))] ?? 9;
    if (oa !== ob) return oa - ob;
    return b.row - a.row;
  });

  for (const unit of aiUnits) {
    if (state.winner) break;
    if (!state.units.some(u => u.owner === PLAYER)) break;

    while (unit.movesUsed < unit.movement && !state.winner) {
      const rangedTargets = getRangedAttackTargets(state, unit);
      if (rangedTargets.length > 0) {
        const target = pickBestRangedTarget(state, unit, rangedTargets, pressure, minHomeStepsFn);
        unit.movesUsed = unit.movement;
        const attackerId = unit.id;
        const atkCol = unit.col;
        const atkRow = unit.row;
        const defCol = target.col;
        const defRow = target.row;
        animUnitsBefore.push(snapshotUnits(state));
        animHexStatesBefore.push(snapshotHexStates(state));
        const res = resolveCombat(state, unit, target);
        const vfx = combatVfxFromResolve(attackerId, atkCol, atkRow, defCol, defRow, res);
        combatVfx.push(vfx);
        animSteps.push({ type: 'combat', vfx });
        animUnitsAfter.push(snapshotUnits(state));
        checkVictory(state);
        break;
      }

      const validMoves = getValidMoves(state, unit);
      if (validMoves.length === 0) break;

      type BestAct =
        | { kind: 'attack'; col: number; row: number; score: number }
        | { kind: 'move'; col: number; row: number; score: number; stepsCost: number };

      let best: BestAct | null = null;

      for (const [nc, nr] of validMoves) {
        const occupant = getUnit(state, nc, nr);
        if (occupant && occupant.owner === PLAYER) {
          const s = scoreMeleeAttack(state, unit, occupant, pressure, minHomeStepsFn);
          if (!best || s > best.score) best = { kind: 'attack', col: nc, row: nr, score: s };
        } else {
          const path = getMovePath(state, unit, nc, nr);
          const stepsCost = path.length > 0 ? path.length - 1 : 0;
          const s = scoreEmptyMove(
            state,
            unit,
            nc,
            nr,
            stepsCost,
            pressure,
            threat,
            minHomeStepsFn,
            minBfsToCpWhereFn,
            minPlayerBfsToHexFn,
            bfsFn,
          );
          if (s === -Infinity) continue;
          if (!best || s > best.score) best = { kind: 'move', col: nc, row: nr, score: s, stepsCost };
        }
      }

      if (!best) break;

      if (best.kind === 'attack') {
        const target = getUnit(state, best.col, best.row);
        if (!target || target.owner !== PLAYER) break;
        const path = getMovePath(state, unit, best.col, best.row);
        const stepsCost = path.length > 0 ? path.length - 1 : bfsDistance(state, unit.col, unit.row, best.col, best.row);
        const movesBefore = unit.movesUsed;
        const spearhead = tankSpearheadFromApproach(unit, stepsCost, movesBefore);
        unit.movesUsed = unit.movement;
        const attackerId = unit.id;
        const unitBeforeMelee = { ...unit } as Unit;
        const unitsBeforeApproach = snapshotUnits(state);
        const hexBeforeApproach = snapshotHexStates(state);

        advanceAlongPathBeforeCombat(state, unit, path, AI);
        const atkCol = unit.col;
        const atkRow = unit.row;
        const beforeResolveUnits = snapshotUnits(state);
        const hexAfterApproachBeforeResolve = snapshotHexStates(state);

        const res = resolveCombat(state, unit, target, { spearhead });
        const vfx = combatVfxFromResolve(attackerId, atkCol, atkRow, best.col, best.row, res, path);
        combatVfx.push(vfx);

        const hasMk =
          vfx.mutualKillLunge && vfx.mutualKillLunge.pathHexes.length >= 2;
        if (hasMk) {
          const p = vfx.mutualKillLunge!.pathHexes;
          const s = p[0]!;
          const e = p[p.length - 1]!;
          animUnitsBefore.push(unitsBeforeApproach);
          animHexStatesBefore.push(hexBeforeApproach);
          animSteps.push({
            type: 'move',
            anim: {
              unit: unitBeforeMelee,
              fromCol: s[0],
              fromRow: s[1],
              toCol: e[0],
              toRow: e[1],
              pathHexes: p,
            },
          });
          animUnitsAfter.push(snapshotUnits(state));
        }

        // Approach without strike (e.g. AI loses unit): animate along the attack path. Human player
        // uses needsApproach = from !== to; that includes path.length === 2 (one step into combat), not
        // only path.length >= 3. For longer paths, advanceAlongPath stops adjacent — animate
        // path.slice(0, -1); for a single step, animate the full path onto the defender hex.
        const needsApproachAnim =
          !hasMk && !res.meleeBothSurvived && path.length >= 2;
        /** Pre-damage board for floats: for a one-hex attack, state still has the attacker on the start hex, but the move anim ends on the defender hex — match that so units do not snap back before disappearing (same idea as human: token ends on the fight hex). */
        const boardBeforeMeleeFloats =
          !hasMk && path.length === 2 && !res.meleeBothSurvived
            ? withUnitAtHex(beforeResolveUnits, attackerId, path[1]![0], path[1]![1])
            : beforeResolveUnits;

        if (needsApproachAnim) {
          const approachHexes =
            path.length >= 3
              ? (path.slice(0, -1) as [number, number][])
              : path;
          const from = approachHexes[0]!;
          const to = approachHexes[approachHexes.length - 1]!;
          animUnitsBefore.push(unitsBeforeApproach);
          animHexStatesBefore.push(hexBeforeApproach);
          animSteps.push({
            type: 'move',
            anim: {
              unit: unitBeforeMelee,
              fromCol: from[0],
              fromRow: from[1],
              toCol: to[0],
              toRow: to[1],
              pathHexes: approachHexes.length >= 2 ? approachHexes : undefined,
            },
          });
          animUnitsAfter.push(
            path.length === 2 ? boardBeforeMeleeFloats : beforeResolveUnits,
          );
        }

        // Combat floats / strike: mutual-kill path shows empty board before floats; else pre-damage for strike.
        animUnitsBefore.push(hasMk ? snapshotUnits(state) : boardBeforeMeleeFloats);
        animHexStatesBefore.push(hasMk ? snapshotHexStates(state) : hexAfterApproachBeforeResolve);
        animSteps.push({ type: 'combat', vfx });
        animUnitsAfter.push(snapshotUnits(state));
        checkVictory(state);
        break;
      }

      const path = getMovePath(state, unit, best.col, best.row);
      const stepsCost = path.length > 0 ? path.length - 1 : 0;
      if (unit.movesUsed + stepsCost > unit.movement) break;
      const fromCol = unit.col;
      const fromRow = unit.row;
      const unitSnap = { ...unit } as Unit;
      animUnitsBefore.push(snapshotUnits(state));
      animHexStatesBefore.push(snapshotHexStates(state));
      unit.movesUsed += stepsCost;
      for (const [pc, pr] of path.slice(1)) {
        conquerHex(state, pc, pr, AI);
      }
      unit.col = best.col;
      unit.row = best.row;
      animSteps.push({
        type: 'move',
        anim: {
          unit: unitSnap,
          fromCol,
          fromRow,
          toCol: best.col,
          toRow: best.row,
          pathHexes: path.length >= 2 ? path : undefined,
        },
      });
      animUnitsAfter.push(snapshotUnits(state));
      checkVictory(state);
    }
  }
  checkVictory(state);
  log(state, 'AI completed movement.');
  perfLog('ai.movement.total', performance.now() - tStart);
  return { state, combatVfx, animSteps, animUnitsBefore, animHexStatesBefore, animUnitsAfter };
}

// ── Phase advancement ─────────────────────────────────────────────────────────

// Prepares the AI turn: logs end-of-movement and resets AI moved flags.
// Call this before running aiMovement separately (used by the animation path).
// Clears selectedUnit: activePlayer stays PLAYER until endTurnAfterAi, but the renderer
// must not keep movement/ranged highlights during AI resolution.
export function prepareAiTurn(state: GameState): GameState {
  if (state.phase !== 'movement' || state.activePlayer !== PLAYER) return state;
  log(state, 'You ended your movement.');
  state.selectedUnit = null;
  // Clear exhaustion from the human's movement so pieces render at full opacity during AI play; AI counters also reset before aiMovement.
  state.units.forEach(u => { u.movesUsed = 0; });
  applyConquestDrainAfterMovement(state);
  return state;
}

// Runs end-of-turn housekeeping after AI movement: heal, stability, turn counter, PP.
// Call this after aiMovement has already been applied (used by the animation path).
// In vs human, the guest already applied conquest drain in {@link vsHumanEndMovement}; pass skipConquestDrain when merging that state on the host.
export function endTurnAfterAi(
  state: GameState,
  options?: { skipConquestDrain?: boolean },
): { state: GameState; healFloats: { col: number; row: number; amount: number }[] } {
  const healFloats = healUnits(state);
  updateHexStability(state);
  state.units.forEach(u => { u.movesUsed = 0; });
  state.turn += 1;
  state.phase = 'production';
  state.activePlayer = PLAYER;
  state.selectedUnit = null;
  const playerHexes = Object.values(state.hexStates).filter(h => h.owner === PLAYER).length;
  const aiHexes     = Object.values(state.hexStates).filter(h => h.owner === AI).length;
  const playerBonus = territoryBonusForHexCount(playerHexes);
  const aiBonus     = territoryBonusForHexCount(aiHexes);
  if (state.gameMode === 'breakthrough') {
    const att = getBreakthroughAttackerOwner(state);
    const def = getBreakthroughDefenderOwner(state);
    const defHexes = Object.values(state.hexStates).filter(h => h.owner === def).length;
    const defBonus = territoryBonusForHexCount(defHexes);
    const defBasePP = def === AI ? config.productionPointsPerTurnAi : config.productionPointsPerTurn;
    state.productionPoints[def] += defBasePP + defBonus;
    log(
      state,
      `Turn ${state.turn} — Production phase. Attacker PP: ${state.productionPoints[att]} (no income). Defender: ${state.productionPoints[def]} PP (+${defBonus} territory).`,
    );
  } else {
    state.productionPoints[PLAYER] += config.productionPointsPerTurn + playerBonus;
    state.productionPoints[AI]     += config.productionPointsPerTurnAi + aiBonus;
    log(state, `Turn ${state.turn} — Production phase. PP: ${state.productionPoints[PLAYER]} (+${playerBonus} from territory).`);
  }
  if (!options?.skipConquestDrain) applyConquestDrainAfterMovement(state);
  if (state.gameMode === 'breakthrough') applyBreakthroughEndOfRound(state);
  return { state, healFloats };
}

export function advancePhase(state: GameState): GameState {
  if (state.winner) return state;

  if (state.phase === 'production') {
    if (state.activePlayer === PLAYER) {
      state = aiProduction(state);
      state.phase = 'movement';
      state.activePlayer = PLAYER;
      state.units.forEach(u => { if (u.owner === PLAYER) u.movesUsed = 0; });
      log(state, `Turn ${state.turn} — Movement phase. Click a unit then a hex.`);
    }
  } else if (state.phase === 'movement') {
    if (state.activePlayer === PLAYER) {
      state = prepareAiTurn(state);
      if (state.winner) return state;
      state = aiMovement(state).state;
      if (state.winner) return state;
      state = endTurnAfterAi(state).state;
    }
  }

  return state;
}

// ── Territory map initial state ───────────────────────────────────────────────

function buildTerritoryState(
  graph: TerritoryGraphData,
  units: Unit[],
  hexStates: Record<string, HexState>,
  mountainHexes: string[],
  gameMode: GameMode,
  opts: {
    controlPointHexes: string[];
    conquestPoints: Record<Owner, number> | null;
    sectorOwners: Owner[];
    sectorHexes: string[][];
    sectorIndexByHex: Record<string, number>;
    sectorControlPointHex: string[][];
    breakthroughCpOccupation: number[];
    breakthroughAttackerOwner: Owner | undefined;
    productionPoints: Record<Owner, number>;
  },
): GameState {
  const pkgs = snapshotActiveUnitPackagesForSave();
  return {
    units,
    hexStates,
    mountainHexes,
    riverHexes: [],
    boardCols: graph.virtualCols,
    boardRows: graph.virtualRows,
    gameMode,
    unitPackage: pkgs.unitPackage,
    unitPackagePlayer2: pkgs.unitPackagePlayer2,
    controlPointHexes: opts.controlPointHexes,
    conquestPoints: opts.conquestPoints,
    sectorHexes: opts.sectorHexes,
    sectorOwners: opts.sectorOwners,
    sectorControlPointHex: opts.sectorControlPointHex,
    breakthroughCpOccupation: opts.breakthroughCpOccupation,
    sectorIndexByHex: opts.sectorIndexByHex,
    breakthroughAttackerOwner: opts.breakthroughAttackerOwner,
    turn: 1,
    phase: 'production' as const,
    activePlayer: PLAYER,
    selectedUnit: null,
    productionPoints: opts.productionPoints,
    log: ['Game started. Your turn — Production phase.'],
    winner: null,
    matchStartedAtMs: Date.now(),
    battleStats: initBattleStatsFromUnits(units),
    customMapGraph: graph,
  };
}

export function createInitialStateFromTerritoryMap(mapDef: TerritoryMapDef, gameMode: GameMode): GameState {
  const graph = buildTerritoryGraph(mapDef);
  setActiveTerritoryGraph(graph);
  updateConfig({ boardCols: graph.virtualCols, boardRows: graph.virtualRows });
  syncDimensions();
  unitIdCounter = 0;

  const mountainHexes = graph.mountainTerritoryIds.map(id => graph.territories[id]!.virtualKey);

  const hexStates: Record<string, HexState> = {};

  /** Sector index with no CP (attacker home sector). */
  let attackerSectorIdxForBreakthrough = -1;
  if (gameMode === 'breakthrough') {
    const cpTids = new Set(Object.values(graph.controlPoints).map(cp => cp.territoryId));
    attackerSectorIdxForBreakthrough = graph.sectors.findIndex(sec => !sec.territoryIds.some(tid => cpTids.has(tid)));
  }

  const desiredBreakthroughAttacker: Owner | undefined =
    gameMode === 'breakthrough'
      ? (
          config.breakthroughRandomRoles
            ? (Math.random() < 0.5 ? PLAYER : AI)
            : config.breakthroughPlayer1Role === 'attacker'
              ? PLAYER
              : AI
        )
      : undefined;

  let units: Unit[];
  if (gameMode === 'breakthrough' && desiredBreakthroughAttacker !== undefined) {
    const attackerOwner = desiredBreakthroughAttacker;
    const defenderOwner = attackerOwner === PLAYER ? AI : PLAYER;
    const { attackerHomeIds, defenderHomeIds } = computeBreakthroughTerritoryRoleHomes(graph);

    const attSlots =
      attackerHomeIds.length === 0
        ? []
        : spreadHomeTerritorySlotIndices(config.startingUnitsAttacker, attackerHomeIds.length);
    const defSlots =
      defenderHomeIds.length === 0
        ? []
        : spreadHomeTerritorySlotIndices(config.startingUnitsDefender, defenderHomeIds.length);

    units = [
      ...attSlots.map(si => {
        const id = attackerHomeIds[si]!;
        const t = graph.territories[id]!;
        return makeUnit(attackerOwner, t.virtualCol, t.virtualRow);
      }),
      ...defSlots.map(si => {
        const id = defenderHomeIds[si]!;
        const t = graph.territories[id]!;
        return makeUnit(defenderOwner, t.virtualCol, t.virtualRow);
      }),
    ];
  } else {
    const sortedPlayerTids = sortTerritoryIdsByVirtualPosition(graph, graph.playerHomeTerritoryIds);
    const sortedAiTids = sortTerritoryIdsByVirtualPosition(graph, graph.aiHomeTerritoryIds);
    const playerSlotIndices = spreadHomeTerritorySlotIndices(config.startingUnitsPlayer1, sortedPlayerTids.length);
    const aiSlotIndices = spreadHomeTerritorySlotIndices(config.startingUnitsPlayer2, sortedAiTids.length);
    units = [
      ...playerSlotIndices.map(slotIdx => {
        const id = sortedPlayerTids[slotIdx]!;
        const t = graph.territories[id]!;
        return makeUnit(PLAYER, t.virtualCol, t.virtualRow);
      }),
      ...aiSlotIndices.map(slotIdx => {
        const id = sortedAiTids[slotIdx]!;
        const t = graph.territories[id]!;
        return makeUnit(AI, t.virtualCol, t.virtualRow);
      }),
    ];
  }

  if (gameMode === 'breakthrough') {
    const attackerSectorIdx = attackerSectorIdxForBreakthrough >= 0 ? attackerSectorIdxForBreakthrough : 0;
    const attackerOwner: Owner = desiredBreakthroughAttacker!;
    const defenderOwner: Owner = attackerOwner === AI ? PLAYER : AI;

    const sectorOwners: Owner[] = graph.sectors.map((_, i) => i === attackerSectorIdx ? attackerOwner : defenderOwner);
    let sectorHexes = graph.sectors.map(sec =>
      sec.territoryIds
        .map(id => graph.territories[id])
        .filter(t => t && t.state !== 'mountain' && t.state !== 'offmap')
        .map(t => t!.virtualKey),
    );
    sectorHexes = expandBreakthroughSectorHexesForTerritoryMap(graph, sectorHexes, attackerSectorIdx);
    const sectorIndexByHex: Record<string, number> = {};
    sectorHexes.forEach((hexes, i) => { for (const k of hexes) sectorIndexByHex[k] = i; });

    // All territories owned by their sector's owner
    for (let s = 0; s < graph.sectors.length; s++) {
      const owner = sectorOwners[s]!;
      for (const k of sectorHexes[s]!) hexStates[k] = { owner, stableFor: 0, isProduction: false };
    }

    // Sector CPs from JSON (attacker sector has none; a sector may list multiple CP territories)
    const sectorControlPointHex = graph.sectors.map((sec, i) => {
      if (i === attackerSectorIdx) return [];
      const keys: string[] = [];
      for (const cp of Object.values(graph.controlPoints)) {
        if (!sec.territoryIds.includes(cp.territoryId)) continue;
        const t = graph.territories[cp.territoryId];
        if (t) keys.push(t.virtualKey);
      }
      keys.sort();
      return keys;
    });

    primeInitialBreakthroughProductionHexes(hexStates, mountainHexes);

    const nSec = graph.sectors.length;
    const frontlineIdx =
      attackerOwner === PLAYER
        ? sectorOwners.findIndex(o => o !== attackerOwner)
        : (() => {
            for (let i = nSec - 1; i >= 0; i--) {
              if (sectorOwners[i] !== attackerOwner) return i;
            }
            return -1;
          })();
    const frontCps = frontlineIdx >= 0 ? sectorControlPointHex[frontlineIdx] ?? [] : [];
    const controlPointHexes = frontCps.length ? [...frontCps] : [];

    const defHexCount = Object.values(hexStates).filter(h => h.owner === defenderOwner).length;
    const defBonus = territoryBonusForHexCount(defHexCount);
    const defBasePP = defenderOwner === AI ? config.productionPointsPerTurnAi : config.productionPointsPerTurn;
    const defPP = defBasePP + defBonus;
    const pp: Record<Owner, number> = { 1: 0, 2: 0 };
    pp[attackerOwner] = config.breakthroughAttackerStartingPP;
    pp[defenderOwner] = defPP;

    return buildTerritoryState(graph, units, hexStates, mountainHexes, gameMode, {
      controlPointHexes,
      conquestPoints: null,
      sectorOwners,
      sectorHexes,
      sectorIndexByHex,
      sectorControlPointHex,
      breakthroughCpOccupation: graph.sectors.map(() => 0),
      breakthroughAttackerOwner: attackerOwner,
      productionPoints: pp,
    });

  } else {
    // Domination or Conquest: allied=player, enemy=AI, neutral=unowned
    for (const id of graph.playerHomeTerritoryIds) {
      const t = graph.territories[id]!;
      hexStates[t.virtualKey] = { owner: PLAYER, stableFor: 0, isProduction: false };
    }
    for (const id of graph.aiHomeTerritoryIds) {
      const t = graph.territories[id]!;
      hexStates[t.virtualKey] = { owner: AI, stableFor: 0, isProduction: false };
    }

    const controlPointHexes = gameMode === 'conquest'
      ? Object.values(graph.controlPoints)
          .map(cp => graph.territories[cp.territoryId]?.virtualKey)
          .filter(Boolean) as string[]
      : [];
    const conquestPoints = gameMode === 'conquest'
      ? ({ [PLAYER]: config.conquestPointsPlayer, [AI]: config.conquestPointsAi } as Record<Owner, number>)
      : null;

    return buildTerritoryState(graph, units, hexStates, mountainHexes, gameMode, {
      controlPointHexes,
      conquestPoints,
      sectorOwners: [],
      sectorHexes: [],
      sectorIndexByHex: {},
      sectorControlPointHex: [],
      breakthroughCpOccupation: [],
      breakthroughAttackerOwner: undefined,
      productionPoints: { [PLAYER]: config.productionPointsPerTurn, [AI]: config.productionPointsPerTurnAi } as Record<Owner, number>,
    });
  }
}
