import { getNeighbors, hexDistance } from './hex';
import config, { getAvailableUnitTypes } from './gameconfig';
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
} from './types';

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

function makeUnit(owner: Owner, col: number, row: number, unitTypeId = 'infantry'): Unit {
  const unitType = config.unitTypes.find(u => u.id === unitTypeId) ?? config.unitTypes[0];
  return {
    id: unitIdCounter++,
    owner,
    unitTypeId,
    col,
    row,
    movesUsed: 0,
    attackedThisTurn: false,
    hp: unitType.maxHp,
    maxHp: unitType.maxHp,
    strength: unitType.strength,
    movement: unitType.movement,
  };
}

// Spread n columns evenly across the board width
function spreadCols(n: number, cols: number): number[] {
  if (n === 1) return [Math.floor(cols / 2)];
  return Array.from({ length: n }, (_, i) =>
    Math.round((cols - 1) * i / (n - 1))
  );
}

/** Conquest: place control points with north/south balance and spacing (not clustered). */
function pickControlPointHexes(cpCandidates: string[], want: number, cols: number, rows: number): string[] {
  if (want <= 0 || cpCandidates.length === 0) return [];
  const n = Math.min(want, cpCandidates.length);

  const parseKey = (key: string): { col: number; row: number } => {
    const [col, row] = key.split(',').map(Number);
    return { col, row };
  };

  function shuffleInPlace<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  const minDistToPicked = (col: number, row: number, picked: { col: number; row: number }[]): number => {
    if (picked.length === 0) return Infinity;
    let m = Infinity;
    for (const p of picked) {
      const d = hexDistance(col, row, p.col, p.row, cols, rows);
      if (d < m) m = d;
    }
    return m;
  };

  const pickGreedySpread = (pool: string[], k: number): string[] => {
    if (k <= 0 || pool.length === 0) return [];
    const poolCopy = [...pool];
    shuffleInPlace(poolCopy);
    const picked: { col: number; row: number }[] = [];
    const result: string[] = [];
    while (result.length < k && poolCopy.length > 0) {
      let bestIdx = -1;
      let bestScore = -1;
      for (let i = 0; i < poolCopy.length; i++) {
        const { col, row } = parseKey(poolCopy[i]);
        const md = minDistToPicked(col, row, picked);
        if (md > bestScore) {
          bestScore = md;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      const key = poolCopy.splice(bestIdx, 1)[0];
      const { col, row } = parseKey(key);
      picked.push({ col, row });
      result.push(key);
    }
    return result;
  };

  const rMin = 1;
  const rMax = rows - 2;
  if (rMax < rMin) {
    const copy = [...cpCandidates];
    shuffleInPlace(copy);
    return copy.slice(0, n);
  }

  // Single CP: interior vertical band ~45–55% of playable rows (map center).
  if (n === 1) {
    const span = rMax - rMin;
    if (span <= 0) {
      const copy = [...cpCandidates];
      shuffleInPlace(copy);
      return [copy[0]];
    }
    const band = cpCandidates.filter(k => {
      const { row } = parseKey(k);
      const tr = (row - rMin) / span;
      return tr >= 0.45 && tr <= 0.55;
    });
    if (band.length > 0) {
      shuffleInPlace(band);
      return [band[0]];
    }
    let bestKey = cpCandidates[0];
    let bestD = Infinity;
    for (const key of cpCandidates) {
      const { row } = parseKey(key);
      const tr = (row - rMin) / span;
      const d = Math.abs(tr - 0.5);
      if (d < bestD) {
        bestD = d;
        bestKey = key;
      }
    }
    return [bestKey];
  }

  // Multiple CPs: split playable rows into north / south halves; assign counts evenly (odd: random extra side).
  const northMax = rMin + Math.floor((rMax - rMin) / 2);
  const northPool = cpCandidates.filter(k => parseKey(k).row <= northMax);
  const southPool = cpCandidates.filter(k => parseKey(k).row > northMax);

  let northGets = Math.ceil(n / 2);
  let southGets = n - northGets;
  if (Math.random() < 0.5) [northGets, southGets] = [southGets, northGets];

  const takeNorth = Math.min(northGets, northPool.length);
  const takeSouth = Math.min(southGets, southPool.length);
  let chosen = [...pickGreedySpread(northPool, takeNorth), ...pickGreedySpread(southPool, takeSouth)];

  const shortfall = n - chosen.length;
  if (shortfall > 0) {
    const chosenSet = new Set(chosen);
    const rest = cpCandidates.filter(k => !chosenSet.has(k));
    chosen = chosen.concat(pickGreedySpread(rest, shortfall));
  }

  return chosen.slice(0, n);
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
function breakthroughActiveFrontlineSectorIndex(state: GameState): number | null {
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

/** Breakthrough: only show the current frontline control point. */
function breakthroughRefreshActiveControlPoint(state: GameState): void {
  if (state.gameMode !== 'breakthrough') return;
  const sid = breakthroughActiveFrontlineSectorIndex(state);
  if (sid === null) {
    state.controlPointHexes = [];
    return;
  }
  const cp = state.sectorControlPointHex[sid];
  state.controlPointHexes = cp ? [cp] : [];
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

/** True if the player controls at least one non-mountain hex on their home row (supply from the border). */
export function hasHomeProductionAccess(state: GameState, localPlayer: Owner): boolean {
  const homeRow = localPlayer === PLAYER ? ROWS - 1 : 0;
  const mountains = state.mountainHexes ?? [];
  for (let c = 0; c < COLS; c++) {
    if (mountains.includes(`${c},${homeRow}`)) continue;
    const hex = state.hexStates[`${c},${homeRow}`];
    if (hex && hex.owner === localPlayer) return true;
  }
  return false;
}

export function isValidProductionPlacement(state: GameState, col: number, row: number, localPlayer: Owner = PLAYER): boolean {
  if ((state.mountainHexes ?? []).includes(`${col},${row}`)) return false;
  if (getUnit(state, col, row)) return false;
  if (!hasHomeProductionAccess(state, localPlayer)) return false;
  const homeRow = localPlayer === PLAYER ? ROWS - 1 : 0;
  const enemy: Owner = localPlayer === PLAYER ? AI : PLAYER;
  if (row === homeRow) {
    const hex = state.hexStates[`${col},${row}`];
    if (hex && hex.owner === enemy) return false;
    return true;
  }
  const hex = state.hexStates[`${col},${row}`];
  return !!(hex && hex.isProduction && hex.owner === localPlayer);
}

// Returns true if (col,row) is under ZoC from any unit belonging to `enemyOwner`
export function isInEnemyZoC(state: GameState, col: number, row: number, enemyOwner: Owner): boolean {
  if (!config.zoneOfControl) return false;
  const neighbors = getNeighbors(col, row, COLS, ROWS);
  return neighbors.some(([nc, nr]) => {
    const u = getUnit(state, nc, nr);
    return u && u.owner === enemyOwner;
  });
}

// Valid destination hexes for a unit (respects ZoC, supports multi-hex movement)
export function getValidMoves(state: GameState, unit: Unit): [number, number][] {
  const enemy: Owner = unit.owner === PLAYER ? AI : PLAYER;
  const mountains = new Set(state.mountainHexes ?? []);
  // ZoC is checked on the SOURCE hex, not the destination.
  // If this unit is already adjacent to an enemy it is "locked":
  // it may only attack an adjacent enemy or retreat to a non-ZoC hex.
  const inZoC = isInEnemyZoC(state, unit.col, unit.row, enemy);

  if (inZoC) {
    return getNeighbors(unit.col, unit.row, COLS, ROWS).filter(([c, r]) => {
      if (mountains.has(`${c},${r}`)) return false;
      const occupant = getUnit(state, c, r);
      if (occupant && occupant.owner === unit.owner) return false;
      if (occupant && occupant.owner === enemy) return true;
      if (isInEnemyZoC(state, c, r, enemy)) return false;
      return true;
    });
  }

  // BFS up to remaining movement steps; enemy hexes are valid destinations but block further passage
  const remainingMoves = unit.movement - unit.movesUsed;
  const visited = new Set<string>([`${unit.col},${unit.row}`]);
  const reachable = new Set<string>();
  let frontier: [number, number][] = [[unit.col, unit.row]];

  for (let step = 0; step < remainingMoves; step++) {
    const nextFrontier: [number, number][] = [];
    for (const [c, r] of frontier) {
      for (const [nc, nr] of getNeighbors(c, r, COLS, ROWS)) {
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
      for (const [nc, nr] of getNeighbors(c, r, COLS, ROWS)) {
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

  // Reconstruct path from target back to start
  const path: [number, number][] = [];
  let cur: string | null = targetKey;
  while (cur !== null) {
    const [c, r] = cur.split(',').map(Number);
    path.unshift([c, r]);
    cur = predecessors.get(cur) ?? null;
  }
  return path; // first element is the unit's start hex, last is the target
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
// Used to count how many movement points a move actually costs.
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
      for (const [nc, nr] of getNeighbors(c, r, COLS, ROWS)) {
        const key = `${nc},${nr}`;
        if (visited.has(key) || mountains.has(key)) continue;
        visited.add(key);
        next.push([nc, nr]);
      }
    }
    dist++;
    frontier = next;
  }
  bfsDistanceCache.set(cacheKey, dist);
  maybeTrimPathCaches();
  return dist;
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
): number {
  let min = Infinity;
  for (const key of state.controlPointHexes ?? []) {
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

/** Breakthrough: lower = act earlier — defend CPs in sectors still owned by the defender, then react to threats. */
function aiBreakthroughUnitPriority(
  state: GameState,
  u: Unit,
  minPlayerBfsToHexFn: (tcol: number, trow: number) => number,
): number {
  const def = getBreakthroughDefenderOwner(state);
  let best = 999;
  const sid = breakthroughActiveFrontlineSectorIndex(state);
  if (sid !== null && state.sectorOwners[sid] === def) {
    const cp = state.sectorControlPointHex[sid];
    if (cp) {
      const [cc, cr] = cp.split(',').map(Number);
      const dist = bfsDistance(state, u.col, u.row, cc, cr);
      const pd = minPlayerBfsToHexFn(cc, cr);
      best = Math.min(best, dist - Math.min(pd, 6) * 2.5);
    }
  }
  const thr = criticalThreatPlayerUnit(state);
  if (thr) best = Math.min(best, bfsDistance(state, u.col, u.row, thr.col, thr.row));
  return best;
}

function removeUnit(state: GameState, id: number): void {
  state.units = state.units.filter(u => u.id !== id);
}

function log(state: GameState, msg: string): void {
  state.log = [msg, ...state.log.slice(0, 49)];
}

// ── Combat ────────────────────────────────────────────────────────────────────

function unitTypeForUnit(unit: Unit): UnitType {
  return config.unitTypes.find(u => u.id === unit.unitTypeId) ?? config.unitTypes[0];
}

// Adjacent friendlies to the defender in neighbor order (excluding the attacker's hex),
// capped to maxFlankingUnits — these provide base flanking and optional extraFlanking.
function analyzeFlanking(state: GameState, attacker: Unit, defender: Unit): {
  count: number;
  extraSum: number;
  extraFlankingFrom: { name: string; bonusPct: number }[];
} {
  const neighbors = getNeighbors(defender.col, defender.row, COLS, ROWS);
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

function effectiveCS(
  state: GameState,
  unit: Unit,
  flankingCount: number = 0,
  extraFlankingSum: number = 0,
): number {
  const hpRatio = unit.hp / unit.maxHp;
  const woundedMult = 0.5 + 0.5 * hpRatio;
  const flankMult = 1 + flankingCount * config.flankingBonus + extraFlankingSum;
  const brMult = breakthroughStrengthMult(state, unit);
  return unit.strength * brMult * woundedMult * flankMult;
}

/** True when limit-artillery mode blocks ranged fire (any enemy adjacent to this ranged unit). */
function limitArtilleryBlocksRanged(state: GameState, unit: Unit): boolean {
  if (!config.limitArtillery) return false;
  const ut = unitTypeForUnit(unit);
  if (!ut.range) return false;
  const enemy: Owner = unit.owner === PLAYER ? AI : PLAYER;
  for (const [c, r] of getNeighbors(unit.col, unit.row, COLS, ROWS)) {
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
  const d = hexDistance(attacker.col, attacker.row, defender.col, defender.row, COLS, ROWS);
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
    const d = hexDistance(unit.col, unit.row, u.col, u.row, COLS, ROWS);
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

function resolveCombat(state: GameState, attacker: Unit, defender: Unit): CombatResolveResult {
  const ranged = isRangedCombat(state, attacker, defender);
  const { count: flanking, extraSum } = analyzeFlanking(state, attacker, defender);
  const csA = effectiveCS(state, attacker, flanking, extraSum);
  const csD = effectiveCS(state, defender, 0);
  const delta = csA - csD;
  const scale = config.combatStrengthScale;
  const base  = config.combatDamageBase;

  const dmgToDefender = Math.max(1, Math.floor(base * Math.exp( delta / scale)));
  const dmgToAttacker = ranged ? 0 : Math.max(1, Math.floor(base * Math.exp(-delta / scale)));

  const flankStr = flanking > 0 ? ` (${flanking} flanker${flanking > 1 ? 's' : ''})` : '';
  if (ranged) {
    log(state, `Ranged: #${attacker.id} [${Math.round(csA)}CS] vs #${defender.id} [${Math.round(csD)}CS]${flankStr} → dealt ${dmgToDefender} dmg (no return fire)`);
  } else {
    log(state, `Combat: #${attacker.id} [${Math.round(csA)}CS] vs #${defender.id} [${Math.round(csD)}CS]${flankStr} → dealt ${dmgToDefender}/${dmgToAttacker} dmg`);
  }

  if (ranged) {
    defender.hp -= dmgToDefender;
    attacker.attackedThisTurn = true;
    defender.attackedThisTurn = true;
    const defenderDied = defender.hp <= 0;
    if (defenderDied) {
      log(state, `Unit #${defender.id} was destroyed.`);
      removeUnit(state, defender.id);
    } else {
      log(state, `Defender has ${defender.hp} HP remaining.`);
    }
    return {
      ranged: true,
      dmgToAttacker: 0,
      dmgToDefender,
      meleeBothSurvived: false,
      mutualKill: false,
      attackerDied: false,
      defenderDied,
    };
  }

  // Melee: apply damage simultaneously
  attacker.hp -= dmgToAttacker;
  defender.hp -= dmgToDefender;
  attacker.attackedThisTurn = true;
  defender.attackedThisTurn = true;

  const attackerDied = attacker.hp <= 0;
  const defenderDied = defender.hp <= 0;
  const mutualKill = attackerDied && defenderDied;

  if (defenderDied) {
    log(state, `Unit #${defender.id} was destroyed.`);
    removeUnit(state, defender.id);
    if (!attackerDied) {
      attacker.col = defender.col;
      attacker.row = defender.row;
      conquerHex(state, attacker.col, attacker.row, attacker.owner);
    }
  }
  if (attackerDied) {
    log(state, `Unit #${attacker.id} was destroyed.`);
    removeUnit(state, attacker.id);
  }
  if (!attackerDied && !defenderDied) {
    log(state, `Both units survived (${attacker.hp}/${defender.hp} HP remaining).`);
  }

  return {
    ranged: false,
    dmgToAttacker,
    dmgToDefender,
    meleeBothSurvived: !attackerDied && !defenderDied,
    mutualKill,
    attackerDied,
    defenderDied,
  };
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
      damageFloats: [{ col: defCol, row: defRow, amount: -res.dmgToDefender }],
    };
  }
  const { atk, def: defHex } = meleeDamageFloatHexes(atkCol, atkRow, defCol, defRow, res);
  const payload: CombatVfxPayload = {
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

export function forecastCombat(state: GameState, attacker: Unit, defender: Unit): CombatForecast {
  const ranged = isRangedCombat(state, attacker, defender);
  const { count: flanking, extraSum, extraFlankingFrom } = analyzeFlanking(state, attacker, defender);
  const csA = effectiveCS(state, attacker, flanking, extraSum);
  const csD = effectiveCS(state, defender, 0);
  const delta = csA - csD;
  const scale = config.combatStrengthScale;
  const base  = config.combatDamageBase;

  const dmgToDefender = Math.max(1, Math.floor(base * Math.exp( delta / scale)));
  const dmgToAttacker = ranged ? 0 : Math.max(1, Math.floor(base * Math.exp(-delta / scale)));

  return {
    isRanged:             ranged,
    attackerCS:           Math.round(csA),
    defenderCS:           Math.round(csD),
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
  };
}

// ── Victory check ─────────────────────────────────────────────────────────────

/** No units and no owned (non-mountain) hexes — used for Conquest map elimination. */
function sideFullyEliminated(state: GameState, owner: Owner): boolean {
  if (state.units.some(u => u.owner === owner)) return false;
  for (const hex of Object.values(state.hexStates)) {
    if (hex.owner === owner) return false;
  }
  return true;
}

function checkVictory(state: GameState): void {
  if (state.winner) return;

  if (state.gameMode === 'breakthrough' && state.sectorOwners && state.sectorOwners.length > 0) {
    const att = getBreakthroughAttackerOwner(state);
    const def = getBreakthroughDefenderOwner(state);
    if (!state.units.some(u => u.owner === att)) {
      state.winner = def;
      log(state, 'Breakthrough: attacker eliminated — defender wins.');
      return;
    }
    if (state.sectorOwners.length > 0 && state.sectorOwners.every(o => o === att)) {
      state.winner = att;
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
      state.winner = AI;
      log(state, 'Conquest: both sides wiped from the map — tie goes to the northern player.');
      return;
    }
    if (aiGone) {
      state.winner = PLAYER;
      log(state, 'Conquest: opponent has no units and no territory.');
      return;
    }
    if (playerGone) {
      state.winner = AI;
      log(state, 'Conquest: you have no units and no territory.');
      return;
    }

    if (cp[AI] <= 0 && cp[PLAYER] <= 0) {
      const playerHexes = Object.values(state.hexStates).filter(h => h.owner === PLAYER).length;
      const aiHexes = Object.values(state.hexStates).filter(h => h.owner === AI).length;
      if (playerHexes > aiHexes) {
        state.winner = PLAYER;
        log(state, `Both sides reached 0 Conquer Points — player wins on territory (${playerHexes} vs ${aiHexes} hexes).`);
      } else {
        state.winner = AI;
        log(state, `Both sides reached 0 Conquer Points — northern player wins on territory (${aiHexes} vs ${playerHexes} hexes).`);
      }
      return;
    }
    if (cp[AI] <= 0) state.winner = PLAYER;
    else if (cp[PLAYER] <= 0) state.winner = AI;
    return;
  }

  const humanAtNorth = state.units.some(u => u.owner === PLAYER && u.row === 0);
  const aiAtSouth    = state.units.some(u => u.owner === AI && u.row === ROWS - 1);
  const noHuman      = !state.units.some(u => u.owner === PLAYER);
  const noAI         = !state.units.some(u => u.owner === AI);

  if (humanAtNorth || noAI) state.winner = PLAYER;
  else if (aiAtSouth || noHuman) state.winner = AI;
}

/** Conquest: drain opponent Conquer Points for each control point they do not own. */
function applyConquestEndOfRound(state: GameState): void {
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

/** Breakthrough: remove the sector control point marker from play once the sector is captured. */
function breakthroughRemoveSectorControlPoint(state: GameState, sectorIndex: number): void {
  const cp = state.sectorControlPointHex[sectorIndex];
  if (!cp) return;
  state.controlPointHexes = state.controlPointHexes.filter(k => k !== cp);
  state.sectorControlPointHex[sectorIndex] = '';
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
  if (state.gameMode !== 'breakthrough' || !state.sectorControlPointHex?.length) return;
  const att = getBreakthroughAttackerOwner(state);
  const i = breakthroughActiveFrontlineSectorIndex(state);
  if (i !== null) {
    const cp = state.sectorControlPointHex[i];
    if (cp) {
      const attackerOnCp = state.units.some(u => u.owner === att && `${u.col},${u.row}` === cp);
      if (attackerOnCp) {
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
          log(
            state,
            bonus > 0
              ? `Breakthrough: sector ${i + 1} captured — attacker territory locked; control point cleared. +${bonus} PP.`
              : `Breakthrough: sector ${i + 1} captured — attacker territory locked; control point cleared.`,
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
    const heal = owner === unit.owner ? config.healOwnTerritory : 0;
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

export function createInitialState(): GameState {
  unitIdCounter = 0;
  const gm = config.gameMode as GameMode;
  const breakthroughAttackerOwnerForState: Owner | undefined =
    gm === 'breakthrough'
      ? (
          config.breakthroughRandomRoles
            ? (Math.random() < 0.5 ? PLAYER : AI)
            : config.breakthroughPlayer1Role === 'attacker'
              ? PLAYER
              : AI
        )
      : undefined;

  const units: Unit[] = [];
  let playerStartingUnits = config.startingUnitsPlayer1;
  let aiStartingUnits = config.startingUnitsPlayer2;
  if (gm === 'breakthrough' && breakthroughAttackerOwnerForState !== undefined) {
    const att = breakthroughAttackerOwnerForState;
    playerStartingUnits = att === PLAYER ? config.startingUnitsAttacker : config.startingUnitsDefender;
    aiStartingUnits = att === AI ? config.startingUnitsAttacker : config.startingUnitsDefender;
  }
  const playerStartingCols = spreadCols(playerStartingUnits, COLS);
  const aiStartingCols = spreadCols(aiStartingUnits, COLS);

  for (const c of playerStartingCols) units.push(makeUnit(PLAYER, c, ROWS - 1));
  for (const c of aiStartingCols) units.push(makeUnit(AI, c, 0));

  let hexStates: Record<string, HexState> = {};
  for (const u of units) {
    hexStates[`${u.col},${u.row}`] = { owner: u.owner, stableFor: 0, isProduction: false };
  }

  // Generate random mountain hexes, excluding home rows and starting unit positions
  const reservedKeys = new Set(units.map(u => `${u.col},${u.row}`));
  const candidates: string[] = [];
  for (let r = 1; r < ROWS - 1; r++) {
    for (let c = 0; c < COLS; c++) {
      const key = `${c},${r}`;
      if (!reservedKeys.has(key)) candidates.push(key);
    }
  }
  const mountainCount = Math.round(COLS * ROWS * config.mountainPct);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const mountainHexes = candidates.slice(0, Math.min(mountainCount, candidates.length));
  const mountainSet = new Set(mountainHexes);

  const cpCandidates: string[] = [];
  for (let r = 1; r < ROWS - 1; r++) {
    for (let c = 0; c < COLS; c++) {
      const key = `${c},${r}`;
      if (!reservedKeys.has(key) && !mountainSet.has(key)) cpCandidates.push(key);
    }
  }
  let sectorHexes: string[][] = [];
  let sectorOwners: Owner[] = [];
  let sectorControlPointHex: string[] = [];
  let breakthroughCpOccupation: number[] = [];
  let sectorIndexByHex: Record<string, number> = {};

  let controlPointHexes: string[] = [];
  if (gm === 'breakthrough') {
    const assignable: string[] = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const key = `${c},${r}`;
        if (!mountainSet.has(key)) assignable.push(key);
      }
    }
    const wantSectors = Math.max(2, config.breakthroughSectorCount);
    const nSectors = Math.min(wantSectors, Math.max(2, assignable.length));
    sectorHexes = partitionBreakthroughSectors(assignable, nSectors);
    const att: Owner = breakthroughAttackerOwnerForState!;
    const nSec = sectorHexes.length;
    sectorOwners = sectorHexes.map((_, i) =>
      att === PLAYER ? (i === 0 ? PLAYER : AI) : i === nSec - 1 ? AI : PLAYER,
    );
    sectorIndexByHex = {};
    sectorHexes.forEach((keys, sid) => {
      for (const k of keys) sectorIndexByHex[k] = sid;
    });
    hexStates = {};
    for (let s = 0; s < sectorHexes.length; s++) {
      const owner = sectorOwners[s]!;
      for (const k of sectorHexes[s]!) {
        hexStates[k] = { owner, stableFor: 0, isProduction: false };
      }
    }
    sectorControlPointHex = sectorHexes.map(keys => pickBreakthroughSectorControlPoint(keys, COLS, ROWS));
    controlPointHexes = [];
    breakthroughCpOccupation = Array(sectorHexes.length).fill(0);
    // Attacker's home sector (south if attacker is PLAYER, north if attacker is AI) has no CP marker.
    const homeIdx = att === PLAYER ? 0 : nSec - 1;
    const cpHome = sectorControlPointHex[homeIdx];
    if (cpHome) {
      sectorControlPointHex[homeIdx] = '';
    }
    const frontlineIdx = att === PLAYER
      ? sectorOwners.findIndex(o => o !== att)
      : (() => {
          for (let i = sectorOwners.length - 1; i >= 0; i--) {
            if (sectorOwners[i] !== att) return i;
          }
          return -1;
        })();
    controlPointHexes =
      frontlineIdx >= 0 && sectorControlPointHex[frontlineIdx]
        ? [sectorControlPointHex[frontlineIdx]!]
        : [];
    primeInitialBreakthroughProductionHexes(hexStates, mountainHexes);
  } else if (gm === 'conquest' && config.controlPointCount > 0 && cpCandidates.length > 0) {
    controlPointHexes = pickControlPointHexes(cpCandidates, config.controlPointCount, COLS, ROWS);
  }

  const conquestPoints =
    gm === 'conquest'
      ? ({
          [PLAYER]: config.conquestPointsPlayer,
          [AI]: config.conquestPointsAi,
        } as Record<Owner, number>)
      : null;

  const playerHexes = Object.values(hexStates).filter(h => h.owner === PLAYER).length;
  const aiHexes = Object.values(hexStates).filter(h => h.owner === AI).length;
  const playerBonus = territoryBonusForHexCount(playerHexes);
  const aiBonus = territoryBonusForHexCount(aiHexes);

  let ppPlayer: number;
  let ppAi: number;
  if (gm === 'breakthrough' && breakthroughAttackerOwnerForState !== undefined) {
    const att = breakthroughAttackerOwnerForState;
    const def: Owner = att === PLAYER ? AI : PLAYER;
    const defHexCount = Object.values(hexStates).filter(h => h.owner === def).length;
    const defBonus = territoryBonusForHexCount(defHexCount);
    const defPP = config.productionPointsPerTurn + defBonus;
    const attPP = config.breakthroughAttackerStartingPP;
    ppPlayer = att === PLAYER ? attPP : defPP;
    ppAi = att === AI ? attPP : defPP;
  } else {
    ppPlayer = config.productionPointsPerTurn;
    ppAi = config.productionPointsPerTurn;
  }

  const logMsg =
    gm === 'breakthrough'
      ? 'Game started — Breakthrough. Your turn — Production phase.'
      : 'Game started. Your turn — Production phase.';

  return {
    units,
    hexStates,
    mountainHexes,
    gameMode: gm,
    controlPointHexes,
    conquestPoints,
    sectorHexes,
    sectorOwners,
    sectorControlPointHex,
    breakthroughCpOccupation,
    sectorIndexByHex,
    ...(gm === 'breakthrough' && breakthroughAttackerOwnerForState !== undefined
      ? { breakthroughAttackerOwner: breakthroughAttackerOwnerForState }
      : {}),
    turn: 1,
    phase: 'production',
    activePlayer: PLAYER,
    selectedUnit: null,
    productionPoints: {
      [PLAYER]: ppPlayer,
      [AI]: ppAi,
    } as Record<Owner, number>,
    log: [logMsg],
    winner: null,
  };
}

// ── Story state ───────────────────────────────────────────────────────────────

/**
 * Creates a GameState from a story definition, using its fixed map layout.
 * Call updateConfig + syncDimensions before this so COLS/ROWS are correct.
 */
export function createStoryState(story: StoryDef): GameState {
  unitIdCounter = 0;
  const units: Unit[] = [];

  for (const pos of story.map.playerStart) {
    units.push(makeUnit(PLAYER, pos.col, ROWS - 1, pos.unitTypeId ?? 'infantry'));
  }
  for (const pos of story.map.aiStart) {
    units.push(makeUnit(AI, pos.col, 0, pos.unitTypeId ?? 'infantry'));
  }

  let hexStates: Record<string, HexState> = {};
  for (const u of units) {
    hexStates[`${u.col},${u.row}`] = { owner: u.owner, stableFor: 0, isProduction: false };
  }

  const mountainHexes = [...story.map.mountains];
  const mountainSet = new Set(mountainHexes);
  let controlPointHexes = story.map.controlPoints ? [...story.map.controlPoints] : [];

  let sectorHexes: string[][] = [];
  let sectorOwners: Owner[] = [];
  let sectorControlPointHex: string[] = [];
  let breakthroughCpOccupation: number[] = [];
  let sectorIndexByHex: Record<string, number> = {};
  let breakthroughAttackerOwner: Owner | undefined;

  if (story.gameMode === 'breakthrough') {
    // Determine attacker owner
    const randomRoles = story.breakthroughRandomRoles ?? config.breakthroughRandomRoles;
    const player1Role = story.breakthroughPlayer1Role ?? config.breakthroughPlayer1Role;
    breakthroughAttackerOwner = randomRoles
      ? (Math.random() < 0.5 ? PLAYER : AI)
      : player1Role === 'attacker' ? PLAYER : AI;
    const att = breakthroughAttackerOwner;

    // Build all assignable (non-mountain) hexes
    const assignable: string[] = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const key = `${c},${r}`;
        if (!mountainSet.has(key)) assignable.push(key);
      }
    }

    // Sector count: explicit override > derived from map CPs+1 > config default
    const storyMapCps = story.map.controlPoints ?? [];
    const wantSectors = story.breakthroughSectorCount
      ?? (storyMapCps.length > 0 ? storyMapCps.length + 1 : config.breakthroughSectorCount);
    const nSectors = Math.max(2, Math.min(wantSectors, assignable.length));

    sectorHexes = partitionBreakthroughSectors(assignable, nSectors);
    const nSec = sectorHexes.length;

    sectorOwners = sectorHexes.map((_, i) =>
      att === PLAYER ? (i === 0 ? PLAYER : AI) : i === nSec - 1 ? AI : PLAYER,
    );

    sectorIndexByHex = {};
    sectorHexes.forEach((keys, sid) => {
      for (const k of keys) sectorIndexByHex[k] = sid;
    });

    // All hexes owned by their sector's owner
    hexStates = {};
    for (let s = 0; s < sectorHexes.length; s++) {
      const owner = sectorOwners[s]!;
      for (const k of sectorHexes[s]!) {
        hexStates[k] = { owner, stableFor: 0, isProduction: false };
      }
    }

    // Assign CPs: use story's pre-defined positions if they fall within the sector, else centroid
    const storyCpSet = new Set(storyMapCps);
    sectorControlPointHex = sectorHexes.map(keys => {
      const storyCP = keys.find(k => storyCpSet.has(k));
      return storyCP ?? pickBreakthroughSectorControlPoint(keys, COLS, ROWS);
    });

    breakthroughCpOccupation = Array(nSec).fill(0);

    // Attacker's home sector has no CP marker
    const homeIdx = att === PLAYER ? 0 : nSec - 1;
    sectorControlPointHex[homeIdx] = '';

    // Expose only the frontline CP
    const frontlineIdx = att === PLAYER
      ? sectorOwners.findIndex(o => o !== att)
      : (() => {
          for (let i = sectorOwners.length - 1; i >= 0; i--) {
            if (sectorOwners[i] !== att) return i;
          }
          return -1;
        })();
    controlPointHexes =
      frontlineIdx >= 0 && sectorControlPointHex[frontlineIdx]
        ? [sectorControlPointHex[frontlineIdx]!]
        : [];

    primeInitialBreakthroughProductionHexes(hexStates, mountainHexes);
  }

  const conquestPoints =
    story.gameMode === 'conquest'
      ? ({
          [PLAYER]: story.conquestPointsPlayer ?? config.conquestPointsPlayer,
          [AI]: story.conquestPointsAi ?? config.conquestPointsAi,
        } as Record<Owner, number>)
      : null;

  let ppPlayer: number;
  let ppAi: number;
  if (story.gameMode === 'breakthrough' && breakthroughAttackerOwner !== undefined) {
    const att = breakthroughAttackerOwner;
    const def: Owner = att === PLAYER ? AI : PLAYER;
    const defHexCount = Object.values(hexStates).filter(h => h.owner === def).length;
    const defBonus = territoryBonusForHexCount(defHexCount);
    const attPP = story.breakthroughAttackerStartingPP ?? config.breakthroughAttackerStartingPP;
    const defPP = (story.productionPointsPerTurn ?? config.productionPointsPerTurn) + defBonus;
    ppPlayer = att === PLAYER ? attPP : defPP;
    ppAi = att === AI ? attPP : defPP;
  } else {
    const ppTurn = story.productionPointsPerTurn ?? config.productionPointsPerTurn;
    const playerHexCount = Object.values(hexStates).filter(h => h.owner === PLAYER).length;
    const aiHexCount = Object.values(hexStates).filter(h => h.owner === AI).length;
    ppPlayer = ppTurn + territoryBonusForHexCount(playerHexCount);
    ppAi = ppTurn + territoryBonusForHexCount(aiHexCount);
  }

  const logMsg = story.gameMode === 'breakthrough'
    ? 'Story mission started — Breakthrough. Your turn — Production phase.'
    : 'Story mission started. Your turn — Production phase.';

  return {
    units,
    hexStates,
    mountainHexes,
    gameMode: story.gameMode,
    controlPointHexes,
    conquestPoints,
    sectorHexes,
    sectorOwners,
    sectorControlPointHex,
    breakthroughCpOccupation,
    sectorIndexByHex,
    ...(story.gameMode === 'breakthrough' && breakthroughAttackerOwner !== undefined
      ? { breakthroughAttackerOwner }
      : {}),
    turn: 1,
    phase: 'production',
    activePlayer: PLAYER,
    selectedUnit: null,
    productionPoints: { [PLAYER]: ppPlayer, [AI]: ppAi } as Record<Owner, number>,
    log: [logMsg],
    winner: null,
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

  const unitType = config.unitTypes.find(u => u.id === unitTypeId);
  if (!unitType) return state;

  if (state.productionPoints[localPlayer] < unitType.cost) {
    log(state, `Not enough production points (need ${unitType.cost}, have ${state.productionPoints[localPlayer]}).`);
    return state;
  }

  state.productionPoints[localPlayer] -= unitType.cost;
  state.units.push(makeUnit(localPlayer, col, row, unitType.id));
  conquerHex(state, col, row, localPlayer);
  log(state, `Placed ${unitType.name} at (${col}, ${row}). PP: ${state.productionPoints[localPlayer]}.`);
  return state;
}

export function playerEndProduction(state: GameState): GameState {
  if (state.phase !== 'production' || state.activePlayer !== PLAYER) return state;
  log(state, 'You ended production.');
  return advancePhase(state);
}

function collectAiProductionCandidates(state: GameState, occupied: Set<string>): [number, number][] {
  const candidates: [number, number][] = [];
  for (let c = 0; c < COLS; c++) {
    if (!occupied.has(`${c},0`)) candidates.push([c, 0]);
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
 * 0 = calm, 1 = player is deep in the northern quarter of the map (past 75% of the march from
 * south to north). Ramps linearly from 75% → 100% progress.
 */
function aiDefensivePressure(state: GameState): number {
  const progress = minPlayerRowProgressTowardAiHome(state);
  const RAMP_START = 0.75;
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
    counts[u.unitTypeId] = (counts[u.unitTypeId] ?? 0) + 1;
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
    for (const [nc, nr] of getNeighbors(c, r, COLS, ROWS)) {
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
  const neighbors = getNeighbors(col, row, COLS, ROWS);
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

  // Closer to the human home row, more neutral/enemy neighbors to expand territory
  let score =
    -distToGoal * 18 * (1 - pressure * 0.72) +
    expandNeighbor * 6 * (1 - pressure * 0.55) +
    row * 5 * (1 - pressure * 0.65);
  score += pressure * (ROWS - 1 - row) * 18;
  score += pressure * adjacentEnemy * 28;

  if (ut.id === 'tank') {
    score += row * 6 * (1 - pressure * 0.55);
    if (adjacentEnemy > 0) score -= 55 * (1 - pressure * 0.65);
    if (tn < Math.max(1, inf * 0.25)) score += 45;
  } else if (ut.id === 'artillery') {
    score += (ROWS - 1 - row) * 14;
    if (adjacentEnemy > 0) score -= 85 * (1 - pressure * 0.45);
    else score += 35;
    if (ar < Math.max(1, inf * 0.35)) score += 40;
    score += pressure * 22;
  } else {
    score += row * 4 * (1 - pressure * 0.55);
    if (inf / total > 0.65) score -= 25;
  }

  if (state.productionPoints[AI] >= 60 && (ut.id === 'tank' || ut.id === 'artillery')) {
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

  return score;
}

export function aiProduction(state: GameState): GameState {
  const tStart = performance.now();
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
  unit.movesUsed += stepsCost;
  state.selectedUnit = null;

  if (target && target.owner === enemy) {
    // Combat exhausts remaining movement
    unit.movesUsed = unit.movement;
    const attackerId = unit.id;
    advanceAlongPathBeforeCombat(state, unit, path, localPlayer);
    const atkCol = unit.col;
    const atkRow = unit.row;
    const res = resolveCombat(state, unit, target);
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
export function vsHumanEndProduction(state: GameState, localPlayer: Owner): GameState {
  if (state.phase !== 'production' || state.activePlayer !== localPlayer) return state;
  log(state, 'You ended production.');
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
    if (state.gameMode === 'conquest' && state.conquestPoints) {
      const k = `${t.col},${t.row}`;
      if ((state.controlPointHexes ?? []).includes(k)) s += 220;
    }
    if (state.gameMode === 'breakthrough' && state.sectorOwners?.length) {
      const k = `${t.col},${t.row}`;
      if ((state.controlPointHexes ?? []).includes(k)) {
        const sid = state.sectorIndexByHex[k];
        const def = getBreakthroughDefenderOwner(state);
        if (sid !== undefined && state.sectorOwners[sid] === def) s += 210;
      }
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
  if (!favorable) s -= 85 * (1 - pressure * 0.35);
  if (state.gameMode === 'conquest' && state.conquestPoints && defenderOnPlayerControlPoint(state, defender)) {
    s += 190;
  }
  if (state.gameMode === 'breakthrough' && state.sectorOwners?.length) {
    const dk = `${defender.col},${defender.row}`;
    if ((state.controlPointHexes ?? []).includes(dk)) {
      const sid = state.sectorIndexByHex[dk];
      const defOw = getBreakthroughDefenderOwner(state);
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
  const before = minHomeStepsFn(unit.col, unit.row, AI);
  const after = minHomeStepsFn(toCol, toRow, AI);
  let s = (before - after) * 28 * (1 - pressure * 0.82);
  const hex = state.hexStates[`${toCol},${toRow}`];
  const terr = !hex || hex.owner !== AI ? 14 : 0;
  s += terr * (1 - pressure * 0.55);
  s += toRow * 1.5 * (1 - pressure * 0.65);
  s += pressure * (ROWS - 1 - toRow) * 10;
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
    const beforeC = minBfsToCpWhereFn(unit.col, unit.row, key => {
      const sid = state.sectorIndexByHex[key];
      return sid !== undefined && state.sectorOwners[sid] === defOw;
    });
    const afterC = minBfsToCpWhereFn(toCol, toRow, key => {
      const sid = state.sectorIndexByHex[key];
      return sid !== undefined && state.sectorOwners[sid] === defOw;
    });
    s += (beforeC - afterC) * 40;
    const tk = `${toCol},${toRow}`;
    if ((state.controlPointHexes ?? []).includes(tk)) {
      const sid = state.sectorIndexByHex[tk];
      if (sid !== undefined && state.sectorOwners[sid] === defOw) {
        const hx = state.hexStates[tk];
        if (!hx || hx.owner !== defOw) s += 240;
      }
    }
  }
  return s;
}

/** Full unit copies for AI anim replay (positions + HP). */
function snapshotUnits(st: GameState): Unit[] {
  return st.units.map(u => ({ ...u }));
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
  /** Board state immediately after each step (same length as animSteps). */
  animUnitsAfter: Unit[][];
} {
  const tStart = performance.now();
  const combatVfx: CombatVfxPayload[] = [];
  const animSteps: AiAnimStep[] = [];
  const animUnitsBefore: Unit[][] = [];
  const animUnitsAfter: Unit[][] = [];
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
    const cpKeys = (state.controlPointHexes ?? []).filter(pred).join('|');
    const k = `${col},${row}|${cpKeys}`;
    const v = localMinCpCache.get(k);
    if (v !== undefined) return v;
    const d = minBfsToCpWhere(state, col, row, pred);
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
    const oa = AI_MOVE_TYPE_ORDER[a.unitTypeId] ?? 9;
    const ob = AI_MOVE_TYPE_ORDER[b.unitTypeId] ?? 9;
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
        unit.movesUsed = unit.movement;
        const attackerId = unit.id;
        const unitBeforeMelee = { ...unit } as Unit;
        const unitsBeforeApproach = snapshotUnits(state);

        advanceAlongPathBeforeCombat(state, unit, path, AI);
        const atkCol = unit.col;
        const atkRow = unit.row;
        const beforeResolveUnits = snapshotUnits(state);

        const res = resolveCombat(state, unit, target);
        const vfx = combatVfxFromResolve(attackerId, atkCol, atkRow, best.col, best.row, res, path);
        combatVfx.push(vfx);

        const hasMk =
          vfx.mutualKillLunge && vfx.mutualKillLunge.pathHexes.length >= 2;
        if (hasMk) {
          const p = vfx.mutualKillLunge!.pathHexes;
          const s = p[0]!;
          const e = p[p.length - 1]!;
          animUnitsBefore.push(unitsBeforeApproach);
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
    }
  }
  log(state, 'AI completed movement.');
  perfLog('ai.movement.total', performance.now() - tStart);
  return { state, combatVfx, animSteps, animUnitsBefore, animUnitsAfter };
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
  return state;
}

// Runs end-of-turn housekeeping after AI movement: heal, stability, turn counter, PP.
// Call this after aiMovement has already been applied (used by the animation path).
export function endTurnAfterAi(state: GameState): { state: GameState; healFloats: { col: number; row: number; amount: number }[] } {
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
    state.productionPoints[def] += config.productionPointsPerTurn + defBonus;
    log(
      state,
      `Turn ${state.turn} — Production phase. Attacker PP: ${state.productionPoints[att]} (no income). Defender: ${state.productionPoints[def]} PP (+${defBonus} territory).`,
    );
  } else {
    state.productionPoints[PLAYER] += config.productionPointsPerTurn + playerBonus;
    state.productionPoints[AI]     += config.productionPointsPerTurn + aiBonus;
    log(state, `Turn ${state.turn} — Production phase. PP: ${state.productionPoints[PLAYER]} (+${playerBonus} from territory).`);
  }
  applyConquestEndOfRound(state);
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
      state = aiMovement(state).state;
      if (state.winner) return state;
      state = endTurnAfterAi(state).state;
    }
  }

  return state;
}
