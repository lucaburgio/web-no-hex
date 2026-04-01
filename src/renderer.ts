import { hexToPixel, hexPoints, HEX_SIZE } from './hex';
import { COLS, ROWS, PLAYER, AI, getUnit, getUnitById, isValidProductionPlacement, getValidMoves, isInEnemyZoC } from './game';
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

  const margin = HEX_SIZE * 2;
  const W = COLS * HEX_SIZE * Math.sqrt(3) + margin * 2;
  const H = ROWS * HEX_SIZE * 1.5 + HEX_SIZE + margin * 2;

  svgElement.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svgElement.setAttribute('width', String(W));
  svgElement.setAttribute('height', String(H));

  const bg = svgEl('rect');
  bg.setAttribute('width', String(W));
  bg.setAttribute('height', String(H));
  bg.setAttribute('fill', c.bg);
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

      const dot = svgEl('circle');
      dot.setAttribute('cx', String(x));
      dot.setAttribute('cy', String(y));
      dot.setAttribute('r', '2');
      dot.setAttribute('fill', '#A1A1A1');
      dot.setAttribute('pointer-events', 'none');
      dot.setAttribute('id', `dot-${col}-${r}`);
      hexLayer.appendChild(dot);
    }
  }

  // Movement area boundary overlay (drawn above hexes, below units)
  const boundary = svgEl('path');
  boundary.setAttribute('id', 'move-boundary');
  boundary.setAttribute('fill', 'none');
  boundary.setAttribute('stroke-linecap', 'round');
  boundary.setAttribute('stroke-linejoin', 'round');
  boundary.setAttribute('pointer-events', 'none');
  hexLayer.appendChild(boundary);
}

export function renderState(svgElement: SVGSVGElement, state: GameState, productionHex: { col: number; row: number } | null = null, hiddenUnitIds: Set<number> = new Set()): void {
  const c = colors();
  const unitLayer = svgElement.querySelector('#unit-layer') as SVGGElement;
  unitLayer.innerHTML = '';

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

  const zocHexes = new Set<string>();
  if (selectedUnit) {
    for (const key of validMoveHexes) {
      const [kc, kr] = key.split(',').map(Number);
      if (!getUnit(state, kc, kr) && isInEnemyZoC(state, kc, kr, AI)) {
        zocHexes.add(key);
      }
    }
  }

  const canPlaceHexes = new Set<string>();
  if (state.phase === 'production' && state.activePlayer === PLAYER) {
    for (let r = 0; r < ROWS; r++) {
      for (let col = 0; col < COLS; col++) {
        if (isValidProductionPlacement(state, col, r)) canPlaceHexes.add(`${col},${r}`);
      }
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
      const dot  = svgElement.querySelector(`#dot-${col}-${r}`) as SVGCircleElement | null;
      if (!poly) continue;

      const key                = `${col},${r}`;
      const hexState           = state.hexStates[key];
      const isSelectedHex      = selectedUnit && col === selectedUnit.col && r === selectedUnit.row;
      const isValidMove        = validMoveHexes.has(key);
      const isZoc              = zocHexes.has(key);
      const canPlace           = canPlaceHexes.has(key);
      const isProdSelected     = productionHex && col === productionHex.col && r === productionHex.row;
      const isConquered        = !!hexState;

      if (dot) dot.setAttribute('opacity', isConquered || isSelectedHex || isValidMove || canPlace || isProdSelected ? '0' : '0.5');

      let fill   = c.bg;
      let stroke = 'transparent';

      if (isSelectedHex) {
        fill = c.hexSelected;
      } else if (isZoc) {
        fill = c.hexZoc;
      } else if (isValidMove) {
        fill = c.hexMove;
      } else if (isProdSelected) {
        fill   = c.hexProdSelected;
        stroke = c.unitSelected;
      } else if (canPlace) {
        fill   = c.hexCanPlace;
        stroke = c.player;
      } else if (isConquered) {
        if (hexState.owner === PLAYER) {
          fill = c.hexPlayer;
        } else {
          fill   = c.hexAi;
          stroke = 'transparent';
        }
      }

      poly.setAttribute('fill', fill);
      poly.setAttribute('stroke', stroke);

      // Production marker
      svgElement.querySelector(`#marker-${col}-${r}`)?.remove();
      if (hexState && hexState.isProduction && !isSelectedHex && !isValidMove) {
        const { x, y } = hexToPixel(col, r);
        const s = HEX_SIZE * 0.18;
        const diamond = svgEl('polygon');
        diamond.setAttribute('points', `${x},${y - s} ${x + s},${y} ${x},${y + s} ${x - s},${y}`);
        diamond.setAttribute('fill', hexState.owner === PLAYER ? c.player : c.ai);
        diamond.setAttribute('opacity', '0.4');
        diamond.setAttribute('pointer-events', 'none');
        diamond.setAttribute('id', `marker-${col}-${r}`);
        (svgElement.querySelector('#hex-layer') as SVGGElement).appendChild(diamond);
      }
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
    const opacity   = unit.movedThisTurn ? '0.25' : '1';

    const circle = svgEl('circle');
    circle.setAttribute('cx', String(x));
    circle.setAttribute('cy', String(y));
    circle.setAttribute('r', String(HEX_SIZE * 0.55));
    circle.setAttribute('fill', fill);
    circle.setAttribute('stroke', isSelected ? baseColor : lerpColor(baseColor, '#000000', 0.3));
    circle.setAttribute('stroke-width', isSelected ? '2.5' : '1.2');
    circle.setAttribute('opacity', opacity);
    circle.setAttribute('data-col', String(unit.col));
    circle.setAttribute('data-row', String(unit.row));
    circle.style.cursor = 'pointer';
    unitLayer.appendChild(circle);

    // HP bar
    const barW = HEX_SIZE * 1.0;
    const barH = HEX_SIZE * 0.14;
    const barX = x - barW / 2;
    const barY = y + HEX_SIZE * 0.64;

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

    // Icon
    const icon = unitIcon(unit.unitTypeId);
    if (icon) {
      const iconSize = HEX_SIZE * 0.6;
      const img = svgEl('image') as unknown as SVGImageElement;
      img.setAttribute('href', `/${icon}`);
      img.setAttribute('x', String(x - iconSize / 2));
      img.setAttribute('y', String(y - iconSize / 2));
      img.setAttribute('width', String(iconSize));
      img.setAttribute('height', String(iconSize));
      img.setAttribute('pointer-events', 'none');
      img.setAttribute('opacity', opacity);
      unitLayer.appendChild(img);
    }
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
  const margin = HEX_SIZE * 2;

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

    const circle = svgEl('circle');
    circle.setAttribute('r', String(HEX_SIZE * 0.55));
    circle.setAttribute('fill', lerpColor(baseColor, '#333333', 1 - hpRatio));
    circle.setAttribute('stroke', lerpColor(baseColor, '#000000', 0.3));
    circle.setAttribute('stroke-width', '1.2');
    circle.setAttribute('pointer-events', 'none');
    animLayer!.appendChild(circle);

    const barW = HEX_SIZE * 1.0;
    const barH = HEX_SIZE * 0.14;
    const barBg = svgEl('rect');
    barBg.setAttribute('width', String(barW)); barBg.setAttribute('height', String(barH));
    barBg.setAttribute('fill', '#222'); barBg.setAttribute('rx', '1');
    barBg.setAttribute('pointer-events', 'none');
    animLayer!.appendChild(barBg);

    const barColor = hpRatio > 0.6 ? c.hpHigh : hpRatio > 0.3 ? c.hpMid : c.hpLow;
    const barFill = svgEl('rect');
    barFill.setAttribute('width', String(barW * hpRatio)); barFill.setAttribute('height', String(barH));
    barFill.setAttribute('fill', barColor); barFill.setAttribute('rx', '1');
    barFill.setAttribute('pointer-events', 'none');
    animLayer!.appendChild(barFill);

    const iconSrc = unitIcon(anim.unit.unitTypeId);
    const iconSize = HEX_SIZE * 0.6;
    const iconImg = iconSrc ? svgEl('image') as unknown as SVGImageElement : null;
    if (iconImg) {
      iconImg.setAttribute('href', `/${iconSrc}`);
      iconImg.setAttribute('width', String(iconSize));
      iconImg.setAttribute('height', String(iconSize));
      iconImg.setAttribute('pointer-events', 'none');
      animLayer!.appendChild(iconImg);
    }

    const startTime = performance.now();

    (function step(now: number): void {
      const t    = Math.min((now - startTime) / durationMs, 1);
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // ease-in-out
      const x    = from.x + (to.x - from.x) * ease;
      const y    = from.y + (to.y - from.y) * ease;

      circle.setAttribute('cx', String(x));
      circle.setAttribute('cy', String(y));
      barBg.setAttribute('x',   String(x - barW / 2));
      barBg.setAttribute('y',   String(y + HEX_SIZE * 0.64));
      barFill.setAttribute('x', String(x - barW / 2));
      barFill.setAttribute('y', String(y + HEX_SIZE * 0.64));
      if (iconImg) {
        iconImg.setAttribute('x', String(x - iconSize / 2));
        iconImg.setAttribute('y', String(y - iconSize / 2));
      }

      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        circle.remove(); barBg.remove(); barFill.remove(); iconImg?.remove();
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
