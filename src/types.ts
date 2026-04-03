// Shared types for the game engine

export type Owner = 1 | 2;
export type Phase = 'production' | 'movement';

export interface Unit {
  id: number;
  owner: Owner;
  unitTypeId: string;
  col: number;
  row: number;
  movedThisTurn: boolean;
  attackedThisTurn: boolean;
  hp: number;
  maxHp: number;
  strength: number;
  movement: number;
}

export interface HexState {
  owner: Owner;
  stableFor: number;
  isProduction: boolean;
}

export interface GameState {
  units: Unit[];
  hexStates: Record<string, HexState>;
  turn: number;
  phase: Phase;
  activePlayer: Owner;
  selectedUnit: number | null;
  productionPoints: Record<Owner, number>;
  log: string[];
  winner: Owner | null;
}

export interface CombatForecast {
  attackerCS: number;
  defenderCS: number;
  dmgToAttacker: number;
  dmgToDefender: number;
  attackerHpAfter: number;
  defenderHpAfter: number;
  attackerDies: boolean;
  defenderDies: boolean;
  flankingCount: number;
  flankBonusPct: number;
  attackerConditionPct: number;
  defenderConditionPct: number;
}

export interface UnitType {
  id: string;
  name: string;
  cost: number;
  movement: number;
  icon?: string;
}

export interface GameConfig {
  boardCols: number;
  boardRows: number;
  startingUnits: number;
  hexSize: number;
  productionTurns: number;
  productionSafeDistance: number;
  productionPointsPerTurn: number;
  territoryQuota: number;
  pointsPerQuota: number;
  unitTypes: UnitType[];
  unitMaxHp: number;
  unitBaseStrength: number;
  combatDamageBase: number;
  combatStrengthScale: number;
  flankingBonus: number;
  maxFlankingUnits: number;
  healOwnTerritory: number;
  healNeutral: number;
  healEnemyTerritory: number;
  zoneOfControl: boolean;
  autoEndProduction: boolean;
  autoEndMovement: boolean;
  // Duration in ms for the unit move animation (0 = instant)
  unitMoveSpeed: number;
}
