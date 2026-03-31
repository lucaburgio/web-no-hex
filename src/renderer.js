import { hexToPixel, hexPoints, HEX_SIZE } from './hex.js';
import { COLS, ROWS, PLAYER, getUnit, getUnitById, isValidProductionPlacement, getValidMoves, isInEnemyZoC } from './game.js';
import config from './gameconfig.js';

// Corner-bracket dash params — one full cycle = one hex edge (HEX_SIZE)
// Each bracket leg = BRACKET * HEX_SIZE on each side of a vertex
const BRACKET     = 0.22;
const DASH        = HEX_SIZE * BRACKET * 2;        // total dash length
const GAP         = HEX_SIZE * (1 - BRACKET * 2);  // gap in the middle of each edge
const DASH_OFFSET = HEX_SIZE * BRACKET;             // centers dash on each vertex

const BG = '#0a0a0a';

// Lerp between two hex colours by t (0→1)
function lerpColor(hex1, hex2, t) {
  const r1 = parseInt(hex1.slice(1, 3), 16), g1 = parseInt(hex1.slice(3, 5), 16), b1 = parseInt(hex1.slice(5, 7), 16);
  const r2 = parseInt(hex2.slice(1, 3), 16), g2 = parseInt(hex2.slice(3, 5), 16), b2 = parseInt(hex2.slice(5, 7), 16);
  const r = Math.round(r1 + (r2 - r1) * t).toString(16).padStart(2, '0');
  const g = Math.round(g1 + (g2 - g1) * t).toString(16).padStart(2, '0');
  const b = Math.round(b1 + (b2 - b1) * t).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

export function initRenderer(svgEl) {
  svgEl.innerHTML = '';

  const margin = HEX_SIZE * 2;
  const W = COLS * HEX_SIZE * Math.sqrt(3) + margin * 2;
  const H = ROWS * HEX_SIZE * 1.5 + HEX_SIZE + margin * 2;

  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svgEl.setAttribute('width', W);
  svgEl.setAttribute('height', H);

  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', W);
  bg.setAttribute('height', H);
  bg.setAttribute('fill', BG);
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
    for (let c = 0; c < COLS; c++) {
      const { x, y } = hexToPixel(c, r);

      // Hex polygon — bracket dash is baked in; stroke color is toggled in renderState
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('points', hexPoints(x, y));
      poly.setAttribute('id', `hex-${c}-${r}`);
      poly.setAttribute('data-col', c);
      poly.setAttribute('data-row', r);
      poly.setAttribute('fill', BG);
      poly.setAttribute('stroke', 'transparent');
      poly.setAttribute('stroke-width', '2.5');
      poly.setAttribute('stroke-dasharray', `${DASH} ${GAP}`);
      poly.setAttribute('stroke-dashoffset', DASH_OFFSET);
      poly.style.cursor = 'pointer';
      hexLayer.appendChild(poly);

      // Center dot — shown only on neutral hexes
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', y);
      dot.setAttribute('r', 2);
      dot.setAttribute('fill', '#A1A1A1');
      dot.setAttribute('pointer-events', 'none');
      dot.setAttribute('id', `dot-${c}-${r}`);
      hexLayer.appendChild(dot);
    }
  }
}

export function renderState(svgEl, state) {
  const unitLayer = svgEl.querySelector('#unit-layer');
  unitLayer.innerHTML = '';

  const selectedUnit = state.selectedUnit !== null ? getUnitById(state, state.selectedUnit) : null;

  const validMoveHexes = new Set();
  if (selectedUnit) {
    for (const [c, r] of getValidMoves(state, selectedUnit)) {
      validMoveHexes.add(`${c},${r}`);
    }
  }

  const zocHexes = new Set();
  if (state.phase === 'movement' && state.activePlayer === PLAYER) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (!getUnit(state, c, r) && isInEnemyZoC(state, c, r, 2)) {
          zocHexes.add(`${c},${r}`);
        }
      }
    }
  }

  const canPlaceHexes = new Set();
  if (state.phase === 'production' && state.activePlayer === PLAYER) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (isValidProductionPlacement(state, c, r)) canPlaceHexes.add(`${c},${r}`);
      }
    }
  }

  // Update each hex
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const poly = svgEl.querySelector(`#hex-${c}-${r}`);
      const dot  = svgEl.querySelector(`#dot-${c}-${r}`);
      if (!poly) continue;

      const key           = `${c},${r}`;
      const hexState      = state.hexStates[key];
      const isSelectedHex = selectedUnit && c === selectedUnit.col && r === selectedUnit.row;
      const isValidMove   = validMoveHexes.has(key);
      const isZoc         = zocHexes.has(key);
      const canPlace      = canPlaceHexes.has(key);
      const isConquered   = !!hexState;

      // Dot: hide when hex is conquered or highlighted
      if (dot) dot.setAttribute('opacity', isConquered || isSelectedHex || isValidMove || canPlace ? '0' : '0.5');

      // Determine fill + bracket stroke color
      let fill   = BG;
      let stroke = 'transparent';

      if (isSelectedHex) {
        fill   = '#1e2e1e';
        stroke = config.playerColor;
      } else if (isValidMove) {
        fill   = '#0d200d';
        stroke = config.playerColor;
      } else if (isConquered) {
        const ownerColor = hexState.owner === PLAYER ? config.playerColor : config.aiColor;
        fill   = hexState.owner === PLAYER ? '#141414' : '#180606';
        stroke = isZoc ? ownerColor : ownerColor;  // always show bracket on conquered
      } else if (canPlace) {
        fill   = '#0a1a10';
        stroke = config.playerColor;
      } else if (isZoc) {
        fill   = '#160404';
        stroke = 'transparent';
      }

      poly.setAttribute('fill', fill);
      poly.setAttribute('stroke', stroke);

      // Production marker
      svgEl.querySelector(`#marker-${c}-${r}`)?.remove();
      if (hexState && hexState.isProduction && !isSelectedHex && !isValidMove) {
        const { x, y } = hexToPixel(c, r);
        const s = HEX_SIZE * 0.18;
        const diamond = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        diamond.setAttribute('points', `${x},${y - s} ${x + s},${y} ${x},${y + s} ${x - s},${y}`);
        diamond.setAttribute('fill', hexState.owner === PLAYER ? config.playerColor : config.aiColor);
        diamond.setAttribute('opacity', '0.4');
        diamond.setAttribute('pointer-events', 'none');
        diamond.setAttribute('id', `marker-${c}-${r}`);
        svgEl.querySelector('#hex-layer').appendChild(diamond);
      }
    }
  }

  // Draw units
  for (const unit of state.units) {
    const { x, y } = hexToPixel(unit.col, unit.row);
    const isSelected = state.selectedUnit === unit.id;
    const hpRatio    = unit.hp / unit.maxHp;

    const baseColor = unit.owner === PLAYER ? config.playerColor : config.aiColor;
    const fill      = lerpColor(baseColor, '#333333', 1 - hpRatio);
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

    const barColor = hpRatio > 0.6 ? '#aaaaaa' : hpRatio > 0.3 ? '#888822' : '#882222';
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
