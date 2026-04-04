import type { GameConfig, UnitType } from './types';

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

const config: GameConfig = {
  // Board dimensions (number of hexes)
  boardCols: 8,
  boardRows: 8,

  // Number of units each side starts with
  startingUnits: 3,

  // Hexagon size (radius in pixels)
  hexSize: 40,

  // Turns a hex must remain stable before becoming a production hex
  productionTurns: 2,

  // Minimum distance to any neutral or enemy hex required for stability
  productionSafeDistance: 2,

  // ── Production economy ───────────────────────────────────────────────────────

  // Production points earned by each player at the start of every turn
  productionPointsPerTurn: 20,

  // Number of owned hexes required to form one quota
  territoryQuota: 10,

  // Bonus production points earned per quota owned each turn
  pointsPerQuota: 2,

  // Available unit types (id must be unique; cost is in production points)
  unitTypes: [
    {
      id: 'infantry',
      name: 'Infantry',
      cost: 20,
      movement: 1,
      maxHp: 10,
      strength: 10,
      icon: 'icons/infantry.svg',
    },
    {
      id: 'tank',
      name: 'Tank',
      cost: 40,
      movement: 2,
      maxHp: 14,
      strength: 11,
      extraFlanking: 0.05,
      icon: 'icons/tank.svg',
    },
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

  // HP recovered per turn when unit is on neutral territory
  healNeutral: 1,

  // HP recovered per turn when unit is on enemy territory (0 = no healing)
  healEnemyTerritory: 0,

  // Whether Zone of Control is active (blocks free movement past enemies)
  zoneOfControl: true,

  // ── Automation ───────────────────────────────────────────────────────────────

  // Automatically end the production phase when the player can no longer afford any unit
  autoEndProduction: true,

  // Automatically end the movement phase when no player unit has a valid move
  autoEndMovement: true,

  // Duration in ms for the unit move animation (0 = instant)
  unitMoveSpeed: 480,

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
