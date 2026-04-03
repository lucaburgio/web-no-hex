import type { GameConfig } from './types';

export function updateConfig(overrides: Partial<Omit<GameConfig, 'unitTypes'>> & { infantryCost?: number }): void {
  const { infantryCost, ...rest } = overrides;
  Object.assign(config, rest);
  if (infantryCost !== undefined) {
    config.unitTypes = config.unitTypes.map(u =>
      u.id === 'infantry' ? { ...u, cost: infantryCost } : u
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
    { id: 'infantry', name: 'Infantry', cost: 20, movement: 1, icon: 'icons/grade.svg' },
    { id: 'tank',     name: 'Tank',     cost: 40, movement: 2, icon: 'icons/tank.svg'  },
  ],

  // ── Combat ──────────────────────────────────────────────────────────────────

  // Max hit points for a unit
  unitMaxHp: 10,

  // Base combat strength for all units
  unitBaseStrength: 10,

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
  movePathColor: '#ffffff',

  // Stroke width of the movement path preview line (in pixels)
  movePathStrokeWidth: 2.5,
};

export default config;
