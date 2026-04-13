import type { GameConfig, GameMode, UnitType } from './types';

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
  controlPointCount: 1,
  conquestPointsPlayer: 14,
  conquestPointsAi: 14,

  breakthroughAttackerStartingPP: 120,
  breakthroughSectorCount: 3,
  breakthroughEnemySectorStrengthMult: 0.5,
  breakthroughSectorCaptureBonusPP: 120,
  breakthroughPlayer1Role: 'attacker',
  breakthroughRandomRoles: false,

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
      name: 'Infantry',
      cost: 20,
      movement: 1,
      maxHp: 10,
      strength: 10,
      icon: 'icons/units/infantry.svg',
      image: 'images/units/infantry.png',
      package: 'standard',
    },
    {
      id: 'tank',
      name: 'Tank',
      cost: 40,
      movement: 2,
      maxHp: 14,
      strength: 11,
      extraFlanking: 0.05,
      icon: 'icons/units/tank.svg',
      image: 'images/units/tank.png',
      package: 'standard',
    },
    {
      id: 'artillery',
      name: 'Artillery',
      cost: 34,
      movement: 1,
      maxHp: 9,
      strength: 8,
      range: 3,
      icon: 'icons/units/artillery.svg',
      image: 'images/units/artillery.png',
      package: 'standard',
    },




    {
      id: 'infantry',
      name: 'US Marines',
      cost: 20,
      movement: 1,
      maxHp: 10,
      strength: 10,
      icon: 'icons/units/infantry.svg',
      image: 'images/units/marines.png',
      package: 'us-ww2',
    },
    {
      id: 'tank',
      name: 'Sherman Tank',
      cost: 40,
      movement: 2,
      maxHp: 14,
      strength: 11,
      extraFlanking: 0.05,
      icon: 'icons/units/tank.svg',
      image: 'images/units/sherman.png',
      package: 'us-ww2',
    },
    {
      id: 'artillery',
      name: 'M2 105mm Howitzer',
      cost: 34,
      movement: 1,
      maxHp: 9,
      strength: 8,
      range: 3,
      icon: 'icons/units/artillery.svg',
      image: 'images/units/m2-howitzer.png',
      package: 'us-ww2',
    },
    {
      id: 'artillery',
      name: 'M1 155mm Long Tom',
      cost: 46,
      movement: 1,
      maxHp: 7,
      strength: 9,
      range: 4,
      icon: 'icons/units/artillery.svg',
      image: 'images/units/m1-long-tom.png',
      package: 'us-ww2',
    },









    {
      id: 'infantry',
      name: 'Panzergrenadiers',
      cost: 20,
      movement: 1,
      maxHp: 10,
      strength: 10,
      icon: 'icons/units/de-infantry.svg',
      image: 'images/units/de-infantry.png',
      package: 'de-ww2',
    },
    {
      id: 'tank',
      name: 'Panzer IV',
      cost: 40,
      movement: 2,
      maxHp: 14,
      strength: 11,
      extraFlanking: 0.05,
      icon: 'icons/units/panzer-iv.svg',
      image: 'images/units/panzer-iv.png',
      package: 'de-ww2',
    },
    {
      id: 'artillery',
      name: 'LEFH 18',
      cost: 34,
      movement: 1,
      maxHp: 9,
      strength: 8,
      range: 3,
      icon: 'icons/units/artillery.svg',
      package: 'de-ww2',
    },








    {
      id: 'infantry',
      name: 'Conscript Squad',
      cost: 20,
      movement: 1,
      maxHp: 10,
      strength: 10,
      icon: 'icons/units/infantry.svg',
      package: 'ru-ww2',
    },
    {
      id: 'tank',
      name: 'T34 Tank',
      cost: 40,
      movement: 2,
      maxHp: 14,
      strength: 11,
      extraFlanking: 0.05,
      icon: 'icons/units/tank.svg',
      package: 'ru-ww2',
    },
    {
      id: 'artillery',
      name: 'ML20 152mm Howitzer',
      cost: 34,
      movement: 1,
      maxHp: 9,
      strength: 8,
      range: 3,
      icon: 'icons/units/artillery.svg',
      package: 'ru-ww2',
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

  // HP recovered per turn when unit is on owned territory
  healOwnTerritory: 2,

  // Whether Zone of Control is active (blocks free movement past enemies)
  zoneOfControl: true,

  // If true, artillery cannot ranged-attack while any enemy is adjacent (must fight adjacent first)
  limitArtillery: false,

  // ── Automation ───────────────────────────────────────────────────────────────

  // Automatically end the production phase when the player can no longer afford any unit
  autoEndProduction: true,

  // Automatically end the movement phase when no player unit has a valid move
  autoEndMovement: true,

  // Duration in ms for the unit move animation (0 = instant)
  unitMoveSpeed: 480,

  // Floating damage labels above hexes (fade out + move up)
  damageFloatDurationMs: 900,

  // Melee strike-and-return: out to enemy hex and back (full round trip)
  strikeReturnSpeedMs: 520,

  // HP bar fill eases when unit HP changes (combat, healing, etc.)
  hpBarAnimDurationMs: 280,

  // Fraction of board hexes to randomly set as impassable mountains at game start (0–1)
  mountainPct: 0.12,

  // Color of the movement path preview line shown when hovering a valid move hex
  movePathColor: '#C77E00',

  // Stroke width of the movement path preview line (in pixels)
  movePathStrokeWidth: 6,

  // How long the movement path preview takes to draw (line stroke + dot stagger)
  movePathDrawDurationMs: 220,
};

export default config;
