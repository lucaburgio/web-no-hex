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

> **IMPORTANT — keep in sync:** Whenever production, movement, victory conditions, game modes, or combat logic changes in `game.ts`, `gameconfig.ts`, or related code, you **must** also update the in-game rules overlay built by `buildRulesContent()` in `src/main.ts` (shown in `#rules-modal`) to reflect the new logic. The overlay is the canonical player-facing description of the rules and must always match the actual code. For combat, update both the concise **Combat** list and the **Combat in detail** section (formulas must stay aligned with `effectiveCS`, `resolveCombat`, and `forecastCombat` in `game.ts`, and combat-related settings in `gameconfig.ts`).

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
- **Production hex:** an owned hex becomes a production hex after being stable for **2 consecutive turns**. Stability requires all hexes within distance 2 to be owned by the same player; **mountain** hexes in that ring count as secure (impassable, not unconquered “holes”). Breaks immediately if any nearby non-mountain hex becomes neutral or enemy.
- Multiple units can be placed per turn if you have enough PP.

### Units
- Each **unit type** defines its own **max HP** and **base strength** (see `unitTypes` in `gameconfig.ts`; e.g. infantry, tank, artillery).
- **Artillery** may have **`range`**: it can either **move** or **shoot** at an enemy at hex distance 2–`range` in one turn (not both). Ranged hits deal no damage to the artillery and do not conquer the hex if the defender dies; **adjacent** combat uses normal simultaneous damage and advance rules.
- Optional **`limitArtillery`** in `gameconfig.ts`: when **true**, artillery cannot use ranged fire while **any** enemy is adjacent (must resolve adjacent threats via melee first).
- Combat Strength (CS) = `strength × condition × flanking`
  - **Condition:** scales from 50% (1 HP) to 100% (full HP)
  - **Flanking:** +15% CS per friendly unit adjacent to the defender (max 2 flankers, capped at +30%), in fixed neighbor order. Some unit types define **extra flanking**: an additional CS multiplier when that type is among those contributing flankers (same cap and order).

### Movement & Zone of Control
- Each unit moves up to its **movement** value per turn (see unit types; e.g. infantry 1, tank 2).
- Moving onto an empty hex conquers it.
- **Zone of Control (ZoC):** a unit adjacent to an enemy is "locked" — it may only attack an adjacent enemy or retreat to a hex that is itself not adjacent to any enemy. **Adjacent** matches movement: on hex boards, the six grid neighbors; on polygon territory maps, **shared-border** adjacency (same as melee), not merely neighboring indices on the virtual column grid.

### Combat
- Damage is resolved **simultaneously**.
- Damage formula: `floor(3 × exp(±ΔCS / 10))`, minimum 1.
- If defender dies: attacker advances and conquers the hex.
- If both die: both removed.
- **Healing** (units that did not fight): +2 HP on own territory, +1 HP on neutral, +0 HP on enemy territory.

### Game modes
- **Domination** (default): move a unit onto the **opponent's home row**, or **eliminate all enemy units**.
- **Conquest:** control **control point** hexes on the map; each side has **Conquer Points**. After each full round, the opponent loses 1 Conquer Point per control point you own (stacking). First side to **0** Conquer Points loses. A side also loses if they have **no units** and **no owned territory** (full map elimination). Reaching the opponent’s home row alone does not end the match. If both hit 0 in the same tick, the player with more owned hexes wins; if hex counts are also equal, the **northern** player wins the tie. Both fully eliminated from the map in the same check → northern player wins. Settings: `gameMode`, `conquestPointsPlayer`, `conquestPointsAi` in `gameconfig.ts`; control point hex positions come from the map JSON / editor.
- **Breakthrough:** attacker has a **fixed PP pool** (no further income); defender gets normal PP + territory. **Player 1** (south / host) can be set as attacker or defender in settings, or **random role** picks at match start; `breakthroughAttackerOwner` on state records who is attacker. Map split into **sectors**; the **attacker’s home sector** (south if attacker is player 1, north if defender is player 1) has no CP. Other sectors may have **one or more control points** until captured; the attacker must hold **every** CP in the active (frontline) sector **simultaneously** for **two full rounds** before the sector flips (irreversible). On capture, those CP markers are removed, **all hexes in that sector** become attacker territory, attacker gains **bonus PP** (`breakthroughSectorCaptureBonusPP`); the defender cannot regain those hexes. Defender units in attacker-held sectors fight at reduced CS. Settings include `breakthroughPlayer1Role`, `breakthroughRandomRoles`, `breakthroughAttackerStartingPP`, `breakthroughSectorCount`, `breakthroughEnemySectorStrengthMult`, `breakthroughSectorCaptureBonusPP`.

## Coordinate System
Axial hex coordinates (q, r). Offset display via `axialToPixel()`.
Row = r, Col = q offset per row parity.

## Dev Notes
- No frameworks, no bundler — just `<script type="module">` imports
- SVG for rendering (scalable, easy hit-testing)
- AI uses greedy heuristics in `game.ts`: **Domination** — pressure toward the player home row and threats; **Conquest** — prioritize capturing neutral/enemy control points, defending AI-owned CPs when player units are close, and prefer ranged/melee targets on CP hexes; **Breakthrough** — defend CPs in sectors still owned by the **defender**, pressure threats from the **attacker** (roles follow `breakthroughAttackerOwner`).
- **Polygon territory maps:** Movement and melee adjacency use `effectiveGetNeighbors()` → `customMapGraph.adjacency`. That graph is built by `buildTerritoryAdjacency()` from **shared polygon edges** (the same undirected edge must appear as consecutive vertices on both territory boundaries), aligned with `mapEditor.ts` / `buildEdgeTerritoryIndex` in `territoryRenderer.ts`. **`sanitizeTerritoryMapDef()`** (called from `buildTerritoryGraph()` and editor import/export) removes a redundant **outer** territory when smaller territories of the same state lie inside it, their centroids fall inside the parent polygon, and **their areas sum to the parent’s area** — this catches the common mistake of splitting a region into new faces (auto-detect / “save as new”) **without deleting** the original enclosing territory. Optional **`adjacencyBlockPairs`** still removes selected edges after the shared-edge pass. On load, `applyGameStateBoardDimensions()` rebuilds the graph from embedded `mapDef`. Dropping territories **changes** neutral/mountain **virtual column** indices (assignment is by order within each state group); prefer fixing the JSON once rather than relying on saves across territory-count edits. **Artillery ranged range** on polygon maps uses `max(graph BFS steps, ceil(centroid pixel distance / avgAdjacentCentroidPx))` so hop-count shortcuts cannot shoot across visually large gaps. Each **movement step** across one border still costs **1 MP** (same as hex boards).

### SVG layers with CSS animations (avoid flicker)
`renderState` runs on every board interaction (selection, moves, combat, etc.). **Do not** wipe whole SVG subtrees with `innerHTML = ''` (or mass `remove`/`replace`) if those nodes carry CSS **`animation`** or other continuous motion (e.g. marching **`stroke-dashoffset`**). Replacing the node restarts the animation from 0 and reads as a global flicker.

**Do instead:** keep **stable elements** per logical thing (e.g. one path pair for the faction frontline, one group per control point hex). On each render, **update in place** (`d`, `class`, `stroke`, `transform`, visibility). When updating `d` or similar, **skip** `setAttribute` if the value is unchanged so the browser does not reset animation state unnecessarily. For keyed decorations (CPs, markers), sync with a map: remove only disappeared keys, create only new keys.

If you add persistent caches (`WeakMap` keyed by the root `SVGSVGElement`), **clear them inside `initRenderer`** when that SVG is rebuilt so you never hold detached nodes.

Reference implementation: `#sector-outline-layer` and `#control-point-layer` in `src/renderer.ts`.

## Tauri Asset Rules
When working on the Tauri build, follow these rules to avoid broken assets:

- **No `public/` prefix in asset paths.** Vite copies the contents of `public/` to the dist root, so `public/icons/x.svg` must be referenced as `icons/x.svg`. The `public/` directory does not exist in the built output.
- **Never use CSS `background-image: url()` for images in the Tauri app.** WKWebView (macOS) fails to load images via the `tauri://` custom protocol when they are set through CSS `background-image`, even if the URL is correct. Always use `<img src>` tags with `object-fit: cover` instead.
- **Always import images as ES modules.** Any image referenced in JS/TS or set dynamically must be imported at the top of the file (e.g. `import img from '../public/images/foo.png'`). This makes Vite hash and bundle it into `dist/assets/`, ensuring it is correctly resolved at runtime in Tauri.

## Workflow
- After completing a concrete task with no errors, commit automatically without asking.
- Never push to remote unless explicitly asked.
