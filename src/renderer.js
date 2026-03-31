import { hexToPixel, hexPoints, HEX_SIZE } from './hex.js';
import { COLS, ROWS, PLAYER, getUnit, getUnitById, isValidProductionPlacement, getValidMoves, isInEnemyZoC } from './game.js';

const COLORS = {
  empty:            '#2C2C2C',
  emptyStroke:      '#424242',
  playerOwned:      '#1a3d1a',
  aiOwned:          '#3d1a1a',
  playerProduction: '#1a5225',
  aiProduction:     '#521a1a',
  selectedUnit:     '#4a8a4a',
  validMove:        '#2a5a2a',
  canPlace:         '#0d3d20',
  zoc:              '#3a1a1a',   // enemy ZoC hex tint
  playerUnit:       '#3a7a3a',
  aiUnit:           '#7a3a3a',
};

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
  bg.setAttribute('fill', '#111811');
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
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('points', hexPoints(x, y));
      poly.setAttribute('id', `hex-${c}-${r}`);
      poly.setAttribute('data-col', c);
      poly.setAttribute('data-row', r);
      poly.setAttribute('fill', COLORS.empty);
      poly.setAttribute('stroke', COLORS.emptyStroke);
      poly.setAttribute('stroke-width', '0.8');
      poly.style.cursor = 'pointer';
      hexLayer.appendChild(poly);
    }
  }
}

export function renderState(svgEl, state) {
  const unitLayer = svgEl.querySelector('#unit-layer');
  unitLayer.innerHTML = '';

  const selectedUnit = state.selectedUnit !== null ? getUnitById(state, state.selectedUnit) : null;

  // Valid move targets for selected unit
  const validMoveHexes = new Set();
  if (selectedUnit) {
    for (const [c, r] of getValidMoves(state, selectedUnit)) {
      validMoveHexes.add(`${c},${r}`);
    }
  }

  // Enemy ZoC hexes (shown during movement phase when nothing is selected)
  const zocHexes = new Set();
  if (state.phase === 'movement' && state.activePlayer === PLAYER) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (!getUnit(state, c, r) && isInEnemyZoC(state, c, r, state.activePlayer === PLAYER ? 2 : 1)) {
          zocHexes.add(`${c},${r}`);
        }
      }
    }
  }

  // Valid placement hexes during production phase
  const canPlaceHexes = new Set();
  if (state.phase === 'production' && state.activePlayer === PLAYER) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (isValidProductionPlacement(state, c, r)) canPlaceHexes.add(`${c},${r}`);
      }
    }
  }

  // Update hex fills
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const poly = svgEl.querySelector(`#hex-${c}-${r}`);
      if (!poly) continue;

      const key = `${c},${r}`;
      const isSelectedHex = selectedUnit && c === selectedUnit.col && r === selectedUnit.row;
      const isValidMove   = validMoveHexes.has(key);
      const isZoc         = zocHexes.has(key);
      const canPlace      = canPlaceHexes.has(key);
      const hexState      = state.hexStates[key];

      if (isSelectedHex) {
        poly.setAttribute('fill', COLORS.selectedUnit);
      } else if (isValidMove) {
        poly.setAttribute('fill', COLORS.validMove);
      } else if (isZoc) {
        poly.setAttribute('fill', COLORS.zoc);
      } else if (hexState) {
        if (hexState.isProduction) {
          poly.setAttribute('fill', hexState.owner === PLAYER ? COLORS.playerProduction : COLORS.aiProduction);
        } else {
          poly.setAttribute('fill', hexState.owner === PLAYER ? COLORS.playerOwned : COLORS.aiOwned);
        }
      } else if (canPlace) {
        poly.setAttribute('fill', COLORS.canPlace);
      } else {
        poly.setAttribute('fill', COLORS.empty);
      }

      // Remove old production marker and redraw if needed
      svgEl.querySelector(`#marker-${c}-${r}`)?.remove();
      if (hexState && hexState.isProduction && !isSelectedHex && !isValidMove) {
        const { x, y } = hexToPixel(c, r);
        const s = HEX_SIZE * 0.22;
        const diamond = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        diamond.setAttribute('points', `${x},${y - s} ${x + s},${y} ${x},${y + s} ${x - s},${y}`);
        diamond.setAttribute('fill', hexState.owner === PLAYER ? '#3aff6a' : '#ff3a3a');
        diamond.setAttribute('opacity', '0.35');
        diamond.setAttribute('pointer-events', 'none');
        diamond.setAttribute('id', `marker-${c}-${r}`);
        svgEl.querySelector('#hex-layer').appendChild(diamond);
      }
    }
  }

  // Apply canPlace tint only where territory doesn't already colour it
  for (const key of canPlaceHexes) {
    const [c, r] = key.split(',').map(Number);
    const poly = svgEl.querySelector(`#hex-${c}-${r}`);
    if (!poly) continue;
    const hexState = state.hexStates[key];
    if (!hexState || hexState.owner !== PLAYER) poly.setAttribute('fill', COLORS.canPlace);
  }

  // Draw units
  for (const unit of state.units) {
    const { x, y } = hexToPixel(unit.col, unit.row);
    const isSelected  = state.selectedUnit === unit.id;
    const hpRatio     = unit.hp / unit.maxHp;

    // Wounded tint: lerp unit color toward grey as HP drops
    const baseColor = unit.owner === PLAYER ? COLORS.playerUnit : COLORS.aiUnit;
    const fill = lerpColor(baseColor, '#555555', 1 - hpRatio);

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', HEX_SIZE * 0.65);
    circle.setAttribute('fill', fill);
    circle.setAttribute('stroke', isSelected ? '#aaffaa' : unit.owner === PLAYER ? '#5aaa5a' : '#aa5a5a');
    circle.setAttribute('stroke-width', isSelected ? 2.5 : 1.5);
    circle.setAttribute('opacity', unit.movedThisTurn ? '0.2' : '1');
    circle.setAttribute('data-col', unit.col);
    circle.setAttribute('data-row', unit.row);
    circle.style.cursor = 'pointer';
    unitLayer.appendChild(circle);

    // HP bar
    const barW = HEX_SIZE * 1.1;
    const barH = HEX_SIZE * 0.18;
    const barX = x - barW / 2;
    const barY = y + HEX_SIZE * 0.72;

    // Background
    const barBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    barBg.setAttribute('x', barX);
    barBg.setAttribute('y', barY);
    barBg.setAttribute('width', barW);
    barBg.setAttribute('height', barH);
    barBg.setAttribute('fill', '#222');
    barBg.setAttribute('rx', 2);
    barBg.setAttribute('pointer-events', 'none');
    barBg.setAttribute('opacity', unit.movedThisTurn ? '0.2' : '1');
    unitLayer.appendChild(barBg);

    // Fill
    const barColor = hpRatio > 0.6 ? '#4aaa4a' : hpRatio > 0.3 ? '#aaaa22' : '#aa3a3a';
    const barFill = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    barFill.setAttribute('x', barX);
    barFill.setAttribute('y', barY);
    barFill.setAttribute('width', barW * hpRatio);
    barFill.setAttribute('height', barH);
    barFill.setAttribute('fill', barColor);
    barFill.setAttribute('rx', 2);
    barFill.setAttribute('pointer-events', 'none');
    barFill.setAttribute('opacity', unit.movedThisTurn ? '0.2' : '1');
    unitLayer.appendChild(barFill);

    // Label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', y + 4);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '9');
    text.setAttribute('font-family', 'monospace');
    text.setAttribute('fill', '#e0e0e0');
    text.setAttribute('pointer-events', 'none');
    text.setAttribute('opacity', unit.movedThisTurn ? '0.2' : '1');
    text.textContent = unit.owner === PLAYER ? `P${unit.id}` : `A${unit.id}`;
    unitLayer.appendChild(text);
  }
}

export function getHexFromEvent(e) {
  const target = e.target.closest('[data-col]');
  if (!target) return null;
  return { col: parseInt(target.dataset.col), row: parseInt(target.dataset.row) };
}
