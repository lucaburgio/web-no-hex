import { hexToPixel, hexPoints, getNeighbors, HEX_SIZE } from './hex.js';
import { COLS, ROWS, PLAYER, AI, getUnit, getUnitById } from './game.js';

const COLORS = {
  empty: '#1a2a1a',
  emptyStroke: '#2d4a2d',
  hover: '#2a3a2a',
  selectedUnit: '#4a8a4a',
  playerUnit: '#3a7a3a',
  aiUnit: '#7a3a3a',
  playerBorder: '#1e3a1e',
  aiBorder: '#3a1e1e',
  validMove: '#2a4a2a',
};

export function initRenderer(svgEl) {
  svgEl.innerHTML = '';

  const margin = HEX_SIZE * 2;
  const W = COLS * HEX_SIZE * Math.sqrt(3) + margin * 2;
  const H = ROWS * HEX_SIZE * 1.5 + HEX_SIZE + margin * 2;

  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svgEl.setAttribute('width', W);
  svgEl.setAttribute('height', H);

  // Background
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', W);
  bg.setAttribute('height', H);
  bg.setAttribute('fill', '#111811');
  svgEl.appendChild(bg);

  // Create hex cells layer
  const hexLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  hexLayer.id = 'hex-layer';
  hexLayer.setAttribute('transform', `translate(${margin},${margin})`);
  svgEl.appendChild(hexLayer);

  // Unit layer
  const unitLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  unitLayer.id = 'unit-layer';
  unitLayer.setAttribute('transform', `translate(${margin},${margin})`);
  svgEl.appendChild(unitLayer);

  // Build hex cells
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const { x, y } = hexToPixel(c, r);
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('points', hexPoints(x, y));
      poly.setAttribute('id', `hex-${c}-${r}`);
      poly.setAttribute('data-col', c);
      poly.setAttribute('data-row', r);
      poly.setAttribute('fill', r === 0 ? COLORS.aiBorder : r === ROWS - 1 ? COLORS.playerBorder : COLORS.empty);
      poly.setAttribute('stroke', COLORS.emptyStroke);
      poly.setAttribute('stroke-width', '0.8');
      poly.style.cursor = 'pointer';
      hexLayer.appendChild(poly);
    }
  }
}

export function renderState(svgEl, state) {
  const margin = HEX_SIZE * 2;
  const unitLayer = svgEl.querySelector('#unit-layer');
  unitLayer.innerHTML = '';

  const selectedUnit = state.selectedUnit !== null ? getUnitById(state, state.selectedUnit) : null;
  let validMoveHexes = new Set();

  if (selectedUnit) {
    const ns = getNeighbors(selectedUnit.col, selectedUnit.row, COLS, ROWS);
    for (const [c, r] of ns) {
      const occ = getUnit(state, c, r);
      if (!occ || occ.owner !== PLAYER) {
        validMoveHexes.add(`${c},${r}`);
      }
    }
  }

  // Reset hex colors
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const poly = svgEl.querySelector(`#hex-${c}-${r}`);
      if (!poly) continue;
      const isValid = validMoveHexes.has(`${c},${r}`);
      const isSelectedHex = selectedUnit && c === selectedUnit.col && r === selectedUnit.row;
      if (isSelectedHex) {
        poly.setAttribute('fill', COLORS.selectedUnit);
      } else if (isValid) {
        poly.setAttribute('fill', COLORS.validMove);
      } else {
        poly.setAttribute('fill', r === 0 ? COLORS.aiBorder : r === ROWS - 1 ? COLORS.playerBorder : COLORS.empty);
      }
    }
  }

  // Draw units
  for (const unit of state.units) {
    const { x, y } = hexToPixel(unit.col, unit.row);
    const isSelected = state.selectedUnit === unit.id;

    // Circle background
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

    // Label
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
