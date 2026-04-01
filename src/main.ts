import {
  createInitialState,
  playerPlaceUnit,
  playerEndProduction,
  playerSelectUnit,
  playerMoveUnit,
  playerEndMovement,
  getUnit,
  getUnitById,
  getValidMoves,
  isValidProductionPlacement,
  forecastCombat,
  PLAYER,
  AI,
} from './game';
import { initRenderer, renderState, getHexFromEvent } from './renderer';
import config from './gameconfig';
import type { GameState, Unit, CombatForecast } from './types';

const svg        = document.getElementById('board') as unknown as SVGSVGElement;
const logEl      = document.getElementById('log') as HTMLUListElement;
const phaseEl    = document.getElementById('phase') as HTMLElement;
const turnEl     = document.getElementById('turn') as HTMLElement;
const ppDisplay  = document.getElementById('pp-display') as HTMLElement;
const endMoveBtn = document.getElementById('end-move-btn') as HTMLButtonElement;
const overlayEl  = document.getElementById('overlay') as HTMLDivElement;
const overlayMsg = document.getElementById('overlay-msg') as HTMLDivElement;
const restartBtn = document.getElementById('restart-btn') as HTMLButtonElement;

const unitPickerEl   = document.getElementById('unit-picker') as HTMLDivElement;
const unitPickerHex  = document.getElementById('unit-picker-hex') as HTMLDivElement;
const unitPickerList = document.getElementById('unit-picker-list') as HTMLDivElement;

const autoEndProductionEl = document.getElementById('auto-end-production') as HTMLInputElement;
const autoEndMovementEl   = document.getElementById('auto-end-movement') as HTMLInputElement;
autoEndProductionEl.checked = config.autoEndProduction;
autoEndMovementEl.checked   = config.autoEndMovement;

const rulesOverlayEl = document.getElementById('rules-overlay') as HTMLDivElement;
document.getElementById('rules-btn')!.addEventListener('click', () => rulesOverlayEl.classList.remove('hidden'));
document.getElementById('rules-close')!.addEventListener('click', () => rulesOverlayEl.classList.add('hidden'));
rulesOverlayEl.addEventListener('click', e => { if (e.target === rulesOverlayEl) rulesOverlayEl.classList.add('hidden'); });

let state: GameState = createInitialState();
let pendingProductionHex: { col: number; row: number } | null = null;

function render(): void {
  renderState(svg, state, pendingProductionHex);
}

initRenderer(svg);
render();
updateUI();
maybeAutoEnd();

// ── Unit picker ───────────────────────────────────────────────────────────────

function showUnitPicker(col: number, row: number): void {
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
      hideUnitPicker();
      render();
      updateUI();
      checkWinner();
      maybeAutoEnd();
    });
    unitPickerList.appendChild(btn);
  }

  unitPickerEl.style.display = 'block';
}

function hideUnitPicker(): void {
  pendingProductionHex = null;
  unitPickerEl.style.display = 'none';
}

// ── Board click ───────────────────────────────────────────────────────────────

svg.addEventListener('click', (e: MouseEvent) => {
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
    maybeAutoEnd();
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
  maybeAutoEnd();
});

// ── Auto-end helpers ──────────────────────────────────────────────────────────

function canAffordAnyUnit(): boolean {
  return config.unitTypes.some(u => state.productionPoints[PLAYER] >= u.cost);
}

function hasAnyValidMove(): boolean {
  return state.units
    .filter(u => u.owner === PLAYER && !u.movedThisTurn)
    .some(u => getValidMoves(state, u).length > 0);
}

function maybeAutoEnd(): void {
  if (state.winner || state.activePlayer !== PLAYER) return;
  if (state.phase === 'production' && autoEndProductionEl.checked && !canAffordAnyUnit()) {
    state = playerEndProduction(state);
    hideUnitPicker();
    render();
    updateUI();
    checkWinner();
  } else if (state.phase === 'movement' && autoEndMovementEl.checked && !hasAnyValidMove()) {
    state = playerEndMovement(state);
    render();
    updateUI();
    checkWinner();
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function updateUI(): void {
  turnEl.textContent  = `Turn ${state.turn}`;
  phaseEl.textContent = state.phase.charAt(0).toUpperCase() + state.phase.slice(1);
  ppDisplay.textContent = String(state.productionPoints[PLAYER]);

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

function checkWinner(): void {
  if (state.winner) {
    overlayMsg.textContent = state.winner === PLAYER ? 'You win!' : 'AI wins.';
    overlayEl.classList.remove('hidden');
  }
}

// ── Combat forecast tooltip ───────────────────────────────────────────────────

const tooltipEl = document.getElementById('combat-tooltip') as HTMLDivElement;

function hpBarColor(ratio: number): string {
  if (ratio > 0.6) return 'var(--color-hp-high)';
  if (ratio > 0.3) return 'var(--color-hp-mid)';
  return 'var(--color-hp-low)';
}

interface SideFactors {
  cs: number;
  conditionPct: number;
  flankCount: number;
  flankBonusPct: number;
}

function buildSideHTML(unit: Unit, dmg: number, hpAfter: number, label: string, labelClass: string, factors: SideFactors): string {
  const curRatio = unit.hp / unit.maxHp;
  const aftRatio = hpAfter / unit.maxHp;
  const curColor = hpBarColor(curRatio);
  const aftColor = hpBarColor(aftRatio);
  return `
    <div class="tt-side">
      <div class="tt-side-label ${labelClass}">${label}</div>
      <div class="tt-hp-block">
        <div class="tt-bar-wrap">
          <div class="tt-bar current" style="width:${curRatio*100}%;background:${curColor}"></div>
        </div>
        <div class="tt-bar-wrap">
          <div class="tt-bar after" style="width:${aftRatio*100}%;background:${aftColor}"></div>
        </div>
        <div class="tt-hp-nums">${unit.hp} → ${hpAfter} HP</div>
      </div>
      <div class="tt-dmg">−${dmg} damage</div>
      <div class="tt-cs">CS: ${factors.cs}</div>
      <div class="tt-factors">
        <div>· Strength: ${unit.strength}</div>
        <div>· Condition: ${factors.conditionPct}%</div>
        ${factors.flankBonusPct > 0 ? `<div>· Flanking ×${factors.flankCount}: +${factors.flankBonusPct}%</div>` : ''}
      </div>
    </div>`;
}

function showCombatTooltip(attacker: Unit, defender: Unit, pageX: number, pageY: number): void {
  const fc: CombatForecast = forecastCombat(state, attacker, defender);

  const attackerFactors: SideFactors = {
    cs: fc.attackerCS,
    conditionPct: fc.attackerConditionPct,
    flankCount: fc.flankingCount,
    flankBonusPct: fc.flankBonusPct,
  };
  const defenderFactors: SideFactors = {
    cs: fc.defenderCS,
    conditionPct: fc.defenderConditionPct,
    flankCount: 0,
    flankBonusPct: 0,
  };

  let outcomeText: string, outcomeClass: string;
  if (fc.attackerDies && fc.defenderDies) {
    outcomeText = 'Both units destroyed'; outcomeClass = 'both';
  } else if (fc.defenderDies) {
    outcomeText = 'Enemy destroyed';      outcomeClass = 'win';
  } else if (fc.attackerDies) {
    outcomeText = 'Your unit destroyed';  outcomeClass = 'lose';
  } else {
    outcomeText = 'Both units survive';   outcomeClass = 'none';
  }

  const attackerLabel = `You (P${attacker.id})`;
  const defenderLabel = `AI (A${defender.id})`;

  tooltipEl.innerHTML = `
    <div class="tt-title">Combat Forecast</div>
    <div class="tt-columns">
      ${buildSideHTML(attacker, fc.dmgToAttacker, fc.attackerHpAfter, attackerLabel, 'attacker', attackerFactors)}
      ${buildSideHTML(defender, fc.dmgToDefender, fc.defenderHpAfter, defenderLabel, 'defender', defenderFactors)}
    </div>
    <hr class="tt-divider">
    <div class="tt-outcome ${outcomeClass}">→ ${outcomeText}</div>`;

  tooltipEl.classList.remove('hidden');
  positionTooltip(pageX, pageY);
}

function positionTooltip(pageX: number, pageY: number): void {
  const offset = 14;
  let left = pageX + offset;
  let top  = pageY + offset;
  const rect = tooltipEl.getBoundingClientRect();
  if (left + rect.width  > window.innerWidth)  left = pageX - rect.width  - offset;
  if (top  + rect.height > window.innerHeight) top  = pageY - rect.height - offset;
  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top  = `${top}px`;
}

svg.addEventListener('mousemove', (e: MouseEvent) => {
  if (state.phase !== 'movement' || state.activePlayer !== PLAYER || state.selectedUnit === null) {
    tooltipEl.classList.add('hidden');
    return;
  }
  const hex = getHexFromEvent(e);
  if (!hex) { tooltipEl.classList.add('hidden'); return; }

  const attacker = getUnitById(state, state.selectedUnit);
  if (!attacker) { tooltipEl.classList.add('hidden'); return; }

  const target = getUnit(state, hex.col, hex.row);
  if (!target || target.owner !== AI) { tooltipEl.classList.add('hidden'); return; }

  const validMoves = getValidMoves(state, attacker);
  const canAttack = validMoves.some(([c, r]) => c === hex.col && r === hex.row);
  if (!canAttack) { tooltipEl.classList.add('hidden'); return; }

  showCombatTooltip(attacker, target, e.pageX, e.pageY);
});

svg.addEventListener('mouseleave', () => {
  tooltipEl.classList.add('hidden');
});
