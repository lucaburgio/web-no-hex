// Shared types for the game engine

export type Owner = 1 | 2;

/**
 * One of the six sides of a pointy-top hex, clockwise from top-right.
 *
 *       F _____ A
 *      /         \
 * E --+   center  +-- B
 *      \         /
 *       D ‾‾‾‾‾ C
 */
export type HexSide = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

/** One hex in a river path. Stored in the map definition and propagated to GameState. */
export interface RiverHex {
  col: number;
  row: number;
  /** Segment image key, e.g. 'F-B-01'. Resolved to a URL at render time via riverSegmentUrl(). */
  segment: string;
  /** Side through which the river enters this hex. */
  entrySide: HexSide;
  /** Side through which the river exits this hex. */
  exitSide: HexSide;
}
export type Phase = 'production' | 'movement';

/** Match rules: core gameplay is shared; each mode tweaks victory and scoring. */
export type GameMode = 'domination' | 'conquest' | 'breakthrough';

/** Why the match ended — paired with the winner to produce a subtitle on the end screen. */
export type WinReason =
  | 'dom_breakthrough'       // a unit reached the opponent's home row
  | 'dom_annihilation'       // all opponent units eliminated
  | 'cq_elimination'         // one side fully wiped (no units + no territory)
  | 'cq_both_eliminated'     // both sides wiped → northern tiebreaker
  | 'cq_cp_depleted'         // one side's conquest points reached 0
  | 'cq_both_cp_depleted'    // both hit 0 simultaneously → territory tiebreak
  | 'bt_attacker_wiped'      // breakthrough: all attacker units eliminated → defender wins
  | 'bt_all_sectors';        // breakthrough: attacker captured all sectors → attacker wins

export interface Unit {
  id: number;
  owner: Owner;
  unitTypeId: string;
  icon?: string;
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
  /** River hexes placed on the map (visual only). */
  riverHexes: RiverHex[];
  /** Set at match start from config; used for saves / multiplayer. */
  gameMode: GameMode;
  /** Hex keys `col,row` that are control points (Conquest). Empty in Domination. */
  controlPointHexes: string[];
  /** Remaining Conquer Points per side (Conquest only; null in Domination). */
  conquestPoints: Record<Owner, number> | null;
  /** Breakthrough: hex keys per sector (south → north). Empty / absent in other modes. */
  sectorHexes: string[][];
  /** Breakthrough: who politically controls each sector (irreversible from AI → Player). */
  sectorOwners: Owner[];
  /** Breakthrough: one control point hex per sector (same order as sectorHexes). */
  sectorControlPointHex: string[];
  /** Breakthrough: full-round occupation counts toward capturing that sector’s CP. */
  breakthroughCpOccupation: number[];
  /** Breakthrough: O(1) `col,row` → sector index. */
  sectorIndexByHex: Record<string, number>;
  /** Breakthrough: which owner is the attacker (fixed for the match). Omitted in other modes / old saves. */
  breakthroughAttackerOwner?: Owner;
  turn: number;
  phase: Phase;
  activePlayer: Owner;
  selectedUnit: number | null;
  productionPoints: Record<Owner, number>;
  log: string[];
  winner: Owner | null;
  /** Reason the match ended; set alongside {@link winner}. */
  winReason?: WinReason;
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
  /**
   * Melee combat sprites: if true, the attacker animation draws above static units on the board;
   * if false, below (e.g. defender stays visually on top when the attacker loses the exchange).
   */
  attackerAnimAboveUnits?: boolean;
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
  /** Melee/ranged: attacker unit id (for same-hex paint order during combat VFX). */
  meleeAttackerId?: number;
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
  /** Breakthrough: defender has strength malus in attacker-held sector. */
  breakthroughDefenderMalus?: boolean;
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
  /** Optional art shown at the top of the production unit card on hover (path under site root, e.g. cards/unit.png). */
  image?: string;
  /** Story unit package this unit belongs to. In story mode only units matching the story's unitPackage are available. */
  package?: string;
}

export interface StoryMapDef {
  cols: number;
  rows: number;
  /** Hex keys "col,row" that are impassable mountains. */
  mountains: string[];
  playerStart: Array<{ col: number; unitTypeId?: string }>;
  aiStart: Array<{ col: number; unitTypeId?: string }>;
  /**
   * Hex keys for Conquest control points. When set alongside {@link breakthroughControlPoints},
   * the map can be offered as a custom-match preset (all modes share terrain).
   */
  conquestControlPoints?: string[];
  /** Hex keys for Breakthrough sector CPs (sectors = length + 1). */
  breakthroughControlPoints?: string[];
  /**
   * Legacy single list used by older stories and the campaign when only one mode was authored.
   * Prefer {@link conquestControlPoints} / {@link breakthroughControlPoints} for new maps.
   */
  controlPoints?: string[];
  /** River hexes painted on this map. */
  rivers?: RiverHex[];
}

export interface StoryDef {
  id: string;
  title: string;
  description: string;
  /** Groups stories into a named collection displayed together in the UI. */
  scenario: string;
  /** Only unit types with this package are available for player 1 (south). Undefined = all units. */
  unitPackage?: string;
  /** Only unit types with this package are available for player 2 / AI (north). Undefined = same as unitPackage. */
  unitPackagePlayer2?: string;
  gameMode: GameMode;
  map: StoryMapDef;
  conquestPointsPlayer?: number;
  conquestPointsAi?: number;
  /** Override production points per turn for both sides. */
  productionPointsPerTurn?: number;
  /** Override production points per turn for AI / player 2 only. */
  productionPointsPerTurnAi?: number;
  // Breakthrough-specific overrides
  breakthroughSectorCount?: number;
  breakthroughAttackerStartingPP?: number;
  breakthroughPlayer1Role?: 'attacker' | 'defender';
  breakthroughRandomRoles?: boolean;
}

export interface StoryProgress {
  /** Per-scenario highest story index unlocked (scenarioId → index within that scenario, 0 = first story available). */
  reachedScenarioIndex: Record<string, number>;
  /** IDs of completed stories. */
  completedIds: string[];
  /** ID of the story currently in progress (has a saved game state). */
  activeStoryId: string | null;
  /** Turn count recorded when each story was completed (storyId → turn). */
  completedTurns: Record<string, number>;
}

export interface ScenarioDef {
  /** Matches the `scenario` field on StoryDef entries. */
  id: string;
  /** Imported SVG string used as icon in the scenario rail. */
  icon: string;
  title: string;
  /** Imported image URL shown in the scenario detail panel. */
  image: string;
  miniTitle: string;
  description: string;
}

export interface GameConfig {
  /** Default when starting a new match from settings. */
  gameMode: GameMode;
  /** Number of control-point hexes placed on the map (Conquest). */
  controlPointCount: number;
  /** Starting Conquer Points for the southern player (owner 1). */
  conquestPointsPlayer: number;
  /** Starting Conquer Points for the northern player (owner 2). */
  conquestPointsAi: number;

  /** Breakthrough: attacker (south) starts with this PP pool only (no further income). */
  breakthroughAttackerStartingPP: number;
  /** Breakthrough: number of sectors (≥2); map is split south → north. */
  breakthroughSectorCount: number;
  /** Breakthrough: defender strength multiplier while in a sector controlled by the attacker. */
  breakthroughEnemySectorStrengthMult: number;
  /** Breakthrough: PP granted to the attacker when they capture a sector (control point removed). */
  breakthroughSectorCaptureBonusPP: number;
  /** Breakthrough: player 1 (south / host) is attacker or defender when random roles is off. */
  breakthroughPlayer1Role: 'attacker' | 'defender';
  /** Breakthrough: ignore {@link breakthroughPlayer1Role} and assign attacker randomly at match start. */
  breakthroughRandomRoles: boolean;

  /** Custom match: use fixed terrain from this story id, or null for procedurally generated map. */
  customMatchMapId: string | null;

  boardCols: number;
  boardRows: number;
  /** Domination/Conquest: starting units for player 1 (south). */
  startingUnitsPlayer1: number;
  /** Domination/Conquest: starting units for player 2 (north). */
  startingUnitsPlayer2: number;
  /** Breakthrough: starting units for the defender role. */
  startingUnitsDefender: number;
  /** Breakthrough: starting units for the attacker role. */
  startingUnitsAttacker: number;
  hexSize: number;
  productionTurns: number;
  productionSafeDistance: number;
  productionPointsPerTurn: number;
  productionPointsPerTurnAi: number;
  territoryQuota: number;
  pointsPerQuota: number;
  unitTypes: UnitType[];
  combatDamageBase: number;
  combatStrengthScale: number;
  flankingBonus: number;
  maxFlankingUnits: number;
  healOwnTerritory: number;
  zoneOfControl: boolean;
  /** If true, artillery cannot use ranged fire while any enemy is adjacent; must clear adjacencies first. */
  limitArtillery: boolean;
  autoEndProduction: boolean;
  autoEndMovement: boolean;
  // Duration in ms for the unit move animation (0 = instant)
  unitMoveSpeed: number;
  // Fraction of board hexes to randomly set as impassable mountains (0–1)
  mountainPct: number;
  /** When true, one river is generated on new games before mountains are placed. */
  enableRivers: boolean;
  /**
   * Generated river length cap: at most this many times {@link boardCols} hexes wide
   * (actual max hex count is floor(boardCols × this value), minimum 1).
   */
  riverMaxLengthBoardWidthMult: number;
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
  /** Opacity (0–1) for the unit type icon when the unit is tired (no movement left). */
  tiredIconOpacity: number;
}
