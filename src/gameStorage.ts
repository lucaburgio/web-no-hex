import config from './gameconfig';
import type { GameState } from './types';

const STORAGE_KEY = 'web-strategic-save';

export function saveGameState(state: GameState): void {
  if (state.winner !== null) {
    clearGameState();
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error('Failed to save game state:', error);
  }
}

export function loadGameState(): GameState | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return null;
    const state = JSON.parse(saved) as GameState;

    // Backward-compat: mountainHexes added later
    if (!state.mountainHexes) state.mountainHexes = [];
    if (!state.riverHexes) state.riverHexes = [];
    if (state.gameMode == null) state.gameMode = 'domination';
    if (!state.controlPointHexes) state.controlPointHexes = [];
    if (!state.sectorHexes) state.sectorHexes = [];
    if (!state.sectorOwners) state.sectorOwners = [];
    if (!state.sectorControlPointHex) state.sectorControlPointHex = [];
    if (!state.breakthroughCpOccupation) state.breakthroughCpOccupation = [];
    if (!state.sectorIndexByHex) state.sectorIndexByHex = {};
    if (state.gameMode === 'breakthrough' && state.sectorOwners.length === 0) {
      state.gameMode = 'domination';
    }
    if (state.gameMode === 'breakthrough' && state.breakthroughAttackerOwner == null) {
      state.breakthroughAttackerOwner = 1;
    }
    if (state.gameMode !== 'conquest') {
      state.conquestPoints = null;
    } else if (state.conquestPoints == null) {
      state.conquestPoints = {
        1: config.conquestPointsPlayer,
        2: config.conquestPointsAi,
      };
    }

    // Migrate units — fill in fields that may be absent from older saves
    for (const unit of state.units) {
      if (unit.unitTypeId == null) unit.unitTypeId = 'infantry';
      if (unit.attackedThisTurn == null) unit.attackedThisTurn = false;
      const ut = config.unitTypes.find(u => u.id === unit.unitTypeId) ?? config.unitTypes[0];
      if (unit.movement == null) unit.movement = ut.movement;
      if (unit.maxHp == null) unit.maxHp = ut.maxHp;
      if (unit.strength == null) unit.strength = ut.strength;
      unit.hp = Math.min(unit.hp ?? unit.maxHp, unit.maxHp);
      if (unit.upgradePoints == null) unit.upgradePoints = 0;
    }

    return state;
  } catch (error) {
    console.error('Failed to load game state:', error);
    return null;
  }
}

export function hasSaveGame(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function clearGameState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear game state:', error);
  }
}
