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

### Board
- 32×32 hexagonal grid, pointy-top orientation
- Player 1 (human) starts from the **south** (row 31)
- Player 2 (AI) starts from the **north** (row 0)

### Turn Phases (in order)
1. **Production** — each player places one new unit on their home border (row 0 for AI, row 31 for human). Must be an empty hex.
2. **Movement** — each unit may move at most 1 hex. Moving onto an enemy hex triggers combat immediately.
3. **End** — turn counter advances, AI takes its turn automatically.

### Units
- Represented by a tag/label (e.g. `P1`, `P2`)
- Attack strength: **1**
- Defense strength: **2**
- Combat resolution: `(attacker ATK) - (defender DEF)` → negative/zero = attacker loses; positive = defender loses

### Victory
- Reach the opponent's home row, or eliminate all enemy units.

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
