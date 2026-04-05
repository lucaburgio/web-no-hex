import gsap from 'gsap';
import { playDefenderHexBarrage } from './artilleryProjectileVfx';
import type { ArtilleryProjectileHandle } from './artilleryProjectileVfx';
import { hexToPixel, hexPoints, HEX_SIZE, getNeighbors } from './hex';
import { COLS, ROWS, PLAYER, AI, getUnit, getUnitById, isValidProductionPlacement, getValidMoves, getRangedAttackTargets, isInEnemyZoC } from './game';
import type { Owner } from './types';
import type { GameState, Unit } from './types';
import config from './gameconfig';

/** Margin in px between SVG edge and board origin (must match {@link initRenderer}). */
export const BOARD_MARGIN = 100;

/** Vertical midpoint of hex *centers* in board-local space (used for vs-human guest Y-mirror). */
export function boardCenterY(): number {
  return (HEX_SIZE * 1.5 * (ROWS - 1)) / 2;
}

/** Mirror board-local Y so simulation row 0 (north) draws toward the bottom of the screen. */
export function boardViewFlipTransform(): string {
  const yMid = boardCenterY();
  return `translate(0,${yMid}) scale(1,-1) translate(0,${-yMid})`;
}

function getBoardViewRoot(svg: SVGSVGElement): SVGGElement | null {
  return svg.querySelector('#board-view-root') as SVGGElement | null;
}

/** Parent for VFX/anim layers: under `#board-view-root` when present so they share margin + flip. */
function getBoardVfxParent(svg: SVGSVGElement): SVGElement {
  return getBoardViewRoot(svg) ?? svg;
}

/** Hover move-path preview timeline; killed whenever the target hex changes or the path clears. */
let movePathPreviewTl: gsap.core.Timeline | null = null;

export interface MoveAnimation {
  unit: Unit;      // snapshot of the unit before moving (owner/hp for colour)
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
  /** Hex centers from start to destination (inclusive); if omitted, falls back to a straight segment (e.g. old sync). Player and AI both pass this from getMovePath. */
  pathHexes?: [number, number][];
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/** Last committed game HP we showed (per unit); used to detect changes and drive bar animation. */
let lastRenderedGameHp = new Map<number, number>();
/** In-flight HP bar tweens: visual HP lerps from fromHp → toHp. */
let hpBarAnim = new Map<number, { fromHp: number; toHp: number; maxHp: number; startMs: number }>();
let boardRenderCallback: (() => void) | null = null;
let hpBarRafScheduled = false;

/** Wire the main board redraw (e.g. `() => render()`) so HP bars can tick after damage/healing. */
export function setBoardRenderCallback(cb: (() => void) | null): void {
  boardRenderCallback = cb;
}

function scheduleHpBarFrame(): void {
  if (hpBarRafScheduled || !boardRenderCallback) return;
  hpBarRafScheduled = true;
  requestAnimationFrame(() => {
    hpBarRafScheduled = false;
    boardRenderCallback!();
  });
}

function clearHpBarAnimationState(): void {
  lastRenderedGameHp.clear();
  hpBarAnim.clear();
}

/** Visual HP for bar + color tiers (may differ from `unit.hp` while animating). */
export function getBoardVisualHp(unit: Unit, now: number = performance.now()): number {
  return visualHpForUnit(unit, now);
}

function visualHpForUnit(unit: Unit, now: number): number {
  const anim = hpBarAnim.get(unit.id);
  if (!anim) return unit.hp;
  const dur = config.hpBarAnimDurationMs;
  const t = dur <= 0 ? 1 : Math.min(1, (now - anim.startMs) / dur);
  const hp = anim.fromHp + (anim.toHp - anim.fromHp) * easeOutQuad(t);
  if (t >= 1) {
    hpBarAnim.delete(unit.id);
    lastRenderedGameHp.set(unit.id, unit.hp);
  }
  return Math.max(0, hp);
}

function syncHpBarAnimState(state: GameState, now: number): void {
  const alive = new Set(state.units.map(u => u.id));
  for (const id of lastRenderedGameHp.keys()) {
    if (!alive.has(id)) lastRenderedGameHp.delete(id);
  }
  for (const id of hpBarAnim.keys()) {
    if (!alive.has(id)) hpBarAnim.delete(id);
  }

  const dur = config.hpBarAnimDurationMs;

  for (const unit of state.units) {
    const existing = hpBarAnim.get(unit.id);
    if (existing) {
      if (existing.toHp !== unit.hp) {
        const t = dur <= 0 ? 1 : Math.min(1, (now - existing.startMs) / dur);
        const fromVisual =
          existing.fromHp + (existing.toHp - existing.fromHp) * easeOutQuad(t);
        hpBarAnim.set(unit.id, {
          fromHp: fromVisual,
          toHp: unit.hp,
          maxHp: unit.maxHp,
          startMs: now,
        });
      }
      continue;
    }
    const prev = lastRenderedGameHp.get(unit.id);
    if (prev === undefined) {
      lastRenderedGameHp.set(unit.id, unit.hp);
    } else if (prev !== unit.hp) {
      hpBarAnim.set(unit.id, {
        fromHp: prev,
        toHp: unit.hp,
        maxHp: unit.maxHp,
        startMs: now,
      });
    }
  }

  let anyInProgress = false;
  for (const [, anim] of hpBarAnim) {
    if (dur > 0 && now - anim.startMs < dur) {
      anyInProgress = true;
      break;
    }
  }
  if (anyInProgress) scheduleHpBarFrame();
}

/** Position at fraction `t01` (0–1) of total arc length along the polyline. */
function positionOnPolyline(points: { x: number; y: number }[], t01: number): { x: number; y: number } {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0]!;
  const t = Math.min(1, Math.max(0, t01));
  const segLens: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1]!.x - points[i]!.x;
    const dy = points[i + 1]!.y - points[i]!.y;
    const seg = Math.hypot(dx, dy);
    segLens.push(seg);
    total += seg;
  }
  if (total <= 0) return points[points.length - 1]!;
  let targetDist = t * total;
  for (let i = 0; i < segLens.length; i++) {
    const seg = segLens[i]!;
    if (targetDist <= seg) {
      const ratio = seg === 0 ? 0 : targetDist / seg;
      return {
        x: points[i]!.x + (points[i + 1]!.x - points[i]!.x) * ratio,
        y: points[i]!.y + (points[i + 1]!.y - points[i]!.y) * ratio,
      };
    }
    targetDist -= seg;
  }
  return points[points.length - 1]!;
}

function pixelPathForAnimation(anim: MoveAnimation): { x: number; y: number }[] {
  if (anim.pathHexes && anim.pathHexes.length >= 2) {
    return anim.pathHexes.map(([c, r]) => hexToPixel(c, r));
  }
  return [hexToPixel(anim.fromCol, anim.fromRow), hexToPixel(anim.toCol, anim.toRow)];
}

function unitIcon(unitTypeId: string): string | undefined {
  return config.unitTypes.find(t => t.id === unitTypeId)?.icon;
}

interface IconDef { viewBox: number; mode: 'stroke' | 'fill'; paths: string[]; }

const SVG_ICON_DEFS: Record<string, IconDef> = {
  'icons/sword.svg': {
    viewBox: 24,
    mode: 'stroke',
    paths: ['m11 19-6-6', 'm5 21-2-2', 'm8 16-4 4', 'M9.5 17.5 21 6V3h-3L6.5 14.5'],
  },
  'icons/infantry.svg': {
    viewBox: 48,
    mode: 'fill',
    paths: [
      'M30.5384 17.7331C30.5399 17.7361 30.5472 17.747 30.5575 17.7665C30.5831 17.8143 30.633 17.9104 30.7102 18.0458C30.8655 18.3174 31.1216 18.7453 31.4766 19.2775C32.1945 20.3544 33.271 21.7882 34.6849 23.202C37.5522 26.0694 41.2976 28.387 46 28.387V43.0537C36.0357 43.0537 28.7811 38.0379 24.3151 33.5719C24.2078 33.4646 24.1047 33.3543 24 33.2473C23.8953 33.3543 23.7922 33.4646 23.6849 33.5719C19.2189 38.0379 11.9642 43.0537 2 43.0537V28.387C6.70245 28.387 10.4478 26.0694 13.3151 23.202C14.7289 21.7882 15.8055 20.3544 16.5234 19.2775C16.8783 18.7453 17.1345 18.3174 17.2897 18.0458C17.367 17.9104 17.417 17.8143 17.4425 17.7665L17.4568 17.7426L24 4.65625L30.5384 17.7331ZM17.4449 17.7641L17.4425 17.7665L17.4496 17.7569C17.4485 17.7593 17.4462 17.7614 17.4449 17.7641ZM30.5575 17.7665L30.555 17.7641C30.5538 17.7614 30.5516 17.7593 30.5504 17.7569L30.5575 17.7665Z',
    ],
  },
  'icons/tank.svg': {
    viewBox: 48,
    mode: 'fill',
    paths: [
      'M41 25.7547C41 36.6814 33.5625 42.1448 24.7225 45.3135C24.2596 45.4748 23.7568 45.4671 23.2988 45.2917C14.4375 42.1448 7 36.6814 7 25.7547V10.4572C11.6263 8.37169 24 1.71484 24 1.71484C24 1.71484 36.3736 8.37209 41 10.4572V25.7547Z',
    ],
  },
  'icons/artillery.svg': {
    viewBox: 48,
    mode: 'fill',
    paths: [
      'M18.5 15V4H29.5V15H35L24 26L13 15H18.5Z',
      'M7.5 34V23H13L18.5 28.5V34H24L13 45L2 34H7.5Z',
      'M40.5 34V23H35L29.5 28.5V34H24L35 45L46 34H40.5Z',
    ],
  },
};

function inlineIcon(iconSrc: string | undefined, x: number, y: number, size: number, color: string, opacity: string): SVGGElement | null {
  if (!iconSrc) return null;
  const def = SVG_ICON_DEFS[iconSrc];
  if (!def) return null;
  const scale = size / def.viewBox;
  const g = svgEl('g');
  g.setAttribute('transform', `translate(${x - size / 2},${y - size / 2}) scale(${scale})`);
  if (def.mode === 'fill') {
    g.setAttribute('fill', color);
    g.setAttribute('stroke', 'none');
  } else {
    g.setAttribute('fill', 'none');
    g.setAttribute('stroke', color);
    g.setAttribute('stroke-width', String(2 / scale));
    g.setAttribute('stroke-linecap', 'round');
    g.setAttribute('stroke-linejoin', 'round');
  }
  g.setAttribute('opacity', opacity);
  g.setAttribute('pointer-events', 'none');
  for (const d of def.paths) {
    const p = svgEl('path');
    p.setAttribute('d', d);
    g.appendChild(p);
  }
  return g;
}

// Corner-bracket dash params — one full cycle = one hex edge (HEX_SIZE)
const BRACKET     = 0.22;
const DASH        = HEX_SIZE * BRACKET * 2;
const GAP         = HEX_SIZE * (1 - BRACKET * 2);
const DASH_OFFSET = HEX_SIZE * BRACKET;

// CSS color variables — read once after DOM is ready, then cached
interface Colors {
  bg: string;
  player: string;
  ai: string;
  unitSelected: string;
  hexSelected: string;
  hexMove: string;
  hexPlayer: string;
  hexAi: string;
  hexCanPlace: string;
  hexProdSelected: string;
  hexZoc: string;
  hexNeutral: string;
  hexStroke: string;
  hexProdStroke: string;
  unitIconColor: string;
  moveBorder: string;
  hpHigh: string;
  hpMid: string;
  hpLow: string;
  rangedTarget: string;
}

let C: Colors | null = null;
function colors(): Colors {
  if (C) return C;
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(n).trim();
  C = {
    bg:              v('--color-bg'),
    player:          v('--color-player'),
    ai:              v('--color-ai'),
    unitSelected:    v('--color-unit-selected'),
    hexSelected:     v('--color-hex-selected'),
    hexMove:         v('--color-hex-valid-move'),
    hexPlayer:       v('--color-hex-player'),
    hexAi:           v('--color-hex-ai'),
    hexCanPlace:     v('--color-hex-can-place'),
    hexProdSelected: v('--color-hex-prod-selected'),
    hexZoc:          v('--color-hex-zoc'),
    hexNeutral:      v('--color-hex-neutral'),
    hexStroke:       v('--color-hex-stroke'),
    hexProdStroke:   v('--color-hex-prod-stroke'),
    unitIconColor:   v('--color-unit-icon'),
    moveBorder:      v('--color-move-border'),
    hpHigh:          v('--color-hp-high'),
    hpMid:           v('--color-hp-mid'),
    hpLow:           v('--color-hp-low'),
    rangedTarget:    v('--color-red-700'),
  };
  return C;
}

// Neighbor direction → edge index mapping (edge i spans vertex i to vertex (i+1)%6).
// Vertex i sits at angle (60*i − 30)° in pointy-top orientation (y-axis down).
//   Edge 0 (v0–v1): right (E)        Edge 3 (v3–v4): left (W)
//   Edge 1 (v1–v2): lower-right (SE) Edge 4 (v4–v5): upper-left (NW)
//   Edge 2 (v2–v3): lower-left (SW)  Edge 5 (v5–v0): upper-right (NE)
const DIRS_EVEN: [number, number][] = [[1,0],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1]]; // even rows
const DIRS_ODD:  [number, number][] = [[1,0],[1,1],[0,1],[-1,0],[0,-1],[1,-1]];   // odd rows

// Build an SVG path `d` tracing only the outer boundary of a set of hexes.
// Each boundary edge (where a neighbor is outside the set) is emitted as M…L.
function buildBoundaryPath(hexSet: Set<string>): string {
  if (hexSet.size === 0) return '';
  let d = '';
  for (const key of hexSet) {
    const [c, r] = key.split(',').map(Number);
    const { x, y } = hexToPixel(c, r);
    const dirs = r % 2 === 0 ? DIRS_EVEN : DIRS_ODD;
    for (let i = 0; i < 6; i++) {
      const [dc, dr] = dirs[i];
      if (!hexSet.has(`${c + dc},${r + dr}`)) {
        const a1 = (Math.PI / 180) * (60 * i - 30);
        const a2 = (Math.PI / 180) * (60 * (i + 1) - 30);
        const x1 = (x + HEX_SIZE * Math.cos(a1)).toFixed(2);
        const y1 = (y + HEX_SIZE * Math.sin(a1)).toFixed(2);
        const x2 = (x + HEX_SIZE * Math.cos(a2)).toFixed(2);
        const y2 = (y + HEX_SIZE * Math.sin(a2)).toFixed(2);
        d += `M${x1},${y1}L${x2},${y2}`;
      }
    }
  }
  return d;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

/** Counter-flip upright content when the board is under {@link boardViewFlipTransform}. */
function svgUprightAt(x: number, y: number): SVGGElement {
  const g = svgEl('g');
  g.setAttribute('transform', `translate(${x},${y}) scale(1,-1) translate(${-x},${-y})`);
  return g;
}

const DECOR_RINGS = 4;

export interface InitRendererOptions {
  /** When true (vs-human guest), mirror the board vertically so local side appears at the bottom. */
  flipBoardY?: boolean;
}

export function initRenderer(svgElement: SVGSVGElement, options?: InitRendererOptions): void {
  svgElement.innerHTML = '';
  const flipBoardY = !!options?.flipBoardY;
  svgElement.dataset.boardFlipY = flipBoardY ? '1' : '';
  const c = colors();

  const boardMargin = BOARD_MARGIN;
  // Width/height cover only the board — decor overflows visually without affecting scroll
  const W = COLS * HEX_SIZE * Math.sqrt(3) + boardMargin * 2;
  const H = 1.5 * HEX_SIZE * (ROWS - 1) + boardMargin * 2;

  svgElement.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svgElement.setAttribute('width', String(W));
  svgElement.setAttribute('height', String(H));
  svgElement.style.overflow = 'visible';

  const bg = svgEl('rect');
  bg.setAttribute('width', String(W));
  bg.setAttribute('height', String(H));
  bg.setAttribute('fill', 'transparent');
  svgElement.appendChild(bg);

  const boardOrigin = svgEl('g');
  boardOrigin.id = 'board-origin';
  boardOrigin.setAttribute('transform', `translate(${boardMargin},${boardMargin})`);

  const boardViewRoot = svgEl('g');
  boardViewRoot.id = 'board-view-root';
  if (flipBoardY) {
    boardViewRoot.setAttribute('transform', boardViewFlipTransform());
  }
  boardOrigin.appendChild(boardViewRoot);
  svgElement.appendChild(boardOrigin);

  // Decorative hex layer — ghost hexes ringing the board, rendered first (below everything).
  // Ghost dots ring the board; may extend past the viewBox.
  const decorLayer = svgEl('g');
  decorLayer.setAttribute('pointer-events', 'none');
  boardViewRoot.appendChild(decorLayer);

  for (let r = -DECOR_RINGS; r < ROWS + DECOR_RINGS; r++) {
    for (let col = -DECOR_RINGS; col < COLS + DECOR_RINGS; col++) {
      if (col >= 0 && col < COLS && r >= 0 && r < ROWS) continue; // skip board hexes
      const { x, y } = hexToPixel(col, r);
      const dot = svgEl('circle');
      dot.setAttribute('cx', String(x));
      dot.setAttribute('cy', String(y));
      dot.setAttribute('r', String(HEX_SIZE * 0.05));
      dot.setAttribute('fill', 'rgba(0,0,0,0.18)');
      decorLayer.appendChild(dot);
    }
  }

  const hexLayer = svgEl('g');
  hexLayer.id = 'hex-layer';
  boardViewRoot.appendChild(hexLayer);

  const unitLayer = svgEl('g');
  unitLayer.id = 'unit-layer';
  unitLayer.setAttribute('pointer-events', 'none');
  boardViewRoot.appendChild(unitLayer);

  for (let r = 0; r < ROWS; r++) {
    for (let col = 0; col < COLS; col++) {
      const { x, y } = hexToPixel(col, r);

      const poly = svgEl('polygon');
      poly.setAttribute('points', hexPoints(x, y));
      poly.setAttribute('id', `hex-${col}-${r}`);
      poly.setAttribute('data-col', String(col));
      poly.setAttribute('data-row', String(r));
      poly.setAttribute('fill', c.bg);
      poly.setAttribute('stroke', 'transparent');
      poly.setAttribute('stroke-width', '2.5');
      poly.setAttribute('stroke-dasharray', `${DASH} ${GAP}`);
      poly.setAttribute('stroke-dashoffset', String(DASH_OFFSET));
      poly.style.cursor = "url('/icons/pointer.svg') 13 14, pointer";
      hexLayer.appendChild(poly);

    }
  }

  // Mountain icon layer (above hex fills, below units)
  const mountainLayer = svgEl('g');
  mountainLayer.id = 'mountain-layer';
  mountainLayer.setAttribute('pointer-events', 'none');
  hexLayer.appendChild(mountainLayer);

  // Movement area boundary overlay (drawn above hexes, below units)
  const boundary = svgEl('path');
  boundary.setAttribute('id', 'move-boundary');
  boundary.setAttribute('fill', 'none');
  boundary.setAttribute('stroke-linecap', 'round');
  boundary.setAttribute('stroke-linejoin', 'round');
  boundary.setAttribute('pointer-events', 'none');
  hexLayer.appendChild(boundary);

  // Movement path preview line (above hex layer, below units)
  const movePathLayer = svgEl('g');
  movePathLayer.id = 'move-path-layer';
  movePathLayer.setAttribute('pointer-events', 'none');
  boardViewRoot.insertBefore(movePathLayer, unitLayer);

  const pathLine = svgEl('polyline');
  pathLine.id = 'move-path-line';
  pathLine.setAttribute('fill', 'none');
  pathLine.setAttribute('stroke-linecap', 'round');
  pathLine.setAttribute('stroke-linejoin', 'round');
  pathLine.setAttribute('pointer-events', 'none');
  movePathLayer.appendChild(pathLine);

  // Full-hex invisible targets on top of unit artwork so clicks always map to a cell (getHexFromEvent).
  const hexHitLayer = svgEl('g');
  hexHitLayer.id = 'hex-hit-layer';
  for (let r = 0; r < ROWS; r++) {
    for (let col = 0; col < COLS; col++) {
      const { x, y } = hexToPixel(col, r);
      const hit = svgEl('polygon');
      hit.setAttribute('points', hexPoints(x, y));
      hit.setAttribute('data-col', String(col));
      hit.setAttribute('data-row', String(r));
      hit.setAttribute('fill', 'rgba(0,0,0,0)');
      hit.setAttribute('stroke', 'none');
      hit.setAttribute('pointer-events', 'all');
      hit.style.cursor = "url('/icons/pointer.svg') 13 14, pointer";
      hexHitLayer.appendChild(hit);
    }
  }
  boardViewRoot.appendChild(hexHitLayer);

  if (svgElement.id === 'board') clearHpBarAnimationState();
}

export function renderState(
  svgElement: SVGSVGElement,
  state: GameState,
  productionHex: { col: number; row: number } | null = null,
  hiddenUnitIds: Set<number> = new Set(),
  localPlayer: Owner = PLAYER,
  /**
   * When set, draw this unit list instead of state.units (AI turn replay).
   * Skips HP bar tween sync so bars match the snapshot, not end-of-turn state.
   */
  unitDrawOverride?: Unit[] | null,
): void {
  const trackHpBars = svgElement.id === 'board' && !unitDrawOverride;
  const now = performance.now();
  if (trackHpBars) syncHpBarAnimState(state, now);

  const c = colors();
  const unitLayer = svgElement.querySelector('#unit-layer') as SVGGElement;
  unitLayer.innerHTML = '';

  const mountainSet = new Set(state.mountainHexes ?? []);

  let selectedUnit = state.selectedUnit !== null ? getUnitById(state, state.selectedUnit) : null;
  if (selectedUnit && selectedUnit.owner !== localPlayer) selectedUnit = null;

  const rangedTargetKeys = new Set<string>();
  if (selectedUnit && state.phase === 'movement' && state.activePlayer === localPlayer) {
    for (const t of getRangedAttackTargets(state, selectedUnit)) {
      rangedTargetKeys.add(`${t.col},${t.row}`);
    }
  }

  const validMoveHexes = new Set<string>();
  if (selectedUnit) {
    for (const [col, row] of getValidMoves(state, selectedUnit)) {
      validMoveHexes.add(`${col},${row}`);
    }
  }

  // Full move area = selected hex + valid destinations (used for perimeter outline)
  const moveAreaHexes = new Set<string>(validMoveHexes);
  if (selectedUnit) moveAreaHexes.add(`${selectedUnit.col},${selectedUnit.row}`);

  const zocEnemy: Owner = localPlayer === PLAYER ? AI : PLAYER;
  const zocHexes = new Set<string>();
  if (selectedUnit && isInEnemyZoC(state, selectedUnit.col, selectedUnit.row, zocEnemy)) {
    // Unit is locked in ZoC: highlight empty neighbors it cannot retreat to (also in ZoC)
    for (const [nc, nr] of getNeighbors(selectedUnit.col, selectedUnit.row, COLS, ROWS)) {
      const key = `${nc},${nr}`;
      if (!getUnit(state, nc, nr) && isInEnemyZoC(state, nc, nr, zocEnemy)) {
        zocHexes.add(key);
      }
    }
  }

  const canPlaceHexes = new Set<string>();
  // Focus set: home row + owned production hexes (regardless of occupation) — used for dimming
  const productionFocusHexes = new Set<string>();
  const homeRow = localPlayer === PLAYER ? ROWS - 1 : 0;
  if (state.phase === 'production' && state.activePlayer === localPlayer) {
    for (let r = 0; r < ROWS; r++) {
      for (let col = 0; col < COLS; col++) {
        if (isValidProductionPlacement(state, col, r, localPlayer)) canPlaceHexes.add(`${col},${r}`);
        if (r === homeRow) productionFocusHexes.add(`${col},${r}`);
      }
    }
    for (const [key, hex] of Object.entries(state.hexStates)) {
      if (hex.owner === localPlayer && hex.isProduction) productionFocusHexes.add(key);
    }
  }

  // Update move area perimeter outline
  const boundary = svgElement.querySelector('#move-boundary') as SVGPathElement | null;
  if (boundary) {
    if (moveAreaHexes.size > 0) {
      boundary.setAttribute('d', buildBoundaryPath(moveAreaHexes));
      boundary.setAttribute('stroke', c.moveBorder);
      boundary.setAttribute('stroke-width', '2');
      boundary.setAttribute('stroke-dasharray', '5 4');
    } else {
      boundary.setAttribute('d', '');
    }
  }

  // Update each hex polygon
  for (let r = 0; r < ROWS; r++) {
    for (let col = 0; col < COLS; col++) {
      const poly = svgElement.querySelector(`#hex-${col}-${r}`) as SVGPolygonElement | null;
      if (!poly) continue;

      const key                = `${col},${r}`;
      const isMountain         = mountainSet.has(key);
      const hexState           = state.hexStates[key];
      const isSelectedHex      = selectedUnit && col === selectedUnit.col && r === selectedUnit.row;
      const isValidMove        = validMoveHexes.has(key);
      const isZoc              = zocHexes.has(key);
      const canPlace           = canPlaceHexes.has(key);
      const isProdSelected     = productionHex && col === productionHex.col && r === productionHex.row;
      const isConquered        = !!hexState;

      let fill   = c.hexNeutral;
      let stroke = 'transparent';

      if (isMountain) {
        fill = c.hexNeutral;
      } else if (isSelectedHex) {
        fill = c.hexSelected;
      } else if (isZoc) {
        fill = c.hexZoc;
      } else if (isValidMove) {
        fill = c.hexMove;
      } else if (isProdSelected) {
        fill   = c.hexProdSelected;
        stroke = c.hexProdStroke;
      } else if (canPlace) {
        fill   = c.hexCanPlace;
        stroke = c.hexStroke;
      } else if (isConquered) {
        if (hexState.owner === PLAYER) {
          fill = c.hexPlayer;
        } else {
          fill   = c.hexAi;
          stroke = 'transparent';
        }
      }

      const hexOccupied = !!getUnit(state, col, r);
      const hexDimmed = productionFocusHexes.size > 0 && isConquered && (!productionFocusHexes.has(key) || hexOccupied) && !isProdSelected;
      poly.setAttribute('fill', fill);
      poly.setAttribute('stroke', stroke);
      poly.setAttribute('opacity', hexDimmed ? '0.2' : '1');
      poly.style.cursor = "url('/icons/pointer.svg') 13 14, auto";

      // Production marker
      svgElement.querySelector(`#marker-${col}-${r}`)?.remove();
      if (hexState && hexState.isProduction && !isSelectedHex && !isValidMove) {
        const { x, y } = hexToPixel(col, r);
        const s = HEX_SIZE * 0.18;
        const diamond = svgEl('polygon');
        diamond.setAttribute('points', `${x},${y - s} ${x + s},${y} ${x},${y + s} ${x - s},${y}`);
        diamond.setAttribute('fill', hexState.owner === PLAYER ? c.player : c.ai);
        diamond.setAttribute('opacity', hexDimmed ? '0.08' : '0.4');
        diamond.setAttribute('pointer-events', 'none');
        diamond.setAttribute('id', `marker-${col}-${r}`);
        (svgElement.querySelector('#hex-layer') as SVGGElement).appendChild(diamond);
      }
    }
  }

  const flipBoardY = svgElement.dataset.boardFlipY === '1';

  // Draw mountain icons
  const mountainLayer = svgElement.querySelector('#mountain-layer') as SVGGElement | null;
  if (mountainLayer) {
    mountainLayer.innerHTML = '';
    const iw = HEX_SIZE * Math.sqrt(3);
    const ih = HEX_SIZE * 2;
    for (const key of mountainSet) {
      const [mc, mr] = key.split(',').map(Number);
      const { x, y } = hexToPixel(mc, mr);
      const img = svgEl('image');
      img.setAttribute('href', '/icons/mountains.svg');
      img.setAttribute('x', String(x - iw / 2));
      img.setAttribute('y', String(y - ih / 2));
      img.setAttribute('width', String(iw));
      img.setAttribute('height', String(ih));
      img.setAttribute('pointer-events', 'none');
      if (flipBoardY) {
        const upright = svgUprightAt(x, y);
        upright.appendChild(img);
        mountainLayer.appendChild(upright);
      } else {
        mountainLayer.appendChild(img);
      }
    }
  }

  // Advance HP bar tweens for every unit (including hidden — moving/strike sprites skip
  // the draw loop, so we must tick visualHpForUnit for them or their bars never animate).
  const displayHpByUnit = new Map<number, number>();
  const unitsToDraw = unitDrawOverride ?? state.units;
  if (trackHpBars) {
    for (const unit of state.units) {
      displayHpByUnit.set(unit.id, visualHpForUnit(unit, now));
    }
  } else if (unitDrawOverride) {
    for (const unit of unitDrawOverride) {
      displayHpByUnit.set(unit.id, unit.hp);
    }
  }

  // Draw units
  for (const unit of unitsToDraw) {
    if (hiddenUnitIds.has(unit.id)) continue;
    const dc = unit.col;
    const dr = unit.row;
    const { x, y } = hexToPixel(dc, dr);
    const isSelected = state.selectedUnit === unit.id;
    const displayHp  = displayHpByUnit.get(unit.id) ?? unit.hp;
    const hpRatio    = displayHp / unit.maxHp;

    const baseColor = unit.owner === PLAYER ? c.player : c.ai;
    const isRangedTarget = rangedTargetKeys.has(`${dc},${dr}`);
    const fill      = isRangedTarget ? c.rangedTarget : isSelected ? c.unitSelected : baseColor;
    const unitDimmed = productionFocusHexes.size > 0;
    const moveExhausted =
      state.phase === 'movement' &&
      state.activePlayer === unit.owner &&
      unit.movesUsed >= unit.movement;
    const opacity   = (moveExhausted || unitDimmed) ? '0.2' : '1';

    const unitRoot = flipBoardY ? svgUprightAt(x, y) : null;
    if (unitRoot) unitLayer.appendChild(unitRoot);
    const uParent: SVGGElement = unitRoot ?? unitLayer;

    const UNIT_PATH_D = 'M0 44.1143V0H25H50V44.1143L25 64L0 44.1143Z';
    const sc = (HEX_SIZE * 1.1) / 50;
    const unitEl = svgEl('path');
    unitEl.setAttribute('d', UNIT_PATH_D);
    unitEl.setAttribute('fill', fill);
    unitEl.setAttribute('stroke', 'none');
    unitEl.setAttribute('opacity', opacity);
    unitEl.setAttribute('data-col', String(dc));
    unitEl.setAttribute('data-row', String(dr));
    unitEl.setAttribute('transform', `translate(${x - 25 * sc},${y - 32 * sc}) scale(${sc})`);
    unitEl.style.cursor = "url('/icons/pointer.svg') 13 14, pointer";
    uParent.appendChild(unitEl);

    // HP bar (inside shape)
    const barW = HEX_SIZE * 0.58;
    const barH = HEX_SIZE * 0.1;
    const barX = x - barW / 2;
    const barY = y + HEX_SIZE * 0.13;

    const barBg = svgEl('rect');
    barBg.setAttribute('x', String(barX)); barBg.setAttribute('y', String(barY));
    barBg.setAttribute('width', String(barW)); barBg.setAttribute('height', String(barH));
    barBg.setAttribute('fill', '#222'); barBg.setAttribute('rx', '1');
    barBg.setAttribute('pointer-events', 'none');
    barBg.setAttribute('opacity', opacity);
    uParent.appendChild(barBg);

    const barColor = hpRatio > 0.6 ? c.hpHigh : hpRatio > 0.3 ? c.hpMid : c.hpLow;
    const barFill = svgEl('rect');
    barFill.setAttribute('x', String(barX)); barFill.setAttribute('y', String(barY));
    barFill.setAttribute('width', String(barW * hpRatio)); barFill.setAttribute('height', String(barH));
    barFill.setAttribute('fill', barColor); barFill.setAttribute('rx', '1');
    barFill.setAttribute('pointer-events', 'none');
    barFill.setAttribute('opacity', opacity);
    uParent.appendChild(barFill);

    // Icon (shifted up inside shape)
    const icon = unitIcon(unit.unitTypeId);
    const iconColor = isRangedTarget ? '#ffffff' : c.unitIconColor;
    const iconEl = inlineIcon(icon, x, y - HEX_SIZE * 0.34, HEX_SIZE * 0.4, iconColor, opacity);
    if (iconEl) uParent.appendChild(iconEl);

    if (isRangedTarget) {
      const aim = inlineIcon('icons/artillery.svg', x, y - HEX_SIZE * 1, HEX_SIZE * 0.5, c.rangedTarget, opacity);
      if (aim) {
        const aimWrap = svgEl('g');
        aimWrap.setAttribute('class', 'ranged-target-aim');
        aimWrap.setAttribute('pointer-events', 'none');
        aimWrap.appendChild(aim);
        uParent.appendChild(aimWrap);
      }
    }
  }
}

// Animate a list of unit moves in parallel, then call onDone once.
// During animation the caller should hide the moving units from the static render
// (pass their ids to renderState's hiddenUnitIds) so they don't ghost at the destination.
// Call cancel() to stop frames, clear the anim layer, and skip onDone (caller handles completion).
export function animateMoves(
  svgElement: SVGSVGElement,
  animations: MoveAnimation[],
  durationMs: number,
  onDone: () => void,
  /** When set, HP bar on the moving sprite uses live state + board HP tween each frame. */
  liveStateForHp?: GameState | null,
): { cancel: () => void } {
  const noopCancel = (): void => {};

  if (animations.length === 0 || durationMs <= 0) {
    onDone();
    return { cancel: noopCancel };
  }

  const c = colors();
  const flipBoardY = svgElement.dataset.boardFlipY === '1';

  let animLayer = svgElement.querySelector('#anim-layer') as SVGGElement | null;
  if (!animLayer) {
    animLayer = svgEl('g');
    animLayer.id = 'anim-layer';
    animLayer.setAttribute('pointer-events', 'none');
    getBoardVfxParent(svgElement).appendChild(animLayer);
  }
  animLayer.setAttribute('pointer-events', 'none');
  animLayer.innerHTML = '';

  let cancelled = false;
  let doneCalled = false;

  function callDoneOnce(): void {
    if (cancelled || doneCalled) return;
    doneCalled = true;
    onDone();
  }

  const cancel = (): void => {
    if (cancelled || doneCalled) return;
    cancelled = true;
    animLayer!.innerHTML = '';
  };

  let completed = 0;

  for (const anim of animations) {
    const pixelPath = pixelPathForAnimation(anim);
    const baseColor = anim.unit.owner === PLAYER ? c.player : c.ai;

    const spriteRoot = flipBoardY ? svgEl('g') : null;
    const layer: SVGGElement = spriteRoot ?? animLayer!;
    if (spriteRoot) animLayer!.appendChild(spriteRoot);

    const UNIT_PATH_D = 'M0 44.1143V0H25H50V44.1143L25 64L0 44.1143Z';
    const animFill = baseColor;
    const unitSc = (HEX_SIZE * 1.1) / 50;
    const circle = svgEl('path');
    circle.setAttribute('d', UNIT_PATH_D);
    circle.setAttribute('fill', animFill);
    circle.setAttribute('stroke', 'none');
    circle.setAttribute('pointer-events', 'none');
    layer.appendChild(circle);

    const animBarW = HEX_SIZE * 0.58;
    const barH = HEX_SIZE * 0.1;
    const barBg = svgEl('rect');
    barBg.setAttribute('width', String(animBarW)); barBg.setAttribute('height', String(barH));
    barBg.setAttribute('fill', '#222'); barBg.setAttribute('rx', '1');
    barBg.setAttribute('pointer-events', 'none');
    layer.appendChild(barBg);

    const live0 = liveStateForHp ? getUnitById(liveStateForHp, anim.unit.id) : null;
    const maxHp0 = live0?.maxHp ?? anim.unit.maxHp;
    const displayHp0 = live0 ? getBoardVisualHp(live0, performance.now()) : anim.unit.hp;
    const hpRatio0 = maxHp0 > 0 ? Math.min(1, Math.max(0, displayHp0 / maxHp0)) : 0;
    const barColor0 = hpRatio0 > 0.6 ? c.hpHigh : hpRatio0 > 0.3 ? c.hpMid : c.hpLow;
    const barFill = svgEl('rect');
    barFill.setAttribute('width', String(animBarW * hpRatio0)); barFill.setAttribute('height', String(barH));
    barFill.setAttribute('fill', barColor0); barFill.setAttribute('rx', '1');
    barFill.setAttribute('pointer-events', 'none');
    layer.appendChild(barFill);

    const iconSrc = unitIcon(anim.unit.unitTypeId);
    const iconSize = HEX_SIZE * 0.4;
    // Place icon at (0,0) so its internal scale stays fixed; a wrapper <g> handles translation each frame.
    const iconEl = inlineIcon(iconSrc, 0, 0, iconSize, c.unitIconColor, '1');
    const iconWrapper = svgEl('g');
    iconWrapper.setAttribute('pointer-events', 'none');
    if (iconEl) iconWrapper.appendChild(iconEl);
    layer.appendChild(iconWrapper);

    const startTime = performance.now();

    (function step(now: number): void {
      if (cancelled) return;

      const t    = Math.min((now - startTime) / durationMs, 1);
      const ease = easeInOutQuad(t);
      const { x, y } = positionOnPolyline(pixelPath, ease);

      const live = liveStateForHp ? getUnitById(liveStateForHp, anim.unit.id) : null;
      const maxHp = live?.maxHp ?? anim.unit.maxHp;
      const displayHp = live ? getBoardVisualHp(live, now) : anim.unit.hp;
      const hpRatio = maxHp > 0 ? Math.min(1, Math.max(0, displayHp / maxHp)) : 0;
      const barColor = hpRatio > 0.6 ? c.hpHigh : hpRatio > 0.3 ? c.hpMid : c.hpLow;
      barFill.setAttribute('width', String(animBarW * hpRatio));
      barFill.setAttribute('fill', barColor);

      if (spriteRoot) {
        spriteRoot.setAttribute('transform', `translate(${x},${y}) scale(1,-1) translate(${-x},${-y})`);
      }
      circle.setAttribute('transform', `translate(${x - 25 * unitSc},${y - 32 * unitSc}) scale(${unitSc})`);
      barBg.setAttribute('x',   String(x - animBarW / 2));
      barBg.setAttribute('y',   String(y + HEX_SIZE * 0.13));
      barFill.setAttribute('x', String(x - animBarW / 2));
      barFill.setAttribute('y', String(y + HEX_SIZE * 0.13));
      iconWrapper.setAttribute('transform', `translate(${x},${y - HEX_SIZE * 0.34})`);

      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        if (cancelled) return;
        if (spriteRoot) {
          spriteRoot.remove();
        } else {
          circle.remove(); barBg.remove(); barFill.remove(); iconWrapper.remove();
        }
        completed++;
        if (completed >= animations.length) {
          animLayer!.innerHTML = '';
          callDoneOnce();
        }
      }
    })(performance.now());
  }

  return { cancel };
}


export interface StrikeReturnParams {
  unit: Unit;
  fromCol: number;
  fromRow: number;
  enemyCol: number;
  enemyRow: number;
  durationMs: number;
  /** Fires once when the unit reaches the enemy hex (halfway along the out-and-back path). */
  onHit?: () => void;
}

/** Melee: attacker moves onto the defender hex and returns (both units survived). */
export function animateStrikeAndReturn(
  svgElement: SVGSVGElement,
  params: StrikeReturnParams,
  onDone: () => void,
  /** When set, HP bar on the sprite uses live state + board HP tween each frame. */
  liveStateForHp?: GameState | null,
): { cancel: () => void } {
  const noopCancel = (): void => {};
  const { unit, fromCol, fromRow, enemyCol, enemyRow, durationMs, onHit } = params;

  if (durationMs <= 0) {
    onHit?.();
    onDone();
    return { cancel: noopCancel };
  }

  const pixelPath = [
    hexToPixel(fromCol, fromRow),
    hexToPixel(enemyCol, enemyRow),
    hexToPixel(fromCol, fromRow),
  ];

  const c = colors();
  const flipBoardY = svgElement.dataset.boardFlipY === '1';

  let animLayer = svgElement.querySelector('#anim-layer') as SVGGElement | null;
  if (!animLayer) {
    animLayer = svgEl('g');
    animLayer.id = 'anim-layer';
    animLayer.setAttribute('pointer-events', 'none');
    getBoardVfxParent(svgElement).appendChild(animLayer);
  }
  animLayer.setAttribute('pointer-events', 'none');
  animLayer.innerHTML = '';

  let cancelled = false;
  let doneCalled = false;
  let hitCalled = false;

  function callDoneOnce(): void {
    if (cancelled || doneCalled) return;
    doneCalled = true;
    onDone();
  }

  const cancel = (): void => {
    if (cancelled || doneCalled) return;
    cancelled = true;
    animLayer!.innerHTML = '';
  };

  const spriteRoot = flipBoardY ? svgEl('g') : null;
  const layer: SVGGElement = spriteRoot ?? animLayer!;
  if (spriteRoot) animLayer.appendChild(spriteRoot);

  const baseColor = unit.owner === PLAYER ? c.player : c.ai;
  const live0 = liveStateForHp ? getUnitById(liveStateForHp, unit.id) : null;
  const maxHp0 = live0?.maxHp ?? unit.maxHp;
  const displayHp0 = live0 ? getBoardVisualHp(live0, performance.now()) : unit.hp;
  const hpRatio0 = maxHp0 > 0 ? Math.min(1, Math.max(0, displayHp0 / maxHp0)) : 0;
  const UNIT_PATH_D = 'M0 44.1143V0H25H50V44.1143L25 64L0 44.1143Z';
  const unitSc = (HEX_SIZE * 1.1) / 50;

  const circle = svgEl('path');
  circle.setAttribute('d', UNIT_PATH_D);
  circle.setAttribute('fill', baseColor);
  circle.setAttribute('stroke', 'none');
  circle.setAttribute('pointer-events', 'none');
  layer.appendChild(circle);

  const animBarW = HEX_SIZE * 0.58;
  const barH = HEX_SIZE * 0.1;
  const barBg = svgEl('rect');
  barBg.setAttribute('width', String(animBarW));
  barBg.setAttribute('height', String(barH));
  barBg.setAttribute('fill', '#222');
  barBg.setAttribute('rx', '1');
  barBg.setAttribute('pointer-events', 'none');
  layer.appendChild(barBg);

  const barColor0 = hpRatio0 > 0.6 ? c.hpHigh : hpRatio0 > 0.3 ? c.hpMid : c.hpLow;
  const barFill = svgEl('rect');
  barFill.setAttribute('width', String(animBarW * hpRatio0));
  barFill.setAttribute('height', String(barH));
  barFill.setAttribute('fill', barColor0);
  barFill.setAttribute('rx', '1');
  barFill.setAttribute('pointer-events', 'none');
  layer.appendChild(barFill);

  const iconSrc = unitIcon(unit.unitTypeId);
  const iconSize = HEX_SIZE * 0.4;
  const iconEl = inlineIcon(iconSrc, 0, 0, iconSize, c.unitIconColor, '1');
  const iconWrapper = svgEl('g');
  iconWrapper.setAttribute('pointer-events', 'none');
  if (iconEl) iconWrapper.appendChild(iconEl);
  layer.appendChild(iconWrapper);

  const startTime = performance.now();

  (function step(now: number): void {
    if (cancelled) return;

    const t = Math.min((now - startTime) / durationMs, 1);
    const ease = easeInOutQuad(t);
    const { x, y } = positionOnPolyline(pixelPath, ease);

    if (!hitCalled && t >= 0.5) {
      hitCalled = true;
      onHit?.();
    }

    const live = liveStateForHp ? getUnitById(liveStateForHp, unit.id) : null;
    const maxHp = live?.maxHp ?? unit.maxHp;
    const displayHp = live ? getBoardVisualHp(live, now) : unit.hp;
    const hpRatio = maxHp > 0 ? Math.min(1, Math.max(0, displayHp / maxHp)) : 0;
    const barColor = hpRatio > 0.6 ? c.hpHigh : hpRatio > 0.3 ? c.hpMid : c.hpLow;
    barFill.setAttribute('width', String(animBarW * hpRatio));
    barFill.setAttribute('fill', barColor);

    if (spriteRoot) {
      spriteRoot.setAttribute('transform', `translate(${x},${y}) scale(1,-1) translate(${-x},${-y})`);
    }
    circle.setAttribute('transform', `translate(${x - 25 * unitSc},${y - 32 * unitSc}) scale(${unitSc})`);
    barBg.setAttribute('x', String(x - animBarW / 2));
    barBg.setAttribute('y', String(y + HEX_SIZE * 0.13));
    barFill.setAttribute('x', String(x - animBarW / 2));
    barFill.setAttribute('y', String(y + HEX_SIZE * 0.13));
    iconWrapper.setAttribute('transform', `translate(${x},${y - HEX_SIZE * 0.34})`);

    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      if (cancelled) return;
      if (spriteRoot) {
        spriteRoot.remove();
      } else {
        circle.remove();
        barBg.remove();
        barFill.remove();
        iconWrapper.remove();
      }
      animLayer!.innerHTML = '';
      callDoneOnce();
    }
  })(performance.now());

  return { cancel };
}

type FloatBadgeKind = 'damage' | 'heal';

function showHexFloatBadges(
  svgElement: SVGSVGElement,
  entries: { col: number; row: number; amount: number }[],
  durationMs: number,
  onDone: () => void,
  kind: FloatBadgeKind,
): { cancel: () => void } {
  const noopCancel = (): void => {};

  if (entries.length === 0 || durationMs <= 0) {
    onDone();
    return { cancel: noopCancel };
  }

  const flipBoardY = svgElement.dataset.boardFlipY === '1';

  let vfxLayer = svgElement.querySelector('#vfx-layer') as SVGGElement | null;
  if (!vfxLayer) {
    vfxLayer = svgEl('g');
    vfxLayer.id = 'vfx-layer';
    vfxLayer.setAttribute('pointer-events', 'none');
    getBoardVfxParent(svgElement).appendChild(vfxLayer);
  }

  let cancelled = false;
  let doneCalled = false;
  let timer: number | null = null;

  function callDoneOnce(): void {
    if (cancelled || doneCalled) return;
    doneCalled = true;
    onDone();
  }

  const cancel = (): void => {
    if (cancelled || doneCalled) return;
    cancelled = true;
    if (vfxLayer) vfxLayer.innerHTML = '';
    if (timer !== null) window.clearTimeout(timer);
  };

  const rootClass = kind === 'damage' ? 'damage-float-root' : 'heal-float-root';
  const bgClass = kind === 'damage' ? 'damage-float-bg' : 'heal-float-bg';
  const labelClass = kind === 'damage' ? 'damage-float-label' : 'heal-float-label';

  const stackIndexByHex = new Map<string, number>();
  const STACK_STEP = 20;
  for (const e of entries) {
    const { x, y } = hexToPixel(e.col, e.row);
    const key = `${e.col},${e.row}`;
    const stack = stackIndexByHex.get(key) ?? 0;
    stackIndexByHex.set(key, stack + 1);
    const staggerY = -stack * STACK_STEP;
    const label = kind === 'damage' ? String(e.amount) : `heal +${e.amount}`;
    const outer = svgEl('g');
    outer.setAttribute('transform', `translate(${x},${y - HEX_SIZE * 0.72 + staggerY})`);

    const g = svgEl('g');
    g.setAttribute('class', rootClass);

    const textW = Math.max(22, 7 + label.length * 7);
    const h = 16;
    const rect = svgEl('rect');
    rect.setAttribute('class', bgClass);
    rect.setAttribute('x', String(-textW / 2));
    rect.setAttribute('y', String(-h / 2));
    rect.setAttribute('width', String(textW));
    rect.setAttribute('height', String(h));
    rect.setAttribute('rx', '3');

    const text = svgEl('text');
    text.setAttribute('class', labelClass);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('y', '4');
    text.setAttribute('font-size', '11');
    text.setAttribute('font-weight', '700');
    text.textContent = label;

    g.appendChild(rect);
    g.appendChild(text);
    if (flipBoardY) {
      const upright = svgEl('g');
      upright.setAttribute('transform', 'scale(1,-1)');
      upright.appendChild(g);
      outer.appendChild(upright);
    } else {
      outer.appendChild(g);
    }
    vfxLayer.appendChild(outer);
  }

  timer = window.setTimeout(() => {
    if (cancelled) return;
    vfxLayer!.innerHTML = '';
    callDoneOnce();
  }, durationMs);

  return { cancel };
}

export function showDamageFloats(
  svgElement: SVGSVGElement,
  entries: { col: number; row: number; amount: number }[],
  durationMs: number,
  onDone: () => void,
): { cancel: () => void } {
  return showHexFloatBadges(svgElement, entries, durationMs, onDone, 'damage');
}

/** Green +N badges for end-of-turn healing (same motion/layout as damage floats). */
export function showHealFloats(
  svgElement: SVGSVGElement,
  entries: { col: number; row: number; amount: number }[],
  durationMs: number,
  onDone: () => void,
): { cancel: () => void } {
  return showHexFloatBadges(svgElement, entries, durationMs, onDone, 'heal');
}

/** Clears combat VFX layers (#anim-layer, #vfx-layer) without invoking callbacks. */
export function clearCombatVfxLayers(svgElement: SVGSVGElement): void {
  const anim = svgElement.querySelector('#anim-layer') as SVGGElement | null;
  if (anim) anim.innerHTML = '';
  const vfx = svgElement.querySelector('#vfx-layer') as SVGGElement | null;
  if (vfx) vfx.innerHTML = '';
}

const ARTILLERY_HEX_RADIUS_SCALE = 0.55;

/**
 * Artillery ranged attack: shuffled fan shell streaks on the defender hex (theme reds).
 * Coordinates match the board / damage floats (same layer transform as {@link showDamageFloats}).
 */
export function playRangedArtilleryHexBarrageVfx(
  svgElement: SVGSVGElement,
  col: number,
  row: number,
  onComplete?: () => void,
): ArtilleryProjectileHandle {
  let vfxLayer = svgElement.querySelector('#vfx-layer') as SVGGElement | null;
  if (!vfxLayer) {
    vfxLayer = svgEl('g');
    vfxLayer.id = 'vfx-layer';
    vfxLayer.setAttribute('pointer-events', 'none');
    getBoardVfxParent(svgElement).appendChild(vfxLayer);
  }
  const { x, y } = hexToPixel(col, row);
  return playDefenderHexBarrage({
    parent: vfxLayer,
    center: { x, y },
    hexRadius: HEX_SIZE * ARTILLERY_HEX_RADIUS_SCALE,
    mirrorFanY: svgElement.dataset.boardFlipY === '1',
    onComplete,
  });
}

export function getHexFromEvent(e: MouseEvent): { col: number; row: number } | null {
  const target = (e.target as Element).closest('[data-col]') as HTMLElement | null;
  if (!target) return null;
  return { col: parseInt(target.dataset['col']!), row: parseInt(target.dataset['row']!) };
}

// Draw (or clear) the movement path preview from the unit to a hovered valid-move hex.
// `path` is an array of [col, row] pairs including the unit's start hex; pass [] to clear.
export function renderMovePath(svgElement: SVGSVGElement, path: [number, number][]): void {
  const pathLine = svgElement.querySelector('#move-path-line') as SVGPolylineElement | null;
  if (!pathLine) return;

  // Stop any in-flight preview so rapid hover changes don't stack or fight attributes/styles.
  movePathPreviewTl?.kill();
  movePathPreviewTl = null;
  gsap.killTweensOf(pathLine);
  // GSAP often writes stroke-dash* as inline style; leaving it causes glitches on retarget.
  pathLine.removeAttribute('style');

  if (path.length < 2) {
    pathLine.setAttribute('points', '');
    pathLine.removeAttribute('stroke-dasharray');
    pathLine.removeAttribute('stroke-dashoffset');
    return;
  }

  const pathEase = 'expo.out';

  const points = path.map(([c, r]) => {
    const { x, y } = hexToPixel(c, r);
    return `${x},${y}`;
  }).join(' ');

  pathLine.setAttribute('points', points);
  pathLine.setAttribute('stroke', config.movePathColor);
  pathLine.setAttribute('stroke-width', String(config.movePathStrokeWidth));
  pathLine.setAttribute('opacity', '0.8');

  const pathLen = pathLine.getTotalLength();
  const drawSec = Math.max(0.08, config.movePathDrawDurationMs / 1000);

  pathLine.setAttribute('stroke-dasharray', String(pathLen));
  pathLine.setAttribute('stroke-dashoffset', String(pathLen));

  const tl = gsap.timeline({ defaults: { ease: pathEase } });
  movePathPreviewTl = tl;
  tl.to(pathLine, {
    strokeDashoffset: 0,
    duration: drawSec,
    ease: pathEase,
  });
}
