// Central configuration for the game.
// Edit these values to change the board layout and starting conditions.

const config = {
  // Board dimensions (number of hexes)
  boardCols: 16,
  boardRows: 16,

  // Number of units each side starts with
  startingUnits: 3,

  // Hexagon size (radius in pixels)
  hexSize: 32,

  // Turns a hex must remain stable before becoming a production hex
  productionTurns: 2,

  // Minimum distance to any neutral or enemy hex required for stability
  productionSafeDistance: 2,
};

export default config;
