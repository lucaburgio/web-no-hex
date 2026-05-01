import type { GameConfig, GameMode, UnitType } from './types';

/** Allowed range for board width/height (hex count). Keep in sync with `#cfg-boardCols` / `#cfg-boardRows` in index.html. */
export const BOARD_HEX_DIM_MIN = 4;
export const BOARD_HEX_DIM_MAX = 48;

let _activeUnitPackage: string | null = null;
let _activeUnitPackagePlayer2: string | null = null;

/** Set the active unit package for player 1 (south). Only units with this package will be available for production. Null = all units (defaults to 'standard'). */
export function setActiveUnitPackage(pkg: string | null): void {
  _activeUnitPackage = pkg;
}

/** Set the active unit package for player 2 / AI (north). Null = fall back to player 1's package. */
export function setActiveUnitPackagePlayer2(pkg: string | null): void {
  _activeUnitPackagePlayer2 = pkg;
}

/** Snapshot effective packages for embedding in {@link import('./types').GameState} when saving. */
export function snapshotActiveUnitPackagesForSave(): {
  unitPackage: string;
  unitPackagePlayer2: string;
} {
  const p1 = _activeUnitPackage ?? 'standard';
  const p2 = _activeUnitPackagePlayer2 ?? _activeUnitPackage ?? 'standard';
  return { unitPackage: p1, unitPackagePlayer2: p2 };
}

/** Returns unit types available for production for the given owner (1 = player/south, 2 = AI/north). Filtered by the owner's active package (falls back to player 1 package, then 'standard'). */
export function getAvailableUnitTypes(owner: 1 | 2 = 1): UnitType[] {
  const pkg = owner === 2
    ? (_activeUnitPackagePlayer2 ?? _activeUnitPackage ?? 'standard')
    : (_activeUnitPackage ?? 'standard');
  return config.unitTypes.filter(u => u.package === pkg);
}

type UnitTypePatches = {
  infantryCost?: number;
  infantryMaxHp?: number;
  infantryStrength?: number;
  tankMaxHp?: number;
  tankStrength?: number;
};

export function updateConfig(overrides: Partial<Omit<GameConfig, 'unitTypes'>> & UnitTypePatches): void {
  const {
    infantryCost,
    infantryMaxHp,
    infantryStrength,
    tankMaxHp,
    tankStrength,
    ...rest
  } = overrides;
  Object.assign(config, rest);
  const patchById: Record<string, Partial<UnitType>> = {};
  if (infantryCost !== undefined) patchById.infantry = { ...patchById.infantry, cost: infantryCost };
  if (infantryMaxHp !== undefined) patchById.infantry = { ...patchById.infantry, maxHp: infantryMaxHp };
  if (infantryStrength !== undefined) patchById.infantry = { ...patchById.infantry, strength: infantryStrength };
  if (tankMaxHp !== undefined) patchById.tank = { ...patchById.tank, maxHp: tankMaxHp };
  if (tankStrength !== undefined) patchById.tank = { ...patchById.tank, strength: tankStrength };
  if (Object.keys(patchById).length > 0) {
    config.unitTypes = config.unitTypes.map(u =>
      patchById[u.id] ? { ...u, ...patchById[u.id] } : u
    );
  }
}

/** Shipped defaults for territory bonus; used when restoring settings UI after leaving Breakthrough. */
export const DEFAULT_TERRITORY_ECONOMY = { territoryQuota: 8, pointsPerQuota: 3 } as const;

const config: GameConfig = {
  gameMode: 'domination' as GameMode,
  conquestPointsPlayer: 40,
  conquestPointsAi: 40,

  breakthroughAttackerStartingPP: 180,
  breakthroughDefenderStartingPP: 60,
  breakthroughSectorCount: 3,
  breakthroughEnemySectorStrengthMult: 0.5,
  breakthroughSectorCaptureBonusPP: 120,
  breakthroughPlayer1Role: 'attacker',
  breakthroughRandomRoles: false,

  customMatchMapId: null,

  // Board dimensions (number of hexes)
  boardCols: 8,
  boardRows: 8,

  // Domination/Conquest: number of units each side starts with
  startingUnitsPlayer1: 3,
  startingUnitsPlayer2: 3,

  // Breakthrough: number of units each role starts with
  startingUnitsDefender: 6,
  startingUnitsAttacker: 6,

  // Hexagon size (radius in pixels)
  hexSize: 40,

  // Turns a hex must remain stable before becoming a production hex
  productionTurns: 2,

  // Minimum distance to any neutral or enemy hex required for stability
  productionSafeDistance: 2,

  // ── Production economy ───────────────────────────────────────────────────────

  // Production points earned by player 1 at the start of every turn
  productionPointsPerTurn: 20,

  // Production points earned by AI / player 2 at the start of every turn
  productionPointsPerTurnAi: 20,

  // Number of owned hexes required to form one quota
  territoryQuota: DEFAULT_TERRITORY_ECONOMY.territoryQuota,

  // Bonus production points earned per quota owned each turn
  pointsPerQuota: DEFAULT_TERRITORY_ECONOMY.pointsPerQuota,

  // Available unit types (id must be unique; cost is in production points)
  unitTypes: [
    
    {
      id: 'infantry',
      unitClass: 'infantry',
      name: 'US Marines',
      cost: 20,
      movement: 1,
      maxHp: 10,
      strength: 10,
      icon: 'icons/units/infantry.svg',
      package: 'us-ww2',
      upgradePointsToLevel: 8,
    },
    {
      id: 'tank',
      unitClass: 'tank',
      name: 'Sherman Tank',
      cost: 40,
      movement: 2,
      maxHp: 14,
      strength: 11,
      extraFlanking: 0.05,
      icon: 'icons/units/sherman-tank.svg',
      package: 'us-ww2',
      upgradePointsToLevel: 10,
    },
    {
      id: 'artillery',
      unitClass: 'artillery',
      name: 'M2 105mm Howitzer',
      cost: 36,
      movement: 1,
      maxHp: 9,
      strength: 8,
      range: 2.6,
      icon: 'icons/units/artillery.svg',
      package: 'us-ww2',
      upgradePointsToLevel: 20,
    },
    {
      id: 'artillery-heavy',
      unitClass: 'artillery',
      name: 'M1 155mm Long Tom',
      cost: 56,
      movement: 1,
      maxHp: 7,
      strength: 9,
      range: 4,
      icon: 'icons/units/artillery-heavy.svg',
      package: 'us-ww2',
      upgradePointsToLevel: 20,
    },









    {
      id: 'infantry',
      unitClass: 'infantry',
      name: 'Panzergrenadiers',
      cost: 20,
      movement: 1,
      maxHp: 10,
      strength: 10,
      icon: 'icons/units/de-infantry.svg',
      package: 'de-ww2',
      upgradePointsToLevel: 8,
    },
    {
      id: 'tank',
      unitClass: 'tank',
      name: 'Panzer IV',
      cost: 40,
      movement: 2,
      maxHp: 14,
      strength: 11,
      extraFlanking: 0.05,
      icon: 'icons/units/panzer-iv.svg',
      package: 'de-ww2',
      upgradePointsToLevel: 10,
    },
    {
      id: 'tiger-tank',
      unitClass: 'tank',
      name: 'Tiger Tank',
      cost: 54,
      movement: 2,
      maxHp: 16,
      strength: 12,
      extraFlanking: 0.1,
      icon: 'icons/units/tiger-tank.svg',
      package: 'de-ww2',
      upgradePointsToLevel: 10,
    },
    {
      id: 'artillery',
      unitClass: 'artillery',
      name: 'LEFH 18',
      cost: 36,
      movement: 1,
      maxHp: 9,
      strength: 8,
      range: 2.6,
      icon: 'icons/units/artillery.svg',
      package: 'de-ww2',
      upgradePointsToLevel: 20,
    },








    {
      id: 'infantry',
      unitClass: 'infantry',
      name: 'Conscript Squad',
      cost: 20,
      movement: 1,
      maxHp: 10,
      strength: 10,
      icon: 'icons/units/ru-infantry.svg',
      package: 'ru-ww2',
      upgradePointsToLevel: 8,
    },
    {
      id: 'tank',
      unitClass: 'tank',
      name: 'T34 Tank',
      cost: 36,
      movement: 2,
      maxHp: 14,
      strength: 11,
      extraFlanking: 0.04,
      icon: 'icons/units/tank.svg',
      package: 'ru-ww2',
      upgradePointsToLevel: 10,
    },
    {
      id: 'artillery',
      unitClass: 'artillery',
      name: 'ML20 152mm Howitzer',
      cost: 36,
      movement: 1,
      maxHp: 9,
      strength: 8,
      range: 2.6,
      icon: 'icons/units/artillery.svg',
      package: 'ru-ww2',
      upgradePointsToLevel: 20,
    },







    {
      id: 'infantry',
      unitClass: 'infantry',
      name: 'Imperial Guard',
      cost: 20,
      movement: 1,
      maxHp: 10,
      strength: 10,
      icon: 'icons/units/jp-infantry.svg',
      package: 'jp-ww2',
      upgradePointsToLevel: 8,
    },
    {
      id: 'tank',
      unitClass: 'tank',
      name: 'Type 97 Chi-Ha Tank',
      cost: 34,
      movement: 2,
      maxHp: 13,
      strength: 11,
      extraFlanking: 0.03,
      icon: 'icons/units/jp-tank.svg',
      package: 'jp-ww2',
      upgradePointsToLevel: 10,
    },
    {
      id: 'artillery',
      unitClass: 'artillery',
      name: 'Type 91 Howitzer',
      cost: 36,
      movement: 1,
      maxHp: 9,
      strength: 8,
      range: 2.6,
      icon: 'icons/units/artillery.svg',
      package: 'jp-ww2',
      upgradePointsToLevel: 20,
    }
  ],

  // ── Combat ──────────────────────────────────────────────────────────────────

  // Damage dealt when both sides have exactly equal effective strength
  combatDamageBase: 3,

  // Divisor in the exponential formula — higher = flatter damage curve
  combatStrengthScale: 10,

  // CS bonus per flanking unit adjacent to the defender
  flankingBonus: 0.15,

  // Maximum number of flanking units that contribute a bonus
  maxFlankingUnits: 2,

  // Tank only: +CS when moving into adjacent melee after using the unit's full movement allowance in one approach (melee path length = movement, from full MP at start of the move)
  tankSpearheadAttackBonus: 0.05,

  // Defender CS multiplier while standing on a river hex (additive: 0.15 = +15%)
  riverDefenseBonus: 0.15,

  // Minimum edge length (in map SVG units) for a river-edge icon to be shown at its midpoint
  riverEdgeIconMinLength: 100,

  // HP recovered per turn when unit is on owned territory
  healOwnTerritory: 2,

  // Whether Zone of Control is active (blocks free movement past enemies)
  zoneOfControl: true,

  // If true, artillery cannot ranged-attack while any enemy is adjacent (must fight adjacent first)
  limitArtillery: false,

  // Reveal only nearby enemies and shroud distant territory (renderer-only; default off)
  fogOfWar: false,

  // Upgrade points: attacker earns these from damage dealt to enemies and from kills (see game.ts combat)
  upgradePointsPerDamageDealt: 1,
  upgradePointsKillBonus: 1,

  // Per-level upgrade bonuses (stack when the same upgrade is chosen again)
  upgradeBonusAttackPerStack: 0.05,
  /** CS fraction per flanker when attacking (× flank count, capped by maxFlankingUnits). */
  upgradeBonusFlankingPerStack: 0.05,
  upgradeBonusDefensePerStack: 0.1,
  /** Added to healOwnTerritory for end-of-turn heal on own territory. */
  upgradeBonusHealPerStack: 1,
  maxUnitUpgradeStacks: 3,

  // Duration in ms for the unit move animation (0 = instant)
  unitMoveSpeed: 480,

  // Floating damage labels above hexes (fade out + move up)
  damageFloatDurationMs: 900,

  // Melee strike-and-return: out to enemy hex and back (full round trip)
  strikeReturnSpeedMs: 520,

  // HP bar fill eases when unit HP changes (combat, healing, etc.)
  hpBarAnimDurationMs: 280,

  // Unit silhouette icon opacity when out of movement (tired); body/HP use theme tired colors
  tiredIconOpacity: 0.5,

  // Color of the movement path preview line shown when hovering a valid move hex (track uses CSS; kept for API parity)
  movePathColor: '#FFC13A',

  // Stroke width of the movement path preview line (in pixels)
  movePathStrokeWidth: 6,

  // How long the movement path preview takes to draw (line stroke + dot stagger)
  movePathDrawDurationMs: 220,
};

export default config;
