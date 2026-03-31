import { getNeighbors } from './hex.js';
import config from './gameconfig.js';

export const COLS = config.boardCols;
export const ROWS = config.boardRows;

export const PLAYER = 1;
export const AI = 2;

// Unit stats
const ATK = 1;
const DEF = 2;

export const PHASES = ['production', 'movement', 'end'];

let unitIdCounter = 0;
function makeUnit(owner, col, row) {
  return { id: unitIdCounter++, owner, col, row, movedThisTurn: false };
}

// Spread n columns evenly across the board width
function spreadCols(n, cols) {
  if (n === 1) return [Math.floor(cols / 2)];
  return Array.from({ length: n }, (_, i) =>
    Math.round((cols - 1) * i / (n - 1))
  );
}

// ── Hex territory ─────────────────────────────────────────────────────────────

function conquerHex(state, col, row, owner) {
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

// Returns all hexes at distance 1..dist from (col, row)
function getHexesWithinDistance(col, row, dist, cols, rows) {
  const visited = new Set([`${col},${row}`]);
  let frontier = [[col, row]];
  const result = [];
  for (let d = 0; d < dist; d++) {
    const next = [];
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

// Called at end of each full turn. A hex is stable when every hex within
// distance 2 is owned by the same player (no neutral, no enemy).
// After 2 consecutive stable turns it becomes a production hex.
// Losing the stability condition immediately removes production status.
function updateHexStability(state) {
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

export function getUnit(state, col, row) {
  return state.units.find(u => u.col === col && u.row === row) ?? null;
}

export function getUnitById(state, id) {
  return state.units.find(u => u.id === id) ?? null;
}

// Returns true if (col, row) is a valid production placement for the player
export function isValidProductionPlacement(state, col, row) {
  if (getUnit(state, col, row)) return false;
  if (row === ROWS - 1) return true;
  const hex = state.hexStates[`${col},${row}`];
  return !!(hex && hex.isProduction && hex.owner === PLAYER);
}

function removeUnit(state, id) {
  state.units = state.units.filter(u => u.id !== id);
}

function log(state, msg) {
  state.log = [msg, ...state.log.slice(0, 49)];
}

// ── Initial state ─────────────────────────────────────────────────────────────

export function createInitialState() {
  unitIdCounter = 0;
  const units = [];
  const startingCols = spreadCols(config.startingUnits, COLS);

  for (const c of startingCols) units.push(makeUnit(PLAYER, c, ROWS - 1));
  for (const c of startingCols) units.push(makeUnit(AI, c, 0));

  // Conquer starting positions
  const hexStates = {};
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
    log: ['Game started. Your turn — Production phase.'],
    winner: null,
  };
}

// ── Combat ────────────────────────────────────────────────────────────────────

function resolveCombat(state, attacker, defender) {
  const result = ATK - DEF;
  if (result > 0) {
    log(state, `Combat: unit #${attacker.id} defeated unit #${defender.id}!`);
    removeUnit(state, defender.id);
    attacker.col = defender.col;
    attacker.row = defender.row;
    conquerHex(state, attacker.col, attacker.row, attacker.owner);
  } else {
    log(state, `Combat: unit #${attacker.id} was repelled by unit #${defender.id}.`);
    removeUnit(state, attacker.id);
  }
  return state;
}

// ── Victory check ─────────────────────────────────────────────────────────────

function checkVictory(state) {
  const humanAtNorth = state.units.some(u => u.owner === PLAYER && u.row === 0);
  const aiAtSouth    = state.units.some(u => u.owner === AI && u.row === ROWS - 1);
  const noHuman      = !state.units.some(u => u.owner === PLAYER);
  const noAI         = !state.units.some(u => u.owner === AI);

  if (humanAtNorth || noAI) state.winner = PLAYER;
  else if (aiAtSouth || noHuman) state.winner = AI;
}

// ── Production ────────────────────────────────────────────────────────────────

export function playerPlaceUnit(state, col, row) {
  if (state.phase !== 'production' || state.activePlayer !== PLAYER) return state;

  if (!isValidProductionPlacement(state, col, row)) {
    log(state, 'Place on your border row or a production hex (empty).');
    return state;
  }

  state.units.push(makeUnit(PLAYER, col, row));
  conquerHex(state, col, row, PLAYER);
  log(state, `You placed a unit at (${col}, ${row}).`);
  return advancePhase(state);
}

export function aiProduction(state) {
  const candidates = [];

  // Home border
  for (let c = 0; c < COLS; c++) {
    if (!getUnit(state, c, 0)) candidates.push([c, 0]);
  }

  // AI production hexes away from home border
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
  state.units.push(makeUnit(AI, col, row));
  conquerHex(state, col, row, AI);
  log(state, `AI placed a unit at (${col}, ${row}).`);
  return state;
}

// ── Movement ──────────────────────────────────────────────────────────────────

export function playerSelectUnit(state, col, row) {
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

export function playerMoveUnit(state, col, row) {
  if (state.phase !== 'movement' || state.activePlayer !== PLAYER) return state;
  if (state.selectedUnit === null) return state;

  const unit = getUnitById(state, state.selectedUnit);
  if (!unit) { state.selectedUnit = null; return state; }

  const neighbors = getNeighbors(unit.col, unit.row, COLS, ROWS);
  if (!neighbors.some(([c, r]) => c === col && r === row)) {
    log(state, 'Invalid move: not adjacent.');
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

export function playerEndMovement(state) {
  if (state.phase !== 'movement' || state.activePlayer !== PLAYER) return state;
  log(state, 'You ended your movement.');
  return advancePhase(state);
}

export function aiMovement(state) {
  const aiUnits = state.units.filter(u => u.owner === AI);
  for (const unit of aiUnits) {
    const humanUnits = state.units.filter(u => u.owner === PLAYER);
    if (humanUnits.length === 0) break;

    let bestNeighbor = null;
    let bestDist = Infinity;
    const neighbors = getNeighbors(unit.col, unit.row, COLS, ROWS);

    for (const [nc, nr] of neighbors) {
      const occupant = getUnit(state, nc, nr);
      if (occupant && occupant.owner === AI) continue;

      if (occupant && occupant.owner === PLAYER) {
        resolveCombat(state, unit, occupant);
        checkVictory(state);
        break;
      }

      const minDist = Math.min(...humanUnits.map(h =>
        Math.abs(h.row - nr) + Math.abs(h.col - nc)
      ));
      if (minDist < bestDist) {
        bestDist = minDist;
        bestNeighbor = [nc, nr];
      }
    }

    if (bestNeighbor && !unit.movedThisTurn) {
      const existing = getUnit(state, bestNeighbor[0], bestNeighbor[1]);
      if (!existing) {
        unit.movedThisTurn = true;
        unit.col = bestNeighbor[0];
        unit.row = bestNeighbor[1];
        conquerHex(state, unit.col, unit.row, AI);
      }
    }
  }
  log(state, 'AI completed movement.');
  return state;
}

// ── Phase advancement ─────────────────────────────────────────────────────────

export function advancePhase(state) {
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
      state.units.forEach(u => { if (u.owner === AI) u.movedThisTurn = false; });
      state = aiMovement(state);
      if (state.winner) return state;
      updateHexStability(state);
      state.turn += 1;
      state.phase = 'production';
      state.activePlayer = PLAYER;
      state.selectedUnit = null;
      log(state, `Turn ${state.turn} — Production phase. Click a border hex to place a unit.`);
    }
  }

  return state;
}
