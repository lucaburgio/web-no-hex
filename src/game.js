import { getNeighbors } from './hex.js';

export const COLS = 32;
export const ROWS = 32;

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

export function createInitialState() {
  unitIdCounter = 0;
  const units = [];

  // Human player (south = row ROWS-1), 3 starting units spread across middle cols
  const humanCols = [12, 16, 20];
  for (const c of humanCols) units.push(makeUnit(PLAYER, c, ROWS - 1));

  // AI player (north = row 0)
  const aiCols = [12, 16, 20];
  for (const c of aiCols) units.push(makeUnit(AI, c, 0));

  return {
    units,
    turn: 1,
    phase: 'production',        // current phase
    activePlayer: PLAYER,       // whose sub-turn within phase
    phaseStep: 0,               // 0 = player, 1 = AI
    selectedUnit: null,         // id of selected unit (movement phase)
    log: ['Game started. Your turn — Production phase.'],
    winner: null,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function getUnit(state, col, row) {
  return state.units.find(u => u.col === col && u.row === row) ?? null;
}

export function getUnitById(state, id) {
  return state.units.find(u => u.id === id) ?? null;
}

function removeUnit(state, id) {
  state.units = state.units.filter(u => u.id !== id);
}

function log(state, msg) {
  state.log = [msg, ...state.log.slice(0, 49)];
}

// ── Combat ───────────────────────────────────────────────────────────────────
// Returns updated state; attacker moves onto defender's hex if wins
function resolveCombat(state, attacker, defender) {
  const result = ATK - DEF; // 1 - 2 = -1 → attacker loses; to win ATK must > DEF
  if (result > 0) {
    // attacker wins
    log(state, `Combat: unit #${attacker.id} defeated unit #${defender.id}!`);
    removeUnit(state, defender.id);
    attacker.col = defender.col;
    attacker.row = defender.row;
  } else {
    // defender wins (or tie → attacker loses)
    log(state, `Combat: unit #${attacker.id} was repelled by unit #${defender.id}.`);
    removeUnit(state, attacker.id);
  }
  return state;
}

// ── Victory check ────────────────────────────────────────────────────────────
function checkVictory(state) {
  // Reach opponent's home row
  const humanAtNorth = state.units.some(u => u.owner === PLAYER && u.row === 0);
  const aiAtSouth = state.units.some(u => u.owner === AI && u.row === ROWS - 1);
  const noHuman = !state.units.some(u => u.owner === PLAYER);
  const noAI = !state.units.some(u => u.owner === AI);

  if (humanAtNorth || noAI) state.winner = PLAYER;
  else if (aiAtSouth || noHuman) state.winner = AI;
}

// ── Production ───────────────────────────────────────────────────────────────

export function playerPlaceUnit(state, col) {
  if (state.phase !== 'production' || state.activePlayer !== PLAYER) return state;
  const row = ROWS - 1;
  if (getUnit(state, col, row)) {
    log(state, 'That hex is occupied. Choose another column.');
    return state;
  }
  state.units.push(makeUnit(PLAYER, col, row));
  log(state, `You placed a unit at (${col}, ${row}).`);
  return advancePhase(state);
}

export function aiProduction(state) {
  const row = 0;
  const available = [];
  for (let c = 0; c < COLS; c++) {
    if (!getUnit(state, c, row)) available.push(c);
  }
  if (available.length === 0) {
    log(state, 'AI: no space on border to place unit.');
    return state;
  }
  const col = available[Math.floor(Math.random() * available.length)];
  state.units.push(makeUnit(AI, col, row));
  log(state, `AI placed a unit at (${col}, 0).`);
  return state;
}

// ── Movement ─────────────────────────────────────────────────────────────────

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
  const isNeighbor = neighbors.some(([c, r]) => c === col && r === row);
  if (!isNeighbor) {
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

    // Find closest human unit
    let bestNeighbor = null;
    let bestDist = Infinity;
    const neighbors = getNeighbors(unit.col, unit.row, COLS, ROWS);

    for (const [nc, nr] of neighbors) {
      const occupant = getUnit(state, nc, nr);
      if (occupant && occupant.owner === AI) continue;

      // If enemy, attack
      if (occupant && occupant.owner === PLAYER) {
        resolveCombat(state, unit, occupant);
        checkVictory(state);
        break;
      }

      // Pick neighbor closer to nearest human unit
      const minDist = Math.min(...humanUnits.map(h => {
        const dr = Math.abs(h.row - nr);
        const dc = Math.abs(h.col - nc);
        return dr + dc;
      }));
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
      }
    }
  }
  log(state, 'AI completed movement.');
  return state;
}

// ── Phase advancement ────────────────────────────────────────────────────────

export function advancePhase(state) {
  if (state.winner) return state;

  if (state.phase === 'production') {
    if (state.activePlayer === PLAYER) {
      // AI does production immediately
      state = aiProduction(state);
      state.phase = 'movement';
      state.activePlayer = PLAYER;
      // Reset moved flags for player units
      state.units.forEach(u => { if (u.owner === PLAYER) u.movedThisTurn = false; });
      log(state, `Turn ${state.turn} — Movement phase. Click a unit then a hex.`);
    }
  } else if (state.phase === 'movement') {
    if (state.activePlayer === PLAYER) {
      // AI takes its movement turn
      state.units.forEach(u => { if (u.owner === AI) u.movedThisTurn = false; });
      state = aiMovement(state);
      if (state.winner) return state;
      // Advance to next turn
      state.turn += 1;
      state.phase = 'production';
      state.activePlayer = PLAYER;
      state.selectedUnit = null;
      log(state, `Turn ${state.turn} — Production phase. Click a border hex to place a unit.`);
    }
  }

  return state;
}
