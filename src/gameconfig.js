// Central configuration for the game.
// Edit these values to change the board layout and starting conditions.

const config = {
  // Board dimensions (number of hexes)
  boardCols: 8,
  boardRows: 8,

  // Number of units each side starts with
  startingUnits: 3,

  // Hexagon size (radius in pixels)
  hexSize: 32,

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
    { id: 'infantry', name: 'Infantry', cost: 20 },
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

};

export default config;
