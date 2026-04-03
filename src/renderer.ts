import { hexToPixel, hexPoints, HEX_SIZE } from './hex';
import { COLS, ROWS, PLAYER, AI, getUnit, getUnitById, isValidProductionPlacement, getValidMoves, isInEnemyZoC } from './game';
import type { Owner } from './types';
import type { GameState, Unit } from './types';
import config from './gameconfig';

export interface MoveAnimation {
  unit: Unit;      // snapshot of the unit before moving (owner/hp for colour)
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
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
  'icons/grade.svg': {
    viewBox: 18,
    mode: 'fill',
    paths: ['M11.6748 6.64258C11.6754 6.64381 11.6784 6.64827 11.6826 6.65625C11.6931 6.67582 11.7135 6.71514 11.7451 6.77051C11.8086 6.88164 11.9134 7.05668 12.0586 7.27441C12.3523 7.71495 12.7927 8.30151 13.3711 8.87988C14.5441 10.0529 16.0763 11.001 18 11.001V17.001C13.9237 17.001 10.9559 14.9491 9.12891 13.1221C9.085 13.0782 9.04283 13.0331 9 12.9893C8.95717 13.0331 8.915 13.0782 8.87109 13.1221C7.0441 14.9491 4.07627 17.001 0 17.001V11.001C1.92373 11.001 3.4559 10.0529 4.62891 8.87988C5.20727 8.30151 5.64772 7.71495 5.94141 7.27441C6.08656 7.05668 6.19138 6.88164 6.25488 6.77051C6.28652 6.71514 6.30695 6.67582 6.31738 6.65625L6.32324 6.64648L9 1.29297L11.6748 6.64258ZM6.31836 6.65527L6.31738 6.65723L6.32031 6.65234C6.31983 6.65331 6.31891 6.65417 6.31836 6.65527ZM11.6826 6.65723L11.6816 6.65527C11.6811 6.65417 11.6802 6.65331 11.6797 6.65234L11.6826 6.65723Z'],
  },
  'icons/tank.svg': {
    viewBox: 18,
    mode: 'fill',
    paths: ['M9 0.5L15.5 3.5V10.5C15.5 14.5 9 17.5 9 17.5C9 17.5 2.5 14.5 2.5 10.5V3.5Z'],
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
  };
  return C;
}

// Lerp between two #rrggbb hex colours by t (0→1)
function lerpColor(hex1: string, hex2: string, t: number): string {
  const r1 = parseInt(hex1.slice(1,3),16), g1 = parseInt(hex1.slice(3,5),16), b1 = parseInt(hex1.slice(5,7),16);
  const r2 = parseInt(hex2.slice(1,3),16), g2 = parseInt(hex2.slice(3,5),16), b2 = parseInt(hex2.slice(5,7),16);
  const r = Math.round(r1+(r2-r1)*t).toString(16).padStart(2,'0');
  const g = Math.round(g1+(g2-g1)*t).toString(16).padStart(2,'0');
  const b = Math.round(b1+(b2-b1)*t).toString(16).padStart(2,'0');
  return `#${r}${g}${b}`;
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

export function initRenderer(svgElement: SVGSVGElement): void {
  svgElement.innerHTML = '';
  const c = colors();

  const margin = 100;
  const W = COLS * HEX_SIZE * Math.sqrt(3) + margin * 2;
  const H = ROWS * HEX_SIZE * 1.5 + HEX_SIZE + margin * 2;

  svgElement.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svgElement.setAttribute('width', String(W));
  svgElement.setAttribute('height', String(H));

  const bg = svgEl('rect');
  bg.setAttribute('width', String(W));
  bg.setAttribute('height', String(H));
  bg.setAttribute('fill', 'transparent');
  svgElement.appendChild(bg);

  const hexLayer = svgEl('g');
  hexLayer.id = 'hex-layer';
  hexLayer.setAttribute('transform', `translate(${margin},${margin})`);
  svgElement.appendChild(hexLayer);

  const unitLayer = svgEl('g');
  unitLayer.id = 'unit-layer';
  unitLayer.setAttribute('transform', `translate(${margin},${margin})`);
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
      poly.style.cursor = 'pointer';
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
}

export function renderState(svgElement: SVGSVGElement, state: GameState, productionHex: { col: number; row: number } | null = null, hiddenUnitIds: Set<number> = new Set(), localPlayer: Owner = PLAYER): void {
  const c = colors();
  const unitLayer = svgElement.querySelector('#unit-layer') as SVGGElement;
  unitLayer.innerHTML = '';

  const mountainSet = new Set(state.mountainHexes ?? []);

  const selectedUnit = state.selectedUnit !== null ? getUnitById(state, state.selectedUnit) : null;

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
  if (selectedUnit) {
    for (const key of validMoveHexes) {
      const [kc, kr] = key.split(',').map(Number);
      if (!getUnit(state, kc, kr) && isInEnemyZoC(state, kc, kr, zocEnemy)) {
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
      poly.style.cursor = isMountain ? 'default' : 'pointer';

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
    const fill      = isSelected ? c.unitSelected : lerpColor(baseColor, '#333333', 1 - hpRatio);
    const unitDimmed = productionFocusHexes.size > 0;
    const opacity   = (unit.movedThisTurn || unitDimmed) ? '0.2' : '1';

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
    unitEl.style.cursor = 'pointer';
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
    const iconEl = inlineIcon(icon, x, y - HEX_SIZE * 0.34, HEX_SIZE * 0.4, c.unitIconColor, opacity);
    if (iconEl) unitLayer.appendChild(iconEl);
  }
}

// Animate a list of unit moves sequentially, then call onDone.
// During animation the caller should hide the moving units from the static render
// (pass their ids to renderState's hiddenUnitIds) so they don't ghost at the destination.
export function animateMoves(
  svgElement: SVGSVGElement,
  animations: MoveAnimation[],
  durationMs: number,
  onDone: () => void,
): void {
  if (animations.length === 0 || durationMs <= 0) { onDone(); return; }

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

  let completed = 0;

  for (const anim of animations) {
    const from = hexToPixel(anim.fromCol, anim.fromRow);
    const to   = hexToPixel(anim.toCol,   anim.toRow);
    const baseColor = anim.unit.owner === PLAYER ? c.player : c.ai;
    const hpRatio   = anim.unit.hp / anim.unit.maxHp;

    const UNIT_PATH_D = 'M0 44.1143V0H25H50V44.1143L25 64L0 44.1143Z';
    const animFill = lerpColor(baseColor, '#333333', 1 - hpRatio);
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
      const t    = Math.min((now - startTime) / durationMs, 1);
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // ease-in-out
      const x    = from.x + (to.x - from.x) * ease;
      const y    = from.y + (to.y - from.y) * ease;

      circle.setAttribute('transform', `translate(${x - 25 * unitSc},${y - 32 * unitSc}) scale(${unitSc})`);
      barBg.setAttribute('x',   String(x - animBarW / 2));
      barBg.setAttribute('y',   String(y + HEX_SIZE * 0.13));
      barFill.setAttribute('x', String(x - animBarW / 2));
      barFill.setAttribute('y', String(y + HEX_SIZE * 0.13));
      iconWrapper.setAttribute('transform', `translate(${x},${y - HEX_SIZE * 0.34})`);

      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        circle.remove(); barBg.remove(); barFill.remove(); iconWrapper.remove();
        completed++;
        if (completed >= animations.length) {
          animLayer!.innerHTML = '';
          onDone();
        }
      }
    })(performance.now());
  }
}

export function getHexFromEvent(e: MouseEvent): { col: number; row: number } | null {
  const target = (e.target as Element).closest('[data-col]') as HTMLElement | null;
  if (!target) return null;
  return { col: parseInt(target.dataset['col']!), row: parseInt(target.dataset['row']!) };
}
