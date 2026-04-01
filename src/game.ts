import { getNeighbors } from './hex';
import config from './gameconfig';
import type { Unit, HexState, GameState, CombatForecast, Owner } from './types';

export const PLAYER = 1 as const;
export const AI     = 2 as const;

export const COLS = config.boardCols;
export const ROWS = config.boardRows;

let unitIdCounter = 0;

function makeUnit(owner: Owner, col: number, row: number, unitTypeId = 'infantry'): Unit {
  return {
    id: unitIdCounter++,
    owner,
    unitTypeId,
    col,
    row,
    movedThisTurn: false,
    attackedThisTurn: false,
    hp: config.unitMaxHp,
    maxHp: config.unitMaxHp,
    strength: config.unitBaseStrength,
  };
}

// Spread n columns evenly across the board width
function spreadCols(n: number, cols: number): number[] {
  if (n === 1) return [Math.floor(cols / 2)];
  return Array.from({ length: n }, (_, i) =>
    Math.round((cols - 1) * i / (n - 1))
  );
}

// ── Hex territory ─────────────────────────────────────────────────────────────

function conquerHex(state: GameState, col: number, row: number, owner: Owner): void {
  const key = `${col},${row}`;
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
  for (const [key, hex] of Object.entries(state.hexStates)) {
    if (hex.owner === null) continue;
    const [col, row] = key.split(',').map(Number);
    const nearby = getHexesWithinDistance(col, row, config.productionSafeDistance, COLS, ROWS);

    const isStable = nearby.every(([nc, nr]) => {
      const nhex = state.hexStates[`${nc},${nr}`];
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

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getUnit(state: GameState, col: number, row: number): Unit | null {
  return state.units.find(u => u.col === col && u.row === row) ?? null;
}

export function getUnitById(state: GameState, id: number): Unit | null {
  return state.units.find(u => u.id === id) ?? null;
}

export function isValidProductionPlacement(state: GameState, col: number, row: number): boolean {
  if (getUnit(state, col, row)) return false;
  if (row === ROWS - 1) return true;
  const hex = state.hexStates[`${col},${row}`];
  return !!(hex && hex.isProduction && hex.owner === PLAYER);
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

// Valid destination hexes for a unit (respects ZoC)
export function getValidMoves(state: GameState, unit: Unit): [number, number][] {
  const enemy: Owner = unit.owner === PLAYER ? AI : PLAYER;
  // ZoC is checked on the SOURCE hex, not the destination.
  // If this unit is already adjacent to an enemy it is "locked":
  // it may only attack, not move to empty hexes (Civ 5 rule).
  // Approaching an enemy is always allowed.
  const inZoC = isInEnemyZoC(state, unit.col, unit.row, enemy);

  return getNeighbors(unit.col, unit.row, COLS, ROWS).filter(([c, r]) => {
    const occupant = getUnit(state, c, r);
    // Can't move onto own unit
    if (occupant && occupant.owner === unit.owner) return false;
    // Can always attack an adjacent enemy
    if (occupant && occupant.owner === enemy) return true;
    // If in ZoC, can only move to hexes that are NOT themselves in ZoC (retreat)
    if (inZoC && isInEnemyZoC(state, c, r, enemy)) return false;
    return true;
  });
}

function removeUnit(state: GameState, id: number): void {
  state.units = state.units.filter(u => u.id !== id);
}

function log(state: GameState, msg: string): void {
  state.log = [msg, ...state.log.slice(0, 49)];
}

// ── Combat ────────────────────────────────────────────────────────────────────

// Count friendly units (same side as attacker) adjacent to the defender,
// excluding the attacker itself — these provide flanking bonus.
function getFlankingCount(state: GameState, attacker: Unit, defender: Unit): number {
  const neighbors = getNeighbors(defender.col, defender.row, COLS, ROWS);
  let count = 0;
  for (const [nc, nr] of neighbors) {
    if (nc === attacker.col && nr === attacker.row) continue; // attacker itself doesn't count
    const u = getUnit(state, nc, nr);
    if (u && u.owner === attacker.owner) count++;
  }
  return Math.min(count, config.maxFlankingUnits);
}

function effectiveCS(unit: Unit, flankingCount: number = 0): number {
  const hpRatio = unit.hp / unit.maxHp;
  const woundedMult = 0.5 + 0.5 * hpRatio;
  const flankMult = 1 + flankingCount * config.flankingBonus;
  return unit.strength * woundedMult * flankMult;
}

function resolveCombat(state: GameState, attacker: Unit, defender: Unit): void {
  const flanking = getFlankingCount(state, attacker, defender);
  const csA = effectiveCS(attacker, flanking);
  const csD = effectiveCS(defender, 0);
  const delta = csA - csD;
  const scale = config.combatStrengthScale;
  const base  = config.combatDamageBase;

  const dmgToDefender = Math.max(1, Math.floor(base * Math.exp( delta / scale)));
  const dmgToAttacker = Math.max(1, Math.floor(base * Math.exp(-delta / scale)));

  const flankStr = flanking > 0 ? ` (${flanking} flanker${flanking > 1 ? 's' : ''})` : '';
  log(state, `Combat: #${attacker.id} [${Math.round(csA)}CS] vs #${defender.id} [${Math.round(csD)}CS]${flankStr} → dealt ${dmgToDefender}/${dmgToAttacker} dmg`);

  // Apply damage simultaneously
  attacker.hp -= dmgToAttacker;
  defender.hp -= dmgToDefender;
  attacker.attackedThisTurn = true;
  defender.attackedThisTurn = true;

  const attackerDied = attacker.hp <= 0;
  const defenderDied = defender.hp <= 0;

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
}

// ── Combat forecast (pure — no state mutation) ────────────────────────────────

export function forecastCombat(state: GameState, attacker: Unit, defender: Unit): CombatForecast {
  const flanking = getFlankingCount(state, attacker, defender);
  const csA = effectiveCS(attacker, flanking);
  const csD = effectiveCS(defender, 0);
  const delta = csA - csD;
  const scale = config.combatStrengthScale;
  const base  = config.combatDamageBase;

  const dmgToDefender = Math.max(1, Math.floor(base * Math.exp( delta / scale)));
  const dmgToAttacker = Math.max(1, Math.floor(base * Math.exp(-delta / scale)));

  return {
    attackerCS:           Math.round(csA),
    defenderCS:           Math.round(csD),
    dmgToAttacker,
    dmgToDefender,
    attackerHpAfter:      Math.max(0, attacker.hp - dmgToAttacker),
    defenderHpAfter:      Math.max(0, defender.hp - dmgToDefender),
    attackerDies:         attacker.hp - dmgToAttacker <= 0,
    defenderDies:         defender.hp - dmgToDefender <= 0,
    flankingCount:        flanking,
    flankBonusPct:        Math.round(flanking * config.flankingBonus * 100),
    attackerConditionPct: Math.round((0.5 + 0.5 * (attacker.hp / attacker.maxHp)) * 100),
    defenderConditionPct: Math.round((0.5 + 0.5 * (defender.hp / defender.maxHp)) * 100),
  };
}

// ── Victory check ─────────────────────────────────────────────────────────────

function checkVictory(state: GameState): void {
  const humanAtNorth = state.units.some(u => u.owner === PLAYER && u.row === 0);
  const aiAtSouth    = state.units.some(u => u.owner === AI && u.row === ROWS - 1);
  const noHuman      = !state.units.some(u => u.owner === PLAYER);
  const noAI         = !state.units.some(u => u.owner === AI);

  if (humanAtNorth || noAI) state.winner = PLAYER;
  else if (aiAtSouth || noHuman) state.winner = AI;
}

// ── Healing ───────────────────────────────────────────────────────────────────

function healUnits(state: GameState): void {
  for (const unit of state.units) {
    if (unit.attackedThisTurn) {
      unit.attackedThisTurn = false;
      continue;
    }
    const hexState = state.hexStates[`${unit.col},${unit.row}`];
    const owner: Owner | null = hexState ? hexState.owner : null;
    const heal = owner === unit.owner
      ? config.healOwnTerritory
      : owner === null
        ? config.healNeutral
        : config.healEnemyTerritory;
    unit.hp = Math.min(unit.maxHp, unit.hp + heal);
    unit.attackedThisTurn = false;
  }
}

// ── Initial state ─────────────────────────────────────────────────────────────

export function createInitialState(): GameState {
  unitIdCounter = 0;
  const units: Unit[] = [];
  const startingCols = spreadCols(config.startingUnits, COLS);

  for (const c of startingCols) units.push(makeUnit(PLAYER, c, ROWS - 1));
  for (const c of startingCols) units.push(makeUnit(AI, c, 0));

  const hexStates: Record<string, HexState> = {};
  for (const u of units) {
    hexStates[`${u.col},${u.row}`] = { owner: u.owner, stableFor: 0, isProduction: false };
  }

  return {
    units,
    hexStates,
    turn: 1,
    phase: 'production',
    activePlayer: PLAYER,
    selectedUnit: null,
    productionPoints: {
      [PLAYER]: config.productionPointsPerTurn,
      [AI]:     config.productionPointsPerTurn,
    } as Record<Owner, number>,
    log: ['Game started. Your turn — Production phase.'],
    winner: null,
  };
}

// ── Production ────────────────────────────────────────────────────────────────

export function playerPlaceUnit(state: GameState, col: number, row: number, unitTypeId: string): GameState {
  if (state.phase !== 'production' || state.activePlayer !== PLAYER) return state;

  if (!isValidProductionPlacement(state, col, row)) {
    log(state, 'Invalid placement hex.');
    return state;
  }

  const unitType = config.unitTypes.find(u => u.id === unitTypeId);
  if (!unitType) return state;

  if (state.productionPoints[PLAYER] < unitType.cost) {
    log(state, `Not enough production points (need ${unitType.cost}, have ${state.productionPoints[PLAYER]}).`);
    return state;
  }

  state.productionPoints[PLAYER] -= unitType.cost;
  state.units.push(makeUnit(PLAYER, col, row, unitType.id));
  conquerHex(state, col, row, PLAYER);
  log(state, `Placed ${unitType.name} at (${col}, ${row}). PP: ${state.productionPoints[PLAYER]}.`);
  return state;
}

export function playerEndProduction(state: GameState): GameState {
  if (state.phase !== 'production' || state.activePlayer !== PLAYER) return state;
  log(state, 'You ended production.');
  return advancePhase(state);
}

export function aiProduction(state: GameState): GameState {
  const unitType = config.unitTypes[0]; // AI always builds the first unit type

  if (state.productionPoints[AI] < unitType.cost) {
    log(state, 'AI: not enough production points.');
    return state;
  }

  const candidates: [number, number][] = [];
  for (let c = 0; c < COLS; c++) {
    if (!getUnit(state, c, 0)) candidates.push([c, 0]);
  }
  for (const [key, hex] of Object.entries(state.hexStates)) {
    if (hex.owner === AI && hex.isProduction) {
      const [c, r] = key.split(',').map(Number);
      if (r !== 0 && !getUnit(state, c, r)) candidates.push([c, r]);
    }
  }

  if (candidates.length === 0) {
    log(state, 'AI: no space to place a unit.');
    return state;
  }

  const [col, row] = candidates[Math.floor(Math.random() * candidates.length)];
  state.productionPoints[AI] -= unitType.cost;
  state.units.push(makeUnit(AI, col, row, unitType.id));
  conquerHex(state, col, row, AI);
  log(state, `AI placed a unit at (${col}, ${row}).`);
  return state;
}

// ── Movement ──────────────────────────────────────────────────────────────────

export function playerSelectUnit(state: GameState, col: number, row: number): GameState {
  if (state.phase !== 'movement' || state.activePlayer !== PLAYER) return state;
  const unit = getUnit(state, col, row);
  if (!unit || unit.owner !== PLAYER) {
    state.selectedUnit = null;
    return state;
  }
  if (unit.movedThisTurn) {
    log(state, `Unit #${unit.id} already moved this turn.`);
    return state;
  }
  state.selectedUnit = unit.id;
  log(state, `Selected unit #${unit.id} at (${col}, ${row}).`);
  return state;
}

export function playerMoveUnit(state: GameState, col: number, row: number): GameState {
  if (state.phase !== 'movement' || state.activePlayer !== PLAYER) return state;
  if (state.selectedUnit === null) return state;

  const unit = getUnitById(state, state.selectedUnit);
  if (!unit) { state.selectedUnit = null; return state; }

  const validMoves = getValidMoves(state, unit);
  if (!validMoves.some(([c, r]) => c === col && r === row)) {
    const occupant = getUnit(state, col, row);
    if (occupant && occupant.owner !== PLAYER) {
      log(state, 'Cannot attack: enemy is outside movement range or blocked by ZoC.');
    } else {
      log(state, 'Invalid move: blocked by Zone of Control or not adjacent.');
    }
    return state;
  }

  const target = getUnit(state, col, row);
  if (target && target.owner === PLAYER) {
    log(state, 'Cannot move onto your own unit.');
    return state;
  }

  unit.movedThisTurn = true;
  state.selectedUnit = null;

  if (target && target.owner === AI) {
    resolveCombat(state, unit, target);
  } else {
    unit.col = col;
    unit.row = row;
    conquerHex(state, col, row, PLAYER);
    log(state, `Moved unit #${unit.id} to (${col}, ${row}).`);
  }

  checkVictory(state);
  return state;
}

export function playerEndMovement(state: GameState): GameState {
  if (state.phase !== 'movement' || state.activePlayer !== PLAYER) return state;
  log(state, 'You ended your movement.');
  return advancePhase(state);
}

export function aiMovement(state: GameState): GameState {  // exported for animation split
  const aiUnits = state.units.filter(u => u.owner === AI);
  for (const unit of aiUnits) {
    const humanUnits = state.units.filter(u => u.owner === PLAYER);
    if (humanUnits.length === 0) break;

    const validMoves = getValidMoves(state, unit);
    let bestTarget: [number, number] | null = null;
    let bestDist = Infinity;

    for (const [nc, nr] of validMoves) {
      const occupant = getUnit(state, nc, nr);

      // Attack immediately if reachable
      if (occupant && occupant.owner === PLAYER) {
        resolveCombat(state, unit, occupant);
        checkVictory(state);
        bestTarget = null; // already moved via combat
        break;
      }

      const minDist = Math.min(...humanUnits.map(h =>
        Math.abs(h.row - nr) + Math.abs(h.col - nc)
      ));
      if (minDist < bestDist) {
        bestDist = minDist;
        bestTarget = [nc, nr];
      }
    }

    if (bestTarget && !unit.movedThisTurn) {
      unit.movedThisTurn = true;
      unit.col = bestTarget[0];
      unit.row = bestTarget[1];
      conquerHex(state, unit.col, unit.row, AI);
    }
  }
  log(state, 'AI completed movement.');
  return state;
}

// ── Phase advancement ─────────────────────────────────────────────────────────

// Prepares the AI turn: logs end-of-movement and resets AI moved flags.
// Call this before running aiMovement separately (used by the animation path).
export function prepareAiTurn(state: GameState): GameState {
  if (state.phase !== 'movement' || state.activePlayer !== PLAYER) return state;
  log(state, 'You ended your movement.');
  state.units.forEach(u => { if (u.owner === AI) u.movedThisTurn = false; });
  return state;
}

// Runs end-of-turn housekeeping after AI movement: heal, stability, turn counter, PP.
// Call this after aiMovement has already been applied (used by the animation path).
export function endTurnAfterAi(state: GameState): GameState {
  healUnits(state);
  updateHexStability(state);
  state.units.forEach(u => { u.movedThisTurn = false; });
  state.turn += 1;
  state.phase = 'production';
  state.activePlayer = PLAYER;
  state.selectedUnit = null;
  const playerHexes = Object.values(state.hexStates).filter(h => h.owner === PLAYER).length;
  const aiHexes     = Object.values(state.hexStates).filter(h => h.owner === AI).length;
  const playerBonus = Math.floor(playerHexes / config.territoryQuota) * config.pointsPerQuota;
  const aiBonus     = Math.floor(aiHexes     / config.territoryQuota) * config.pointsPerQuota;
  state.productionPoints[PLAYER] += config.productionPointsPerTurn + playerBonus;
  state.productionPoints[AI]     += config.productionPointsPerTurn + aiBonus;
  log(state, `Turn ${state.turn} — Production phase. PP: ${state.productionPoints[PLAYER]} (+${playerBonus} from territory).`);
  return state;
}

export function advancePhase(state: GameState): GameState {
  if (state.winner) return state;

  if (state.phase === 'production') {
    if (state.activePlayer === PLAYER) {
      state = aiProduction(state);
      state.phase = 'movement';
      state.activePlayer = PLAYER;
      state.units.forEach(u => { if (u.owner === PLAYER) u.movedThisTurn = false; });
      log(state, `Turn ${state.turn} — Movement phase. Click a unit then a hex.`);
    }
  } else if (state.phase === 'movement') {
    if (state.activePlayer === PLAYER) {
      state = prepareAiTurn(state);
      state = aiMovement(state);
      if (state.winner) return state;
      state = endTurnAfterAi(state);
    }
  }

  return state;
}
