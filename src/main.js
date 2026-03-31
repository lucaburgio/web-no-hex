import {
  createInitialState,
  playerPlaceUnit,
  playerSelectUnit,
  playerMoveUnit,
  playerEndMovement,
  getUnit,
  PLAYER, ROWS,
} from './game.js';
import { initRenderer, renderState, getHexFromEvent } from './renderer.js';

const svg = document.getElementById('board');
const logEl = document.getElementById('log');
const phaseEl = document.getElementById('phase');
const turnEl = document.getElementById('turn');
const endMoveBtn = document.getElementById('end-move-btn');
const overlayEl = document.getElementById('overlay');
const overlayMsg = document.getElementById('overlay-msg');
const restartBtn = document.getElementById('restart-btn');

let state = createInitialState();
initRenderer(svg);
renderState(svg, state);
updateUI();

svg.addEventListener('click', e => {
  if (state.winner) return;
  const hex = getHexFromEvent(svg, e);
  if (!hex) return;
  const { col, row } = hex;

  if (state.phase === 'production' && state.activePlayer === PLAYER) {
    if (row === ROWS - 1) {
      state = playerPlaceUnit(state, col);
    } else {
      flashLog('Place your unit on the bottom border row.');
    }
  } else if (state.phase === 'movement' && state.activePlayer === PLAYER) {
    if (state.selectedUnit === null) {
      state = playerSelectUnit(state, col, row);
    } else {
      // If clicking own unit: re-select it instead of moving
      const target = getUnit(state, col, row);
      if (target && target.owner === PLAYER) {
        state = playerSelectUnit(state, col, row);
      } else {
        state = playerMoveUnit(state, col, row);
      }
    }
  }

  renderState(svg, state);
  updateUI();
  checkWinner();
});

endMoveBtn.addEventListener('click', () => {
  if (state.phase !== 'movement' || state.activePlayer !== PLAYER) return;
  state = playerEndMovement(state);
  renderState(svg, state);
  updateUI();
  checkWinner();
});

restartBtn.addEventListener('click', () => {
  state = createInitialState();
  initRenderer(svg);
  renderState(svg, state);
  overlayEl.classList.add('hidden');
  updateUI();
});

function updateUI() {
  turnEl.textContent = `Turn ${state.turn}`;
  phaseEl.textContent = state.phase.charAt(0).toUpperCase() + state.phase.slice(1);
  endMoveBtn.style.display =
    state.phase === 'movement' && state.activePlayer === PLAYER ? 'inline-block' : 'none';

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

function flashLog(msg) {
  const li = document.createElement('li');
  li.textContent = msg;
  li.style.color = '#ffaa44';
  logEl.insertBefore(li, logEl.firstChild);
  setTimeout(() => li.remove(), 3000);
}
