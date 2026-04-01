import {
  createInitialState,
  playerPlaceUnit,
  playerEndProduction,
  playerSelectUnit,
  playerMoveUnit,
  playerEndMovement,
  getUnit,
  isValidProductionPlacement,
  PLAYER,
} from './game.js';
import { initRenderer, renderState, getHexFromEvent } from './renderer.js';
import config from './gameconfig.js';

const svg        = document.getElementById('board');
const logEl      = document.getElementById('log');
const phaseEl    = document.getElementById('phase');
const turnEl     = document.getElementById('turn');
const ppDisplay  = document.getElementById('pp-display');
const endMoveBtn = document.getElementById('end-move-btn');
const overlayEl  = document.getElementById('overlay');
const overlayMsg = document.getElementById('overlay-msg');
const restartBtn = document.getElementById('restart-btn');

const unitPickerEl   = document.getElementById('unit-picker');
const unitPickerHex  = document.getElementById('unit-picker-hex');
const unitPickerList = document.getElementById('unit-picker-list');

let state = createInitialState();
let pendingProductionHex = null; // hex currently selected in the unit picker

function render() {
  renderState(svg, state, pendingProductionHex);
}

initRenderer(svg);
render();
updateUI();

// ── Unit picker ───────────────────────────────────────────────────────────────

function showUnitPicker(col, row) {
  pendingProductionHex = { col, row };
  unitPickerHex.textContent = `Hex (${col}, ${row})`;
  unitPickerList.innerHTML = '';

  for (const unitType of config.unitTypes) {
    const btn = document.createElement('button');
    btn.className = 'unit-btn';
    btn.textContent = `${unitType.name}  —  ${unitType.cost} PP`;
    btn.disabled = state.productionPoints[PLAYER] < unitType.cost;
    btn.addEventListener('click', () => {
      state = playerPlaceUnit(state, col, row, unitType.id);
      // Hex is now occupied — close picker; player picks a new hex if needed
      hideUnitPicker();
      render();
      updateUI();
      checkWinner();
    });
    unitPickerList.appendChild(btn);
  }

  unitPickerEl.style.display = 'block';
}

function hideUnitPicker() {
  pendingProductionHex = null;
  unitPickerEl.style.display = 'none';
}

// ── Board click ───────────────────────────────────────────────────────────────

svg.addEventListener('click', e => {
  if (state.winner) return;
  const hex = getHexFromEvent(e);
  if (!hex) return;
  const { col, row } = hex;

  if (state.phase === 'production' && state.activePlayer === PLAYER) {
    if (isValidProductionPlacement(state, col, row)) {
      showUnitPicker(col, row);
    } else {
      hideUnitPicker();
    }
    render();
  } else if (state.phase === 'movement' && state.activePlayer === PLAYER) {
    if (state.selectedUnit === null) {
      state = playerSelectUnit(state, col, row);
    } else {
      const target = getUnit(state, col, row);
      if (target && target.owner === PLAYER) {
        state = playerSelectUnit(state, col, row);
      } else {
        state = playerMoveUnit(state, col, row);
      }
    }
    render();
    updateUI();
    checkWinner();
  }
});

// ── End phase button ──────────────────────────────────────────────────────────

endMoveBtn.addEventListener('click', () => {
  if (state.phase === 'production' && state.activePlayer === PLAYER) {
    state = playerEndProduction(state);
    hideUnitPicker();
    render();
    updateUI();
    checkWinner();
  } else if (state.phase === 'movement' && state.activePlayer === PLAYER) {
    state = playerEndMovement(state);
    render();
    updateUI();
    checkWinner();
  }
});

restartBtn.addEventListener('click', () => {
  state = createInitialState();
  initRenderer(svg);
  hideUnitPicker();
  render();
  overlayEl.classList.add('hidden');
  updateUI();
});

// ── UI helpers ────────────────────────────────────────────────────────────────

function updateUI() {
  turnEl.textContent  = `Turn ${state.turn}`;
  phaseEl.textContent = state.phase.charAt(0).toUpperCase() + state.phase.slice(1);
  ppDisplay.textContent = state.productionPoints[PLAYER];

  const isPlayerTurn = state.activePlayer === PLAYER;
  if (state.phase === 'production' && isPlayerTurn) {
    endMoveBtn.style.display = 'inline-block';
    endMoveBtn.textContent   = 'End Production';
  } else if (state.phase === 'movement' && isPlayerTurn) {
    endMoveBtn.style.display = 'inline-block';
    endMoveBtn.textContent   = 'End Movement';
  } else {
    endMoveBtn.style.display = 'none';
  }

  logEl.innerHTML = '';
  for (const msg of state.log) {
    const li = document.createElement('li');
    li.textContent = msg;
    logEl.appendChild(li);
  }
}

function checkWinner() {
  if (state.winner) {
    overlayMsg.textContent = state.winner === PLAYER ? 'You win!' : 'AI wins.';
    overlayEl.classList.remove('hidden');
  }
}
