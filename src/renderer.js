import { hexToPixel, hexPoints, HEX_SIZE } from './hex.js';
import { COLS, ROWS, PLAYER, getUnit, getUnitById, isValidProductionPlacement, getValidMoves, isInEnemyZoC } from './game.js';

// Corner-bracket dash params — one full cycle = one hex edge (HEX_SIZE)
const BRACKET     = 0.22;
const DASH        = HEX_SIZE * BRACKET * 2;
const GAP         = HEX_SIZE * (1 - BRACKET * 2);
const DASH_OFFSET = HEX_SIZE * BRACKET;

// CSS color variables — read once after DOM is ready, then cached
let C = null;
function colors() {
  if (C) return C;
  const s = getComputedStyle(document.documentElement);
  const v = n => s.getPropertyValue(n).trim();
  C = {
    bg:           v('--color-bg'),
    player:       v('--color-player'),
    ai:           v('--color-ai'),
    unitSelected: v('--color-unit-selected'),
    hexSelected:  v('--color-hex-selected'),
    hexMove:      v('--color-hex-valid-move'),
    hexPlayer:    v('--color-hex-player'),
    hexAi:        v('--color-hex-ai'),
    hexCanPlace:     v('--color-hex-can-place'),
    hexProdSelected: v('--color-hex-prod-selected'),
    hexZoc:          v('--color-hex-zoc'),
    moveBorder:   v('--color-move-border'),
    hpHigh:       v('--color-hp-high'),
    hpMid:        v('--color-hp-mid'),
    hpLow:        v('--color-hp-low'),
  };
  return C;
}

// Lerp between two #rrggbb hex colours by t (0→1)
function lerpColor(hex1, hex2, t) {
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
const DIRS_EVEN = [[1,0],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1]]; // even rows
const DIRS_ODD  = [[1,0],[1,1],[0,1],[-1,0],[0,-1],[1,-1]];   // odd rows

// Build an SVG path `d` tracing only the outer boundary of a set of hexes.
// Each boundary edge (where a neighbor is outside the set) is emitted as M…L.
function buildBoundaryPath(hexSet) {
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

export function initRenderer(svgEl) {
  svgEl.innerHTML = '';
  const c = colors();

  const margin = HEX_SIZE * 2;
  const W = COLS * HEX_SIZE * Math.sqrt(3) + margin * 2;
  const H = ROWS * HEX_SIZE * 1.5 + HEX_SIZE + margin * 2;

  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svgEl.setAttribute('width', W);
  svgEl.setAttribute('height', H);

  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', W);
  bg.setAttribute('height', H);
  bg.setAttribute('fill', c.bg);
  svgEl.appendChild(bg);

  const hexLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  hexLayer.id = 'hex-layer';
  hexLayer.setAttribute('transform', `translate(${margin},${margin})`);
  svgEl.appendChild(hexLayer);

  const unitLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  unitLayer.id = 'unit-layer';
  unitLayer.setAttribute('transform', `translate(${margin},${margin})`);
  svgEl.appendChild(unitLayer);

  for (let r = 0; r < ROWS; r++) {
    for (let col = 0; col < COLS; col++) {
      const { x, y } = hexToPixel(col, r);

      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('points', hexPoints(x, y));
      poly.setAttribute('id', `hex-${col}-${r}`);
      poly.setAttribute('data-col', col);
      poly.setAttribute('data-row', r);
      poly.setAttribute('fill', c.bg);
      poly.setAttribute('stroke', 'transparent');
      poly.setAttribute('stroke-width', '2.5');
      poly.setAttribute('stroke-dasharray', `${DASH} ${GAP}`);
      poly.setAttribute('stroke-dashoffset', DASH_OFFSET);
      poly.style.cursor = 'pointer';
      hexLayer.appendChild(poly);

      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', y);
      dot.setAttribute('r', 2);
      dot.setAttribute('fill', '#A1A1A1');
      dot.setAttribute('pointer-events', 'none');
      dot.setAttribute('id', `dot-${col}-${r}`);
      hexLayer.appendChild(dot);
    }
  }

  // Movement area boundary overlay (drawn above hexes, below units)
  const boundary = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  boundary.setAttribute('id', 'move-boundary');
  boundary.setAttribute('fill', 'none');
  boundary.setAttribute('stroke-linecap', 'round');
  boundary.setAttribute('stroke-linejoin', 'round');
  boundary.setAttribute('pointer-events', 'none');
  hexLayer.appendChild(boundary);
}

export function renderState(svgEl, state, productionHex = null) {
  const c = colors();
  const unitLayer = svgEl.querySelector('#unit-layer');
  unitLayer.innerHTML = '';

  const selectedUnit = state.selectedUnit !== null ? getUnitById(state, state.selectedUnit) : null;

  const validMoveHexes = new Set();
  if (selectedUnit) {
    for (const [col, row] of getValidMoves(state, selectedUnit)) {
      validMoveHexes.add(`${col},${row}`);
    }
  }

  // Full move area = selected hex + valid destinations (used for perimeter outline)
  const moveAreaHexes = new Set(validMoveHexes);
  if (selectedUnit) moveAreaHexes.add(`${selectedUnit.col},${selectedUnit.row}`);

  const zocHexes = new Set();
  if (selectedUnit) {
    for (const key of validMoveHexes) {
      const [kc, kr] = key.split(',').map(Number);
      if (!getUnit(state, kc, kr) && isInEnemyZoC(state, kc, kr, 2)) {
        zocHexes.add(key);
      }
    }
  }

  const canPlaceHexes = new Set();
  if (state.phase === 'production' && state.activePlayer === PLAYER) {
    for (let r = 0; r < ROWS; r++) {
      for (let col = 0; col < COLS; col++) {
        if (isValidProductionPlacement(state, col, r)) canPlaceHexes.add(`${col},${r}`);
      }
    }
  }

  // Update move area perimeter outline
  const boundary = svgEl.querySelector('#move-boundary');
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
      const poly = svgEl.querySelector(`#hex-${col}-${r}`);
      const dot  = svgEl.querySelector(`#dot-${col}-${r}`);
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
        // no per-hex bracket — perimeter outline covers the whole move area
      } else if (isZoc) {
        fill = c.hexZoc;
        // ZoC warning takes priority over valid-move color
      } else if (isValidMove) {
        fill = c.hexMove;
        // no per-hex bracket — perimeter outline covers the whole move area
      } else if (isProdSelected) {
        fill   = c.hexProdSelected;
        stroke = c.unitSelected; // yellow bracket to match the selected-unit color
      } else if (canPlace) {
        fill   = c.hexCanPlace;
        stroke = c.player;
      } else if (isConquered) {
        if (hexState.owner === PLAYER) {
          fill = c.hexPlayer;
        } else {
          fill   = c.hexAi;
          stroke = 'transparent'; // no bracket on AI territory
        }
      } else if (isZoc) {
        fill = c.hexZoc;
      }

      poly.setAttribute('fill', fill);
      poly.setAttribute('stroke', stroke);

      // Production marker
      svgEl.querySelector(`#marker-${col}-${r}`)?.remove();
      if (hexState && hexState.isProduction && !isSelectedHex && !isValidMove) {
        const { x, y } = hexToPixel(col, r);
        const s = HEX_SIZE * 0.18;
        const diamond = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        diamond.setAttribute('points', `${x},${y - s} ${x + s},${y} ${x},${y + s} ${x - s},${y}`);
        diamond.setAttribute('fill', hexState.owner === PLAYER ? c.player : c.ai);
        diamond.setAttribute('opacity', '0.4');
        diamond.setAttribute('pointer-events', 'none');
        diamond.setAttribute('id', `marker-${col}-${r}`);
        svgEl.querySelector('#hex-layer').appendChild(diamond);
      }
    }
  }

  // Draw units
  for (const unit of state.units) {
    const { x, y } = hexToPixel(unit.col, unit.row);
    const isSelected = state.selectedUnit === unit.id;
    const hpRatio    = unit.hp / unit.maxHp;

    const baseColor = unit.owner === PLAYER ? c.player : c.ai;
    const fill      = isSelected ? c.unitSelected : lerpColor(baseColor, '#333333', 1 - hpRatio);
    const opacity   = unit.movedThisTurn ? '0.25' : '1';

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', HEX_SIZE * 0.55);
    circle.setAttribute('fill', fill);
    circle.setAttribute('stroke', isSelected ? baseColor : lerpColor(baseColor, '#000000', 0.3));
    circle.setAttribute('stroke-width', isSelected ? 2.5 : 1.2);
    circle.setAttribute('opacity', opacity);
    circle.setAttribute('data-col', unit.col);
    circle.setAttribute('data-row', unit.row);
    circle.style.cursor = 'pointer';
    unitLayer.appendChild(circle);

    // HP bar
    const barW = HEX_SIZE * 1.0;
    const barH = HEX_SIZE * 0.14;
    const barX = x - barW / 2;
    const barY = y + HEX_SIZE * 0.64;

    const barBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    barBg.setAttribute('x', barX); barBg.setAttribute('y', barY);
    barBg.setAttribute('width', barW); barBg.setAttribute('height', barH);
    barBg.setAttribute('fill', '#222'); barBg.setAttribute('rx', 1);
    barBg.setAttribute('pointer-events', 'none');
    barBg.setAttribute('opacity', opacity);
    unitLayer.appendChild(barBg);

    const barColor = hpRatio > 0.6 ? c.hpHigh : hpRatio > 0.3 ? c.hpMid : c.hpLow;
    const barFill = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    barFill.setAttribute('x', barX); barFill.setAttribute('y', barY);
    barFill.setAttribute('width', barW * hpRatio); barFill.setAttribute('height', barH);
    barFill.setAttribute('fill', barColor); barFill.setAttribute('rx', 1);
    barFill.setAttribute('pointer-events', 'none');
    barFill.setAttribute('opacity', opacity);
    unitLayer.appendChild(barFill);

    // Label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', y + 4);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '9');
    text.setAttribute('font-family', 'monospace');
    text.setAttribute('fill', unit.owner === PLAYER ? '#0a0a0a' : '#ffffff');
    text.setAttribute('pointer-events', 'none');
    text.setAttribute('opacity', opacity);
    text.textContent = unit.owner === PLAYER ? `P${unit.id}` : `A${unit.id}`;
    unitLayer.appendChild(text);
  }
}

export function getHexFromEvent(e) {
  const target = e.target.closest('[data-col]');
  if (!target) return null;
  return { col: parseInt(target.dataset.col), row: parseInt(target.dataset.row) };
}
