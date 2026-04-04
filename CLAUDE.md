# Web Strategic — Hexagonal Strategy Game

## Project Overview
A turn-based hexagonal strategy game playable in the browser (vanilla JS, no build tools).

## Architecture

```
web-strategic/
├── index.html          # Entry point, layout
├── src/
│   ├── hex.js          # Hex grid math (axial coords, neighbors, distance)
│   ├── game.js         # Game state machine, turn logic, combat
│   ├── ai.js           # AI player logic
│   ├── renderer.js     # SVG rendering of board and units
│   └── main.js         # App bootstrap
└── CLAUDE.md
```

## Game Rules

> **IMPORTANT — keep in sync:** Whenever production, movement, victory conditions, or combat logic changes in `game.js` or `gameconfig.js`, you **must** also update the in-game rules overlay in `index.html` (`#rules-modal`) to reflect the new logic. The overlay is the canonical player-facing description of the rules and must always match the actual code.

### Board
- 6×4 hexagonal grid (configurable in `gameconfig.js`), pointy-top orientation
- Player (human) starts from the **south** (bottom row)
- AI starts from the **north** (top row, row 0)

### Turn Phases (in order)
1. **Production** — each player spends PP to place units on valid hexes.
2. **Movement** — each unit may move at most 1 hex. Moving onto an enemy triggers combat.
3. **End** — AI takes its turn, units heal, hex stability updates, turn counter advances.

### Production Economy
- Each turn both players earn **20 PP** (production points).
- **Territory bonus:** +2 PP per 10 owned hexes per turn.
- Spend **20 PP** to place an Infantry unit on a valid hex.
- Valid placement: **home row** (bottom row for player) or any **owned production hex**.
- **Production hex:** an owned hex becomes a production hex after being stable for **2 consecutive turns**. Stability requires all hexes within distance 2 to be owned by the same player. Breaks immediately if any nearby hex becomes neutral or enemy.
- Multiple units can be placed per turn if you have enough PP.

### Units
- Each **unit type** defines its own **max HP** and **base strength** (see `unitTypes` in `gameconfig.ts`; e.g. infantry, tank, artillery).
- **Artillery** may have **`range`**: it can either **move** or **shoot** at an enemy at hex distance 2–`range` in one turn (not both). Ranged hits deal no damage to the artillery and do not conquer the hex if the defender dies; **adjacent** combat uses normal simultaneous damage and advance rules.
- Combat Strength (CS) = `strength × condition × flanking`
  - **Condition:** scales from 50% (1 HP) to 100% (full HP)
  - **Flanking:** +15% CS per friendly unit adjacent to the defender (max 2 flankers, capped at +30%), in fixed neighbor order. Some unit types define **extra flanking**: an additional CS multiplier when that type is among those contributing flankers (same cap and order).

### Movement & Zone of Control
- Each unit moves up to its **movement** value per turn (see unit types; e.g. infantry 1, tank 2).
- Moving onto an empty hex conquers it.
- **Zone of Control (ZoC):** a unit adjacent to an enemy is "locked" — it may only attack an adjacent enemy or retreat to a hex that is itself not adjacent to any enemy.

### Combat
- Damage is resolved **simultaneously**.
- Damage formula: `floor(3 × exp(±ΔCS / 10))`, minimum 1.
- If defender dies: attacker advances and conquers the hex.
- If both die: both removed.
- **Healing** (units that did not fight): +2 HP on own territory, +1 HP on neutral, +0 HP on enemy territory.

### Victory
- Move a unit onto the **opponent's home row**, or **eliminate all enemy units**.

## Coordinate System
Axial hex coordinates (q, r). Offset display via `axialToPixel()`.
Row = r, Col = q offset per row parity.

## Dev Notes
- No frameworks, no bundler — just `<script type="module">` imports
- SVG for rendering (scalable, easy hit-testing)
- AI uses simple greedy logic: move toward nearest enemy, attack if adjacent

## Workflow
- After completing a concrete task with no errors, commit automatically without asking.
- Never push to remote unless explicitly asked.
