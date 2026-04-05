// Shared types for the game engine

export type Owner = 1 | 2;
export type Phase = 'production' | 'movement';

export interface Unit {
  id: number;
  owner: Owner;
  unitTypeId: string;
  col: number;
  row: number;
  movesUsed: number;
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
  mountainHexes: string[];
  turn: number;
  phase: Phase;
  activePlayer: Owner;
  selectedUnit: number | null;
  productionPoints: Record<Owner, number>;
  log: string[];
  winner: Owner | null;
}

/** One AI turn animation step, in chronological order (same order as aiMovement resolves). */
export interface AiMoveAnimPayload {
  unit: Unit;
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
  pathHexes?: [number, number][];
}

export type AiAnimStep =
  | { type: 'move'; anim: AiMoveAnimPayload }
  | { type: 'combat'; vfx: CombatVfxPayload };

/** Visual-only combat feedback for animations (not part of saved game state). */
export interface CombatVfxPayload {
  /** Melee only: both units survived — play strike onto enemy hex and return. */
  strikeReturn?: {
    attackerId: number;
    fromCol: number;
    fromRow: number;
    enemyCol: number;
    enemyRow: number;
  };
  /** Negative amounts (e.g. -2) for damage dealt. */
  damageFloats: { col: number; row: number; amount: number }[];
  /** Artillery / ranged: play hex-local shell streak VFX on the defender tile before damage floats. */
  ranged?: boolean;
  /** Melee: both units destroyed — animate attacker along path onto defender, then both gone. */
  mutualKillLunge?: {
    attackerId: number;
    pathHexes: [number, number][];
  };
}

export interface CombatForecast {
  /** True when attacker uses ranged rules (no return fire, no advance on kill). */
  isRanged?: boolean;
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
  /** Per contributing flanker with extraFlanking on their type (same order as first N flankers). */
  extraFlankingFrom: { name: string; bonusPct: number }[];
  attackerConditionPct: number;
  defenderConditionPct: number;
}

export interface UnitType {
  id: string;
  name: string;
  cost: number;
  movement: number;
  maxHp: number;
  strength: number;
  /** Optional extra additive flanking multiplier when this unit is a contributing flanker (same scale as global flankingBonus). */
  extraFlanking?: number;
  /** If set, unit may attack enemies at this hex distance (2..range) without moving (ranged). */
  range?: number;
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
  combatDamageBase: number;
  combatStrengthScale: number;
  flankingBonus: number;
  maxFlankingUnits: number;
  healOwnTerritory: number;
  healNeutral: number;
  healEnemyTerritory: number;
  zoneOfControl: boolean;
  /** If true, artillery cannot use ranged fire while any enemy is adjacent; must clear adjacencies first. */
  limitArtillery: boolean;
  autoEndProduction: boolean;
  autoEndMovement: boolean;
  // Duration in ms for the unit move animation (0 = instant)
  unitMoveSpeed: number;
  // Fraction of board hexes to randomly set as impassable mountains (0–1)
  mountainPct: number;
  // Color of the movement path preview line
  movePathColor: string;
  // Stroke width of the movement path preview line (in pixels)
  movePathStrokeWidth: number;
  // Duration in ms for the movement path preview draw animation (line + dots)
  movePathDrawDurationMs: number;
  /** Duration in ms for floating damage labels (fade + move up). */
  damageFloatDurationMs: number;
  /** Duration in ms for melee strike-and-return (out + back). */
  strikeReturnSpeedMs: number;
  /** Duration in ms when the on-board HP bar width eases to a new value after HP changes. */
  hpBarAnimDurationMs: number;
}
