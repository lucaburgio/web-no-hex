import { hexToPixel, hexPoints, getNeighbors, HEX_SIZE } from './hex.js';
import { COLS, ROWS, PLAYER, AI, getUnit, getUnitById, isValidProductionPlacement } from './game.js';

const COLORS = {
  empty:            '#1a2a1a',
  emptyStroke:      '#2d4a2d',
  // Territory — conquered but not yet production
  playerOwned:      '#1a3d1a',
  aiOwned:          '#3d1a1a',
  // Territory — stable enough to spawn units
  playerProduction: '#1a5225',
  aiProduction:     '#521a1a',
  // Interaction highlights
  selectedUnit:     '#4a8a4a',
  validMove:        '#2a5a2a',
  canPlace:         '#0d3d20',   // empty hex player can place on this turn
  // Unit fills
  playerUnit:       '#3a7a3a',
  aiUnit:           '#7a3a3a',
};

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
    for (const [c, r] of getNeighbors(selectedUnit.col, selectedUnit.row, COLS, ROWS)) {
      const occ = getUnit(state, c, r);
      if (!occ || occ.owner !== PLAYER) validMoveHexes.add(`${c},${r}`);
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
      const canPlace      = canPlaceHexes.has(key);
      const hexState      = state.hexStates[key];

      if (isSelectedHex) {
        poly.setAttribute('fill', COLORS.selectedUnit);
      } else if (isValidMove) {
        poly.setAttribute('fill', COLORS.validMove);
      } else if (hexState) {
        // Conquered territory
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

      // Production hex icon: small diamond marker
      const existingMarker = svgEl.querySelector(`#marker-${c}-${r}`);
      if (existingMarker) existingMarker.remove();
      if (hexState && hexState.isProduction && !isSelectedHex && !isValidMove) {
        const { x, y } = hexToPixel(c, r);
        const margin = HEX_SIZE * 2;
        const mx = x + margin; // account for group transform
        const my = y + margin;
        // small diamond
        const diamond = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        const s = HEX_SIZE * 0.22;
        diamond.setAttribute('points', `${x},${y - s} ${x + s},${y} ${x},${y + s} ${x - s},${y}`);
        diamond.setAttribute('fill', hexState.owner === PLAYER ? '#3aff6a' : '#ff3a3a');
        diamond.setAttribute('opacity', '0.35');
        diamond.setAttribute('pointer-events', 'none');
        diamond.setAttribute('id', `marker-${c}-${r}`);
        svgEl.querySelector('#hex-layer').appendChild(diamond);
      }
    }
  }

  // canPlace highlight ring (when no territory color to override)
  for (const key of canPlaceHexes) {
    const [c, r] = key.split(',').map(Number);
    const poly = svgEl.querySelector(`#hex-${c}-${r}`);
    if (!poly) continue;
    const hexState = state.hexStates[key];
    // Only apply canPlace color if not already colored by territory
    if (!hexState || hexState.owner !== PLAYER) {
      poly.setAttribute('fill', COLORS.canPlace);
    }
  }

  // Draw units
  for (const unit of state.units) {
    const { x, y } = hexToPixel(unit.col, unit.row);
    const isSelected = state.selectedUnit === unit.id;

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', HEX_SIZE * 0.65);
    circle.setAttribute('fill', unit.owner === PLAYER ? COLORS.playerUnit : COLORS.aiUnit);
    circle.setAttribute('stroke', isSelected ? '#aaffaa' : unit.owner === PLAYER ? '#5aaa5a' : '#aa5a5a');
    circle.setAttribute('stroke-width', isSelected ? 2.5 : 1.5);
    circle.setAttribute('data-col', unit.col);
    circle.setAttribute('data-row', unit.row);
    circle.style.cursor = 'pointer';
    unitLayer.appendChild(circle);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', y + 4);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '9');
    text.setAttribute('font-family', 'monospace');
    text.setAttribute('fill', '#e0e0e0');
    text.setAttribute('pointer-events', 'none');
    text.textContent = unit.owner === PLAYER ? `P${unit.id}` : `A${unit.id}`;
    unitLayer.appendChild(text);
  }
}

export function getHexFromEvent(svgEl, e) {
  const target = e.target.closest('[data-col]');
  if (!target) return null;
  return { col: parseInt(target.dataset.col), row: parseInt(target.dataset.row) };
}
