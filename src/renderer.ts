import gsap from 'gsap';
import { hexToPixel, hexPoints, HEX_SIZE, getNeighbors } from './hex';
import { COLS, ROWS, PLAYER, AI, getUnit, getUnitById, isValidProductionPlacement, getValidMoves, getRangedAttackTargets, isInEnemyZoC } from './game';
import type { Owner } from './types';
import type { GameState, Unit } from './types';
import config from './gameconfig';

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

const DECOR_RINGS = 4;

export function initRenderer(svgElement: SVGSVGElement): void {
  svgElement.innerHTML = '';
  const c = colors();

  const boardMargin = 100;
  const decorMargin = Math.ceil(DECOR_RINGS * HEX_SIZE * Math.sqrt(3)) + HEX_SIZE;
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

  // Decorative hex layer — ghost hexes ringing the board, rendered first (below everything).
  // Uses decorMargin so hexes align with the board, but the layer overflows the SVG layout box.
  const decorLayer = svgEl('g');
  decorLayer.setAttribute('transform', `translate(${boardMargin},${boardMargin})`);
  decorLayer.setAttribute('pointer-events', 'none');
  svgElement.appendChild(decorLayer);

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
  hexLayer.setAttribute('transform', `translate(${boardMargin},${boardMargin})`);
  svgElement.appendChild(hexLayer);

  const unitLayer = svgEl('g');
  unitLayer.id = 'unit-layer';
  unitLayer.setAttribute('transform', `translate(${boardMargin},${boardMargin})`);
  svgElement.appendChild(unitLayer);

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
  movePathLayer.setAttribute('transform', `translate(${boardMargin},${boardMargin})`);
  movePathLayer.setAttribute('pointer-events', 'none');
  svgElement.insertBefore(movePathLayer, unitLayer);

  const pathLine = svgEl('polyline');
  pathLine.id = 'move-path-line';
  pathLine.setAttribute('fill', 'none');
  pathLine.setAttribute('stroke-linecap', 'round');
  pathLine.setAttribute('stroke-linejoin', 'round');
  pathLine.setAttribute('pointer-events', 'none');
  movePathLayer.appendChild(pathLine);
}

export function renderState(svgElement: SVGSVGElement, state: GameState, productionHex: { col: number; row: number } | null = null, hiddenUnitIds: Set<number> = new Set(), localPlayer: Owner = PLAYER): void {
  const c = colors();
  const unitLayer = svgElement.querySelector('#unit-layer') as SVGGElement;
  unitLayer.innerHTML = '';

  const mountainSet = new Set(state.mountainHexes ?? []);

  const selectedUnit = state.selectedUnit !== null ? getUnitById(state, state.selectedUnit) : null;

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
      mountainLayer.appendChild(img);
    }
  }

  // Draw units
  for (const unit of state.units) {
    if (hiddenUnitIds.has(unit.id)) continue;
    const { x, y } = hexToPixel(unit.col, unit.row);
    const isSelected = state.selectedUnit === unit.id;
    const hpRatio    = unit.hp / unit.maxHp;

    const baseColor = unit.owner === PLAYER ? c.player : c.ai;
    const isRangedTarget = rangedTargetKeys.has(`${unit.col},${unit.row}`);
    const fill      = isRangedTarget ? c.rangedTarget : isSelected ? c.unitSelected : baseColor;
    const unitDimmed = productionFocusHexes.size > 0;
    const opacity   = (unit.movesUsed >= unit.movement || unitDimmed) ? '0.2' : '1';

    const UNIT_PATH_D = 'M0 44.1143V0H25H50V44.1143L25 64L0 44.1143Z';
    const sc = (HEX_SIZE * 1.1) / 50;
    const unitEl = svgEl('path');
    unitEl.setAttribute('d', UNIT_PATH_D);
    unitEl.setAttribute('fill', fill);
    unitEl.setAttribute('stroke', 'none');
    unitEl.setAttribute('opacity', opacity);
    unitEl.setAttribute('data-col', String(unit.col));
    unitEl.setAttribute('data-row', String(unit.row));
    unitEl.setAttribute('transform', `translate(${x - 25 * sc},${y - 32 * sc}) scale(${sc})`);
    unitEl.style.cursor = "url('/icons/pointer.svg') 13 14, pointer";
    unitLayer.appendChild(unitEl);

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
    unitLayer.appendChild(barBg);

    const barColor = hpRatio > 0.6 ? c.hpHigh : hpRatio > 0.3 ? c.hpMid : c.hpLow;
    const barFill = svgEl('rect');
    barFill.setAttribute('x', String(barX)); barFill.setAttribute('y', String(barY));
    barFill.setAttribute('width', String(barW * hpRatio)); barFill.setAttribute('height', String(barH));
    barFill.setAttribute('fill', barColor); barFill.setAttribute('rx', '1');
    barFill.setAttribute('pointer-events', 'none');
    barFill.setAttribute('opacity', opacity);
    unitLayer.appendChild(barFill);

    // Icon (shifted up inside shape)
    const icon = unitIcon(unit.unitTypeId);
    const iconColor = isRangedTarget ? '#ffffff' : c.unitIconColor;
    const iconEl = inlineIcon(icon, x, y - HEX_SIZE * 0.34, HEX_SIZE * 0.4, iconColor, opacity);
    if (iconEl) unitLayer.appendChild(iconEl);

    if (isRangedTarget) {
      const aim = inlineIcon('icons/artillery.svg', x, y - HEX_SIZE * 0.76, HEX_SIZE * 0.36, c.rangedTarget, opacity);
      if (aim) {
        const aimWrap = svgEl('g');
        aimWrap.setAttribute('class', 'ranged-target-aim');
        aimWrap.appendChild(aim);
        unitLayer.appendChild(aimWrap);
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
): { cancel: () => void } {
  const noopCancel = (): void => {};

  if (animations.length === 0 || durationMs <= 0) {
    onDone();
    return { cancel: noopCancel };
  }

  const c = colors();
  const margin = 100;

  let animLayer = svgElement.querySelector('#anim-layer') as SVGGElement | null;
  if (!animLayer) {
    animLayer = svgEl('g');
    animLayer.id = 'anim-layer';
    animLayer.setAttribute('transform', `translate(${margin},${margin})`);
    svgElement.appendChild(animLayer);
  }
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
    const hpRatio   = anim.unit.hp / anim.unit.maxHp;

    const UNIT_PATH_D = 'M0 44.1143V0H25H50V44.1143L25 64L0 44.1143Z';
    const animFill = baseColor;
    const unitSc = (HEX_SIZE * 1.1) / 50;
    const circle = svgEl('path');
    circle.setAttribute('d', UNIT_PATH_D);
    circle.setAttribute('fill', animFill);
    circle.setAttribute('stroke', 'none');
    circle.setAttribute('pointer-events', 'none');
    animLayer!.appendChild(circle);

    const animBarW = HEX_SIZE * 0.58;
    const barH = HEX_SIZE * 0.1;
    const barBg = svgEl('rect');
    barBg.setAttribute('width', String(animBarW)); barBg.setAttribute('height', String(barH));
    barBg.setAttribute('fill', '#222'); barBg.setAttribute('rx', '1');
    barBg.setAttribute('pointer-events', 'none');
    animLayer!.appendChild(barBg);

    const barColor = hpRatio > 0.6 ? c.hpHigh : hpRatio > 0.3 ? c.hpMid : c.hpLow;
    const barFill = svgEl('rect');
    barFill.setAttribute('width', String(animBarW * hpRatio)); barFill.setAttribute('height', String(barH));
    barFill.setAttribute('fill', barColor); barFill.setAttribute('rx', '1');
    barFill.setAttribute('pointer-events', 'none');
    animLayer!.appendChild(barFill);

    const iconSrc = unitIcon(anim.unit.unitTypeId);
    const iconSize = HEX_SIZE * 0.4;
    // Place icon at (0,0) so its internal scale stays fixed; a wrapper <g> handles translation each frame.
    const iconEl = inlineIcon(iconSrc, 0, 0, iconSize, c.unitIconColor, '1');
    const iconWrapper = svgEl('g');
    iconWrapper.setAttribute('pointer-events', 'none');
    if (iconEl) iconWrapper.appendChild(iconEl);
    animLayer!.appendChild(iconWrapper);

    const startTime = performance.now();

    (function step(now: number): void {
      if (cancelled) return;

      const t    = Math.min((now - startTime) / durationMs, 1);
      const ease = easeInOutQuad(t);
      const { x, y } = positionOnPolyline(pixelPath, ease);

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
        circle.remove(); barBg.remove(); barFill.remove(); iconWrapper.remove();
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
