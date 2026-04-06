import {
  createInitialState,
  playerPlaceUnit,
  playerEndProduction,
  playerSelectUnit,
  playerMoveUnit,
  prepareAiTurn,
  aiMovement,
  endTurnAfterAi,
  getUnit,
  getUnitById,
  getValidMoves,
  getMovePath,
  getRangedAttackTargets,
  playerRangedAttack,
  isValidProductionPlacement,
  forecastCombat,
  vsHumanEndProduction,
  vsHumanEndMovement,
  syncUnitIdCounter,
  PLAYER,
  AI,
  COLS,
  ROWS,
} from './game';
import {
  initRenderer,
  renderState,
  setBoardRenderCallback,
  animateMoves,
  animateStrikeAndReturn,
  showDamageFloats,
  showHealFloats,
  getHexFromEvent,
  renderMovePath,
  clearCombatVfxLayers,
  playRangedArtilleryHexBarrageVfx,
  invalidateColorsCache,
} from './renderer';
import { getNeighbors } from './hex';
import { isInEnemyZoC } from './game';
import type { MoveAnimation } from './renderer';
import config from './gameconfig';
import type { GameState, Unit, CombatForecast, Owner, CombatVfxPayload, GameMode } from './types';
import { saveGameState, loadGameState, hasSaveGame, clearGameState } from './gameStorage';
import { updateConfig } from './gameconfig';
import { syncDimensions } from './game';
import {
  playMpResultIntro,
  revertMpResultIntro,
  DEFAULT_MP_RESULT_VARIANT,
} from './mpResultOverlay';

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${wsProtocol}//${location.hostname}:3001`;

const svg        = document.getElementById('board') as unknown as SVGSVGElement;

/** Last move-path preview key; redraw only when unit position or hovered destination changes. */
let movePathPreviewKey: string | null = null;

function clearMovePathPreview(): void {
  if (movePathPreviewKey === null) return;
  renderMovePath(svg, []);
  movePathPreviewKey = null;
}
const logEl      = document.getElementById('log') as HTMLUListElement;
const phaseEl    = document.getElementById('phase') as HTMLElement;
const turnEl     = document.getElementById('turn') as HTMLElement;
const ppDisplay  = document.getElementById('pp-display') as HTMLElement;
const endMoveBtn  = document.getElementById('end-move-btn') as HTMLButtonElement;
const phaseLabelEl = document.getElementById('phase-label') as HTMLElement;
const overlayEl  = document.getElementById('overlay') as HTMLDivElement;
const overlayMsg = document.getElementById('overlay-msg') as HTMLDivElement;
const restartBtn = document.getElementById('restart-btn') as HTMLButtonElement;
const recapOverlayEl = document.getElementById('recap-overlay') as HTMLDivElement;

const mpResultOverlayEl = document.getElementById('mp-result-overlay') as HTMLDivElement;
const mpResultMsg = document.getElementById('mp-result-msg') as HTMLParagraphElement;
const mpResultActionsEl = document.getElementById('mp-result-actions') as HTMLDivElement;
const mpRestartBtn = document.getElementById('mp-restart-btn') as HTMLButtonElement;
const mpRecapBtn = document.getElementById('mp-recap-btn') as HTMLButtonElement;

const unitPickerEl   = document.getElementById('unit-picker') as HTMLDivElement;
const unitPickerList = document.getElementById('unit-picker-list') as HTMLDivElement;

const playerConquerPctEl  = document.getElementById('player-conquer-pct') as HTMLElement;
const aiConquerPctEl      = document.getElementById('ai-conquer-pct') as HTMLElement;
const playerConquerLabel  = document.getElementById('player-conquer-label') as HTMLElement;
const aiConquerLabel      = document.getElementById('ai-conquer-label') as HTMLElement;
const conquerBarEl        = document.getElementById('conquer-bar-line') as HTMLElement;
const ppTooltipEl         = document.getElementById('pp-tooltip') as HTMLDivElement;
const unitStatTooltipEl   = document.getElementById('unit-stat-tooltip') as HTMLDivElement;
const ppInfoEl            = document.getElementById('pp-info') as HTMLDivElement;
const cpInfoEl            = document.getElementById('cp-info') as HTMLDivElement;
const cpYouEl             = document.getElementById('cp-you') as HTMLElement;
const cpOpponentEl        = document.getElementById('cp-opponent') as HTMLElement;

const autoEndProductionEl = document.getElementById('auto-end-production') as HTMLInputElement;
const autoEndMovementEl   = document.getElementById('auto-end-movement') as HTMLInputElement;
autoEndProductionEl.checked = config.autoEndProduction;
autoEndMovementEl.checked   = config.autoEndMovement;

const rulesOverlayEl = document.getElementById('rules-overlay') as HTMLDivElement;
const rulesContentEl = document.getElementById('rules-content') as HTMLDivElement;
document.getElementById('rules-btn')!.addEventListener('click', () => {
  rulesContentEl.innerHTML = buildRulesContent();
  rulesOverlayEl.classList.remove('hidden');
});
document.getElementById('rules-close')!.addEventListener('click', () => rulesOverlayEl.classList.add('hidden'));
rulesOverlayEl.addEventListener('click', e => { if (e.target === rulesOverlayEl) rulesOverlayEl.classList.add('hidden'); });

// ── PP tooltip ────────────────────────────────────────────────────────────────

ppInfoEl.addEventListener('mouseenter', () => {
  const ownedHexes = Object.values(state.hexStates).filter(h => h.owner === localPlayer).length;
  const quotas = Math.floor(ownedHexes / config.territoryQuota);
  const territoryBonus = quotas * config.pointsPerQuota;
  const total = config.productionPointsPerTurn + territoryBonus;
  const hexesIntoQuota = ownedHexes % config.territoryQuota;
  const hexesToNext = config.territoryQuota - hexesIntoQuota;

  const nextLine = hexesIntoQuota === 0 && ownedHexes === 0
    ? `Own ${config.territoryQuota} hexes to earn +${config.pointsPerQuota} PP`
    : `Next +${config.pointsPerQuota} PP in ${hexesToNext} more hex${hexesToNext === 1 ? '' : 'es'}`;

  ppTooltipEl.innerHTML = `
    <div class="pp-tt-row"><span>Base</span><span>+${config.productionPointsPerTurn} PP</span></div>
    <div class="pp-tt-row"><span>Territory (${ownedHexes} hexes)</span><span>+${territoryBonus} PP</span></div>
    <div class="pp-tt-row total"><span>This turn</span><span>+${total} PP</span></div>
    <div class="pp-tt-next">${nextLine}</div>`;
  positionFixedTooltipBelow(ppTooltipEl, ppInfoEl.getBoundingClientRect());
});

ppInfoEl.addEventListener('mouseleave', () => {
  ppTooltipEl.classList.add('hidden');
});

function positionFixedTooltipBelow(tooltip: HTMLElement, anchor: DOMRect): void {
  tooltip.classList.remove('hidden');
  const ttRect = tooltip.getBoundingClientRect();
  let left = anchor.left;
  let top = anchor.bottom + 8;
  if (left + ttRect.width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - ttRect.width - 8);
  }
  if (top + ttRect.height > window.innerHeight - 8) {
    top = Math.max(8, anchor.top - ttRect.height - 8);
  }
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

// ── Main menu DOM refs ────────────────────────────────────────────────────────

const mainMenuOverlayEl    = document.getElementById('main-menu-overlay') as HTMLDivElement;
const menuContinueBtn      = document.getElementById('menu-continue-btn') as HTMLButtonElement;
const menuNewGameBtn       = document.getElementById('menu-new-game-btn') as HTMLButtonElement;
const menuHostBtn          = document.getElementById('menu-host-btn') as HTMLButtonElement;
const menuJoinBtn          = document.getElementById('menu-join-btn') as HTMLButtonElement;
const newGameConfirmOverlay = document.getElementById('new-game-confirm-overlay') as HTMLDivElement;
const confirmNewGameBtn    = document.getElementById('confirm-new-game-btn') as HTMLButtonElement;
const cancelNewGameBtn     = document.getElementById('cancel-new-game-btn') as HTMLButtonElement;
const introOverlayEl       = document.getElementById('intro-overlay') as HTMLDivElement;
const introTextEl          = document.getElementById('intro-text') as HTMLParagraphElement;
const introCursorEl        = document.getElementById('intro-cursor') as HTMLSpanElement;
const introContinueBtn     = document.getElementById('intro-continue-btn') as HTMLButtonElement;

// ── Lobby DOM refs ────────────────────────────────────────────────────────────

const lobbyOverlayEl    = document.getElementById('lobby-overlay') as HTMLDivElement;
const lobbyMenuEl       = document.getElementById('lobby-menu') as HTMLDivElement;
const lobbyHostWaitEl   = document.getElementById('lobby-host-wait') as HTMLDivElement;
const lobbyJoinFormEl   = document.getElementById('lobby-join-form') as HTMLDivElement;
const lobbyCodeEl       = document.getElementById('lobby-code') as HTMLDivElement;
const lobbyCodeInputEl  = document.getElementById('lobby-code-input') as HTMLInputElement;
const lobbyErrorEl      = document.getElementById('lobby-error') as HTMLDivElement;
const vsAiBtn           = document.getElementById('vsai-btn') as HTMLButtonElement;
const hostBtn           = document.getElementById('host-btn') as HTMLButtonElement;
const joinBtn           = document.getElementById('join-btn') as HTMLButtonElement;
const lobbyCancelBtn    = document.getElementById('lobby-cancel-btn') as HTMLButtonElement;
const lobbyCancelJoinBtn = document.getElementById('lobby-cancel-join-btn') as HTMLButtonElement;
const lobbyJoinConfirm  = document.getElementById('lobby-join-confirm') as HTMLButtonElement;

// ── Game mode state ───────────────────────────────────────────────────────────

let gameMode: 'vsAI' | 'vsHuman' = 'vsAI';
let localPlayer: Owner = PLAYER;
let ws: WebSocket | null = null;

let state: GameState = createInitialState();
let pendingProductionHex: { col: number; row: number } | null = null;
let isAnimating = false;
/** True while local vs-AI AI turn visuals run (shared cancel token must not be treated as human interrupt). */
let aiPlaybackInProgress = false;
/** Cancel function for the local player's in-flight move animation (allows selecting another unit mid-animation). */
let humanMoveAnimCancel: (() => void) | null = null;
let turnSnapshots: GameState[] = [];

/** Multiplayer: full combat/move mirror (replaces legacy single {@link MoveAnimation} only). */
interface WsAnimationPayload {
  moves?: MoveAnimation[];
  strikeReturn?: {
    unit: Unit;
    fromCol: number;
    fromRow: number;
    enemyCol: number;
    enemyRow: number;
  };
  damageFloats?: { col: number; row: number; amount: number }[];
  /** Ranged artillery: shell barrage on defender hex before damage floats. */
  ranged?: boolean;
}

function isLegacySingleMoveAnimation(x: unknown): x is MoveAnimation {
  return (
    typeof x === 'object' &&
    x !== null &&
    'unit' in x &&
    'fromCol' in x &&
    'toCol' in x &&
    !('moves' in x)
  );
}

function combineAnimCancels(...cancels: (() => void)[]): () => void {
  return () => {
    for (const c of cancels) c();
    clearCombatVfxLayers(svg);
  };
}

/** Green +N heal badges after end-of-turn cleanup (same timing as damage floats). */
function playEndTurnHealFloats(
  healFloats: { col: number; row: number; amount: number }[],
  onDone: () => void,
): void {
  syncDamageFloatCssDuration();
  if (healFloats.length === 0) {
    isAnimating = false;
    onDone();
    return;
  }
  isAnimating = true;
  render();
  updateUI();
  const { cancel } = showHealFloats(svg, healFloats, config.damageFloatDurationMs, () => {
    humanMoveAnimCancel = null;
    isAnimating = false;
    onDone();
  });
  humanMoveAnimCancel = combineAnimCancels(cancel);
}

function syncDamageFloatCssDuration(): void {
  document.documentElement.style.setProperty(
    '--damage-float-duration',
    `${config.damageFloatDurationMs}ms`,
  );
}

/** Guest: replay host movement + combat visuals (also accepts legacy single {@link MoveAnimation}). */
function runOpponentAnimationPayload(anim: WsAnimationPayload | MoveAnimation, onDone: () => void): void {
  syncDamageFloatCssDuration();
  if (isLegacySingleMoveAnimation(anim)) {
    renderState(svg, state, null, new Set([anim.unit.id]), localPlayer);
    updateUI();
    const { cancel } = animateMoves(svg, [anim], config.unitMoveSpeed, onDone, state);
    humanMoveAnimCancel = combineAnimCancels(cancel);
    return;
  }

  const payload = anim as WsAnimationPayload;
  const moves = payload.moves ?? [];
  const floats = payload.damageFloats ?? [];
  const sr = payload.strikeReturn;

  const hidden = new Set<number>();
  for (const m of moves) hidden.add(m.unit.id);
  if (sr) hidden.add(sr.unit.id);

  const finish = (): void => {
    humanMoveAnimCancel = null;
    onDone();
  };

  const runFloats = (): void => {
    renderState(svg, state, null, new Set(), localPlayer);
    updateUI();
    if (floats.length === 0) finish();
    else {
      const playDamageFloats = (): void => {
        const { cancel } = showDamageFloats(svg, floats, config.damageFloatDurationMs, finish);
        humanMoveAnimCancel = combineAnimCancels(cancel);
      };
      if (payload.ranged && floats.length > 0) {
        const d = floats[0]!;
        const { cancel } = playRangedArtilleryHexBarrageVfx(svg, d.col, d.row, playDamageFloats);
        humanMoveAnimCancel = combineAnimCancels(cancel);
      } else {
        playDamageFloats();
      }
    }
  };

  const runStrike = (): void => {
    if (sr) {
      const { cancel: cSt } = animateStrikeAndReturn(
        svg,
        {
          unit: sr.unit,
          fromCol: sr.fromCol,
          fromRow: sr.fromRow,
          enemyCol: sr.enemyCol,
          enemyRow: sr.enemyRow,
          durationMs: config.strikeReturnSpeedMs,
        },
        runFloats,
        state,
      );
      humanMoveAnimCancel = combineAnimCancels(cSt);
    } else {
      runFloats();
    }
  };

  renderState(svg, state, null, hidden, localPlayer);
  updateUI();

  if (moves.length > 0) {
    const { cancel } = animateMoves(svg, moves, config.unitMoveSpeed, runStrike, state);
    humanMoveAnimCancel = combineAnimCancels(cancel);
  } else {
    runStrike();
  }
}

function render(): void {
  renderState(svg, state, pendingProductionHex, new Set(), localPlayer);
}

setBoardRenderCallback(() => render());

/** CSS vars swapped for vs-human guest so "your" side uses the theme's player palette and the opponent the AI palette. */
const GUEST_IDENTITY_SWAP_PROPS = [
  '--color-player',
  '--color-ai',
  '--color-hex-player',
  '--color-hex-ai',
] as const;

function clearGuestIdentityColorOverrides(): void {
  const root = document.documentElement;
  for (const p of GUEST_IDENTITY_SWAP_PROPS) {
    root.style.removeProperty(p);
  }
  invalidateColorsCache();
}

/**
 * For multiplayer guest, swap player/AI theme hues so local side matches the normal "player" colors.
 * No change to game logic — only how `--color-*` resolve. Clears overrides when not guest.
 */
function syncGuestIdentityColors(): void {
  const root = document.documentElement;
  for (const p of GUEST_IDENTITY_SWAP_PROPS) {
    root.style.removeProperty(p);
  }
  invalidateColorsCache();

  if (gameMode !== 'vsHuman' || localPlayer !== AI) {
    return;
  }

  const s = getComputedStyle(root);
  const player = s.getPropertyValue('--color-player').trim();
  const ai = s.getPropertyValue('--color-ai').trim();
  const hexPlayer = s.getPropertyValue('--color-hex-player').trim();
  const hexAi = s.getPropertyValue('--color-hex-ai').trim();

  root.style.setProperty('--color-player', ai);
  root.style.setProperty('--color-ai', player);
  root.style.setProperty('--color-hex-player', hexAi);
  root.style.setProperty('--color-hex-ai', hexPlayer);
  invalidateColorsCache();
}

// ── Main menu ─────────────────────────────────────────────────────────────────

function showMainMenu(): void {
  clearGuestIdentityColorOverrides();
  mainMenuOverlayEl.classList.remove('hidden');
  if (hasSaveGame()) {
    menuContinueBtn.classList.remove('hidden');
  } else {
    menuContinueBtn.classList.add('hidden');
  }
}

function hideMainMenu(): void {
  mainMenuOverlayEl.classList.add('hidden');
}

menuContinueBtn.addEventListener('click', () => {
  const saved = loadGameState();
  if (!saved) { showMainMenu(); return; }
  hideMainMenu();
  gameMode = 'vsAI';
  localPlayer = PLAYER;
  startGame(saved);
});

menuNewGameBtn.addEventListener('click', () => {
  if (hasSaveGame()) {
    newGameConfirmOverlay.classList.remove('hidden');
  } else {
    hideMainMenu();
    showSettings(() => {
      gameMode = 'vsAI';
      localPlayer = PLAYER;
      startGame(createInitialState());
    });
  }
});

confirmNewGameBtn.addEventListener('click', () => {
  newGameConfirmOverlay.classList.add('hidden');
  clearGameState();
  hideMainMenu();
  showSettings(() => {
    gameMode = 'vsAI';
    localPlayer = PLAYER;
    startGame(createInitialState());
  });
});

cancelNewGameBtn.addEventListener('click', () => {
  newGameConfirmOverlay.classList.add('hidden');
});

menuHostBtn.addEventListener('click', () => {
  gameMode = 'vsHuman';
  localPlayer = PLAYER;
  state = createInitialState();
  hideMainMenu();
  lobbyOverlayEl.classList.remove('hidden');
  lobbyMenuEl.classList.add('hidden');
  lobbyJoinFormEl.classList.add('hidden');
  lobbyHostWaitEl.classList.remove('hidden');
  lobbyCodeEl.textContent = '···';
  lobbyErrorEl.classList.add('hidden');
  connectWs((socket) => {
    socket.send(JSON.stringify({ type: 'host' }));
  });
});

menuJoinBtn.addEventListener('click', () => {
  gameMode = 'vsHuman';
  localPlayer = AI;
  hideMainMenu();
  lobbyOverlayEl.classList.remove('hidden');
  lobbyMenuEl.classList.add('hidden');
  lobbyHostWaitEl.classList.add('hidden');
  lobbyJoinFormEl.classList.remove('hidden');
  lobbyCodeInputEl.value = '';
  lobbyErrorEl.classList.add('hidden');
  lobbyCodeInputEl.focus();
});

// ── Game settings ────────────────────────────────────────────────────────────

const settingsOverlayEl  = document.getElementById('settings-overlay') as HTMLDivElement;
const settingsStartBtn   = document.getElementById('settings-start-btn') as HTMLButtonElement;
const settingsBackBtn    = document.getElementById('settings-back-btn') as HTMLButtonElement;

// Numeric fields: [elementId, configKey, scale factor (e.g. 100 for % fields)]
const NUM_FIELDS: Array<[string, keyof typeof _cfgNumProxy, number]> = [
  ['cfg-controlPointCount',       'controlPointCount',       1],
  ['cfg-conquestPointsPlayer',    'conquestPointsPlayer',    1],
  ['cfg-conquestPointsAi',        'conquestPointsAi',        1],
  ['cfg-boardCols',               'boardCols',               1],
  ['cfg-boardRows',               'boardRows',               1],
  ['cfg-startingUnits',           'startingUnits',           1],
  ['cfg-productionPointsPerTurn', 'productionPointsPerTurn', 1],
  ['cfg-infantryCost',            'infantryCost',            1],
  ['cfg-territoryQuota',          'territoryQuota',          1],
  ['cfg-pointsPerQuota',          'pointsPerQuota',          1],
  ['cfg-productionTurns',         'productionTurns',         1],
  ['cfg-productionSafeDistance',  'productionSafeDistance',  1],
  ['cfg-infantry-maxHp',          'infantryMaxHp',           1],
  ['cfg-infantry-strength',       'infantryStrength',        1],
  ['cfg-tank-maxHp',              'tankMaxHp',               1],
  ['cfg-tank-strength',           'tankStrength',            1],
  ['cfg-combatDamageBase',        'combatDamageBase',        1],
  ['cfg-combatStrengthScale',     'combatStrengthScale',     1],
  ['cfg-flankingBonus',           'flankingBonus',           100],
  ['cfg-maxFlankingUnits',        'maxFlankingUnits',        1],
  ['cfg-healOwnTerritory',        'healOwnTerritory',        1],
  ['cfg-healNeutral',             'healNeutral',             1],
  ['cfg-healEnemyTerritory',      'healEnemyTerritory',      1],
  ['cfg-unitMoveSpeed',           'unitMoveSpeed',           1],
  ['cfg-mountainPct',             'mountainPct',             100],
];

// Proxy type for key checking only — never instantiated
declare const _cfgNumProxy: {
  controlPointCount: number; conquestPointsPlayer: number; conquestPointsAi: number;
  boardCols: number; boardRows: number; startingUnits: number;
  productionPointsPerTurn: number; infantryCost: number;
  territoryQuota: number; pointsPerQuota: number;
  productionTurns: number; productionSafeDistance: number;
  infantryMaxHp: number; infantryStrength: number;
  tankMaxHp: number; tankStrength: number;
  combatDamageBase: number; combatStrengthScale: number;
  flankingBonus: number; maxFlankingUnits: number;
  healOwnTerritory: number; healNeutral: number; healEnemyTerritory: number;
  unitMoveSpeed: number;
  mountainPct: number;
};

const TOGGLE_FIELDS: Array<[string, 'zoneOfControl' | 'limitArtillery' | 'autoEndProduction' | 'autoEndMovement']> = [
  ['cfg-zoneOfControl',      'zoneOfControl'],
  ['cfg-limitArtillery',     'limitArtillery'],
  ['cfg-autoEndProduction',  'autoEndProduction'],
  ['cfg-autoEndMovement',    'autoEndMovement'],
];

function populateSettings(): void {
  const infantry = config.unitTypes.find(u => u.id === 'infantry') ?? config.unitTypes[0];
  const tank = config.unitTypes.find(u => u.id === 'tank') ?? config.unitTypes[0];
  const infantryCost = infantry.cost;
  const vals: Record<string, number> = {
    controlPointCount: config.controlPointCount,
    conquestPointsPlayer: config.conquestPointsPlayer,
    conquestPointsAi: config.conquestPointsAi,
    boardCols: config.boardCols, boardRows: config.boardRows,
    startingUnits: config.startingUnits,
    productionPointsPerTurn: config.productionPointsPerTurn,
    infantryCost,
    territoryQuota: config.territoryQuota, pointsPerQuota: config.pointsPerQuota,
    productionTurns: config.productionTurns, productionSafeDistance: config.productionSafeDistance,
    infantryMaxHp: infantry.maxHp, infantryStrength: infantry.strength,
    tankMaxHp: tank.maxHp, tankStrength: tank.strength,
    combatDamageBase: config.combatDamageBase, combatStrengthScale: config.combatStrengthScale,
    flankingBonus: config.flankingBonus, maxFlankingUnits: config.maxFlankingUnits,
    healOwnTerritory: config.healOwnTerritory, healNeutral: config.healNeutral,
    healEnemyTerritory: config.healEnemyTerritory,
    unitMoveSpeed: config.unitMoveSpeed,
    mountainPct: config.mountainPct,
  };
  for (const [id, key, scale] of NUM_FIELDS) {
    const el = document.getElementById(id) as HTMLInputElement;
    el.value = String(Math.round(vals[key] * scale));
  }
  for (const [id, key] of TOGGLE_FIELDS) {
    const el = document.getElementById(id) as HTMLButtonElement;
    const val = config[key] as boolean;
    el.dataset.value = String(val);
    el.textContent = val ? 'ON' : 'OFF';
  }
  const gameModeEl = document.getElementById('cfg-gameMode') as HTMLSelectElement;
  gameModeEl.value = config.gameMode;
  updateConquestSettingsVisibility();
}

function updateConquestSettingsVisibility(): void {
  const gameModeEl = document.getElementById('cfg-gameMode') as HTMLSelectElement;
  const wrap = document.getElementById('settings-conquest-only') as HTMLDivElement;
  wrap.classList.toggle('hidden', gameModeEl.value !== 'conquest');
}

function collectSettings(): Parameters<typeof updateConfig>[0] {
  const out: Record<string, number | boolean | GameMode> = {};
  for (const [id, key, scale] of NUM_FIELDS) {
    const el = document.getElementById(id) as HTMLInputElement;
    out[key] = parseFloat(el.value) / scale;
  }
  for (const [id, key] of TOGGLE_FIELDS) {
    const el = document.getElementById(id) as HTMLButtonElement;
    out[key] = el.dataset.value === 'true';
  }
  const gameModeEl = document.getElementById('cfg-gameMode') as HTMLSelectElement;
  out.gameMode = gameModeEl.value as GameMode;
  return out as Parameters<typeof updateConfig>[0];
}

// Wire toggle buttons
for (const [id] of TOGGLE_FIELDS) {
  const el = document.getElementById(id) as HTMLButtonElement;
  el.addEventListener('click', () => {
    const next = el.dataset.value !== 'true';
    el.dataset.value = String(next);
    el.textContent = next ? 'ON' : 'OFF';
  });
}

document.getElementById('cfg-gameMode')!.addEventListener('change', updateConquestSettingsVisibility);

let settingsOnStart: (() => void) | null = null;

function showSettings(onStart: () => void): void {
  populateSettings();
  settingsOnStart = onStart;
  settingsOverlayEl.classList.remove('hidden');
}

function hideSettings(): void {
  settingsOverlayEl.classList.add('hidden');
  settingsOnStart = null;
}

settingsStartBtn.addEventListener('click', () => {
  const settings = collectSettings();
  updateConfig(settings);
  syncDimensions();
  const cb = settingsOnStart;
  hideSettings();
  cb?.();
});

settingsBackBtn.addEventListener('click', () => {
  closeLobbyWs();
  hideSettings();
  showMainMenu();
});

// ── Intro story ───────────────────────────────────────────────────────────────

const INTRO_PAGES = [
  'The northern and southern territories have been locked in dispute for decades. As commander of the southern forces, your mission is to break through the enemy lines.',
  'Establish production lines deep in enemy territory, outmaneuver your opponent, and push your units to their home row. One decisive breakthrough wins the war.',
];

let introPageIndex = 0;
let introTypingInterval: ReturnType<typeof setInterval> | null = null;

function startIntro(): void {
  introPageIndex = 0;
  introOverlayEl.classList.remove('hidden');
  showIntroPage(0);
}

function showIntroPage(page: number): void {
  const text = INTRO_PAGES[page];
  introTextEl.textContent = '';
  introCursorEl.style.display = 'inline-block';
  introContinueBtn.classList.add('hidden');

  let i = 0;
  if (introTypingInterval) clearInterval(introTypingInterval);
  introTypingInterval = setInterval(() => {
    if (i < text.length) {
      introTextEl.textContent = text.slice(0, i + 1);
      i++;
    } else {
      if (introTypingInterval) clearInterval(introTypingInterval);
      introTypingInterval = null;
      introCursorEl.style.display = 'none';
      setTimeout(() => {
        introContinueBtn.textContent = page < INTRO_PAGES.length - 1
          ? `CONTINUE (${page + 1}/${INTRO_PAGES.length})`
          : 'START GAME';
        introContinueBtn.classList.remove('hidden');
      }, 300);
    }
  }, 28);
}

introContinueBtn.addEventListener('click', () => {
  if (introPageIndex < INTRO_PAGES.length - 1) {
    introPageIndex++;
    showIntroPage(introPageIndex);
  } else {
    introOverlayEl.classList.add('hidden');
    gameMode = 'vsAI';
    localPlayer = PLAYER;
    startGame(createInitialState());
  }
});

// ── Rules content ─────────────────────────────────────────────────────────────

function buildRulesContent(): string {
  const ar = config.unitTypes.find(u => u.id === 'artillery');
  const arRanged =
    ar?.range != null
      ? `2–${ar.range} hexes away`
      : '2+ hexes away';
  const unitList = config.unitTypes
    .map(u => {
      let s = `<strong>${u.name}</strong> (${u.cost} PP, ${u.maxHp} HP, move ${u.movement}, base str ${u.strength}`;
      if (u.range) s += `, ranged attack range ${u.range} hexes`;
      s += ')';
      return s;
    })
    .join(', ');
  const maxFlankBonus = Math.round(config.maxFlankingUnits * config.flankingBonus * 100);
  return `
    <h2>Game Rules</h2>

    <h3>Overview</h3>
    <p>Turn-based hex strategy on a ${config.boardCols}×${config.boardRows} grid.
       You play from the south (bottom row); the AI plays from the north (top row).</p>

    <h3>Turn Phases</h3>
    <ol>
      <li><strong>Production</strong> — spend PP to place units.</li>
      <li><strong>Movement</strong> — move each of your units up to its movement range.</li>
      <li><strong>End</strong> — AI takes its turn, then the turn counter advances.</li>
    </ol>

    <h3>Production</h3>
    <ul>
      <li>Each turn you earn <strong>${config.productionPointsPerTurn} PP</strong> (production points).</li>
      <li><strong>Territory bonus:</strong> +${config.pointsPerQuota} PP for every ${config.territoryQuota} hexes you own.</li>
      <li>Available units: ${unitList}.</li>
      <li>Valid placement: your <strong>home row</strong> (bottom), or any owned <strong>production hex</strong>.</li>
      <li><strong>Production hex:</strong> an owned hex stable for <strong>${config.productionTurns} consecutive turns</strong>.
        Stability requires all hexes within distance ${config.productionSafeDistance} to be owned by you
        (impassable <strong>mountain</strong> hexes in that ring count as secure — they are not neutral or enemy territory).
        Resets immediately if that condition breaks.</li>
      <li>You can place multiple units per turn as long as you have PP.</li>
    </ul>

    <h3>Movement</h3>
    <ul>
      <li>Each unit may move up to its movement range per turn (see unit types). Moving onto an empty hex <strong>conquers</strong> it.</li>
      <li>Moving onto an enemy unit triggers <strong>combat</strong>. If you need more than one hex to reach them, you move along the path into the hex adjacent to the enemy first, then combat resolves.</li>
      <li><strong>Artillery:</strong> each turn you either <strong>move</strong> one hex or fire a <strong>ranged attack</strong> at an enemy ${arRanged} (not both). Ranged fire does not use movement into the target&rsquo;s hex.</li>
      <li><strong>Zone of Control (ZoC):</strong> a unit adjacent to an enemy is locked — it may only attack
        or retreat to a hex not itself adjacent to any enemy. ZoC limits movement and adjacent attacks; it does not block artillery ranged fire at longer range.</li>
    </ul>

    <h3>Combat</h3>
    <ul>
      <li><strong>Adjacent combat:</strong> both sides deal damage <strong>simultaneously</strong>. If the defender is destroyed, the attacker advances and conquers the hex.</li>
      <li><strong>Artillery ranged (2+ hexes):</strong> only the defender takes damage (no return fire). Destroying a unit with a ranged attack does <strong>not</strong> move the artillery or conquer that hex.</li>
      <li><strong>Limit Artillery</strong> (optional game setting): when enabled, if <strong>any</strong> enemy is adjacent to your artillery, it cannot use ranged attacks against other hexes until no adjacent enemies remain — use adjacent combat (move to attack) first.</li>
      <li><strong>CS</strong> = unit type&rsquo;s base strength × condition (50–100% of current max HP) × flanking bonus.</li>
      <li><strong>Flanking:</strong> +${Math.round(config.flankingBonus * 100)}% CS per adjacent friendly
        (max ${config.maxFlankingUnits} flankers = +${maxFlankBonus}%), in fixed neighbor order.
        Some unit types add <strong>extra flanking</strong> when they are among those adjacent flankers.</li>
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

    <h3>Game modes</h3>
    <p>The match mode is chosen in <strong>Game settings</strong> before play.</p>
    <ul>
      <li><strong>Domination:</strong> move a unit onto the <strong>opponent&rsquo;s home row</strong>, or <strong>eliminate all enemy units</strong>.</li>
      <li><strong>Conquest:</strong> marked <strong>control point</strong> hexes appear on the map (default ${config.controlPointCount} in current settings).
        Each side starts with <strong>Conquer Points</strong> (south ${config.conquestPointsPlayer}, north ${config.conquestPointsAi} — configurable).
        After each full round, for every control point you <strong>own</strong>, the opponent loses 1 Conquer Point (multiple points stack).
        The first side reduced to <strong>0</strong> Conquer Points loses. Reaching the home row or wiping the enemy army does <strong>not</strong> end the match in this mode.
        If both sides hit 0 in the same tick, the <strong>northern</strong> player wins the tie.</li>
    </ul>
  `;
}

// ── Lobby helpers ─────────────────────────────────────────────────────────────

function showLobbyMenu(): void {
  lobbyMenuEl.classList.remove('hidden');
  lobbyHostWaitEl.classList.add('hidden');
  lobbyJoinFormEl.classList.add('hidden');
  lobbyErrorEl.classList.add('hidden');
  lobbyErrorEl.textContent = '';
}

function showLobbyError(msg: string): void {
  lobbyErrorEl.textContent = msg;
  lobbyErrorEl.classList.remove('hidden');
}

function hideLobby(): void {
  lobbyOverlayEl.classList.add('hidden');
}

function sendStateUpdate(anim?: WsAnimationPayload | MoveAnimation): void {
  if (gameMode === 'vsHuman' && ws && ws.readyState === WebSocket.OPEN) {
    const payload: Record<string, unknown> = { type: 'state-update', state };
    if (anim) payload.animation = anim;
    ws.send(JSON.stringify(payload));
  }
}

function closeLobbyWs(): void {
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.close();
    ws = null;
  }
}

// ── WebSocket connect ─────────────────────────────────────────────────────────

function connectWs(onOpen: (socket: WebSocket) => void): void {
  closeLobbyWs();
  const socket = new WebSocket(WS_URL);
  ws = socket;

  socket.onerror = () => {
    showLobbyMenu();
    showLobbyError('Cannot connect to server.');
    ws = null;
  };

  socket.onopen = () => {
    onOpen(socket);
  };

  socket.onmessage = (event: MessageEvent) => {
    let msg: { type: string; [key: string]: unknown };
    try { msg = JSON.parse(event.data as string); } catch { return; }
    handleWsMessage(msg);
  };

  socket.onclose = () => {
    if (!lobbyOverlayEl.classList.contains('hidden')) return; // already in lobby
    if (state.winner) return; // game already ended
    showDisconnected();
  };
}

function handleWsMessage(msg: { type: string; [key: string]: unknown }): void {
  if (msg.type === 'room-created') {
    lobbyCodeEl.textContent = msg.code as string;
    // already showing host-wait
  } else if (msg.type === 'guest-joined') {
    // Host: guest arrived — show settings, then start
    hideLobby();
    showSettings(() => {
      state = createInitialState();
      if (ws) ws.send(JSON.stringify({ type: 'game-start', state }));
      startGame(state);
    });
  } else if (msg.type === 'joined') {
    // Guest: successfully joined, wait for game-start
    lobbyMenuEl.classList.add('hidden');
    lobbyHostWaitEl.classList.add('hidden');
    lobbyJoinFormEl.classList.add('hidden');
    const waitEl = document.createElement('div');
    waitEl.className = 'lobby-hint';
    waitEl.textContent = 'Joined! Waiting for host to start...';
    (document.getElementById('lobby-modal') as HTMLDivElement).appendChild(waitEl);
  } else if (msg.type === 'game-start') {
    // Guest receives initial state from host
    state = msg.state as GameState;
    syncUnitIdCounter(state);
    hideLobby();
    startGame(state);
  } else if (msg.type === 'state-after-host-move') {
    if (localPlayer !== AI) return; // should be guest (AI owner side)
    state = msg.state as GameState;
    syncUnitIdCounter(state);
    render();
    updateUI();
    checkWinner();
    maybeAutoEnd();
  } else if (msg.type === 'state-after-guest-move') {
    if (localPlayer !== PLAYER) return; // should be host
    state = msg.state as GameState;
    syncUnitIdCounter(state);
    // Host runs end-turn cleanup
    const { state: afterHeal, healFloats } = endTurnAfterAi(state);
    state = afterHeal;
    turnSnapshots.push(structuredClone(state));
    playEndTurnHealFloats(healFloats, () => {
      render();
      updateUI();
      checkWinner();
      maybeAutoEnd();
    });
  } else if (msg.type === 'state-update') {
    const incoming = msg.state as GameState;
    // Apply opponent updates while it's their turn, or always accept terminal game-over state
    // (otherwise the loser never runs checkWinner — only the winner does locally after their move).
    if (incoming.winner != null || state.activePlayer !== localPlayer) {
      state = incoming;
      syncUnitIdCounter(state);
      const anim = msg.animation as WsAnimationPayload | MoveAnimation | undefined;
      const afterOpponentState = (): void => {
        render();
        updateUI();
        checkWinner();
        maybeAutoEnd();
      };
      if (anim && !isAnimating) {
        isAnimating = true;
        runOpponentAnimationPayload(anim, () => {
          isAnimating = false;
          afterOpponentState();
        });
      } else {
        afterOpponentState();
      }
    }
  } else if (msg.type === 'error') {
    showLobbyMenu();
    showLobbyError((msg.message as string) ?? 'Error.');
  } else if (msg.type === 'opponent-disconnected') {
    showDisconnected();
  }
}

function showDisconnected(): void {
  overlayMsg.textContent = 'Opponent disconnected.';
  overlayEl.classList.remove('hidden');
}

// ── Lobby button handlers ─────────────────────────────────────────────────────

vsAiBtn.addEventListener('click', () => {
  gameMode = 'vsAI';
  localPlayer = PLAYER;
  closeLobbyWs();
  hideLobby();
  startGame(createInitialState());
});

hostBtn.addEventListener('click', () => {
  gameMode = 'vsHuman';
  localPlayer = PLAYER;
  state = createInitialState();

  lobbyMenuEl.classList.add('hidden');
  lobbyJoinFormEl.classList.add('hidden');
  lobbyHostWaitEl.classList.remove('hidden');
  lobbyCodeEl.textContent = '···';
  lobbyErrorEl.classList.add('hidden');

  connectWs((socket) => {
    socket.send(JSON.stringify({ type: 'host' }));
  });
});

joinBtn.addEventListener('click', () => {
  gameMode = 'vsHuman';
  localPlayer = AI; // guest plays as AI (owner 2)

  lobbyMenuEl.classList.add('hidden');
  lobbyHostWaitEl.classList.add('hidden');
  lobbyJoinFormEl.classList.remove('hidden');
  lobbyCodeInputEl.value = '';
  lobbyErrorEl.classList.add('hidden');
  lobbyCodeInputEl.focus();
});

lobbyCancelBtn.addEventListener('click', () => {
  closeLobbyWs();
  lobbyOverlayEl.classList.add('hidden');
  showMainMenu();
});

lobbyCancelJoinBtn.addEventListener('click', () => {
  closeLobbyWs();
  lobbyOverlayEl.classList.add('hidden');
  showMainMenu();
});

lobbyJoinConfirm.addEventListener('click', () => {
  const code = lobbyCodeInputEl.value.trim().toUpperCase();
  if (code.length < 4) {
    showLobbyError('Please enter a valid room code.');
    return;
  }
  lobbyErrorEl.classList.add('hidden');
  connectWs((socket) => {
    socket.send(JSON.stringify({ type: 'join', code }));
  });
});

lobbyCodeInputEl.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') lobbyJoinConfirm.click();
});

// ── Game start ────────────────────────────────────────────────────────────────

function startGame(initialState: GameState): void {
  revertMpResultIntro();
  mpResultOverlayEl.classList.add('hidden');
  state = initialState;
  syncUnitIdCounter(state);
  pendingProductionHex = null;
  humanMoveAnimCancel?.();
  humanMoveAnimCancel = null;
  isAnimating = false;
  aiPlaybackInProgress = false;
  turnSnapshots = [structuredClone(state)];
  initRenderer(svg, { flipBoardY: gameMode === 'vsHuman' && localPlayer === AI });
  syncGuestIdentityColors();
  render();
  updateUI();
  checkWinner();
  maybeAutoEnd();
}

// ── Unit picker ───────────────────────────────────────────────────────────────

function showUnitPicker(col: number, row: number): void {
  pendingProductionHex = { col, row };
  unitPickerList.innerHTML = '';

  const statIconCost = 'public/icons/points.svg';
  const statIconMove = 'public/icons/movement.svg';
  const statIconRange = 'public/icons/range.svg';
  const statIconStr = 'public/icons/strength.svg';
  const statIconHp = 'public/icons/hp.svg';

  config.unitTypes.forEach((unitType, cardIndex) => {
    const canAfford = state.productionPoints[localPlayer] >= unitType.cost;

    const card = document.createElement('div');
    card.className = 'unit-card unit-card--enter' + (canAfford ? '' : ' disabled');
    card.style.setProperty('--card-enter-i', String(cardIndex));
    card.addEventListener(
      'animationend',
      (e: AnimationEvent) => {
        if (
          e.animationName === 'unit-card-enter' ||
          e.animationName === 'unit-card-enter-disabled'
        ) {
          card.classList.remove('unit-card--enter');
        }
      },
      { once: true }
    );

    const header = document.createElement('div');
    header.className = 'unit-card-header';
    const headerIcon = document.createElement('img');
    headerIcon.className = 'unit-card-header-icon';
    headerIcon.src = unitType.icon ? `public/${unitType.icon}` : `public/icons/${unitType.id}.svg`;
    headerIcon.alt = '';
    header.appendChild(headerIcon);

    const body = document.createElement('div');
    body.className = 'unit-card-body';

    const title = document.createElement('div');
    title.className = 'unit-card-name';
    title.textContent = unitType.name.toUpperCase();

    const stats = document.createElement('div');
    stats.className = 'unit-card-stats';

    function addStat(
      modClass: string,
      value: number,
      statTitle: string,
      statDesc: string,
      iconSrc: string
    ): void {
      const row = document.createElement('div');
      row.className = `unit-card-stat ${modClass}`;
      const iconWrap = document.createElement('span');
      iconWrap.className = 'unit-card-stat-icon';
      iconWrap.setAttribute('aria-hidden', 'true');
      const iconImg = document.createElement('img');
      iconImg.src = iconSrc;
      iconImg.alt = '';
      const val = document.createElement('span');
      val.className = 'unit-card-stat-value';
      val.textContent = String(value);
      iconWrap.appendChild(iconImg);
      row.appendChild(iconWrap);
      row.appendChild(val);
      row.addEventListener('mouseenter', () => {
        unitStatTooltipEl.innerHTML = `
          <div class="unit-stat-tt-title">${statTitle}</div>
          <div class="unit-stat-tt-desc">${statDesc}</div>`;
        positionFixedTooltipBelow(unitStatTooltipEl, row.getBoundingClientRect());
      });
      row.addEventListener('mouseleave', () => {
        unitStatTooltipEl.classList.add('hidden');
      });
      stats.appendChild(row);
    }

    addStat(
      'unit-card-stat--cost',
      unitType.cost,
      'Cost',
      'Production points (PP) required to build this unit.',
      statIconCost
    );
    addStat(
      'unit-card-stat--move',
      unitType.movement,
      'Movement',
      'How many hexes this unit can move on the map each turn.',
      statIconMove
    );
    if (unitType.range != null) {
      addStat(
        'unit-card-stat--range',
        unitType.range,
        'Range',
        'Maximum hex distance for ranged fire. Move or shoot in one turn, not both.',
        statIconRange
      );
    }
    addStat(
      'unit-card-stat--str',
      unitType.strength,
      'Strength',
      'Base combat strength; condition and flanking modify it in battle.',
      statIconStr
    );
    addStat(
      'unit-card-stat--hp',
      unitType.maxHp,
      'Hit points',
      'Maximum HP; the unit is removed when reduced to zero.',
      statIconHp
    );

    body.appendChild(title);
    body.appendChild(stats);
    card.appendChild(header);
    card.appendChild(body);

    if (canAfford) {
      card.addEventListener('click', () => {
        state = playerPlaceUnit(state, col, row, unitType.id, localPlayer);
        if (gameMode === 'vsAI') saveGameState(state);
        hideUnitPicker();
        render();
        updateUI();
        checkWinner();
        sendStateUpdate();
        maybeAutoEnd();
      });
    }

    unitPickerList.appendChild(card);
  });

  unitPickerEl.style.display = 'block';
}

function hideUnitPicker(): void {
  pendingProductionHex = null;
  unitPickerEl.style.display = 'none';
  unitStatTooltipEl.classList.add('hidden');
}

// ── Board click ───────────────────────────────────────────────────────────────

svg.addEventListener('click', (e: MouseEvent) => {
  if (state.winner) return;
  if (state.activePlayer !== localPlayer) return;
  const hex = getHexFromEvent(e);
  if (!hex) {
    // Empty SVG margin / background (no hex under cursor): clear selection
    if (state.phase === 'movement' && state.selectedUnit !== null) {
      let didInterruptHumanMove = false;
      if (humanMoveAnimCancel && !aiPlaybackInProgress) {
        didInterruptHumanMove = true;
        humanMoveAnimCancel();
        humanMoveAnimCancel = null;
        isAnimating = false;
        if (gameMode === 'vsAI') saveGameState(state);
        render();
        checkWinner();
      }
      if (!isAnimating) {
        clearMovePathPreview();
        state.selectedUnit = null;
        render(); updateUI();
        if (didInterruptHumanMove) maybeAutoEnd();
      }
    }
    return;
  }
  const { col, row } = hex;

  let didInterruptHumanMove = false;
  if (humanMoveAnimCancel && !aiPlaybackInProgress) {
    didInterruptHumanMove = true;
    humanMoveAnimCancel();
    humanMoveAnimCancel = null;
    isAnimating = false;
    if (gameMode === 'vsAI') saveGameState(state);
    render();
    checkWinner();
  }
  if (isAnimating) return;

  if (state.phase === 'production' && state.activePlayer === localPlayer) {
    if (isValidProductionPlacement(state, col, row, localPlayer)) {
      showUnitPicker(col, row);
    } else {
      hideUnitPicker();
    }
    render();
  } else if (state.phase === 'movement' && state.activePlayer === localPlayer) {
    if (state.selectedUnit === null) {
      state = playerSelectUnit(state, col, row, localPlayer);
      render(); updateUI();
      sendStateUpdate();
    } else {
      const target = getUnit(state, col, row);
      if (target && target.owner === localPlayer) {
        clearMovePathPreview();
        state = playerSelectUnit(state, col, row, localPlayer);
        render(); updateUI();
        sendStateUpdate();
      } else {
        // Deselect if clicked hex is not a valid move destination (unless ranged attack on enemy)
        const selUnit = getUnitById(state, state.selectedUnit)!;
        const validMoves = getValidMoves(state, selUnit);
        const clickTarget = getUnit(state, col, row);
        const enemyOwner: Owner = localPlayer === PLAYER ? AI : PLAYER;
        const canRanged =
          clickTarget &&
          clickTarget.owner === enemyOwner &&
          getRangedAttackTargets(state, selUnit).some(u => u.id === clickTarget.id);

        if (!validMoves.some(([c, r]) => c === col && r === row)) {
          if (canRanged) {
            clearMovePathPreview();
            syncDamageFloatCssDuration();
            const { state: nextState, combatVfx } = playerRangedAttack(state, col, row, localPlayer);
            state = nextState;
            if (gameMode === 'vsAI') saveGameState(state);
            checkWinner();
            if (combatVfx && combatVfx.damageFloats.length > 0) {
              isAnimating = true;
              render();
              const floats = combatVfx.damageFloats;
              const wsAnim: WsAnimationPayload = { damageFloats: floats };
              if (combatVfx.ranged) wsAnim.ranged = true;
              sendStateUpdate(wsAnim);
              const afterFloats = (): void => {
                humanMoveAnimCancel = null;
                isAnimating = false;
                if (gameMode === 'vsAI') saveGameState(state);
                render();
                updateUI();
                maybeAutoEnd();
              };
              const playDamageFloats = (): void => {
                const { cancel } = showDamageFloats(
                  svg,
                  floats,
                  config.damageFloatDurationMs,
                  afterFloats,
                );
                humanMoveAnimCancel = combineAnimCancels(cancel);
              };
              if (combatVfx.ranged) {
                const d = floats[0]!;
                const { cancel } = playRangedArtilleryHexBarrageVfx(svg, d.col, d.row, playDamageFloats);
                humanMoveAnimCancel = combineAnimCancels(cancel);
              } else {
                playDamageFloats();
              }
              updateUI();
            } else {
              render();
              updateUI();
              sendStateUpdate();
              maybeAutoEnd();
            }
            return;
          }
          clearMovePathPreview();
          state.selectedUnit = null;
          render(); updateUI();
          if (didInterruptHumanMove) maybeAutoEnd();
          return;
        }

        clearMovePathPreview();

        // Snapshot the moving unit before state changes
        const movingUnitId = state.selectedUnit;
        const movingUnit = getUnitById(state, movingUnitId)!;
        const fromCol = movingUnit.col, fromRow = movingUnit.row;
        const stateBeforeMove = structuredClone(state);

        const { state: nextState, combatVfx } = playerMoveUnit(state, col, row, localPlayer);
        state = nextState;

        const unitAfter = getUnitById(state, movingUnitId);
        const toCol = unitAfter?.col ?? col;
        const toRow = unitAfter?.row ?? row;
        const pathHexes = getMovePath(stateBeforeMove, { ...movingUnit, col: fromCol, row: fromRow }, toCol, toRow);
        const pathForAnim = pathHexes.length >= 2 ? pathHexes : undefined;

        const needsApproach = fromCol !== toCol || fromRow !== toRow;
        const mk = combatVfx?.mutualKillLunge;
        let primaryMove: MoveAnimation | null = null;
        if (mk && mk.pathHexes.length >= 2) {
          const p = mk.pathHexes;
          const s = p[0]!;
          const e = p[p.length - 1]!;
          primaryMove = {
            unit: movingUnit,
            fromCol: s[0],
            fromRow: s[1],
            toCol: e[0],
            toRow: e[1],
            pathHexes: p,
          };
        } else if (needsApproach) {
          primaryMove = {
            unit: movingUnit,
            fromCol,
            fromRow,
            toCol,
            toRow,
            pathHexes: pathForAnim,
          };
        }
        const needsMoveAnim = primaryMove !== null;
        const sr = combatVfx?.strikeReturn;
        const floats = combatVfx?.damageFloats ?? [];

        const finishHumanAnim = (): void => {
          humanMoveAnimCancel = null;
          isAnimating = false;
          if (gameMode === 'vsAI') saveGameState(state);
          render();
          checkWinner();
          maybeAutoEnd();
        };

        const runFloatsOnly = (): void => {
          // Strike/move anims hide units on the static layer; show them again before damage floats
          // so the attacker does not vanish until float playback ends.
          renderState(svg, state, pendingProductionHex, new Set(), localPlayer);
          updateUI();
          if (floats.length === 0) finishHumanAnim();
          else {
            const { cancel } = showDamageFloats(svg, floats, config.damageFloatDurationMs, finishHumanAnim);
            humanMoveAnimCancel = combineAnimCancels(cancel);
          }
        };

        syncDamageFloatCssDuration();

        if (!combatVfx) {
          if (needsApproach) {
            isAnimating = true;
            renderState(svg, state, pendingProductionHex, new Set([movingUnitId]), localPlayer);
            updateUI();
            sendStateUpdate({
              moves: [{ unit: movingUnit, fromCol, fromRow, toCol, toRow, pathHexes: pathForAnim }],
            });
            const { cancel } = animateMoves(
              svg,
              [{ unit: movingUnit, fromCol, fromRow, toCol, toRow, pathHexes: pathForAnim }],
              config.unitMoveSpeed,
              finishHumanAnim,
              state,
            );
            humanMoveAnimCancel = combineAnimCancels(cancel);
          } else {
            if (gameMode === 'vsAI') saveGameState(state);
            render();
            updateUI();
            checkWinner();
            sendStateUpdate();
            maybeAutoEnd();
          }
        } else {
          isAnimating = true;
          const hidden = new Set<number>();
          if (needsMoveAnim) hidden.add(movingUnitId);
          if (sr) hidden.add(sr.attackerId);

          renderState(svg, state, pendingProductionHex, hidden, localPlayer);
          updateUI();

          const wsPayload: WsAnimationPayload = {};
          if (primaryMove) {
            wsPayload.moves = [primaryMove];
          }
          if (sr) {
            const u = getUnitById(state, sr.attackerId);
            if (u) {
              wsPayload.strikeReturn = {
                unit: { ...u },
                fromCol: sr.fromCol,
                fromRow: sr.fromRow,
                enemyCol: sr.enemyCol,
                enemyRow: sr.enemyRow,
              };
            }
          }
          if (floats.length > 0) wsPayload.damageFloats = floats;
          if (combatVfx.ranged) wsPayload.ranged = true;
          sendStateUpdate(wsPayload);

          if (needsMoveAnim && primaryMove) {
            const { cancel } = animateMoves(
              svg,
              [primaryMove],
              config.unitMoveSpeed,
              () => {
                if (sr) {
                  const u = getUnitById(state, sr.attackerId);
                  if (!u) {
                    runFloatsOnly();
                    return;
                  }
                  const { cancel: cSt } = animateStrikeAndReturn(
                    svg,
                    {
                      unit: { ...u },
                      fromCol: sr.fromCol,
                      fromRow: sr.fromRow,
                      enemyCol: sr.enemyCol,
                      enemyRow: sr.enemyRow,
                      durationMs: config.strikeReturnSpeedMs,
                    },
                    runFloatsOnly,
                    state,
                  );
                  humanMoveAnimCancel = combineAnimCancels(cSt);
                } else {
                  runFloatsOnly();
                }
              },
              state,
            );
            humanMoveAnimCancel = combineAnimCancels(cancel);
          } else if (sr) {
            const u = getUnitById(state, sr.attackerId);
            if (!u) runFloatsOnly();
            else {
              const { cancel } = animateStrikeAndReturn(
                svg,
                {
                  unit: { ...u },
                  fromCol: sr.fromCol,
                  fromRow: sr.fromRow,
                  enemyCol: sr.enemyCol,
                  enemyRow: sr.enemyRow,
                  durationMs: config.strikeReturnSpeedMs,
                },
                runFloatsOnly,
                state,
              );
              humanMoveAnimCancel = combineAnimCancels(cancel);
            }
          } else {
            if (floats.length > 0) runFloatsOnly();
            else finishHumanAnim();
          }
        }
      }
    }
  }

  if (didInterruptHumanMove && state.phase === 'movement' && state.activePlayer === localPlayer) {
    maybeAutoEnd();
  }
});

// Deselect when clicking outside the SVG (header, footer, game-area padding). Bubble order runs the
// #board handler before this, so hex/unit clicks never hit this path.
document.body.addEventListener('click', (e: MouseEvent) => {
  if (state.winner) return;
  if (state.activePlayer !== localPlayer) return;
  if (state.phase !== 'movement' || state.selectedUnit === null) return;

  const t = e.target;
  if (!(t instanceof Element)) return;
  if (svg.contains(t)) return;

  let didInterruptHumanMove = false;
  if (humanMoveAnimCancel && !aiPlaybackInProgress) {
    didInterruptHumanMove = true;
    humanMoveAnimCancel();
    humanMoveAnimCancel = null;
    isAnimating = false;
    if (gameMode === 'vsAI') saveGameState(state);
    render();
    checkWinner();
  }
  if (isAnimating) return;

  clearMovePathPreview();
  state.selectedUnit = null;
  render(); updateUI();
  if (didInterruptHumanMove) maybeAutoEnd();
});

// ── End phase button ──────────────────────────────────────────────────────────

endMoveBtn.addEventListener('click', () => {
  if (isAnimating) return;

  if (state.phase === 'production' && state.activePlayer === localPlayer) {
    if (gameMode === 'vsAI') {
      state = playerEndProduction(state);
      saveGameState(state);
    } else {
      state = vsHumanEndProduction(state, localPlayer);
    }
    hideUnitPicker();
    render(); updateUI(); checkWinner();
    if (gameMode === 'vsAI') {
      maybeAutoEnd();
    } else {
      sendStateUpdate();
      maybeAutoEnd();
    }
  } else if (state.phase === 'movement' && state.activePlayer === localPlayer) {
    if (gameMode === 'vsAI') {
      runAiTurnWithAnimation();
    } else {
      // vsHuman: advance phase, send state to opponent
      state = vsHumanEndMovement(state, localPlayer);
      render(); updateUI(); checkWinner();
      if (ws && ws.readyState === WebSocket.OPEN) {
        const msgType = localPlayer === PLAYER ? 'state-after-host-move' : 'state-after-guest-move';
        ws.send(JSON.stringify({ type: msgType, state }));
      }
    }
  }
});

/** Shallow-clone units array for AI replay draws / synthetic state. */
function cloneUnits(units: Unit[]): Unit[] {
  return units.map(u => ({ ...u }));
}

/** GameState with replaced units (HP/positions) for anim HP bars during AI replay. */
function aiReplayState(base: GameState, units: Unit[]): GameState {
  return { ...base, units: cloneUnits(units) };
}

function runAiTurnWithAnimation(): void {
  // Block input immediately: activePlayer stays PLAYER until endTurnAfterAi, so clicks would
  // otherwise pass the activePlayer check. Must be true before sync aiMovement() and when
  // animSteps.length === 0 (no later isAnimating assignment).
  if (isAnimating) return;
  isAnimating = true;
  aiPlaybackInProgress = true;

  clearMovePathPreview();
  state = prepareAiTurn(state);

  const aiResult = aiMovement(state);
  state = aiResult.state;
  const animSteps = aiResult.animSteps;
  const animUnitsBefore = aiResult.animUnitsBefore;
  const animUnitsAfter = aiResult.animUnitsAfter;

  if (state.winner) {
    isAnimating = false;
    aiPlaybackInProgress = false;
    render(); updateUI(); checkWinner();
    return;
  }

  if (animSteps.length === 0) {
    const { state: next, healFloats } = endTurnAfterAi(state);
    state = next;
    turnSnapshots.push(structuredClone(state));
    saveGameState(state);
    playEndTurnHealFloats(healFloats, () => {
      aiPlaybackInProgress = false;
      render();
      updateUI();
      checkWinner();
      maybeAutoEnd();
    });
    return;
  }

  syncDamageFloatCssDuration();

  const finishAi = (): void => {
    humanMoveAnimCancel = null;
    const { state: next, healFloats } = endTurnAfterAi(state);
    state = next;
    turnSnapshots.push(structuredClone(state));
    saveGameState(state);
    playEndTurnHealFloats(healFloats, () => {
      aiPlaybackInProgress = false;
      render();
      updateUI();
      checkWinner();
      maybeAutoEnd();
    });
  };

  const playOneCombatVfx = (
    vfx: CombatVfxPayload,
    unitsBefore: Unit[],
    unitsAfter: Unit[],
    onDone: () => void,
  ): void => {
    const floats = vfx.damageFloats;
    const sr = vfx.strikeReturn;

    /**
     * After strike: board already showed the exchange — use unitsAfter for floats.
     * No strike (e.g. attacker dies): show unitsBefore while floats play so casualties
     * do not vanish before the damage labels; then snap to unitsAfter.
     */
    const runFloats = (afterStrike: boolean): void => {
      const initial = cloneUnits(afterStrike ? unitsAfter : unitsBefore);
      renderState(svg, state, null, new Set(), localPlayer, initial);
      updateUI();
      if (floats.length === 0) {
        renderState(svg, state, null, new Set(), localPlayer, cloneUnits(unitsAfter));
        updateUI();
        onDone();
        return;
      }
      const afterDamageFloats = (): void => {
        renderState(svg, state, null, new Set(), localPlayer, cloneUnits(unitsAfter));
        updateUI();
        onDone();
      };
      const playDamageFloats = (): void => {
        const { cancel } = showDamageFloats(svg, floats, config.damageFloatDurationMs, afterDamageFloats);
        humanMoveAnimCancel = combineAnimCancels(cancel);
      };
      if (vfx.ranged) {
        const d = floats[0]!;
        const { cancel } = playRangedArtilleryHexBarrageVfx(svg, d.col, d.row, playDamageFloats);
        humanMoveAnimCancel = combineAnimCancels(cancel);
      } else {
        playDamageFloats();
      }
    };

    if (sr) {
      const u =
        getUnitById(state, sr.attackerId) ??
        unitsBefore.find(x => x.id === sr.attackerId);
      if (!u) {
        runFloats(false);
        return;
      }
      const ub = cloneUnits(unitsBefore);
      renderState(svg, state, null, new Set([sr.attackerId]), localPlayer, ub);
      updateUI();
      const { cancel } = animateStrikeAndReturn(
        svg,
        {
          unit: { ...u },
          fromCol: sr.fromCol,
          fromRow: sr.fromRow,
          enemyCol: sr.enemyCol,
          enemyRow: sr.enemyRow,
          durationMs: config.strikeReturnSpeedMs,
        },
        () => runFloats(true),
        aiReplayState(state, ub),
      );
      humanMoveAnimCancel = combineAnimCancels(cancel);
    } else {
      runFloats(false);
    }
  };

  const runStep = (index: number): void => {
    if (index >= animSteps.length) {
      finishAi();
      return;
    }
    const step = animSteps[index]!;
    const before = cloneUnits(animUnitsBefore[index]!);
    if (step.type === 'move') {
      const a = step.anim;
      renderState(svg, state, null, new Set([a.unit.id]), localPlayer, before);
      updateUI();
      const { cancel } = animateMoves(
        svg,
        [a],
        config.unitMoveSpeed,
        () => runStep(index + 1),
        aiReplayState(state, before),
      );
      humanMoveAnimCancel = combineAnimCancels(cancel);
    } else {
      playOneCombatVfx(step.vfx, before, animUnitsAfter[index]!, () => runStep(index + 1));
    }
  };

  runStep(0);
}

function leaveEndGameToMainMenu(): void {
  closeLobbyWs();
  revertMpResultIntro();
  overlayEl.classList.add('hidden');
  mpResultOverlayEl.classList.add('hidden');
  hideUnitPicker();
  showMainMenu();
}

restartBtn.addEventListener('click', leaveEndGameToMainMenu);
mpRestartBtn.addEventListener('click', leaveEndGameToMainMenu);

// ── Auto-end helpers ──────────────────────────────────────────────────────────

function canAffordAnyUnit(): boolean {
  return config.unitTypes.some(u => state.productionPoints[localPlayer] >= u.cost);
}

function hasAnyValidMove(): boolean {
  return state.units
    .filter(u => u.owner === localPlayer && u.movesUsed < u.movement)
    .some(u => getValidMoves(state, u).length > 0 || getRangedAttackTargets(state, u).length > 0);
}

function maybeAutoEnd(): void {
  if (isAnimating || state.winner || state.activePlayer !== localPlayer) return;
  if (state.phase === 'production' && autoEndProductionEl.checked && !canAffordAnyUnit()) {
    if (gameMode === 'vsAI') {
      state = playerEndProduction(state);
    } else {
      state = vsHumanEndProduction(state, localPlayer);
      if (ws && ws.readyState === WebSocket.OPEN) {
        // After auto-ending production, check if movement also needs auto-ending
        render(); updateUI(); checkWinner();
        maybeAutoEnd(); // recurse to check movement
        return;
      }
    }
    hideUnitPicker();
    render();
    updateUI();
    checkWinner();
  } else if (state.phase === 'movement' && autoEndMovementEl.checked && !hasAnyValidMove()) {
    if (gameMode === 'vsAI') {
      // Same as clicking "End movement": run AI with move animations (do not use playerEndMovement / advancePhase).
      runAiTurnWithAnimation();
    } else {
      state = vsHumanEndMovement(state, localPlayer);
      render(); updateUI(); checkWinner();
      if (ws && ws.readyState === WebSocket.OPEN) {
        const msgType = localPlayer === PLAYER ? 'state-after-host-move' : 'state-after-guest-move';
        ws.send(JSON.stringify({ type: msgType, state }));
      }
    }
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function updateUI(): void {
  turnEl.textContent  = `Turn ${state.turn}`;
  phaseEl.textContent = state.phase.charAt(0).toUpperCase() + state.phase.slice(1);
  ppDisplay.textContent = String(state.productionPoints[localPlayer]);

  const isConquest = state.gameMode === 'conquest' && state.conquestPoints;
  cpInfoEl.classList.toggle('hidden', !isConquest);
  if (isConquest) {
    const cp = state.conquestPoints!;
    const youCp = localPlayer === PLAYER ? cp[PLAYER] : cp[AI];
    const oppCp = localPlayer === PLAYER ? cp[AI] : cp[PLAYER];
    cpYouEl.textContent = String(youCp);
    cpOpponentEl.textContent = String(oppCp);
  }

  // Update conquer header
  const totalHexes = COLS * ROWS;
  const playerHexes = Object.values(state.hexStates).filter(h => h.owner === PLAYER).length;
  const aiHexes     = Object.values(state.hexStates).filter(h => h.owner === AI).length;
  const playerPct = Math.round(playerHexes / totalHexes * 100);
  const aiPct     = Math.round(aiHexes / totalHexes * 100);
  // Show from localPlayer's perspective: "YOU" = localPlayer side
  const localPct    = localPlayer === PLAYER ? playerPct : aiPct;
  const opponentPct = localPlayer === PLAYER ? aiPct : playerPct;
  playerConquerPctEl.textContent = `${localPct}%`;
  aiConquerPctEl.textContent     = `${opponentPct}%`;
  playerConquerLabel.textContent = 'YOU';
  aiConquerLabel.textContent     = localPlayer === PLAYER && gameMode !== 'vsHuman' ? 'AI' : 'OPPONENT';

  // Two-color conquer bar: left = local player, right = opponent
  const total = localPct + opponentPct;
  const leftPct = total > 0 ? Math.round(localPct / total * 100) : 50;
  const style = getComputedStyle(document.documentElement);
  const localColor    = localPlayer === PLAYER
    ? style.getPropertyValue('--color-hex-player').trim()
    : style.getPropertyValue('--color-hex-ai').trim();
  const opponentColor = localPlayer === PLAYER
    ? style.getPropertyValue('--color-hex-ai').trim()
    : style.getPropertyValue('--color-hex-player').trim();
  conquerBarEl.style.background =
    `linear-gradient(to right, ${localColor} ${leftPct}%, ${opponentColor} ${leftPct}%)`;

  const isMyTurn = state.activePlayer === localPlayer;
  if ((state.phase === 'production' || state.phase === 'movement') && isMyTurn) {
    endMoveBtn.style.display = 'flex';
    phaseLabelEl.textContent = state.phase.toUpperCase();
  } else if (gameMode === 'vsHuman' && !isMyTurn) {
    endMoveBtn.style.display = 'none';
    phaseLabelEl.textContent = 'WAITING...';
  } else {
    endMoveBtn.style.display = 'none';
    phaseLabelEl.textContent = '';
  }

  logEl.innerHTML = '';
  for (const msg of state.log) {
    const li = document.createElement('li');
    li.textContent = msg;
    logEl.appendChild(li);
  }
}

function checkWinner(): void {
  if (!state.winner) return;
  if (gameMode === 'vsHuman') {
    mpResultMsg.textContent = state.winner === localPlayer ? 'victory' : 'you lost';
    if (mpResultOverlayEl.classList.contains('hidden')) {
      mpResultOverlayEl.classList.remove('hidden');
      playMpResultIntro(DEFAULT_MP_RESULT_VARIANT, {
        overlay: mpResultOverlayEl,
        text: mpResultMsg,
        actions: mpResultActionsEl,
      });
    }
    return;
  }
  overlayMsg.textContent = state.winner === localPlayer ? 'You win!' : 'AI wins.';
  overlayEl.classList.remove('hidden');
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
  extraFlankingFrom?: { name: string; bonusPct: number }[];
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
        ${(factors.extraFlankingFrom ?? []).map(
          e => `<div>· Extra flanking bonus from ${e.name}: +${e.bonusPct}%</div>`
        ).join('')}
      </div>
    </div>`;
}

function showCombatTooltip(attacker: Unit, defender: Unit, pageX: number, pageY: number): void {
  const validMoves = getValidMoves(state, attacker);
  const meleeAttack = validMoves.some(([c, r]) => c === defender.col && r === defender.row);
  let attackerForForecast = attacker;
  if (meleeAttack) {
    const path = getMovePath(state, attacker, defender.col, defender.row);
    attackerForForecast =
      path.length >= 3
        ? { ...attacker, col: path[path.length - 2][0]!, row: path[path.length - 2][1]! }
        : attacker;
  }
  const fc: CombatForecast = forecastCombat(state, attackerForForecast, defender);

  const attackerFactors: SideFactors = {
    cs: fc.attackerCS,
    conditionPct: fc.attackerConditionPct,
    flankCount: fc.flankingCount,
    flankBonusPct: fc.flankBonusPct,
    extraFlankingFrom: fc.extraFlankingFrom.length > 0 ? fc.extraFlankingFrom : undefined,
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

  const attackerLabel = localPlayer === PLAYER ? `You (P${attacker.id})` : `You (A${attacker.id})`;
  const defenderLabel = localPlayer === PLAYER ? `Opponent (A${defender.id})` : `Opponent (P${defender.id})`;

  const title = fc.isRanged ? 'Ranged attack' : 'Combat Forecast';
  tooltipEl.innerHTML = `
    <div class="tt-title">${title}</div>
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
  const enemyOwner: Owner = localPlayer === PLAYER ? AI : PLAYER;

  if (state.phase !== 'movement' || state.activePlayer !== localPlayer || state.selectedUnit === null) {
    clearMovePathPreview();
    tooltipEl.classList.add('hidden');
    svg.classList.remove('cursor-fight');
    return;
  }
  const hex = getHexFromEvent(e);
  if (!hex) {
    clearMovePathPreview();
    tooltipEl.classList.add('hidden');
    svg.classList.remove('cursor-fight');
    return;
  }

  const attacker = getUnitById(state, state.selectedUnit);
  if (!attacker) {
    clearMovePathPreview();
    tooltipEl.classList.add('hidden');
    svg.classList.remove('cursor-fight');
    return;
  }

  const validMoves = getValidMoves(state, attacker);
  const isValidMove = validMoves.some(([c, r]) => c === hex.col && r === hex.row);

  const pathKey = `${attacker.id}:${attacker.col},${attacker.row}->${hex.col},${hex.row}`;
  if (isValidMove) {
    if (movePathPreviewKey !== pathKey) {
      renderMovePath(svg, getMovePath(state, attacker, hex.col, hex.row));
      movePathPreviewKey = pathKey;
    }
  } else {
    clearMovePathPreview();
  }

  const target = getUnit(state, hex.col, hex.row);

  // ZoC-blocked hex: unit is locked and this empty neighbor is also in enemy ZoC
  if (!target && isInEnemyZoC(state, attacker.col, attacker.row, enemyOwner)) {
    const isNeighbor = getNeighbors(attacker.col, attacker.row, COLS, ROWS)
      .some(([nc, nr]) => nc === hex.col && nr === hex.row);
    if (isNeighbor && isInEnemyZoC(state, hex.col, hex.row, enemyOwner)) {
      tooltipEl.innerHTML = `<div class="tt-title tt-zoc">Zone of Control</div>
        <div class="tt-zoc-msg">Cannot move here — retreating next to an enemy while already engaged is not allowed.</div>`;
      tooltipEl.classList.remove('hidden');
      svg.classList.remove('cursor-fight');
      positionTooltip(e.pageX, e.pageY);
      return;
    }
  }

  if (!target || target.owner !== enemyOwner) { tooltipEl.classList.add('hidden'); svg.classList.remove('cursor-fight'); return; }

  const canMelee = validMoves.some(([c, r]) => c === hex.col && r === hex.row);
  const canRanged = getRangedAttackTargets(state, attacker).some(t => t.id === target.id);
  if (!canMelee && !canRanged) { tooltipEl.classList.add('hidden'); svg.classList.remove('cursor-fight'); return; }

  svg.classList.add('cursor-fight');
  showCombatTooltip(attacker, target, e.pageX, e.pageY);
});

svg.addEventListener('mouseleave', () => {
  tooltipEl.classList.add('hidden');
  svg.classList.remove('cursor-fight');
  renderMovePath(svg, []);
  movePathPreviewKey = null;
});

const pauseOverlayEl   = document.getElementById('pause-overlay') as HTMLDivElement;
const pauseReturnBtn   = document.getElementById('pause-return-btn') as HTMLButtonElement;
const pauseContinueBtn = document.getElementById('pause-continue-btn') as HTMLButtonElement;

pauseReturnBtn.addEventListener('click', () => {
  pauseOverlayEl.classList.add('hidden');
  closeLobbyWs();
  revertMpResultIntro();
  overlayEl.classList.add('hidden');
  mpResultOverlayEl.classList.add('hidden');
  hideUnitPicker();
  showMainMenu();
});

pauseContinueBtn.addEventListener('click', () => {
  pauseOverlayEl.classList.add('hidden');
});

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    const inGame = mainMenuOverlayEl.classList.contains('hidden')
      && introOverlayEl.classList.contains('hidden')
      && recapOverlayEl.classList.contains('hidden');
    if (!inGame) return;
    if (pauseOverlayEl.classList.contains('hidden')) {
      pauseOverlayEl.classList.remove('hidden');
    } else {
      pauseOverlayEl.classList.add('hidden');
    }
    return;
  }
  if (e.key === 'Enter' && !endMoveBtn.hidden && endMoveBtn.style.display !== 'none') {
    if (isAnimating) return;
    endMoveBtn.click();
  }
});

// ── Replay ────────────────────────────────────────────────────────────────────

const recapSliderEl   = document.getElementById('recap-slider') as HTMLInputElement;
const recapTurnLabel  = document.getElementById('recap-turn-label') as HTMLElement;
const recapLogEl      = document.getElementById('recap-log') as HTMLUListElement;
const recapSvg        = document.getElementById('recap-board') as unknown as SVGSVGElement;
const recapCloseBtn   = document.getElementById('recap-close-btn') as HTMLButtonElement;
const recapBtn        = document.getElementById('recap-btn') as HTMLButtonElement;

function renderRecapTurn(index: number): void {
  const snap = turnSnapshots[index];
  if (!snap) return;
  // Override phase/selectedUnit so renderState never dims hexes or highlights moves
  renderState(recapSvg, { ...snap, phase: 'movement', selectedUnit: null }, null, new Set(), localPlayer);
  recapTurnLabel.textContent = index === 0
    ? 'TURN 1 — START'
    : `TURN ${snap.turn - 1} — END`;
  recapLogEl.innerHTML = '';
  for (const msg of snap.log.slice(0, 10)) {
    const li = document.createElement('li');
    li.textContent = msg;
    recapLogEl.appendChild(li);
  }
}

function openReplayFromEndGame(): void {
  initRenderer(recapSvg, { flipBoardY: gameMode === 'vsHuman' && localPlayer === AI });
  recapSliderEl.max = String(turnSnapshots.length - 1);
  recapSliderEl.value = String(turnSnapshots.length - 1);
  renderRecapTurn(turnSnapshots.length - 1);
  overlayEl.classList.add('hidden');
  mpResultOverlayEl.classList.add('hidden');
  recapOverlayEl.classList.remove('hidden');
}

recapBtn.addEventListener('click', openReplayFromEndGame);
mpRecapBtn.addEventListener('click', openReplayFromEndGame);

recapSliderEl.addEventListener('input', () => {
  renderRecapTurn(parseInt(recapSliderEl.value));
});

recapCloseBtn.addEventListener('click', () => {
  recapOverlayEl.classList.add('hidden');
  if (state.winner) {
    if (gameMode === 'vsHuman') {
      mpResultOverlayEl.classList.remove('hidden');
    } else {
      overlayEl.classList.remove('hidden');
    }
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

showMainMenu();
