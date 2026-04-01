import {
  createInitialState,
  playerPlaceUnit,
  playerEndProduction,
  playerSelectUnit,
  playerMoveUnit,
  playerEndMovement,
  prepareAiTurn,
  aiMovement,
  endTurnAfterAi,
  getUnit,
  getUnitById,
  getValidMoves,
  isValidProductionPlacement,
  forecastCombat,
  PLAYER,
  AI,
} from './game';
import { initRenderer, renderState, animateMoves, getHexFromEvent } from './renderer';
import type { MoveAnimation } from './renderer';
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

function buildRulesContent(): string {
  const unitList = config.unitTypes.map(u => `<strong>${u.name}</strong> (${u.cost} PP)`).join(', ');
  const maxFlankBonus = Math.round(config.maxFlankingUnits * config.flankingBonus * 100);
  return `
    <h2>Game Rules</h2>

    <h3>Overview</h3>
    <p>Turn-based hex strategy on a ${config.boardCols}×${config.boardRows} grid.
       You play from the south (bottom row); the AI plays from the north (top row).</p>

    <h3>Turn Phases</h3>
    <ol>
      <li><strong>Production</strong> — spend PP to place units.</li>
      <li><strong>Movement</strong> — move each of your units up to 1 hex.</li>
      <li><strong>End</strong> — AI takes its turn, then the turn counter advances.</li>
    </ol>

    <h3>Production</h3>
    <ul>
      <li>Each turn you earn <strong>${config.productionPointsPerTurn} PP</strong> (production points).</li>
      <li><strong>Territory bonus:</strong> +${config.pointsPerQuota} PP for every ${config.territoryQuota} hexes you own.</li>
      <li>Available units: ${unitList}.</li>
      <li>Valid placement: your <strong>home row</strong> (bottom), or any owned <strong>production hex</strong>.</li>
      <li><strong>Production hex:</strong> an owned hex stable for <strong>${config.productionTurns} consecutive turns</strong>.
        Stability requires all hexes within distance ${config.productionSafeDistance} to be owned by you.
        Resets immediately if that condition breaks.</li>
      <li>You can place multiple units per turn as long as you have PP.</li>
    </ul>

    <h3>Movement</h3>
    <ul>
      <li>Each unit may move <strong>1 hex</strong> per turn. Moving onto an empty hex <strong>conquers</strong> it.</li>
      <li>Moving onto an enemy unit triggers <strong>combat</strong>.</li>
      <li><strong>Zone of Control (ZoC):</strong> a unit adjacent to an enemy is locked — it may only attack
        or retreat to a hex not itself adjacent to any enemy.</li>
    </ul>

    <h3>Combat</h3>
    <ul>
      <li>Both sides deal damage <strong>simultaneously</strong>.</li>
      <li><strong>CS</strong> = base strength (${config.unitBaseStrength}) × condition (50–100% of HP) × flanking bonus.</li>
      <li><strong>Flanking:</strong> +${Math.round(config.flankingBonus * 100)}% CS per adjacent friendly
        (max ${config.maxFlankingUnits} flankers = +${maxFlankBonus}%).</li>
      <li><strong>Damage:</strong> <code>floor(${config.combatDamageBase} × exp(±ΔCS / ${config.combatStrengthScale}))</code>, min 1 per side.</li>
      <li>If defender dies: attacker advances and conquers the hex. If both die: both removed.</li>
      <li>Hover over an enemy unit during movement to see a combat forecast.</li>
    </ul>

    <h3>Healing</h3>
    <ul>
      <li>Units that did <strong>not</strong> fight this turn heal at end of turn.</li>
      <li>+${config.healOwnTerritory} HP on <strong>own territory</strong> ·
          +${config.healNeutral} HP on <strong>neutral</strong> ·
          +${config.healEnemyTerritory} HP on <strong>enemy territory</strong>.</li>
    </ul>

    <h3>Victory</h3>
    <ul>
      <li>Move a unit onto the <strong>opponent's home row</strong>, or <strong>eliminate all enemy units</strong>.</li>
    </ul>
  `;
}

(document.getElementById('rules-content') as HTMLDivElement).innerHTML = buildRulesContent();

let state: GameState = createInitialState();
let pendingProductionHex: { col: number; row: number } | null = null;
let isAnimating = false;

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
  if (state.winner || isAnimating) return;
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
      render(); updateUI();
    } else {
      const target = getUnit(state, col, row);
      if (target && target.owner === PLAYER) {
        state = playerSelectUnit(state, col, row);
        render(); updateUI();
      } else {
        // Snapshot the moving unit before state changes
        const movingUnitId = state.selectedUnit;
        const movingUnit = getUnitById(state, movingUnitId)!;
        const fromCol = movingUnit.col, fromRow = movingUnit.row;

        state = playerMoveUnit(state, col, row);

        const unitAfter = getUnitById(state, movingUnitId);
        const toCol = unitAfter?.col ?? col;
        const toRow = unitAfter?.row ?? row;

        if (fromCol !== toCol || fromRow !== toRow) {
          isAnimating = true;
          renderState(svg, state, pendingProductionHex, new Set([movingUnitId]));
          updateUI();
          animateMoves(svg, [{ unit: movingUnit, fromCol, fromRow, toCol, toRow }], config.unitMoveSpeed, () => {
            isAnimating = false;
            render(); checkWinner(); maybeAutoEnd();
          });
        } else {
          render(); updateUI(); checkWinner(); maybeAutoEnd();
        }
      }
    }
  }
});

// ── End phase button ──────────────────────────────────────────────────────────

endMoveBtn.addEventListener('click', () => {
  if (isAnimating) return;

  if (state.phase === 'production' && state.activePlayer === PLAYER) {
    state = playerEndProduction(state);
    hideUnitPicker();
    render(); updateUI(); checkWinner();
  } else if (state.phase === 'movement' && state.activePlayer === PLAYER) {
    runAiTurnWithAnimation();
  }
});

function runAiTurnWithAnimation(): void {
  // 1. Log end-of-movement and reset AI moved flags
  state = prepareAiTurn(state);

  // 2. Snapshot AI unit positions before AI moves
  const preAiPositions = new Map(
    state.units.filter(u => u.owner === AI).map(u => [u.id, { col: u.col, row: u.row, unit: { ...u } as typeof u }])
  );

  // 3. Run AI movement (state is now fully updated)
  state = aiMovement(state);

  if (state.winner) {
    render(); updateUI(); checkWinner();
    return;
  }

  // 4. Build animation list: AI units that changed position
  const moves: MoveAnimation[] = [];
  for (const unit of state.units.filter(u => u.owner === AI)) {
    const pre = preAiPositions.get(unit.id);
    if (pre && (pre.col !== unit.col || pre.row !== unit.row)) {
      moves.push({ unit: pre.unit, fromCol: pre.col, fromRow: pre.row, toCol: unit.col, toRow: unit.row });
    }
  }

  if (moves.length === 0) {
    state = endTurnAfterAi(state);
    render(); updateUI(); checkWinner(); maybeAutoEnd();
    return;
  }

  // 5. Render final state with moving units hidden, then animate them in
  isAnimating = true;
  renderState(svg, state, null, new Set(moves.map(m => m.unit.id)));
  updateUI();
  animateMoves(svg, moves, config.unitMoveSpeed, () => {
    isAnimating = false;
    state = endTurnAfterAi(state);
    render(); updateUI(); checkWinner(); maybeAutoEnd();
  });
}

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
  if (isAnimating || state.winner || state.activePlayer !== PLAYER) return;
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
  if ((state.phase === 'production' || state.phase === 'movement') && isPlayerTurn) {
    endMoveBtn.style.display = 'flex';
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
