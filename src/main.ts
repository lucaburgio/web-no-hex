import {
  createInitialState,
  createInitialStatePreservingTerrain,
  createInitialStateFromPlayableStory,
  createStoryState,
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
  hasAnyValidProductionPlacement,
  forecastCombat,
  vsHumanEndProduction,
  vsHumanEndMovement,
  syncUnitIdCounter,
  PLAYER,
  AI,
  COLS,
  ROWS,
  getBreakthroughAttackerOwner,
  getBreakthroughDefenderOwner,
  breakthroughActiveFrontlineSectorIndex,
  isInEnemyZoC,
  isHexBlockedByOpponentHomeGuardOnly,
  playerApplyUnitUpgrade,
  resolvePendingAiUpgradeChoices,
  unitTypeForUnit,
  unitShowsBoardPointerHover,
  type EndProductionOptions,
} from './game';
import {
  initRenderer,
  loadIconDefs,
  renderState,
  setBoardRenderCallback,
  setBoardPostPaintCallback,
  queueBoardUnitPointerHoverApply,
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
import { aiDamageFloatDrawParams } from './combatPlayback';
import { getNeighbors } from './hex';
import type { MoveAnimation } from './renderer';
import config, {
  DEFAULT_TERRITORY_ECONOMY,
  updateConfig,
  setActiveUnitPackage,
  setActiveUnitPackagePlayer2,
  getAvailableUnitTypes,
} from './gameconfig';
import {
  RULES_PRESETS,
  RULES_PRESET_CUSTOM,
  findMatchingRulesPresetId,
  getRulesPresetById,
  getRulesPresetDescriptionForSelectValue,
  type RulesPresetValues,
} from './rulesPresets';
import gsap from 'gsap';
import type { GameState, Unit, UnitType, CombatForecast, Owner, CombatVfxPayload, GameMode, UnitUpgradeKind, HexState } from './types';
import { saveGameState, loadGameState, hasSaveGame, clearGameState } from './gameStorage';
import modeImgDomination from '../public/images/modes/domination.png';
import modeImgConquest from '../public/images/modes/conquest.png';
import modeImgBreakthrough from '../public/images/modes/breakthrough.png';
import modeIconDomination from '../public/icons/modes/domination.svg';
import modeIconConquest from '../public/icons/modes/conquest.svg';
import modeIconBreakthrough from '../public/icons/modes/breakthrough.svg';
import chevronFilledIcon from '../public/icons/chevron-filled.svg';
import { STORIES } from './stories';
import { storyMapHasFullCustomMatchSupport } from './storyMapLayouts';
import { SCENARIOS, getScenarioById } from './scenarios';
import {
  loadStoryProgress,
  saveStoryProgress,
  loadStoryGameState,
  saveStoryGameState,
  hasStoryGameState,
  clearStoryGameState,
} from './storyStorage';
import { loadAchievementStats, recordVsAiVictory } from './achievementStorage';
import {
  ACHIEVEMENT_CATEGORY_ORDER,
  categoryLabel,
  getAchievementViews,
  type AchievementCategory,
  type AchievementView,
} from './achievements';
import { applyGameStateBoardDimensions, syncDimensions } from './game';
import {
  hideGameEndScreen,
  hideGameEndOverlayForReplay,
  revealGameEndScreenAfterReplay,
  showGameEndScreenForOutcome,
  showGameEndScreenDisconnected,
  configureStoryEndButtons,
  gameEndRestartBtn,
  gameEndNextStoryBtn,
  gameEndBackMenuBtn,
  gameEndRecapBtn,
  gameEndRetryBtn,
} from './gameEndScreen';
import { initMapEditor, showMapEditor, hideMapEditor } from './mapEditor';
import { initSettingsNumberSpinners } from './settingsNumberSpinners';
import { initGameAreaBoardTexture } from './gameAreaBoardTexture';
import { playMainMenuEnterAnimation } from './mainMenuEnterAnimation';

document.addEventListener('contextmenu', (e) => e.preventDefault(), { capture: true });

/** WebSocket URL for the relay in `server/`. See vite.config proxy `/relay`. */
function relayWebSocketUrl(): string {
  const isSecure = location.protocol === 'https:';
  const wsProto = isSecure ? 'wss:' : 'ws:';
  const explicit = import.meta.env.VITE_RELAY_URL as string | undefined;
  if (explicit) return explicit;

  const port = location.port;
  const useViteProxy =
    import.meta.env.DEV ||
    port === '5173' ||
    port === '4173' ||
    location.hostname.endsWith('.trycloudflare.com');

  if (useViteProxy) {
    return `${wsProto}//${location.host}/relay`;
  }
  return `${wsProto}//${location.hostname}:3001`;
}

const WS_URL = relayWebSocketUrl();

const svg        = document.getElementById('board') as unknown as SVGSVGElement;
const gameAreaEl = document.getElementById('game-area') as HTMLElement | null;
if (gameAreaEl) {
  initGameAreaBoardTexture(gameAreaEl, svg as unknown as HTMLElement);
}

/** Last move-path preview key; redraw only when unit position or hovered destination changes. */
let movePathPreviewKey: string | null = null;
let aiTurnPerfStartMs: number | null = null;

function perfEnabled(): boolean {
  const qs = new URLSearchParams(window.location.search);
  return qs.get('perf') === '1';
}

function perfLog(section: string, ms: number): void {
  if (!perfEnabled()) return;
  console.log(`[perf] ${section}: ${ms.toFixed(2)}ms`);
}

function maybeAutoEndDeferred(): void {
  requestAnimationFrame(() => {
    maybeAutoEnd();
  });
}

function clearMovePathPreview(): void {
  if (movePathPreviewKey === null) return;
  renderMovePath(svg, []);
  movePathPreviewKey = null;
}
const MODE_DEFS = [
  { id: 'domination', name: 'DOMINATION', icon: modeIconDomination, image: modeImgDomination, desc: 'ADVANCE ON THE FIELD AND ANNIHILATE THE ENEMY' },
  { id: 'conquest', name: 'CONQUEST', icon: modeIconConquest, image: modeImgConquest, desc: 'RUN FOR CONTROL POINTS AND KEEP THEM TO OWN THE BATTLEFIELD' },
  { id: 'breakthrough', name: 'BREAKTHROUGH', icon: modeIconBreakthrough, image: modeImgBreakthrough, desc: 'THE ATTACKER MUST PUSH THROUGH THE ENEMY LINES AND CAPTURE ALL SECTORS BUT HAS LIMITED RESOURCERS. THE DEFENDER MUST HOLD CONTROL AND RESIST.' },
] as const;
const modeDisplayImgEl = document.getElementById('mode-display-img') as HTMLImageElement;
const modeDisplayIconEl = document.getElementById('mode-display-icon') as HTMLImageElement;
const modeDisplayNameEl = document.getElementById('mode-display-name') as HTMLElement;
const modeDisplayDescEl = document.getElementById('mode-display-desc') as HTMLElement;

const logEl      = document.getElementById('log') as HTMLUListElement;
const phaseEl    = document.getElementById('phase') as HTMLElement;
const turnEl     = document.getElementById('turn') as HTMLElement;
const ppDisplay  = document.getElementById('pp-display') as HTMLElement;
const endMoveBtn  = document.getElementById('end-move-btn') as HTMLButtonElement;
const phaseLabelEl = document.getElementById('phase-label') as HTMLElement;
const recapOverlayEl = document.getElementById('recap-overlay') as HTMLDivElement;

const unitPickerEl   = document.getElementById('unit-picker') as HTMLDivElement;
const unitPickerList = document.getElementById('unit-picker-list') as HTMLDivElement;
const movementHudStackEl = document.getElementById('movement-hud-stack') as HTMLDivElement;
const upgradePickerPanelEl = document.getElementById('upgrade-picker-panel') as HTMLDivElement;
const movementUnitCardEl = document.getElementById('movement-unit-card') as HTMLDivElement;

const playerConquerPctEl  = document.getElementById('player-conquer-pct') as HTMLElement;
const aiConquerPctEl      = document.getElementById('ai-conquer-pct') as HTMLElement;
const playerConquerLabel  = document.getElementById('player-conquer-label') as HTMLElement;
const aiConquerLabel      = document.getElementById('ai-conquer-label') as HTMLElement;
const conquerBarEl = document.getElementById('conquer-bar-line') as HTMLElement;
const conquerBarLocalEl      = conquerBarEl.querySelector('.conquer-bar-local') as HTMLElement;
const conquerBarOpponentEl   = conquerBarEl.querySelector('.conquer-bar-opponent') as HTMLElement;
const breakthroughToastEl = document.getElementById('breakthrough-toast') as HTMLDivElement;
const ppTooltipEl         = document.getElementById('pp-tooltip') as HTMLDivElement;
const unitStatTooltipEl   = document.getElementById('unit-stat-tooltip') as HTMLDivElement;
const settingsTooltipEl   = document.getElementById('settings-tooltip') as HTMLDivElement;
const conquestTooltipEl   = document.getElementById('conquest-tooltip') as HTMLDivElement;
const ppInfoEl            = document.getElementById('pp-info') as HTMLDivElement;
const headerTerritoryEl   = document.getElementById('header-territory') as HTMLDivElement;

const rulesOverlayEl = document.getElementById('rules-overlay') as HTMLDivElement;
const rulesContentEl = document.getElementById('rules-content') as HTMLDivElement;
const headerModeLabelEl = document.getElementById('header-mode-label') as HTMLElement;
document.getElementById('rules-btn')!.addEventListener('click', () => {
  rulesContentEl.innerHTML = buildRulesContent();
  rulesOverlayEl.classList.remove('hidden');
});
document.getElementById('rules-close')!.addEventListener('click', () => rulesOverlayEl.classList.add('hidden'));
rulesOverlayEl.addEventListener('click', e => {
  if (e.target === rulesOverlayEl) rulesOverlayEl.classList.add('hidden');
});
rulesOverlayEl.addEventListener('click', e => {
  const link = (e.target as HTMLElement).closest('.rules-sidebar a[href^="#"]');
  if (!link || !rulesContentEl.contains(link)) return;
  const id = link.getAttribute('href')?.slice(1);
  if (!id) return;
  const doc = rulesContentEl.querySelector('.rules-doc');
  const target = document.getElementById(id);
  if (!doc || !target || !doc.contains(target)) return;
  e.preventDefault();
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ── PP tooltip ────────────────────────────────────────────────────────────────

function calcTerritoryIncomePreview(ownedHexes: number): {
  territoryBonus: number;
  total: number;
  nextLine: string;
} {
  if (config.territoryQuota <= 0 || config.pointsPerQuota <= 0) {
    return {
      territoryBonus: 0,
      total: config.productionPointsPerTurn,
      nextLine: 'Territory bonus is disabled for this mode.',
    };
  }
  const quotas = Math.floor(ownedHexes / config.territoryQuota);
  const territoryBonus = quotas * config.pointsPerQuota;
  const total = config.productionPointsPerTurn + territoryBonus;
  const hexesIntoQuota = ownedHexes % config.territoryQuota;
  const hexesToNext = config.territoryQuota - hexesIntoQuota;
  const nextLine = hexesIntoQuota === 0 && ownedHexes === 0
    ? `Own ${config.territoryQuota} hexes to earn +${config.pointsPerQuota} PP`
    : `Next +${config.pointsPerQuota} PP in ${hexesToNext} more hex${hexesToNext === 1 ? '' : 'es'}`;
  return { territoryBonus, total, nextLine };
}

ppInfoEl.addEventListener('mouseenter', () => {
  if (state.gameMode === 'breakthrough') {
    const youAreAttacker = localPlayer === getBreakthroughAttackerOwner(state);
    if (youAreAttacker) {
      const cap = config.breakthroughSectorCaptureBonusPP;
      const bonusLine =
        cap > 0
          ? `<div class="pp-tt-row"><span>Sector capture</span><span>+${cap} PP each</span></div>`
          : '';
      ppTooltipEl.innerHTML = `
        <div class="pp-tt-row"><span>Attacker</span><span>No PP income</span></div>
        ${bonusLine}
        <div class="pp-tt-next">Spend your starting pool only; territory does not add PP per turn.</div>`;
    } else {
      const ownedHexes = Object.values(state.hexStates).filter(h => h.owner === localPlayer).length;
      const { territoryBonus, total, nextLine } = calcTerritoryIncomePreview(ownedHexes);
      ppTooltipEl.innerHTML = `
        <div class="pp-tt-row"><span>Base</span><span>+${config.productionPointsPerTurn} PP</span></div>
        <div class="pp-tt-row"><span>Territory (${ownedHexes} hexes)</span><span>+${territoryBonus} PP</span></div>
        <div class="pp-tt-row total"><span>Next production</span><span>+${total} PP</span></div>
        <div class="pp-tt-next">${nextLine}</div>`;
    }
    positionFixedTooltipBelow(ppTooltipEl, ppInfoEl.getBoundingClientRect());
    return;
  }

  const ownedHexes = Object.values(state.hexStates).filter(h => h.owner === localPlayer).length;
  const { territoryBonus, total, nextLine } = calcTerritoryIncomePreview(ownedHexes);

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

// ── Conquest header tooltip ────────────────────────────────────────────────────

headerTerritoryEl.addEventListener('mouseenter', () => {
  if (state.gameMode !== 'conquest' || !state.conquestPoints) return;
  const cp = state.conquestPoints;
  const youCp  = localPlayer === PLAYER ? cp[PLAYER] : cp[AI];
  const oppCp  = localPlayer === PLAYER ? cp[AI] : cp[PLAYER];
  const totalHexes = COLS * ROWS;
  const oppOwner = localPlayer === PLAYER ? AI : PLAYER;
  const localTerPct = Math.round(Object.values(state.hexStates).filter(h => h.owner === localPlayer).length / totalHexes * 100);
  const oppTerPct   = Math.round(Object.values(state.hexStates).filter(h => h.owner === oppOwner).length / totalHexes * 100);
  const cpKeys = state.controlPointHexes ?? [];
  const youCpOwned  = cpKeys.filter(k => state.hexStates[k]?.owner === localPlayer).length;
  const oppCpOwned  = cpKeys.filter(k => state.hexStates[k]?.owner === oppOwner).length;
  conquestTooltipEl.innerHTML = `
    <div class="tt-title">Conquest</div>
    <div class="cq-tt-row"><span>You</span><span>${youCp} CP &nbsp;·&nbsp; ${localTerPct}% territory</span></div>
    <div class="cq-tt-row"><span>Opponent</span><span>${oppCp} CP &nbsp;·&nbsp; ${oppTerPct}% territory</span></div>
    <div class="cq-tt-sep"></div>
    <div class="cq-tt-note">You own <strong>${youCpOwned}</strong> of ${cpKeys.length} control point${cpKeys.length !== 1 ? 's' : ''} — opponent loses ${youCpOwned} CP/round.</div>
    <div class="cq-tt-note">Opponent owns <strong>${oppCpOwned}</strong> — you lose ${oppCpOwned} CP/round.</div>
    <div class="cq-tt-sep"></div>
    <div class="cq-tt-hint">First side to reach 0 CP loses.</div>`;
  positionFixedTooltipBelow(conquestTooltipEl, headerTerritoryEl.getBoundingClientRect());
});

headerTerritoryEl.addEventListener('mouseleave', () => {
  conquestTooltipEl.classList.add('hidden');
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
const mainMenuLogoEl       = document.getElementById('main-menu-logo') as HTMLImageElement;
const mainMenuRightColEl   = document.getElementById('main-menu-right') as HTMLDivElement;
const menuContinueBtn      = document.getElementById('menu-continue-btn') as HTMLButtonElement;
const menuNewGameBtn       = document.getElementById('menu-new-game-btn') as HTMLButtonElement;
const menuStoriesBtn       = document.getElementById('menu-stories-btn') as HTMLButtonElement;
const menuAchievementsBtn  = document.getElementById('menu-achievements-btn') as HTMLButtonElement;
const menuHostBtn          = document.getElementById('menu-host-btn') as HTMLButtonElement;
const menuJoinBtn          = document.getElementById('menu-join-btn') as HTMLButtonElement;
const menuMapEditorBtn     = document.getElementById('menu-map-editor-btn') as HTMLButtonElement;

// ── Stories DOM refs ──────────────────────────────────────────────────────────

const storiesOverlayEl       = document.getElementById('stories-overlay') as HTMLDivElement;
const storiesListEl          = document.getElementById('stories-list') as HTMLDivElement;
const storiesBackBtn         = document.getElementById('stories-back-btn') as HTMLButtonElement;
const storiesScenarioRailEl  = document.getElementById('stories-scenario-rail') as HTMLDivElement;
const storiesScenarioIconEl  = document.getElementById('stories-scenario-icon-large') as HTMLDivElement;
const storiesScenarioTitleEl = document.getElementById('stories-scenario-title') as HTMLHeadingElement;
const storiesScenarioImgEl   = document.getElementById('stories-scenario-image') as HTMLImageElement;
const storiesScenarioMiniTitleEl = document.getElementById('stories-scenario-mini-title') as HTMLDivElement;
const storiesScenarioDescEl  = document.getElementById('stories-scenario-description') as HTMLParagraphElement;
const storiesScenarioProgressEl = document.getElementById('stories-scenario-progress') as HTMLDivElement;
const achievementsOverlayEl   = document.getElementById('achievements-overlay') as HTMLDivElement;
const achievementsBackBtn     = document.getElementById('achievements-back-btn') as HTMLButtonElement;
const achievementsSummaryEl   = document.getElementById('achievements-summary') as HTMLParagraphElement;
const achievementsListEl      = document.getElementById('achievements-list') as HTMLDivElement;
const newGameConfirmOverlay = document.getElementById('new-game-confirm-overlay') as HTMLDivElement;
const confirmNewGameBtn    = document.getElementById('confirm-new-game-btn') as HTMLButtonElement;
const cancelNewGameBtn     = document.getElementById('cancel-new-game-btn') as HTMLButtonElement;
const storyStartConfirmOverlay = document.getElementById('story-start-confirm-overlay') as HTMLDivElement;
const confirmStoryStartBtn     = document.getElementById('confirm-story-start-btn') as HTMLButtonElement;
const cancelStoryStartBtn      = document.getElementById('cancel-story-start-btn') as HTMLButtonElement;
const introOverlayEl       = document.getElementById('intro-overlay') as HTMLDivElement;
const introTextEl          = document.getElementById('intro-text') as HTMLParagraphElement;
const introCursorEl        = document.getElementById('intro-cursor') as HTMLSpanElement;
const introContinueBtn     = document.getElementById('intro-continue-btn') as HTMLButtonElement;

// ── Lobby DOM refs ────────────────────────────────────────────────────────────

const lobbyOverlayEl    = document.getElementById('lobby-overlay') as HTMLDivElement;
const lobbyTitleEl      = document.getElementById('lobby-title') as HTMLDivElement;
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

// ── P2 waiting overlay DOM refs ───────────────────────────────────────────────
const p2WaitingOverlayEl      = document.getElementById('p2-waiting-overlay') as HTMLDivElement;
const p2WaitingModeImgEl      = document.getElementById('p2-waiting-mode-img') as HTMLImageElement;
const p2WaitingModeIconEl     = document.getElementById('p2-waiting-mode-icon') as HTMLImageElement;
const p2WaitingModeNameEl     = document.getElementById('p2-waiting-mode-name') as HTMLDivElement;
const p2WaitingModeDescEl     = document.getElementById('p2-waiting-mode-desc') as HTMLParagraphElement;
const p2WaitingSettingsListEl = document.getElementById('p2-waiting-settings-list') as HTMLDivElement;
const p2WaitingBackBtn        = document.getElementById('p2-waiting-back-btn') as HTMLButtonElement;

// ── Game mode state ───────────────────────────────────────────────────────────

let gameMode: 'vsAI' | 'vsHuman' = 'vsAI';
let localPlayer: Owner = PLAYER;
let ws: WebSocket | null = null;

/** Index into STORIES array when playing a story, null otherwise. */
let activeStoryIndex: number | null = null;

/** Story index awaiting start confirmation (overwriting existing save). */
let pendingStoryStartIndex: number | null = null;

/** Next story index queued from the end screen "Next story" button, null if none. */
let pendingNextStoryIndex: number | null = null;

/** Currently selected scenario ID in the stories UI. */
let activeScenarioId: string = SCENARIOS[0]?.id ?? '';

/** Unit package selected in game settings for player 1 (south); persists across opens. */
let settingsUnitPackage = 'standard';
/** Unit package selected in game settings for player 2 / AI (north); persists across opens. */
let settingsUnitPackagePlayer2 = 'standard';

/** Config values to restore after leaving story mode. */
const STORY_CONFIG_DEFAULTS = {
  boardCols: config.boardCols,
  boardRows: config.boardRows,
  productionPointsPerTurn: config.productionPointsPerTurn,
  productionPointsPerTurnAi: config.productionPointsPerTurnAi,
  conquestPointsPlayer: config.conquestPointsPlayer,
  conquestPointsAi: config.conquestPointsAi,
  breakthroughAttackerStartingPP: config.breakthroughAttackerStartingPP,
  breakthroughSectorCount: config.breakthroughSectorCount,
  breakthroughPlayer1Role: config.breakthroughPlayer1Role,
  breakthroughRandomRoles: config.breakthroughRandomRoles,
  customMatchMapId: null as string | null,
};
let storyConfigSnapshot: typeof STORY_CONFIG_DEFAULTS | null = null;

/** New vs-AI / multiplayer games: fixed terrain when a multi-mode story map is chosen. */
function createInitialStateForMenu(): GameState {
  const id = config.customMatchMapId;
  if (id) {
    const story = STORIES.find(s => s.id === id && storyMapHasFullCustomMatchSupport(s.map));
    if (story) return createInitialStateFromPlayableStory(story);
  }
  return createInitialState();
}

let state: GameState = createInitialStateForMenu();
let pendingProductionHex: { col: number; row: number } | null = null;
let isAnimating = false;
/** True while local vs-AI AI turn visuals run (shared cancel token must not be treated as human interrupt). */
let aiPlaybackInProgress = false;
/** True after player ends movement, before AI playback starts. */
let aiTurnPendingStart = false;
/** Cancel function for the local player's in-flight move animation (allows selecting another unit mid-animation). */
let humanMoveAnimCancel: (() => void) | null = null;
let turnSnapshots: GameState[] = [];
let saveStateTimer: number | null = null;

/**
 * Units omitted from the static unit layer while move/strike sprites run on the anim layer.
 * HP bar tweens call `render()` each frame; this set must stay in sync with any direct
 * `renderState(..., hiddenUnitIds, ...)` used for those VFX so hidden IDs are not redrawn as "tired" underneath.
 */
let animStaticHiddenUnitIds = new Set<number>();

/** Hex under the pointer when it qualifies for unit hover emphasis (see {@link unitShowsBoardPointerHover}). */
let boardPointerHoverHex: { col: number; row: number } | null = null;

function applyBoardPointerHoverClasses(): void {
  if (svg.id !== 'board') return;
  const want = boardPointerHoverHex;
  for (const node of svg.querySelectorAll('#unit-layer g.board-unit')) {
    const el = node as SVGGElement;
    const col = parseInt(el.dataset.col ?? '', 10);
    const row = parseInt(el.dataset.row ?? '', 10);
    if (Number.isNaN(col) || Number.isNaN(row)) continue;
    const unit = getUnit(state, col, row);
    const isTarget =
      want !== null &&
      want.col === col &&
      want.row === row &&
      unit != null &&
      unitShowsBoardPointerHover(state, unit, localPlayer, gameMode === 'vsHuman');
    el.classList.toggle('board-unit--pointer-hover-chromatic', isTarget);
  }
}

function clearBoardPointerHover(): void {
  if (boardPointerHoverHex === null) return;
  boardPointerHoverHex = null;
  queueBoardUnitPointerHoverApply();
}

function syncBoardPointerHoverFromEvent(e: MouseEvent): void {
  if (isAnimating) { clearBoardPointerHover(); return; }
  const hex = getHexFromEvent(e);
  let next: { col: number; row: number } | null = null;
  if (hex) {
    const unit = getUnit(state, hex.col, hex.row);
    if (unit && unitShowsBoardPointerHover(state, unit, localPlayer, gameMode === 'vsHuman')) {
      next = hex;
    }
  }
  const nextSig = next ? `${next.col},${next.row}` : '';
  const prevSig = boardPointerHoverHex ? `${boardPointerHoverHex.col},${boardPointerHoverHex.row}` : '';
  if (nextSig === prevSig) return;
  boardPointerHoverHex = next;
  queueBoardUnitPointerHoverApply();
}

function syncAnimStaticHidden(hidden: Iterable<number>): void {
  animStaticHiddenUnitIds.clear();
  for (const id of hidden) animStaticHiddenUnitIds.add(id);
}

function scheduleSaveGameState(): void {
  if (gameMode !== 'vsAI') return;
  if (saveStateTimer !== null) window.clearTimeout(saveStateTimer);
  // Defer serialization to keep phase transitions responsive on large boards.
  saveStateTimer = window.setTimeout(() => {
    saveStateTimer = null;
    if (activeStoryIndex !== null) {
      saveStoryGameState(state);
    } else {
      saveGameState(state);
    }
  }, 0);
}

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
  /** Melee: match {@link CombatVfxPayload.attackerAnimAboveUnits} for layer order during moves/strike. */
  attackerAnimAboveUnits?: boolean;
  /** Melee/ranged: match {@link CombatVfxPayload.meleeAttackerId} for same-hex paint order after anims. */
  meleeAttackerId?: number;
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
    animStaticHiddenUnitIds.clear();
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
  clearBoardPointerHover();
  animStaticHiddenUnitIds.clear();
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
    syncAnimStaticHidden([anim.unit.id]);
    renderState(svg, state, null, animStaticHiddenUnitIds, localPlayer, undefined, spectatorInspectIdForBoard());
    updateUI();
    const { cancel } = animateMoves(svg, [anim], config.unitMoveSpeed, () => {
      syncAnimStaticHidden([]);
      onDone();
    }, state, true, localPlayer);
    humanMoveAnimCancel = combineAnimCancels(cancel);
    return;
  }

  const payload = anim as WsAnimationPayload;
  const moves = payload.moves ?? [];
  const floats = payload.damageFloats ?? [];
  const sr = payload.strikeReturn;
  const stackAboveUnits = payload.attackerAnimAboveUnits ?? true;

  const hidden = new Set<number>();
  for (const m of moves) hidden.add(m.unit.id);
  if (sr) hidden.add(sr.unit.id);

  const finish = (): void => {
    humanMoveAnimCancel = null;
    onDone();
  };

  const runFloats = (): void => {
    syncAnimStaticHidden([]);
    renderState(svg, state, null, animStaticHiddenUnitIds, localPlayer, undefined, spectatorInspectIdForBoard());
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
        stackAboveUnits,
        localPlayer,
      );
      humanMoveAnimCancel = combineAnimCancels(cSt);
    } else {
      runFloats();
    }
  };

  syncAnimStaticHidden(hidden);
  renderState(svg, state, null, animStaticHiddenUnitIds, localPlayer, undefined, spectatorInspectIdForBoard());
  updateUI();

  if (moves.length > 0) {
    const { cancel } = animateMoves(svg, moves, config.unitMoveSpeed, runStrike, state, stackAboveUnits, localPlayer);
    humanMoveAnimCancel = combineAnimCancels(cancel);
  } else {
    runStrike();
  }
}

function render(): void {
  if (state.winner || gameMode !== 'vsHuman' || state.activePlayer === localPlayer) {
    vsHumanOffTurnInspectUnitId = null;
  }
  if (boardPointerHoverHex !== null) {
    const hu = getUnit(state, boardPointerHoverHex.col, boardPointerHoverHex.row);
    if (!hu || !unitShowsBoardPointerHover(state, hu, localPlayer, gameMode === 'vsHuman')) {
      boardPointerHoverHex = null;
    }
  }
  renderState(svg, state, pendingProductionHex, animStaticHiddenUnitIds, localPlayer, undefined, spectatorInspectIdForBoard());
}

setBoardRenderCallback(() => render());
setBoardPostPaintCallback(() => applyBoardPointerHoverClasses());

// ── Main menu ─────────────────────────────────────────────────────────────────

function showMainMenu(): void {
  mainMenuOverlayEl.classList.remove('hidden');
  if (hasSaveGame()) {
    menuContinueBtn.classList.remove('hidden');
  } else {
    menuContinueBtn.classList.add('hidden');
  }
  playMainMenuEnterAnimation({
    overlay: mainMenuOverlayEl,
    logo: mainMenuLogoEl,
    menuColumn: mainMenuRightColEl,
  });
}

function hideMainMenu(): void {
  mainMenuOverlayEl.classList.add('hidden');
}

// ── Stories ───────────────────────────────────────────────────────────────────

function showStoriesOverlay(): void {
  hideMainMenu();
  buildScenarioRail();
  selectScenario(activeScenarioId);
  storiesOverlayEl.classList.remove('hidden');
}

function hideStoriesOverlay(): void {
  resetStoriesParallaxLayers();
  storiesOverlayEl.classList.add('hidden');
}

// ── Achievements ──────────────────────────────────────────────────────────────

function buildAchievementsList(): void {
  const progress = loadStoryProgress();
  const stats = loadAchievementStats();
  const views = getAchievementViews(progress, stats);
  const nDone = views.filter(v => v.completed).length;
  achievementsSummaryEl.textContent = `${nDone} / ${views.length} unlocked`;

  achievementsListEl.innerHTML = '';
  const byCat = new Map<AchievementCategory, AchievementView[]>();
  for (const v of views) {
    const arr = byCat.get(v.category) ?? [];
    arr.push(v);
    byCat.set(v.category, arr);
  }
  for (const cat of ACHIEVEMENT_CATEGORY_ORDER) {
    const items = byCat.get(cat);
    if (!items?.length) continue;
    const h = document.createElement('h3');
    h.className = 'achievements-section-title';
    h.textContent = categoryLabel(cat);
    achievementsListEl.appendChild(h);
    for (const item of items) {
      achievementsListEl.appendChild(createAchievementCardEl(item));
    }
  }
}

function createAchievementCardEl(v: AchievementView): HTMLElement {
  const card = document.createElement('article');
  card.className = 'achievement-card' + (v.completed ? ' achievement-card-complete' : '');

  const media = document.createElement('div');
  media.className = 'achievement-card-media';
  const img = document.createElement('img');
  img.className = 'achievement-card-image';
  img.src = v.image;
  img.alt = '';
  const ic = document.createElement('img');
  ic.className = 'achievement-card-icon';
  ic.src = v.icon;
  ic.alt = '';
  media.appendChild(img);
  media.appendChild(ic);

  const body = document.createElement('div');
  body.className = 'achievement-card-body';

  const titleEl = document.createElement('h3');
  titleEl.className = 'achievement-card-title';
  titleEl.textContent = v.title;

  const descEl = document.createElement('p');
  descEl.className = 'achievement-card-desc';
  descEl.textContent = v.description;

  body.appendChild(titleEl);
  body.appendChild(descEl);
  if (v.sublabel) {
    const subEl = document.createElement('p');
    subEl.className = 'achievement-card-sublabel';
    subEl.textContent = v.sublabel;
    body.appendChild(subEl);
  }

  const prog = document.createElement('div');
  prog.className = 'achievement-card-progress';
  const pt = document.createElement('span');
  pt.className = 'achievement-card-progress-text';
  pt.textContent = `${v.current} / ${v.goal}`;
  const bar = document.createElement('div');
  bar.className = 'achievement-card-progress-bar';
  const fill = document.createElement('div');
  fill.className = 'achievement-card-progress-fill';
  const pct = v.goal > 0 ? Math.min(100, (v.current / v.goal) * 100) : 0;
  fill.style.width = `${pct}%`;
  bar.appendChild(fill);
  prog.appendChild(pt);
  prog.appendChild(bar);
  body.appendChild(prog);

  card.appendChild(media);
  card.appendChild(body);
  return card;
}

function showAchievementsOverlay(): void {
  hideMainMenu();
  buildAchievementsList();
  achievementsOverlayEl.classList.remove('hidden');
}

function hideAchievementsOverlay(): void {
  achievementsOverlayEl.classList.add('hidden');
}

function resetStoriesParallaxLayers(): void {
  gsap.killTweensOf([
    storiesScenarioIconEl,
    storiesScenarioImgEl,
    storiesScenarioTitleEl,
    storiesScenarioMiniTitleEl,
    storiesScenarioDescEl,
  ]);
  gsap.set(storiesScenarioIconEl, { y: 0 });
  gsap.set(storiesScenarioImgEl, { y: 0, scale: 1 });
  gsap.set(storiesScenarioTitleEl, { y: 0, opacity: 1 });
  gsap.set(storiesScenarioMiniTitleEl, { y: 0, opacity: 1 });
  gsap.set(storiesScenarioDescEl, { y: 0, opacity: 1 });
}

function buildScenarioRail(): void {
  storiesScenarioRailEl.innerHTML = '';
  for (const scenario of SCENARIOS) {
    const btn = document.createElement('button');
    btn.className = 'scenario-rail-btn' + (scenario.id === activeScenarioId ? ' active' : '');
    btn.title = scenario.title;
    const img = document.createElement('img');
    img.src = scenario.icon;
    img.alt = scenario.title;
    btn.appendChild(img);
    btn.addEventListener('click', () => {
      if (scenario.id === activeScenarioId) return;
      const fromIdx = SCENARIOS.findIndex(s => s.id === activeScenarioId);
      const toIdx = SCENARIOS.findIndex(s => s.id === scenario.id);
      const direction = toIdx > fromIdx ? 1 : -1;
      selectScenario(scenario.id, { animated: true, direction });
    });
    storiesScenarioRailEl.appendChild(btn);
  }
}

function selectScenario(
  scenarioId: string,
  options?: { animated?: boolean; direction?: 1 | -1 },
): void {
  activeScenarioId = scenarioId;

  // Update rail active state
  storiesScenarioRailEl.querySelectorAll<HTMLButtonElement>('.scenario-rail-btn').forEach((btn, i) => {
    btn.classList.toggle('active', SCENARIOS[i]?.id === scenarioId);
  });

  const scenario = getScenarioById(scenarioId);
  if (!scenario) return;

  let animated = options?.animated ?? false;
  if (
    animated &&
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    animated = false;
  }
  const dir = options?.direction ?? 1;

  // Update scenario detail panel
  storiesScenarioIconEl.innerHTML = '';
  const iconImg = document.createElement('img');
  iconImg.src = scenario.icon;
  iconImg.alt = scenario.title;
  storiesScenarioIconEl.appendChild(iconImg);

  storiesScenarioTitleEl.textContent = scenario.title;
  storiesScenarioImgEl.src = scenario.image;
  storiesScenarioMiniTitleEl.textContent = scenario.miniTitle;
  storiesScenarioDescEl.textContent = scenario.description;

  buildStoriesList(scenarioId);

  const railIdx = SCENARIOS.findIndex(s => s.id === scenarioId);
  const railBtns = storiesScenarioRailEl.querySelectorAll<HTMLButtonElement>('.scenario-rail-btn');
  railBtns[railIdx]?.scrollIntoView({ block: 'nearest', behavior: animated ? 'smooth' : 'auto' });

  if (!animated) {
    resetStoriesParallaxLayers();
    return;
  }

  resetStoriesParallaxLayers();

  const icon = storiesScenarioIconEl;
  const img = storiesScenarioImgEl;
  const title = storiesScenarioTitleEl;
  const mini = storiesScenarioMiniTitleEl;
  const desc = storiesScenarioDescEl;

  gsap
    .timeline({ defaults: { ease: 'power2.out' } })
    .add(
      gsap.fromTo(
        img,
        { y: dir * 48, scale: 1.07 },
        { y: 0, scale: 1, duration: 0.55, ease: 'power3.out' },
      ),
      0,
    )
    .add(gsap.fromTo(icon, { y: dir * 8 }, { y: 0, duration: 0.45, ease: 'power3.out' }), 0)
    .add(
      gsap.fromTo(title, { y: dir * 10 }, { y: 0, duration: 0.5, ease: 'power3.out' }),
      0,
    )
    .add(
      gsap.fromTo(
        mini,
        { y: dir * 22, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.42 },
      ),
      0,
    )
    .add(
      gsap.fromTo(
        desc,
        { y: dir * 14, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.48 },
      ),
      0.04,
    );
}

function buildStoriesList(scenarioId: string): void {
  const progress = loadStoryProgress();

  const scenarioStories = STORIES.filter(s => s.scenario === scenarioId);

  // Auto-unlock per scenario: walk this scenario's stories in order and advance
  // reachedScenarioIndex based on completedIds (handles stories added after the player last played).
  let computedReached = 0;
  while (computedReached < scenarioStories.length && progress.completedIds.includes(scenarioStories[computedReached].id)) {
    computedReached++;
  }
  const currentReached = progress.reachedScenarioIndex[scenarioId] ?? 0;
  if (computedReached > currentReached) {
    progress.reachedScenarioIndex[scenarioId] = computedReached;
    saveStoryProgress(progress);
  }
  const completedInScenario = scenarioStories.filter(s => progress.completedIds.includes(s.id)).length;

  // Update progress indicator
  storiesScenarioProgressEl.innerHTML = '';
  const progressText = document.createElement('span');
  progressText.textContent = `${completedInScenario} / ${scenarioStories.length}`;
  const progressBar = document.createElement('div');
  progressBar.className = 'stories-progress-bar';
  const progressFill = document.createElement('div');
  progressFill.className = 'stories-progress-bar-fill';
  progressFill.style.width = scenarioStories.length > 0
    ? `${(completedInScenario / scenarioStories.length) * 100}%`
    : '0%';
  progressBar.appendChild(progressFill);
  storiesScenarioProgressEl.appendChild(progressText);
  storiesScenarioProgressEl.appendChild(progressBar);

  storiesListEl.innerHTML = '';

  scenarioStories.forEach(story => {
    const index = STORIES.indexOf(story);
    const scenarioIndex = scenarioStories.indexOf(story);
    const isLocked = scenarioIndex > (progress.reachedScenarioIndex[scenarioId] ?? 0);
    const isCompleted = progress.completedIds.includes(story.id);
    const hasSave = progress.activeStoryId === story.id && hasStoryGameState();

    const card = document.createElement('div');
    card.className = 'story-card' + (isLocked ? ' story-locked' : '');

    // Dashed thumbnail with story number
    const thumb = document.createElement('div');
    thumb.className = 'story-card-thumb';
    thumb.textContent = String(scenarioStories.indexOf(story) + 1);
    card.appendChild(thumb);

    const info = document.createElement('div');
    info.className = 'story-card-info';

    const titleEl = document.createElement('div');
    titleEl.className = 'story-card-title';
    titleEl.textContent = story.title;
    info.appendChild(titleEl);

    const statusEl = document.createElement('div');
    statusEl.className = 'story-card-status';
    const modeLabel = story.gameMode.toUpperCase();
    let statusLabel: string;
    if (isLocked) {
      statusLabel = 'LOCKED';
    } else if (hasSave) {
      statusLabel = 'IN PROGRESS';
    } else if (isCompleted) {
      const turns = progress.completedTurns[story.id];
      statusLabel = turns != null ? `COMPLETED IN ${turns} TURNS` : 'COMPLETED';
    } else {
      statusLabel = 'READY';
    }
    const mapSize = `${story.map.cols}x${story.map.rows}`;
    statusEl.textContent = `${modeLabel} - ${mapSize} - ${statusLabel}`;
    info.appendChild(statusEl);

    card.appendChild(info);

    if (!isLocked) {
      const playBtn = document.createElement('button');
      const label = hasSave ? 'CONTINUE' : isCompleted ? 'REPLAY' : 'PLAY';
      playBtn.className = `story-play-btn ${isCompleted || hasSave ? 'button-secondary' : 'button-primary'}`;
      playBtn.textContent = label;

      playBtn.addEventListener('click', () => {
        if (hasSave) {
          const savedState = loadStoryGameState();
          if (savedState) {
            startStory(index, savedState);
            return;
          }
        }
        if (hasStoryGameState()) {
          pendingStoryStartIndex = index;
          storyStartConfirmOverlay.classList.remove('hidden');
          return;
        }
        startStory(index);
      });

      card.appendChild(playBtn);
    }

    storiesListEl.appendChild(card);
  });
}

function restoreConfigAfterStory(): void {
  const snapshot = storyConfigSnapshot ?? STORY_CONFIG_DEFAULTS;
  updateConfig(snapshot);
  syncDimensions();
  storyConfigSnapshot = null;
  setActiveUnitPackage(null);
  setActiveUnitPackagePlayer2(null);
  activeStoryIndex = null;
}

function handleStoryWin(): void {
  const story = STORIES[activeStoryIndex!]!;
  const progress = loadStoryProgress();
  if (!progress.completedIds.includes(story.id)) {
    progress.completedIds.push(story.id);
    progress.completedTurns[story.id] = state.turn;
  }
  const scenarioId = story.scenario;
  const scenarioStories = STORIES.filter(s => s.scenario === scenarioId);
  const storyScenarioIndex = scenarioStories.indexOf(story);
  const nextScenarioIndex = storyScenarioIndex + 1;
  const currentReached = progress.reachedScenarioIndex[scenarioId] ?? 0;
  if (nextScenarioIndex < scenarioStories.length && nextScenarioIndex > currentReached) {
    progress.reachedScenarioIndex[scenarioId] = nextScenarioIndex;
  }
  progress.activeStoryId = null;
  saveStoryProgress(progress);
  clearStoryGameState();
}

function startStory(storyIndex: number, savedState?: GameState): void {
  const story = STORIES[storyIndex]!;

  storyConfigSnapshot = {
    boardCols: config.boardCols,
    boardRows: config.boardRows,
    productionPointsPerTurn: config.productionPointsPerTurn,
    productionPointsPerTurnAi: config.productionPointsPerTurnAi,
    conquestPointsPlayer: config.conquestPointsPlayer,
    conquestPointsAi: config.conquestPointsAi,
    breakthroughAttackerStartingPP: config.breakthroughAttackerStartingPP,
    breakthroughSectorCount: config.breakthroughSectorCount,
    breakthroughPlayer1Role: config.breakthroughPlayer1Role,
    breakthroughRandomRoles: config.breakthroughRandomRoles,
    customMatchMapId: config.customMatchMapId,
  };

  updateConfig({
    customMatchMapId: null,
    boardCols: story.map.cols,
    boardRows: story.map.rows,
    ...(story.productionPointsPerTurn !== undefined ? { productionPointsPerTurn: story.productionPointsPerTurn } : {}),
    ...(story.productionPointsPerTurnAi !== undefined ? { productionPointsPerTurnAi: story.productionPointsPerTurnAi } : {}),
    ...(story.conquestPointsPlayer !== undefined ? { conquestPointsPlayer: story.conquestPointsPlayer } : {}),
    ...(story.conquestPointsAi !== undefined ? { conquestPointsAi: story.conquestPointsAi } : {}),
    ...(story.breakthroughAttackerStartingPP !== undefined ? { breakthroughAttackerStartingPP: story.breakthroughAttackerStartingPP } : {}),
    ...(story.breakthroughSectorCount !== undefined ? { breakthroughSectorCount: story.breakthroughSectorCount } : {}),
    ...(story.breakthroughPlayer1Role !== undefined ? { breakthroughPlayer1Role: story.breakthroughPlayer1Role } : {}),
    ...(story.breakthroughRandomRoles !== undefined ? { breakthroughRandomRoles: story.breakthroughRandomRoles } : {}),
  });
  syncDimensions();
  setActiveUnitPackage(story.unitPackage ?? null);
  setActiveUnitPackagePlayer2(story.unitPackagePlayer2 ?? null);

  activeStoryIndex = storyIndex;

  const progress = loadStoryProgress();
  progress.activeStoryId = story.id;
  saveStoryProgress(progress);

  if (!savedState) {
    clearStoryGameState();
  }

  let initialState: GameState;
  if (!savedState) {
    initialState = createStoryState(story);
  } else if (savedState.unitPackage == null) {
    const p1 = story.unitPackage ?? 'standard';
    const p2 = story.unitPackagePlayer2 ?? p1;
    initialState = { ...savedState, unitPackage: p1, unitPackagePlayer2: p2 };
  } else {
    initialState = savedState;
  }

  gameMode = 'vsAI';
  localPlayer = PLAYER;
  hideStoriesOverlay();
  startGame(initialState);
}

menuStoriesBtn.addEventListener('click', () => {
  showStoriesOverlay();
});

menuAchievementsBtn.addEventListener('click', () => {
  showAchievementsOverlay();
});

achievementsBackBtn.addEventListener('click', () => {
  hideAchievementsOverlay();
  showMainMenu();
});

storiesBackBtn.addEventListener('click', () => {
  hideStoriesOverlay();
  showMainMenu();
});

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (storiesOverlayEl.classList.contains('hidden')) return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;

  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
    return;
  }

  if (!storyStartConfirmOverlay.classList.contains('hidden')) return;
  if (SCENARIOS.length === 0) return;

  const idx = SCENARIOS.findIndex(s => s.id === activeScenarioId);
  if (idx < 0) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = Math.min(idx + 1, SCENARIOS.length - 1);
    if (next === idx) return;
    selectScenario(SCENARIOS[next]!.id, { animated: true, direction: 1 });
    return;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = Math.max(idx - 1, 0);
    if (prev === idx) return;
    selectScenario(SCENARIOS[prev]!.id, { animated: true, direction: -1 });
  }
});

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
      startGame(createInitialStateForMenu());
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
    startGame(createInitialStateForMenu());
  });
});

cancelNewGameBtn.addEventListener('click', () => {
  newGameConfirmOverlay.classList.add('hidden');
});

confirmStoryStartBtn.addEventListener('click', () => {
  storyStartConfirmOverlay.classList.add('hidden');
  if (pendingStoryStartIndex !== null) {
    startStory(pendingStoryStartIndex);
    pendingStoryStartIndex = null;
  }
});

cancelStoryStartBtn.addEventListener('click', () => {
  storyStartConfirmOverlay.classList.add('hidden');
  pendingStoryStartIndex = null;
});

menuHostBtn.addEventListener('click', () => {
  gameMode = 'vsHuman';
  localPlayer = PLAYER;
  state = createInitialStateForMenu();
  lobbyTitleEl.textContent = 'HOST GAME';
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
  lobbyTitleEl.textContent = 'JOIN GAME';
  lobbyOverlayEl.classList.remove('hidden');
  lobbyMenuEl.classList.add('hidden');
  lobbyHostWaitEl.classList.add('hidden');
  lobbyJoinFormEl.classList.remove('hidden');
  lobbyCodeInputEl.value = '';
  lobbyErrorEl.classList.add('hidden');
  lobbyCodeInputEl.focus();
});

// ── Map Editor ────────────────────────────────────────────────────────────────

initMapEditor(() => {
  hideMapEditor();
  showMainMenu();
});

for (const id of ['me-scenario', 'me-game-mode', 'me-unit-package', 'me-unit-package-player2'] as const) {
  initCustomSettingsSelect(id);
}

menuMapEditorBtn.addEventListener('click', () => {
  hideMainMenu();
  showMapEditor();
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
  ['cfg-breakthroughAttackerStartingPP', 'breakthroughAttackerStartingPP', 1],
  ['cfg-breakthroughSectorCount', 'breakthroughSectorCount', 1],
  ['cfg-breakthroughEnemySectorStrengthMult', 'breakthroughEnemySectorStrengthMult', 100],
  ['cfg-breakthroughSectorCaptureBonusPP', 'breakthroughSectorCaptureBonusPP', 1],
  ['cfg-startingUnitsPlayer1',     'startingUnitsPlayer1',     1],
  ['cfg-startingUnitsPlayer2',     'startingUnitsPlayer2',     1],
  ['cfg-startingUnitsDefender',    'startingUnitsDefender',    1],
  ['cfg-startingUnitsAttacker',    'startingUnitsAttacker',    1],
  ['cfg-boardCols',               'boardCols',               1],
  ['cfg-boardRows',               'boardRows',               1],
  ['cfg-productionPointsPerTurn',   'productionPointsPerTurn',   1],
  ['cfg-productionPointsPerTurnAi', 'productionPointsPerTurnAi', 1],
  ['cfg-territoryQuota',          'territoryQuota',          1],
  ['cfg-pointsPerQuota',          'pointsPerQuota',          1],
  ['cfg-productionTurns',         'productionTurns',         1],
  ['cfg-productionSafeDistance',  'productionSafeDistance',  1],
  ['cfg-flankingBonus',           'flankingBonus',           100],
  ['cfg-maxFlankingUnits',        'maxFlankingUnits',        1],
  ['cfg-healOwnTerritory',        'healOwnTerritory',        1],
  ['cfg-mountainPct',             'mountainPct',             100],
  ['cfg-riverMaxLengthBoardWidthMult', 'riverMaxLengthBoardWidthMult', 100],
];

// Proxy type for key checking only — never instantiated
declare const _cfgNumProxy: {
  controlPointCount: number; conquestPointsPlayer: number; conquestPointsAi: number;
  breakthroughAttackerStartingPP: number; breakthroughSectorCount: number; breakthroughEnemySectorStrengthMult: number;
  breakthroughSectorCaptureBonusPP: number;
  startingUnitsPlayer1: number; startingUnitsPlayer2: number; startingUnitsDefender: number; startingUnitsAttacker: number;
  boardCols: number; boardRows: number;
  productionPointsPerTurn: number;
  productionPointsPerTurnAi: number;
  territoryQuota: number; pointsPerQuota: number;
  productionTurns: number; productionSafeDistance: number;
  flankingBonus: number; maxFlankingUnits: number;
  healOwnTerritory: number;
  mountainPct: number;
  riverMaxLengthBoardWidthMult: number;
  // enableRivers is a toggle, handled separately via TOGGLE_FIELDS
};

const TOGGLE_FIELDS: Array<[string, 'zoneOfControl' | 'limitArtillery' | 'enableRivers']> = [
  ['cfg-zoneOfControl',      'zoneOfControl'],
  ['cfg-limitArtillery',     'limitArtillery'],
  ['cfg-enableRivers',       'enableRivers'],
];

const RULES_PRESET_NUM_FIELDS: Array<[string, keyof RulesPresetValues, number]> = [
  ['cfg-mountainPct', 'mountainPct', 100],
  ['cfg-riverMaxLengthBoardWidthMult', 'riverMaxLengthBoardWidthMult', 100],
  ['cfg-productionPointsPerTurn', 'productionPointsPerTurn', 1],
  ['cfg-productionPointsPerTurnAi', 'productionPointsPerTurnAi', 1],
  ['cfg-territoryQuota', 'territoryQuota', 1],
  ['cfg-pointsPerQuota', 'pointsPerQuota', 1],
  ['cfg-productionTurns', 'productionTurns', 1],
  ['cfg-productionSafeDistance', 'productionSafeDistance', 1],
  ['cfg-flankingBonus', 'flankingBonus', 100],
  ['cfg-maxFlankingUnits', 'maxFlankingUnits', 1],
  ['cfg-healOwnTerritory', 'healOwnTerritory', 1],
  ['cfg-breakthroughAttackerStartingPP', 'breakthroughAttackerStartingPP', 1],
  ['cfg-breakthroughEnemySectorStrengthMult', 'breakthroughEnemySectorStrengthMult', 100],
  ['cfg-breakthroughSectorCaptureBonusPP', 'breakthroughSectorCaptureBonusPP', 1],
];

const RULES_PRESET_TOGGLES: Array<[string, 'zoneOfControl' | 'limitArtillery' | 'enableRivers']> = [
  ['cfg-enableRivers', 'enableRivers'],
  ['cfg-zoneOfControl', 'zoneOfControl'],
  ['cfg-limitArtillery', 'limitArtillery'],
];

class SettingsOnOffToggle {
  private readonly buttonEl: HTMLButtonElement;

  constructor(buttonEl: HTMLButtonElement) {
    this.buttonEl = buttonEl;
    this.buttonEl.type = 'button';
    this.syncFromDom();
    this.buttonEl.addEventListener('click', () => {
      this.setValue(!this.getValue());
    });
  }

  getValue(): boolean {
    return this.buttonEl.dataset.value === 'true';
  }

  setValue(next: boolean): void {
    this.buttonEl.dataset.value = String(next);
    this.buttonEl.textContent = next ? 'ON' : 'OFF';
    this.buttonEl.setAttribute('aria-pressed', String(next));
  }

  private syncFromDom(): void {
    this.setValue(this.getValue());
  }
}

const settingsOnOffToggles = new Map<string, SettingsOnOffToggle>();

/** Tracks game mode across settings UI updates so quota fields can be backed up / restored around Breakthrough. */
let lastSettingsGameModeForQuota: string | null = null;
let quotaFieldsBeforeBreakthrough: { territory: string; points: string } | null = null;
/** Last committed board width (settings); used when width input is empty for snapshots. */
let lastCommittedBoardCols = config.boardCols;

/** Fixed story map selected: hide BOARD — size and terrain come from the preset. */
function setBoardSettingsLocked(locked: boolean): void {
  document.getElementById('settings-board-section')?.classList.toggle('hidden', locked);
}

function populateSettings(): void {
  lastSettingsGameModeForQuota = null;
  quotaFieldsBeforeBreakthrough = null;
  const vals: Record<string, number> = {
    controlPointCount: config.controlPointCount,
    conquestPointsPlayer: config.conquestPointsPlayer,
    conquestPointsAi: config.conquestPointsAi,
    breakthroughAttackerStartingPP: config.breakthroughAttackerStartingPP,
    breakthroughSectorCount: config.breakthroughSectorCount,
    breakthroughEnemySectorStrengthMult: config.breakthroughEnemySectorStrengthMult,
    breakthroughSectorCaptureBonusPP: config.breakthroughSectorCaptureBonusPP,
    startingUnitsPlayer1: config.startingUnitsPlayer1,
    startingUnitsPlayer2: config.startingUnitsPlayer2,
    startingUnitsDefender: config.startingUnitsDefender,
    startingUnitsAttacker: config.startingUnitsAttacker,
    boardCols: config.boardCols, boardRows: config.boardRows,
    productionPointsPerTurn: config.productionPointsPerTurn,
    productionPointsPerTurnAi: config.productionPointsPerTurnAi,
    territoryQuota: config.territoryQuota, pointsPerQuota: config.pointsPerQuota,
    productionTurns: config.productionTurns, productionSafeDistance: config.productionSafeDistance,
    flankingBonus: config.flankingBonus, maxFlankingUnits: config.maxFlankingUnits,
    healOwnTerritory: config.healOwnTerritory,
    mountainPct: config.mountainPct,
    riverMaxLengthBoardWidthMult: config.riverMaxLengthBoardWidthMult,
  };
  for (const [id, key, scale] of NUM_FIELDS) {
    const el = document.getElementById(id) as HTMLInputElement;
    el.value = String(Math.round(vals[key] * scale));
  }
  for (const [id, key] of TOGGLE_FIELDS) {
    const el = settingsOnOffToggles.get(id);
    if (!el) continue;
    const val = config[key] as boolean;
    el.setValue(val);
  }
  const pkgEl = document.getElementById('cfg-unitPackage') as HTMLSelectElement;
  pkgEl.value = settingsUnitPackage;
  pkgEl.dispatchEvent(new Event('settings-select-sync'));
  const pkgEl2 = document.getElementById('cfg-unitPackagePlayer2') as HTMLSelectElement;
  pkgEl2.value = settingsUnitPackagePlayer2;
  pkgEl2.dispatchEvent(new Event('settings-select-sync'));
  const gameModeEl = document.getElementById('cfg-gameMode') as HTMLSelectElement;
  gameModeEl.value = config.gameMode;
  const breakthroughRoleEl = document.getElementById('cfg-breakthroughPlayer1Role') as HTMLSelectElement;
  if (breakthroughRoleEl) breakthroughRoleEl.value = config.breakthroughPlayer1Role;
  const breakthroughRandEl = document.getElementById('cfg-breakthroughRandomRoles') as HTMLInputElement;
  if (breakthroughRandEl) breakthroughRandEl.checked = config.breakthroughRandomRoles;
  syncBreakthroughRoleControls();
  updateModeSpecificSettingsVisibility();
  syncModeCards();
  const customMapEl = document.getElementById('cfg-customMap') as HTMLSelectElement | null;
  if (customMapEl) {
    customMapEl.innerHTML = '';
    const autoOpt = document.createElement('option');
    autoOpt.value = '';
    autoOpt.textContent = '[generate]';
    customMapEl.appendChild(autoOpt);
    for (const s of STORIES.filter(x => storyMapHasFullCustomMatchSupport(x.map))) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.title;
      customMapEl.appendChild(opt);
    }
    const cur = config.customMatchMapId ?? '';
    const valid = cur !== '' && STORIES.some(s => s.id === cur && storyMapHasFullCustomMatchSupport(s.map));
    customMapEl.value = valid ? cur : '';
    if (valid && cur) {
      const st = STORIES.find(s => s.id === cur && storyMapHasFullCustomMatchSupport(s.map));
      if (st) {
        (document.getElementById('cfg-boardCols') as HTMLInputElement).value = String(st.map.cols);
        (document.getElementById('cfg-boardRows') as HTMLInputElement).value = String(st.map.rows);
        vals.boardCols = st.map.cols;
        vals.boardRows = st.map.rows;
      }
    }
    setBoardSettingsLocked(!!customMapEl.value.trim());
    customMapEl.dispatchEvent(new Event('settings-select-rebuild'));
  } else {
    setBoardSettingsLocked(false);
  }
  clampStartingUnitsInputsToBoardWidth(vals.boardCols);
  lastCommittedBoardCols = vals.boardCols;

  const rulesPresetEl = document.getElementById('cfg-rulesPreset') as HTMLSelectElement | null;
  if (rulesPresetEl) {
    rulesPresetEl.value = findMatchingRulesPresetId(config);
    rulesPresetEl.dispatchEvent(new Event('settings-select-sync'));
    syncRulesDetailVisibility();
  }
}

function syncBreakthroughRoleControls(): void {
  const randEl = document.getElementById('cfg-breakthroughRandomRoles') as HTMLInputElement | null;
  const roleEl = document.getElementById('cfg-breakthroughPlayer1Role') as HTMLSelectElement | null;
  if (!randEl || !roleEl) return;
  roleEl.disabled = randEl.checked;
  roleEl.dispatchEvent(new Event('settings-select-sync'));
}

function updateModeSpecificSettingsVisibility(): void {
  const gameModeEl = document.getElementById('cfg-gameMode') as HTMLSelectElement;
  const v = gameModeEl.value;
  const conquestWrap = document.getElementById('settings-conquest-only') as HTMLDivElement;
  const breakthroughWrap = document.getElementById('settings-breakthrough-only') as HTMLDivElement;
  const domConqWrap = document.getElementById('settings-domination-conquest-only') as HTMLDivElement;
  conquestWrap.classList.toggle('hidden', v !== 'conquest');
  breakthroughWrap.classList.toggle('hidden', v !== 'breakthrough');
  domConqWrap.classList.toggle('hidden', v !== 'domination' && v !== 'conquest');

  // Breakthrough balance: territory quota economy is disabled for both factions.
  const territoryQuotaEl = document.getElementById('cfg-territoryQuota') as HTMLInputElement;
  const pointsPerQuotaEl = document.getElementById('cfg-pointsPerQuota') as HTMLInputElement;
  const territoryQuotaRowEl = document.getElementById('cfg-territoryQuota-row') as HTMLDivElement | null;
  const pointsPerQuotaRowEl = document.getElementById('cfg-pointsPerQuota-row') as HTMLDivElement | null;
  const isBreakthrough = v === 'breakthrough';
  const prevMode = lastSettingsGameModeForQuota;
  const enteringBreakthrough = isBreakthrough && prevMode !== 'breakthrough';
  const leavingBreakthrough = !isBreakthrough && prevMode === 'breakthrough';

  if (enteringBreakthrough) {
    quotaFieldsBeforeBreakthrough = {
      territory: territoryQuotaEl.value,
      points: pointsPerQuotaEl.value,
    };
  }
  if (leavingBreakthrough) {
    if (quotaFieldsBeforeBreakthrough) {
      territoryQuotaEl.value = quotaFieldsBeforeBreakthrough.territory;
      pointsPerQuotaEl.value = quotaFieldsBeforeBreakthrough.points;
    } else {
      territoryQuotaEl.value = String(DEFAULT_TERRITORY_ECONOMY.territoryQuota);
      pointsPerQuotaEl.value = String(DEFAULT_TERRITORY_ECONOMY.pointsPerQuota);
    }
    quotaFieldsBeforeBreakthrough = null;
  }
  if (isBreakthrough) {
    territoryQuotaEl.value = '0';
    pointsPerQuotaEl.value = '0';
  }
  territoryQuotaEl.disabled = isBreakthrough;
  pointsPerQuotaEl.disabled = isBreakthrough;
  territoryQuotaRowEl?.toggleAttribute('disabled', isBreakthrough);
  pointsPerQuotaRowEl?.toggleAttribute('disabled', isBreakthrough);
  lastSettingsGameModeForQuota = v;
}

function syncRulesFieldsFromConfig(): void {
  for (const [elId, key, scale] of RULES_PRESET_NUM_FIELDS) {
    const el = document.getElementById(elId) as HTMLInputElement;
    const v = config[key] as number;
    el.value = String(Math.round(v * scale));
  }
  for (const [elId, key] of RULES_PRESET_TOGGLES) {
    const t = settingsOnOffToggles.get(elId);
    if (t) t.setValue(config[key] as boolean);
  }
}

function syncRulesPresetNote(): void {
  const sel = document.getElementById('cfg-rulesPreset') as HTMLSelectElement | null;
  const note = document.getElementById('cfg-rulesPreset-note');
  if (!sel || !note) return;
  note.textContent = getRulesPresetDescriptionForSelectValue(sel.value);
}

function syncRulesDetailVisibility(): void {
  const sel = document.getElementById('cfg-rulesPreset') as HTMLSelectElement | null;
  const wrap = document.getElementById('settings-rules-detail');
  if (!sel || !wrap) return;
  wrap.classList.toggle('hidden', sel.value !== RULES_PRESET_CUSTOM);
  syncRulesPresetNote();
}

function applyRulesPreset(id: string): void {
  if (id === RULES_PRESET_CUSTOM) {
    syncRulesDetailVisibility();
    return;
  }
  const preset = getRulesPresetById(id);
  if (!preset) return;
  const { id: _pid, label: _label, description: _desc, ...values } = preset;
  updateConfig(values);
  syncRulesFieldsFromConfig();
  updateModeSpecificSettingsVisibility();
  syncRulesDetailVisibility();
}

function clampNumericInputToBounds(el: HTMLInputElement): number {
  const raw = parseFloat(el.value);
  const min = el.min === '' ? -Infinity : Number(el.min);
  const max = el.max === '' ? Infinity : Number(el.max);
  const fallback = Number.isFinite(min) ? min : 0;
  const parsed = Number.isFinite(raw) ? raw : fallback;
  const clamped = Math.max(min, Math.min(max, parsed));
  if (String(clamped) !== el.value) el.value = String(clamped);
  return clamped;
}

/** Starting unit count inputs — max is always {@link boardCols} (one unit per home-row hex). */
const STARTING_UNITS_FIELD_IDS = [
  'cfg-startingUnitsPlayer1',
  'cfg-startingUnitsPlayer2',
  'cfg-startingUnitsDefender',
  'cfg-startingUnitsAttacker',
] as const;

/** Sets each starting-units input `max` to `width` and clamps values above `width`. */
function clampStartingUnitsInputsToBoardWidth(width: number): void {
  for (const id of STARTING_UNITS_FIELD_IDS) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) continue;
    el.max = String(width);
    const raw = parseFloat(el.value);
    const v = Number.isFinite(raw) ? raw : Number(el.min) || 1;
    if (v > width) {
      el.value = String(width);
    }
  }
}

function initCustomSettingsSelect(selectId: string): void {
  const selectEl = document.getElementById(selectId) as HTMLSelectElement | null;
  if (!selectEl) return;

  const wrapperEl = document.createElement('div');
  wrapperEl.className = 'settings-custom-select';

  const buttonEl = document.createElement('button');
  buttonEl.type = 'button';
  buttonEl.className = 'settings-custom-select-button';
  buttonEl.setAttribute('aria-haspopup', 'listbox');
  buttonEl.setAttribute('aria-expanded', 'false');

  const labelEl = document.createElement('span');
  labelEl.className = 'settings-custom-select-button-label';

  const chevronEl = document.createElement('img');
  chevronEl.className = 'settings-custom-select-chevron';
  chevronEl.src = chevronFilledIcon;
  chevronEl.alt = '';
  chevronEl.setAttribute('aria-hidden', 'true');
  buttonEl.appendChild(labelEl);
  buttonEl.appendChild(chevronEl);

  const listEl = document.createElement('ul');
  listEl.className = 'settings-custom-select-list hidden';
  listEl.setAttribute('role', 'listbox');

  const syncFromSelect = (): void => {
    const selectedOption = selectEl.selectedOptions[0];
    labelEl.textContent = selectedOption ? selectedOption.textContent ?? '' : '';
    buttonEl.disabled = selectEl.disabled;
    for (const node of listEl.querySelectorAll('.settings-custom-select-option')) {
      node.classList.remove('is-selected');
      if ((node as HTMLButtonElement).dataset.value === selectEl.value) {
        node.classList.add('is-selected');
      }
    }
  };

  const closeList = (): void => {
    listEl.classList.add('hidden');
    buttonEl.setAttribute('aria-expanded', 'false');
  };

  const rebuildOptionList = (): void => {
    closeList();
    listEl.innerHTML = '';
    for (const optionEl of Array.from(selectEl.options)) {
      const liEl = document.createElement('li');
      const itemButtonEl = document.createElement('button');
      itemButtonEl.type = 'button';
      itemButtonEl.className = 'settings-custom-select-option';
      itemButtonEl.dataset.value = optionEl.value;
      itemButtonEl.textContent = optionEl.textContent;
      itemButtonEl.addEventListener('click', () => {
        selectEl.value = optionEl.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        syncFromSelect();
        closeList();
      });
      liEl.appendChild(itemButtonEl);
      listEl.appendChild(liEl);
    }
    syncFromSelect();
  };

  rebuildOptionList();

  buttonEl.addEventListener('click', () => {
    const isOpen = !listEl.classList.contains('hidden');
    if (isOpen) {
      closeList();
      return;
    }
    listEl.classList.remove('hidden');
    buttonEl.setAttribute('aria-expanded', 'true');
  });

  document.addEventListener('click', (event) => {
    const target = event.target as Node | null;
    if (!target) return;
    if (!wrapperEl.contains(target)) closeList();
  });

  selectEl.classList.add('settings-select-native-hidden');
  selectEl.insertAdjacentElement('afterend', wrapperEl);
  wrapperEl.appendChild(buttonEl);
  wrapperEl.appendChild(listEl);

  selectEl.addEventListener('change', syncFromSelect);
  selectEl.addEventListener('settings-select-sync', syncFromSelect as EventListener);
  selectEl.addEventListener('settings-select-rebuild', rebuildOptionList as EventListener);
}

function collectSettings(): Parameters<typeof updateConfig>[0] {
  const out: Partial<Parameters<typeof updateConfig>[0]> = {};
  for (const [id, key, scale] of NUM_FIELDS) {
    const el = document.getElementById(id) as HTMLInputElement;
    out[key] = clampNumericInputToBounds(el) / scale;
  }
  for (const [id, key] of TOGGLE_FIELDS) {
    const toggle = settingsOnOffToggles.get(id);
    if (!toggle) continue;
    out[key] = toggle.getValue();
  }
  const pkgEl2 = document.getElementById('cfg-unitPackage') as HTMLSelectElement;
  settingsUnitPackage = pkgEl2.value || 'standard';
  const pkgEl2P2 = document.getElementById('cfg-unitPackagePlayer2') as HTMLSelectElement;
  settingsUnitPackagePlayer2 = pkgEl2P2.value || 'standard';
  const gameModeEl = document.getElementById('cfg-gameMode') as HTMLSelectElement;
  out.gameMode = gameModeEl.value as GameMode;
  if (out.gameMode === 'breakthrough') {
    out.territoryQuota = 0;
    out.pointsPerQuota = 0;
  }
  if (out.gameMode === 'breakthrough') {
    // Ignore Player 1/2 starting-unit fields in Breakthrough mode.
    out.startingUnitsPlayer1 = config.startingUnitsPlayer1;
    out.startingUnitsPlayer2 = config.startingUnitsPlayer2;
  } else {
    // Ignore Defender/Attacker starting-unit fields outside Breakthrough mode.
    out.startingUnitsDefender = config.startingUnitsDefender;
    out.startingUnitsAttacker = config.startingUnitsAttacker;
  }
  const breakthroughRoleEl = document.getElementById('cfg-breakthroughPlayer1Role') as HTMLSelectElement;
  const breakthroughRandEl = document.getElementById('cfg-breakthroughRandomRoles') as HTMLInputElement;
  if (breakthroughRoleEl) out.breakthroughPlayer1Role = breakthroughRoleEl.value as 'attacker' | 'defender';
  if (breakthroughRandEl) out.breakthroughRandomRoles = breakthroughRandEl.checked;
  const customMapEl = document.getElementById('cfg-customMap') as HTMLSelectElement | null;
  if (customMapEl) {
    const mapId = customMapEl.value.trim();
    out.customMatchMapId = mapId === '' ? null : mapId;
    const story = mapId ? STORIES.find(s => s.id === mapId && storyMapHasFullCustomMatchSupport(s.map)) : undefined;
    if (story) {
      out.boardCols = story.map.cols;
      out.boardRows = story.map.rows;
    }
  }
  return out as Parameters<typeof updateConfig>[0];
}

// Wire settings ON/OFF toggle components
for (const [id] of TOGGLE_FIELDS) {
  const buttonEl = document.getElementById(id) as HTMLButtonElement | null;
  if (!buttonEl) continue;
  settingsOnOffToggles.set(id, new SettingsOnOffToggle(buttonEl));
}

initSettingsNumberSpinners();

for (const [id] of NUM_FIELDS) {
  const el = document.getElementById(id) as HTMLInputElement;
  el.addEventListener('input', () => {
    if (el.max === '') return;
    const v = parseFloat(el.value);
    const max = Number(el.max);
    if (Number.isFinite(v) && Number.isFinite(max) && v > max) {
      el.value = String(max);
    }
  });
  el.addEventListener('blur', () => {
    clampNumericInputToBounds(el);
  });
}

const boardColsSettingsEl = document.getElementById('cfg-boardCols') as HTMLInputElement;
boardColsSettingsEl.addEventListener('input', () => {
  const t = boardColsSettingsEl.value.trim();
  if (t === '') return;
  const raw = parseFloat(t);
  if (!Number.isFinite(raw)) return;
  const min = Number(boardColsSettingsEl.min);
  const max = Number(boardColsSettingsEl.max);
  // Do not enforce min while typing (e.g. "1" before "2" in "12"); blur commits min.
  if (raw > max) {
    boardColsSettingsEl.value = String(max);
    clampStartingUnitsInputsToBoardWidth(max);
    return;
  }
  if (raw >= min) {
    clampStartingUnitsInputsToBoardWidth(raw);
  }
});
boardColsSettingsEl.addEventListener('change', () => {
  const w = clampNumericInputToBounds(boardColsSettingsEl);
  clampStartingUnitsInputsToBoardWidth(w);
  lastCommittedBoardCols = w;
});

// Populate unit package selects from config and build custom widgets
(function () {
  const packages = [...new Set(config.unitTypes.map(u => u.package).filter((p): p is string => !!p))];
  const pkgEl = document.getElementById('cfg-unitPackage') as HTMLSelectElement;
  for (const pkg of packages) {
    const opt = document.createElement('option');
    opt.value = pkg;
    opt.textContent = pkg;
    pkgEl.appendChild(opt);
  }
  pkgEl.value = 'standard';
  const pkgEl2 = document.getElementById('cfg-unitPackagePlayer2') as HTMLSelectElement;
  for (const pkg of packages) {
    const opt = document.createElement('option');
    opt.value = pkg;
    opt.textContent = pkg;
    pkgEl2.appendChild(opt);
  }
  pkgEl2.value = 'standard';
})();
(function initRulesPresetSelectOptions(): void {
  const sel = document.getElementById('cfg-rulesPreset') as HTMLSelectElement | null;
  if (!sel) return;
  sel.innerHTML = '';
  for (const p of RULES_PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
  const customOpt = document.createElement('option');
  customOpt.value = RULES_PRESET_CUSTOM;
  customOpt.textContent = '[Custom]';
  sel.appendChild(customOpt);
})();
initCustomSettingsSelect('cfg-rulesPreset');
initCustomSettingsSelect('cfg-unitPackage');
initCustomSettingsSelect('cfg-unitPackagePlayer2');
initCustomSettingsSelect('cfg-breakthroughPlayer1Role');
initCustomSettingsSelect('cfg-customMap');
document.getElementById('cfg-rulesPreset')?.addEventListener('change', () => {
  const sel = document.getElementById('cfg-rulesPreset') as HTMLSelectElement;
  applyRulesPreset(sel.value);
});
document.getElementById('cfg-customMap')?.addEventListener('change', () => {
  const sel = document.getElementById('cfg-customMap') as HTMLSelectElement;
  const story = sel.value ? STORIES.find(s => s.id === sel.value && storyMapHasFullCustomMatchSupport(s.map)) : undefined;
  const colsEl = document.getElementById('cfg-boardCols') as HTMLInputElement;
  const rowsEl = document.getElementById('cfg-boardRows') as HTMLInputElement;
  if (story) {
    colsEl.value = String(story.map.cols);
    rowsEl.value = String(story.map.rows);
    clampStartingUnitsInputsToBoardWidth(story.map.cols);
    lastCommittedBoardCols = story.map.cols;
  }
  setBoardSettingsLocked(!!sel.value.trim());
});
document.getElementById('cfg-gameMode')!.addEventListener('change', () => {
  updateModeSpecificSettingsVisibility();
  syncModeCards();
});
document.getElementById('cfg-breakthroughRandomRoles')?.addEventListener('change', syncBreakthroughRoleControls);

// Mode pager — visual game mode picker
function syncModeCards(): void {
  const gameModeEl = document.getElementById('cfg-gameMode') as HTMLSelectElement;
  document.querySelectorAll<HTMLElement>('.mode-pager-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === gameModeEl.value);
  });
  const modeDef = MODE_DEFS.find(m => m.id === gameModeEl.value);
  if (modeDef) {
    modeDisplayImgEl.src = modeDef.image;
    modeDisplayIconEl.src = modeDef.icon;
    modeDisplayNameEl.textContent = modeDef.name;
    modeDisplayDescEl.textContent = modeDef.desc;
  }
}

function resetModeParallaxLayers(): void {
  gsap.killTweensOf([modeDisplayImgEl, modeDisplayIconEl, modeDisplayNameEl, modeDisplayDescEl]);
  gsap.set(modeDisplayImgEl, { y: 0, scale: 1 });
  gsap.set(modeDisplayIconEl, { y: 0 });
  gsap.set(modeDisplayNameEl, { y: 0, opacity: 1 });
  gsap.set(modeDisplayDescEl, { y: 0, opacity: 1 });
}

function selectMode(modeId: string, options?: { animated?: boolean; direction?: 1 | -1 }): void {
  const gameModeEl = document.getElementById('cfg-gameMode') as HTMLSelectElement;
  gameModeEl.value = modeId;
  gameModeEl.dispatchEvent(new Event('settings-select-sync'));
  gameModeEl.dispatchEvent(new Event('change'));

  let animated = options?.animated ?? false;
  if (animated && window.matchMedia('(prefers-reduced-motion: reduce)').matches) animated = false;
  const dir = options?.direction ?? 1;

  resetModeParallaxLayers();
  if (!animated) return;

  gsap
    .timeline({ defaults: { ease: 'power2.out' } })
    .add(
      gsap.fromTo(
        modeDisplayImgEl,
        { y: dir * 48, scale: 1.07 },
        { y: 0, scale: 1, duration: 0.55, ease: 'power3.out' },
      ),
      0,
    )
    .add(gsap.fromTo(modeDisplayIconEl, { y: dir * 8 }, { y: 0, duration: 0.45, ease: 'power3.out' }), 0)
    .add(
      gsap.fromTo(modeDisplayNameEl, { y: dir * 10 }, { y: 0, duration: 0.5, ease: 'power3.out' }),
      0,
    )
    .add(
      gsap.fromTo(
        modeDisplayDescEl,
        { y: dir * 14, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.48 },
      ),
      0.04,
    );
}

document.querySelectorAll<HTMLElement>('.mode-pager-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const gameModeEl = document.getElementById('cfg-gameMode') as HTMLSelectElement;
    const currentMode = gameModeEl.value;
    const newMode = btn.dataset.mode;
    if (!newMode || newMode === currentMode) return;
    const modeIds = MODE_DEFS.map(m => m.id);
    const fromIdx = modeIds.indexOf(currentMode as GameMode);
    const toIdx = modeIds.indexOf(newMode as GameMode);
    const direction = toIdx > fromIdx ? 1 : -1;
    selectMode(newMode, { animated: true, direction });
  });
});

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (settingsOverlayEl.classList.contains('hidden')) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;

  const gameModeEl = document.getElementById('cfg-gameMode') as HTMLSelectElement;
  const modeIds = MODE_DEFS.map(m => m.id);
  const idx = modeIds.indexOf(gameModeEl.value as GameMode);
  if (idx < 0) return;

  if (e.key === 'ArrowRight') {
    e.preventDefault();
    const next = Math.min(idx + 1, modeIds.length - 1);
    if (next === idx) return;
    selectMode(modeIds[next]!, { animated: true, direction: 1 });
    broadcastSettingsPreview();
    return;
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    const prev = Math.max(idx - 1, 0);
    if (prev === idx) return;
    selectMode(modeIds[prev]!, { animated: true, direction: -1 });
    broadcastSettingsPreview();
  }
});

const territoryQuotaLabelEl = document.getElementById('cfg-territoryQuota-label') as HTMLLabelElement | null;
const pointsPerQuotaLabelEl = document.getElementById('cfg-pointsPerQuota-label') as HTMLLabelElement | null;
const territoryQuotaInputEl = document.getElementById('cfg-territoryQuota') as HTMLInputElement | null;
const pointsPerQuotaInputEl = document.getElementById('cfg-pointsPerQuota') as HTMLInputElement | null;
const disabledBreakthroughTooltip =
  'Disabled in Breakthrough mode to fairly balance the game for both factions.';

function hideSettingsTooltip(): void {
  settingsTooltipEl.classList.add('hidden');
}

function maybeShowSettingsTooltip(labelEl: HTMLLabelElement | null, inputEl: HTMLInputElement | null): void {
  if (!labelEl || !inputEl || !inputEl.disabled) return;
  settingsTooltipEl.textContent = disabledBreakthroughTooltip;
  positionFixedTooltipBelow(settingsTooltipEl, labelEl.getBoundingClientRect());
}

territoryQuotaLabelEl?.addEventListener('mouseenter', () => {
  maybeShowSettingsTooltip(territoryQuotaLabelEl, territoryQuotaInputEl);
});
territoryQuotaLabelEl?.addEventListener('mouseleave', hideSettingsTooltip);
pointsPerQuotaLabelEl?.addEventListener('mouseenter', () => {
  maybeShowSettingsTooltip(pointsPerQuotaLabelEl, pointsPerQuotaInputEl);
});
pointsPerQuotaLabelEl?.addEventListener('mouseleave', hideSettingsTooltip);

let settingsOnStart: ((settings: Parameters<typeof updateConfig>[0]) => void) | null = null;

function showSettings(onStart: (settings: Parameters<typeof updateConfig>[0]) => void, mpStatusText?: string): void {
  populateSettings();
  settingsOnStart = onStart;
  const mpStatusEl = document.getElementById('settings-mp-status');
  if (mpStatusEl) {
    if (mpStatusText) {
      mpStatusEl.textContent = `[${mpStatusText}]`;
      mpStatusEl.classList.remove('hidden');
    } else {
      mpStatusEl.classList.add('hidden');
    }
  }
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
  setActiveUnitPackage(settingsUnitPackage);
  setActiveUnitPackagePlayer2(settingsUnitPackagePlayer2);
  const cb = settingsOnStart;
  hideSettings();
  cb?.(settings);
});

settingsBackBtn.addEventListener('click', () => {
  closeLobbyWs();
  hideSettings();
  showMainMenu();
});

// Broadcast settings changes to P2 in real-time when hosting a multiplayer game
settingsOverlayEl.addEventListener('change', broadcastSettingsPreview);
settingsOverlayEl.addEventListener('click', (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  if (target.closest('.mode-pager-btn') || target.closest('[data-value]')) {
    broadcastSettingsPreview();
  }
});

// P2 waiting overlay back button: disconnect and return to main menu
p2WaitingBackBtn.addEventListener('click', () => {
  closeLobbyWs();
  hideP2WaitingOverlay();
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
    startGame(createInitialStateForMenu());
  }
});

// ── Rules content ─────────────────────────────────────────────────────────────

function escapeHtmlRules(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unitTypeIdSignature(types: UnitType[]): string {
  return types.map(t => t.id).join('\0');
}

function buildUnitRowHtml(u: UnitType): string {
  const iconSrc = u.icon ?? `icons/${u.id}.svg`;
  const safeSrc = escapeHtmlRules(iconSrc);
  const rangeHtml =
    u.range != null
      ? `<span class="rules-unit-stat"><img src="icons/range.svg" alt="" width="14" height="14" /> Range ${u.range}</span>`
      : '';
  const extraFlankHtml =
    u.extraFlanking != null && u.extraFlanking !== 0
      ? `<span class="rules-unit-stat rules-unit-stat--extra">Extra flank +${Math.round(u.extraFlanking * 100)}%</span>`
      : '';
  return `
    <div class="rules-unit-row">
      <img class="rules-unit-icon" src="${safeSrc}" width="36" height="36" alt="" />
      <div class="rules-unit-body">
        <div class="rules-unit-name">${escapeHtmlRules(u.name)}</div>
        <div class="rules-unit-stats">
          <span class="rules-unit-stat"><img src="icons/points.svg" alt="" width="14" height="14" /> ${u.cost} PP</span>
          <span class="rules-unit-stat"><img src="icons/movement.svg" alt="" width="14" height="14" /> Move ${u.movement}</span>
          <span class="rules-unit-stat"><img src="icons/strength.svg" alt="" width="14" height="14" /> Str ${u.strength}</span>
          <span class="rules-unit-stat"><img src="icons/hp.svg" alt="" width="14" height="14" /> ${u.maxHp} HP</span>
          ${rangeHtml}
          <span class="rules-unit-stat rules-unit-stat--lvl">${u.upgradePointsToLevel} pts to level</span>
          ${extraFlankHtml}
        </div>
      </div>
    </div>`;
}

function buildMatchUnitsRosterHtml(): string {
  const p1 = getAvailableUnitTypes(1);
  const p2 = getAvailableUnitTypes(2);
  const pkg1 = p1[0]?.package;
  const pkg2 = p2[0]?.package;
  const sameRoster =
    unitTypeIdSignature(p1) === unitTypeIdSignature(p2) && (pkg1 ?? '') === (pkg2 ?? '');

  if (p1.length === 0 && p2.length === 0) {
    return `<p class="rules-prose rules-prose--muted">No unit roster is configured for this match.</p>`;
  }

  const listHtml = (types: UnitType[]) =>
    types.length === 0
      ? `<p class="rules-prose rules-prose--muted">No units in this package.</p>`
      : `<div class="rules-units-list">${types.map(buildUnitRowHtml).join('')}</div>`;

  if (sameRoster) {
    const pkgNote =
      pkg1 != null
        ? `<p class="rules-units-package">Unit package: <strong>${escapeHtmlRules(pkg1)}</strong> · both players</p>`
        : '';
    return `
      ${pkgNote}
      ${listHtml(p1)}`;
  }

  const pkgNote1 =
    pkg1 != null ? `<p class="rules-units-package">Package: <strong>${escapeHtmlRules(pkg1)}</strong></p>` : '';
  const pkgNote2 =
    pkg2 != null ? `<p class="rules-units-package">Package: <strong>${escapeHtmlRules(pkg2)}</strong></p>` : '';

  return `
    <div class="rules-units-split">
      <div class="rules-units-faction">
        <div class="rules-units-faction-title">Player 1</div>
        ${pkgNote1}
        ${listHtml(p1)}
      </div>
      <div class="rules-units-faction">
        <div class="rules-units-faction-title">Player 2</div>
        ${pkgNote2}
        ${listHtml(p2)}
      </div>
    </div>`;
}

function buildRulesContent(): string {
  const ar = getAvailableUnitTypes(1).find(u => u.id === 'artillery')
    ?? getAvailableUnitTypes(2).find(u => u.id === 'artillery')
    ?? config.unitTypes.find(u => u.id === 'artillery');
  const arRanged =
    ar?.range != null
      ? `2–${ar.range} hexes away`
      : '2+ hexes away';
  const maxFlankBonus = Math.round(config.maxFlankingUnits * config.flankingBonus * 100);
  const brPct = Math.round(config.breakthroughEnemySectorStrengthMult * 100);
  const riverDefPct = Math.round(config.riverDefenseBonus * 100);
  return `
    <div class="rules-layout">
    <div class="rules-sheet-head">
      <div class="rules-title">FULL RULES</div>
    </div>

    <div class="rules-main">
    <nav class="rules-sidebar" aria-label="Rule sections">
      <div class="rules-nav-group">
        <div class="rules-nav-group-label">Introduction</div>
        <a class="rules-nav-link" href="#rules-units">Units in this match</a>
        <a class="rules-nav-link" href="#rules-overview">Overview</a>
        <a class="rules-nav-link" href="#rules-turn-phases">Turn phases</a>
      </div>
      <div class="rules-nav-group">
        <div class="rules-nav-group-label">Gameplay</div>
        <a class="rules-nav-link" href="#rules-production">Production</a>
        <a class="rules-nav-link" href="#rules-movement">Movement</a>
        <a class="rules-nav-link" href="#rules-combat">Combat</a>
        <a class="rules-nav-link" href="#rules-healing">Healing</a>
        <a class="rules-nav-link" href="#rules-game-modes">Game modes</a>
      </div>
    </nav>
    <div class="rules-doc" tabindex="-1">
    <section id="rules-units" class="rules-anchor-section">
      <div class="settings-group rules-section">
      <div class="rules-group-title">Units in this match</div>
      <p class="rules-prose rules-prose">Production and combat use the stats below. Asymmetric matches list separate rosters for south and north.</p>
      ${buildMatchUnitsRosterHtml()}
      </div>
    </section>

    <section id="rules-overview" class="rules-anchor-section">
      <div class="settings-group rules-section">
      <div class="rules-group-title">Overview</div>
      <p class="rules-prose">Turn-based hex strategy on a ${config.boardCols}×${config.boardRows} grid.
         You play from the south (bottom row); the opponent plays from the north (top row).
         In custom match settings you can pick a <strong>map layout</strong> from maps that define both Conquest and Breakthrough control points in the map editor; otherwise the board is randomly generated.</p>
      </div>
    </section>

    <section id="rules-turn-phases" class="rules-anchor-section">
      <div class="settings-group rules-section">
      <div class="rules-group-title">Turn phases</div>
      <ol class="rules-list rules-list--ol">
        <li><strong>Production</strong> — spend PP to place units.</li>
        <li><strong>Movement</strong> — move each of your units up to its movement range.</li>
        <li><strong>End</strong> — the opponent takes their turn, then the turn counter advances.</li>
      </ol>
      <p class="rules-prose">Press <strong>NEXT</strong> to end the current phase whenever you want. The game also advances automatically when production has nothing left to do (no valid placement or you cannot afford any unit) or when no unit can move or make a ranged attack.</p>
      </div>
    </section>

    <section id="rules-production" class="rules-anchor-section">
      <div class="settings-group rules-section">
      <div class="rules-group-title">Production</div>
      <ul class="rules-list">
      <li>Each turn you earn <strong>${config.productionPointsPerTurn} PP</strong> (production points).</li>
      <li><strong>Breakthrough:</strong> the <strong>southern attacker</strong> does not receive PP after the match starts (only the configured starting pool). The <strong>northern defender</strong> earns PP each turn as above.</li>
      <li><strong>Territory bonus:</strong> +${config.pointsPerQuota} PP for every ${config.territoryQuota} hexes you own.</li>
      <li>Which units you can build is listed under <strong>Units in this match</strong> (north and south may differ).</li>
      <li>Valid placement: your <strong>home row</strong> (bottom), or any owned <strong>production hex</strong>.
        You must control <strong>at least one hex on your home row</strong> to produce anywhere; if the enemy takes
        every border hex, reconquer one before you can build again. You cannot place on home-row hexes the enemy controls
        until you retake them.</li>
      <li><strong>Production hex:</strong> an owned hex stable for <strong>${config.productionTurns} consecutive turns</strong>.
        Stability requires all hexes within distance ${config.productionSafeDistance} to be owned by you
        (impassable <strong>mountain</strong> hexes in that ring count as secure — they are not neutral or enemy territory).
        Resets immediately if that condition breaks.
        <strong>Breakthrough:</strong> sectors start pre-owned, so any owned hex already meeting this stability rule is available as a production hex from turn 1.</li>
      <li>You can place multiple units per turn as long as you have PP.</li>
    </ul>
      </div>
    </section>

    <section id="rules-movement" class="rules-anchor-section">
      <div class="settings-group rules-section">
      <div class="rules-group-title">Movement</div>
      <ul class="rules-list">
      <li>Each unit may move up to its movement range per turn (see <strong>Units in this match</strong>). Moving onto an empty hex <strong>conquers</strong> it.</li>
      <li>Moving onto an enemy unit triggers <strong>combat</strong>. If you need more than one hex to reach them, you move along the path into the hex adjacent to the enemy first, then combat resolves.</li>
      <li><strong>Artillery:</strong> each turn you either <strong>move</strong> one hex or fire a <strong>ranged attack</strong> at an enemy ${arRanged} (not both). Ranged fire does not use movement into the target&rsquo;s hex.</li>
      <li><strong>Zone of Control (ZoC):</strong> a unit adjacent to an enemy is locked — it may only attack
        or retreat to a hex not itself adjacent to any enemy. ZoC limits movement and adjacent attacks; it does not block artillery ranged fire at longer range.</li>
      <li><strong>Domination — guarded home row:</strong> with ZoC enabled, you cannot move onto an <strong>empty</strong> hex on the opponent&rsquo;s <strong>home row</strong> if any enemy is adjacent to that hex (this stops fast units from bypassing ZoC with multi-hex moves). You can still move onto that hex to attack an enemy unit sitting on it.</li>
    </ul>
      </div>
    </section>

    <section id="rules-combat" class="rules-anchor-section">
      <div class="settings-group rules-section">
      <div class="rules-group-title">Combat</div>
      <ul class="rules-list">
      <li><strong>Adjacent combat:</strong> both sides deal damage <strong>simultaneously</strong>. If the defender is destroyed, the attacker advances and conquers the hex.</li>
      <li><strong>Artillery ranged (2+ hexes):</strong> only the defender takes damage (no return fire). Destroying a unit with a ranged attack does <strong>not</strong> move the artillery or conquer that hex.</li>
      <li><strong>Limit Artillery</strong> (optional game setting): when enabled, if <strong>any</strong> enemy is adjacent to your artillery, it cannot use ranged attacks against other hexes until no adjacent enemies remain — use adjacent combat (move to attack) first.</li>
      <li><strong>CS</strong> = unit type&rsquo;s base strength × condition (50–100% of current max HP) × flanking bonus. Defenders on a <strong>river</strong> hex gain <strong>+${riverDefPct}%</strong> effective strength.</li>
      <li><strong>Tank spearhead:</strong> a <strong>tank</strong> gains <strong>+${Math.round(config.tankSpearheadAttackBonus * 100)}%</strong> attacker CS when it moves into <strong>adjacent</strong> melee after a <strong>straight-line approach that uses its full movement allowance in one move</strong> (e.g. movement 2 = two hexes along the attack path; movement 3 = three hexes).</li>
      <li><strong>Breakthrough:</strong> northern (defender) units in a <strong>sector already captured</strong> by the attacker use reduced effective strength in combat (see game settings for the percentage).</li>
      <li><strong>Flanking:</strong> +${Math.round(config.flankingBonus * 100)}% CS per adjacent friendly
        (max ${config.maxFlankingUnits} flankers = +${maxFlankBonus}%), in fixed neighbor order.
        Some unit types add <strong>extra flanking</strong> when they are among those adjacent flankers.</li>
      <li><strong>Damage:</strong> <code>floor(${config.combatDamageBase} × exp(±ΔCS / ${config.combatStrengthScale}))</code>, min 1 per side.</li>
      <li><strong>Upgrade points:</strong> in <strong>adjacent combat</strong>, each side earns <strong>${config.upgradePointsPerDamageDealt}</strong> point per HP of damage it actually deals to the other, plus <strong>${config.upgradePointsKillBonus}</strong> extra if it destroys that unit. <strong>Ranged fire</strong> only damages the target (no return shot), so only the firing unit earns points from that exchange. Required points to level up depend on unit type (shown on the movement unit card). When you have enough points during movement, choose one upgrade: <strong>+${Math.round(config.upgradeBonusFlankingPerStack * 100)}%</strong> CS per flanker when attacking (up to <strong>${Math.round(config.upgradeBonusFlankingPerStack * config.maxFlankingUnits * 100)}%</strong> with ${config.maxFlankingUnits} flankers), <strong>+${Math.round(config.upgradeBonusAttackPerStack * 100)}%</strong> CS when attacking, <strong>+${Math.round(config.upgradeBonusDefensePerStack * 100)}%</strong> CS when defending, or <strong>+${config.upgradeBonusHealPerStack}</strong> HP to your end-of-turn heal on own territory (stacks if you pick the same option again).</li>
      <li>If defender dies: attacker advances and conquers the hex. If both die: both removed.</li>
      <li>Hover over an enemy unit during movement to see a combat forecast.</li>
    </ul>
    </div>

    <!-- Keep in sync with effectiveCS, resolveCombat, forecastCombat in game.ts and combat-related keys in gameconfig.ts -->
      <div class="settings-group rules-section rules-section--tight">
      <div class="rules-group-title">Combat in detail</div>
      <p class="rules-prose"><strong>Base strength</strong> (integer on the unit) is only the starting stat from the unit type. <strong>Effective combat strength (CS)</strong> multiplies that base by modifiers below. The engine uses full-precision numbers; the combat forecast shows <strong>CS to one decimal place</strong>.</p>
      <p class="rules-prose"><strong>Effective CS</strong> = base strength × breakthrough sector mult × condition mult × flank mult × upgrade mult × river defense mult (when that role applies) × tank spearhead mult (attacking tank only, when applicable).</p>
      <ul class="rules-list">
      <li><strong>Condition mult</strong> = <code>0.5 + 0.5 × (current HP / max HP)</code> — from <strong>50%</strong> of full effectiveness at 0 HP up to <strong>100%</strong> at full HP (linear in HP fraction).</li>
      <li><strong>Flank mult</strong> (attacker only) = <code>1 + <em>f</em> × ${Math.round(config.flankingBonus * 100)}%</code> where <em>f</em> is the number of contributing adjacent friendlies next to the defender, capped at <strong>${config.maxFlankingUnits}</strong>, in fixed neighbor order, plus any per-unit-type <strong>extra flanking</strong> from those flankers (see short Combat section).</li>
      <li><strong>Breakthrough</strong> mult for a defender in a sector already captured by the attacker = <strong>${brPct}%</strong> (same setting as above).</li>
      <li><strong>River defense</strong> mult for a defender whose unit is on a river hex = <strong>${100 + riverDefPct}%</strong> (additive +${riverDefPct}% to CS).</li>
      <li><strong>Upgrade</strong> mult: when attacking, stacks of attack upgrade add <strong>+${Math.round(config.upgradeBonusAttackPerStack * 100)}%</strong> CS each; each stack of flanking upgrade adds <strong>+${Math.round(config.upgradeBonusFlankingPerStack * 100)}%</strong> CS per contributing flanker (capped at ${config.maxFlankingUnits}). When defending, defense upgrade stacks add <strong>+${Math.round(config.upgradeBonusDefensePerStack * 100)}%</strong> CS each. The healing upgrade adds <strong>+${config.upgradeBonusHealPerStack}</strong> HP per stack to end-of-turn healing on own territory (not part of CS).</li>
      <li><strong>Tank spearhead</strong> mult (melee attacker only) = <strong>${100 + Math.round(config.tankSpearheadAttackBonus * 100)}%</strong> when the attacker is a <strong>tank</strong>, it had <strong>not</strong> spent movement earlier this phase, and the move into adjacent combat costs <strong>exactly</strong> that unit&rsquo;s <strong>movement</strong> stat in path steps (scales if tanks later have movement 3+).</li>
    </ul>
      <p class="rules-prose">Let <strong>ΔCS</strong> = attacker CS − defender CS. <strong>Damage</strong> uses ΔCS, not percentages of HP directly: adjacent melee deals <code>max(1, floor(${config.combatDamageBase} × exp(ΔCS / ${config.combatStrengthScale})))</code> to the defender and <code>max(1, floor(${config.combatDamageBase} × exp(−ΔCS / ${config.combatStrengthScale})))</code> to the attacker at the same time. Ranged artillery uses the same formula for damage to the target only (no return fire). A percentage bonus to CS changes ΔCS and therefore damage through this curve — it is not a direct “+X% damage”.</p>
      </div>
    </section>

    <section id="rules-healing" class="rules-anchor-section">
      <div class="settings-group rules-section">
      <div class="rules-group-title">Healing</div>
      <ul class="rules-list">
      <li>Units that did <strong>not</strong> fight this turn heal at end of turn.</li>
      <li>Base <strong>+${config.healOwnTerritory} HP</strong> on <strong>own territory</strong>, plus <strong>+${config.upgradeBonusHealPerStack} HP</strong> per stack of the healing upgrade.</li>
    </ul>
      </div>
    </section>

    <section id="rules-game-modes" class="rules-anchor-section">
      <div class="settings-group rules-section">
      <div class="rules-group-title">Game modes</div>
      <p class="rules-prose">The match mode is chosen in <strong>Game settings</strong> before play.</p>
      <ul class="rules-list">
      <li><strong>Domination:</strong> move a unit onto the <strong>opponent&rsquo;s home row</strong>, or <strong>eliminate all enemy units</strong>.</li>
      <li><strong>Conquest:</strong> marked <strong>control point</strong> hexes appear on the map (default ${config.controlPointCount} in current settings).
        Each side starts with <strong>Conquer Points</strong> (south ${config.conquestPointsPlayer}, north ${config.conquestPointsAi} — configurable).
        After each side finishes its <strong>movement phase</strong>, for every control point you <strong>own</strong>, the opponent loses 1 Conquer Point (multiple points stack).
        Additionally, each time a unit is <strong>killed</strong>, its owner loses 1 Conquer Point.
        The first side reduced to <strong>0</strong> Conquer Points loses.
        You also lose immediately if you have <strong>no units</strong> and <strong>no owned territory</strong> (even if your Conquer Points are still above 0).
        Reaching the opponent&rsquo;s home row alone does <strong>not</strong> end the match.
        If both sides hit 0 Conquer Points in the same tick, the side with more <strong>owned hexes</strong> wins; if hex counts are also equal, the <strong>northern</strong> player wins the tie. Both sides totally eliminated from the map at once → northern player wins.</li>
      <li><strong>Breakthrough:</strong> the map is split into <strong>${config.breakthroughSectorCount}</strong> sectors (configurable, south to north). In <strong>Game settings</strong> you can set whether <strong>player 1</strong> (south / host) is <strong>attacker</strong> or <strong>defender</strong>, or enable <strong>random role</strong> to pick at match start. The <strong>attacker</strong> starts with <strong>${config.breakthroughAttackerStartingPP} PP</strong> and earns <strong>no further PP</strong>; the <strong>defender</strong> earns the usual per-turn PP plus territory bonus.
        The attacker&rsquo;s <strong>home sector</strong> (south if player 1 is attacker, north if player 1 is defender) has no control point. Only the <strong>frontline defender sector on the attacker-facing border</strong> shows a control point at a time. To capture that sector, the attacker must keep a unit on its control point for <strong>two full rounds</strong> (checked after both sides move). When a sector is captured, the marker is removed, <strong>every hex in that sector</strong> becomes attacker territory, and the next defender-border sector&rsquo;s control point appears. The attacker also gains <strong>+${config.breakthroughSectorCaptureBonusPP} PP</strong> (configurable; 0 to disable).
        After that, the defender <strong>cannot regain those hexes</strong> — they may still fight and move there, but hex ownership stays with the attacker. The sector itself also <strong>never</strong> flips back politically.
        <strong>Defender units</strong> in a sector already captured by the attacker fight at <strong>${Math.round(config.breakthroughEnemySectorStrengthMult * 100)}%</strong> strength (configurable).
        <strong>Attacker wins</strong> by holding every sector; <strong>defender wins</strong> if the attacker has no units left.</li>
    </ul>
      </div>
    </section>
    </div>
    </div>
    </div>
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

function showP2WaitingOverlay(): void {
  hideLobby();
  p2WaitingOverlayEl.classList.remove('hidden');
}

function hideP2WaitingOverlay(): void {
  p2WaitingOverlayEl.classList.add('hidden');
}

type SettingsPreviewItem =
  | { kind: 'section'; title: string }
  | { kind: 'row'; label: string; value: string };

interface SettingsPreview {
  gameMode: string;
  modeName: string;
  modeDesc: string;
  items: SettingsPreviewItem[];
}

function updateP2WaitingOverlay(preview: SettingsPreview): void {
  const modeDef = MODE_DEFS.find(m => m.id === preview.gameMode);
  if (modeDef) {
    p2WaitingModeImgEl.src = modeDef.image;
    p2WaitingModeIconEl.src = modeDef.icon;
  }
  p2WaitingModeNameEl.textContent = preview.modeName;
  p2WaitingModeDescEl.textContent = preview.modeDesc;

  p2WaitingSettingsListEl.innerHTML = '';
  for (const item of preview.items) {
    if (item.kind === 'section') {
      const el = document.createElement('div');
      el.className = 'p2-waiting-section-title';
      el.textContent = item.title;
      p2WaitingSettingsListEl.appendChild(el);
    } else {
      const rowEl = document.createElement('div');
      rowEl.className = 'p2-waiting-row';
      const labelEl = document.createElement('span');
      labelEl.className = 'p2-waiting-row-label';
      labelEl.textContent = item.label;
      const valueEl = document.createElement('span');
      valueEl.className = 'p2-waiting-row-value';
      valueEl.textContent = item.value;
      rowEl.appendChild(labelEl);
      rowEl.appendChild(valueEl);
      p2WaitingSettingsListEl.appendChild(rowEl);
    }
  }
}

function broadcastSettingsPreview(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || localPlayer !== PLAYER) return;

  const v = (id: string): string =>
    (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
  const selectText = (id: string): string => {
    const el = document.getElementById(id) as HTMLSelectElement | null;
    return el?.options[el.selectedIndex]?.text ?? '';
  };
  const tog = (id: string): string => {
    const t = settingsOnOffToggles.get(id);
    return t ? (t.getValue() ? 'ON' : 'OFF') : '';
  };

  const gameModeEl = document.getElementById('cfg-gameMode') as HTMLSelectElement;
  const gameMode = gameModeEl?.value ?? 'domination';
  const modeDef = MODE_DEFS.find(m => m.id === gameMode);
  const isConquest = gameMode === 'conquest';
  const isBreakthrough = gameMode === 'breakthrough';

  // Mirror exactly what P1 sees: check which sections are visible in the settings overlay
  const showRulesDetail = !document.getElementById('settings-rules-detail')?.classList.contains('hidden');
  const showBoard = !document.getElementById('settings-board-section')?.classList.contains('hidden');

  const items: SettingsPreviewItem[] = [];
  const sec = (title: string): void => { items.push({ kind: 'section', title }); };
  const row = (label: string, value: string): void => { items.push({ kind: 'row', label, value }); };

  sec('MATCH');
  row('Rules', selectText('cfg-rulesPreset') || 'Standard');
  row('Host unit package', v('cfg-unitPackage') || 'standard');
  row('Your unit package', v('cfg-unitPackagePlayer2') || 'standard');
  row('Map', selectText('cfg-customMap') || '[generate]');

  if (isConquest) {
    row('Control points', v('cfg-controlPointCount'));
    row('Conquer pts host', v('cfg-conquestPointsPlayer'));
    row('Your conquer pts', v('cfg-conquestPointsAi'));
  }

  if (isBreakthrough) {
    const roleEl = document.getElementById('cfg-breakthroughPlayer1Role') as HTMLSelectElement | null;
    const randEl = document.getElementById('cfg-breakthroughRandomRoles') as HTMLInputElement | null;
    row('Sectors', v('cfg-breakthroughSectorCount'));
    row('P1 role', randEl?.checked ? 'Random' : (roleEl?.value ?? 'attacker'));
    row('Starting units (defender)', v('cfg-startingUnitsDefender'));
    row('Starting units (attacker)', v('cfg-startingUnitsAttacker'));
  } else {
    row('Starting units (you)', v('cfg-startingUnitsPlayer2'));
    row('Starting units (host)', v('cfg-startingUnitsPlayer1'));
  }

  if (showBoard) {
    sec('BOARD');
    row('Width', v('cfg-boardCols'));
    row('Height', v('cfg-boardRows'));
  }

  if (showRulesDetail) {
    sec('TERRAIN');
    row('Mountain hexes (%)', v('cfg-mountainPct'));
    row('Rivers', tog('cfg-enableRivers'));
    row('Max river length (%)', v('cfg-riverMaxLengthBoardWidthMult'));

    sec('ECONOMY');
    row('PP per turn (host)', v('cfg-productionPointsPerTurn'));
    row('PP per turn (you)', v('cfg-productionPointsPerTurnAi'));
    row('Territory quota (hexes)', v('cfg-territoryQuota'));
    row('Bonus PP per quota', v('cfg-pointsPerQuota'));
    row('Turns to production hex', v('cfg-productionTurns'));
    row('Production safe distance', v('cfg-productionSafeDistance'));

    sec('COMBAT');
    row('Flanking bonus (%)', v('cfg-flankingBonus'));
    row('Max flanking units', v('cfg-maxFlankingUnits'));
    row('Zone of control', tog('cfg-zoneOfControl'));
    row('Limit artillery', tog('cfg-limitArtillery'));

    sec('HEALING');
    row('HP/turn on own territory', v('cfg-healOwnTerritory'));

    if (isBreakthrough) {
      sec('BREAKTHROUGH RULES');
      row('Attacker starting PP', v('cfg-breakthroughAttackerStartingPP'));
      row('Defender str. in captured sector (%)', v('cfg-breakthroughEnemySectorStrengthMult'));
      row('PP bonus per captured sector', v('cfg-breakthroughSectorCaptureBonusPP'));
    }
  }

  const preview: SettingsPreview = {
    gameMode,
    modeName: modeDef?.name ?? gameMode.toUpperCase(),
    modeDesc: modeDef?.desc ?? '',
    items,
  };
  ws.send(JSON.stringify({ type: 'settings-preview', ...preview }));
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
    hideMainMenu();
    showSettings((settings) => {
      state = createInitialStateForMenu();
      state.matchStartedAtMs = Date.now();
      if (ws) ws.send(JSON.stringify({ type: 'game-start', state, settings: { ...settings, unitPackage: settingsUnitPackage, unitPackagePlayer2: settingsUnitPackagePlayer2 } }));
      startGame(state);
    }, 'PLAYER 2 CONNECTED');
    // Send an initial preview so P2 sees the current settings immediately
    setTimeout(broadcastSettingsPreview, 50);
  } else if (msg.type === 'joined') {
    // Guest: successfully joined — show full-screen waiting room while host configures
    showP2WaitingOverlay();
  } else if (msg.type === 'settings-preview') {
    // Guest: host changed settings — update waiting overlay in real-time
    updateP2WaitingOverlay(msg as unknown as SettingsPreview);
  } else if (msg.type === 'game-start') {
    // Guest receives initial state from host
    const syncedSettings = msg.settings as (Parameters<typeof updateConfig>[0] & { unitPackage?: string; unitPackagePlayer2?: string }) | undefined;
    if (syncedSettings) {
      const { unitPackage: pkg, unitPackagePlayer2: pkg2, ...rest } = syncedSettings as Record<string, unknown>;
      updateConfig(rest as Parameters<typeof updateConfig>[0]);
      syncDimensions();
      setActiveUnitPackage((typeof pkg === 'string' ? pkg : null) ?? 'standard');
      setActiveUnitPackagePlayer2((typeof pkg2 === 'string' ? pkg2 : null) ?? 'standard');
    }
    state = msg.state as GameState;
    syncUnitIdCounter(state);
    hideP2WaitingOverlay();
    hideLobby();
    hideMainMenu();
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
    const { state: afterHeal, healFloats } = endTurnAfterAi(state, { skipConquestDrain: true });
    state = afterHeal;
    applyImmediateAutoSkipProductionIfNeeded();
    turnSnapshots.push(structuredClone(state));
    playEndTurnHealFloats(healFloats, () => {
      render();
      updateUI();
      checkWinner();
      sendStateUpdate(); // sync post-cleanup state (conquest points, winner) to guest
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
        clearBoardPointerHover();
        runOpponentAnimationPayload(anim, () => {
          isAnimating = false;
          afterOpponentState();
        });
      } else {
        afterOpponentState();
      }
    }
  } else if (msg.type === 'error') {
    showLobbyError((msg.message as string) ?? 'Error.');
  } else if (msg.type === 'opponent-disconnected') {
    showDisconnected();
  }
}

function showDisconnected(): void {
  if (!p2WaitingOverlayEl.classList.contains('hidden')) {
    // Game hasn't started — guest was in waiting room; go back to main menu
    hideP2WaitingOverlay();
    showMainMenu();
    return;
  }
  showGameEndScreenDisconnected(state, localPlayer);
}

// ── Lobby button handlers ─────────────────────────────────────────────────────

vsAiBtn.addEventListener('click', () => {
  gameMode = 'vsAI';
  localPlayer = PLAYER;
  closeLobbyWs();
  hideLobby();
  startGame(createInitialStateForMenu());
});

hostBtn.addEventListener('click', () => {
  gameMode = 'vsHuman';
  localPlayer = PLAYER;
  state = createInitialStateForMenu();

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
});

lobbyCancelJoinBtn.addEventListener('click', () => {
  closeLobbyWs();
  lobbyOverlayEl.classList.add('hidden');
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

lobbyOverlayEl.addEventListener('click', (e: MouseEvent) => {
  if (e.target !== lobbyOverlayEl) return;
  closeLobbyWs();
  hideLobby();
});

// ── Game start ────────────────────────────────────────────────────────────────

function applyUnitPackagesFromGameState(s: GameState): void {
  const p1 = s.unitPackage ?? 'standard';
  const p2 = s.unitPackagePlayer2 ?? p1;
  setActiveUnitPackage(p1);
  setActiveUnitPackagePlayer2(p2 !== p1 ? p2 : null);
  settingsUnitPackage = p1;
  settingsUnitPackagePlayer2 = p2;
}

function startGame(initialState: GameState): void {
  hideGameEndScreen();
  applyGameStateBoardDimensions(initialState);
  applyUnitPackagesFromGameState(initialState);
  state = initialState;
  if (!state.winner) {
    state.matchDurationMs = undefined;
    if (state.matchStartedAtMs == null) state.matchStartedAtMs = Date.now();
  }
  syncUnitIdCounter(state);
  pendingProductionHex = null;
  vsHumanOffTurnInspectUnitId = null;
  movementUnitCardBoundId = null;
  humanMoveAnimCancel?.();
  humanMoveAnimCancel = null;
  animStaticHiddenUnitIds.clear();
  isAnimating = false;
  aiPlaybackInProgress = false;
  aiTurnPendingStart = false;
  turnSnapshots = [structuredClone(state)];
  initRenderer(svg, { flipBoardY: gameMode === 'vsHuman' && localPlayer === AI });
  updateHeaderModeLabel(initialState);
  render();
  updateUI();
  checkWinner();
  maybeAutoEnd();
}

function updateHeaderModeLabel(s: GameState): void {
  const mode = s.gameMode;
  const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);

  let mapName = '';
  if (activeStoryIndex !== null) {
    mapName = STORIES[activeStoryIndex]!.title;
  } else if (config.customMatchMapId) {
    const story = STORIES.find(st => st.id === config.customMatchMapId);
    if (story) mapName = story.title;
  }

  headerModeLabelEl.textContent = mapName ? `${modeLabel}\n${mapName}` : modeLabel;
}

// ── Unit picker ───────────────────────────────────────────────────────────────

function showUnitPicker(col: number, row: number): void {
  pendingProductionHex = { col, row };
  unitPickerList.innerHTML = '';

  const statIconCost = 'icons/points-yellow.svg';
  const statIconMove = 'icons/movement.svg';
  const statIconRange = 'icons/range.svg';
  const statIconStr = 'icons/strength.svg';
  const statIconHp = 'icons/hp.svg';

  getAvailableUnitTypes(localPlayer).forEach((unitType, cardIndex) => {
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

    if (unitType.image && canAfford) {
      const art = document.createElement('div');
      art.className = 'unit-card-art';
      art.setAttribute('aria-hidden', 'true');
      const artInner = document.createElement('div');
      artInner.className = 'unit-card-art-inner';
      artInner.style.backgroundImage = `url(${JSON.stringify(unitType.image)})`;
      art.appendChild(artInner);
      card.appendChild(art);
    }

    const header = document.createElement('div');
    header.className = 'unit-card-header';
    const headerIcon = document.createElement('img');
    headerIcon.className = 'unit-card-header-icon';
    headerIcon.src = unitType.icon ? `${unitType.icon}` : `icons/${unitType.id}.svg`;
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
        if (gameMode === 'vsAI') scheduleSaveGameState();
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

/** Last unit id rendered into the movement-phase card (for enter animation + partial updates). */
let movementUnitCardBoundId: number | null = null;

/** vs human: inspect opponent units while waiting (not synced — does not touch `state.selectedUnit`). */
let vsHumanOffTurnInspectUnitId: number | null = null;

function spectatorInspectIdForBoard(): number | null {
  if (state.winner || gameMode !== 'vsHuman' || state.activePlayer === localPlayer) return null;
  return vsHumanOffTurnInspectUnitId;
}

function totalUpgradeTiers(unit: Unit): number {
  return (
    (unit.upgradeFlanking ?? 0) +
    (unit.upgradeAttack ?? 0) +
    (unit.upgradeDefense ?? 0) +
    (unit.upgradeHeal ?? 0)
  );
}

function patchMovementUnitCardStars(unit: Unit): void {
  const surface = movementUnitCardEl.querySelector('.movement-unit-card-surface');
  if (!surface) return;
  const starsWrap = surface.querySelector('.movement-unit-card-stars');
  if (!starsWrap) return;
  const filled = Math.min(3, totalUpgradeTiers(unit));
  starsWrap.querySelectorAll('img[data-mv-star]').forEach((img, i) => {
    (img as HTMLImageElement).src = i < filled ? 'icons/star-yellow.svg' : 'icons/star.svg';
  });
}

function buildUpgradePickerPanel(unit: Unit): void {
  upgradePickerPanelEl.innerHTML = '';
  upgradePickerPanelEl.classList.remove('hidden', 'upgrade-picker-panel--enter');
  const header = document.createElement('div');
  header.className = 'upgrade-picker-header';
  header.textContent = 'UPGRADE AVAILABLE';
  const rows = document.createElement('div');
  rows.className = 'upgrade-picker-rows';
  const pctFlank = `+${Math.round(config.upgradeBonusFlankingPerStack * 100)}%`;
  const pctAttack = `+${Math.round(config.upgradeBonusAttackPerStack * 100)}%`;
  const pctDefense = `+${Math.round(config.upgradeBonusDefensePerStack * 100)}%`;
  const pctHeal = `+${config.upgradeBonusHealPerStack}HP`;
  const defs: { kind: UnitUpgradeKind; icon: string; pct: string; desc: string }[] = [
    {
      kind: 'flanking',
      icon: 'icons/upgrade/flank.svg',
      pct: pctFlank,
      desc: 'COMBAT STRENGTH PER FLANKER WHEN ATTACKING',
    },
    {
      kind: 'attack',
      icon: 'icons/upgrade/attack.svg',
      pct: pctAttack,
      desc: 'COMBAT STRENGTH WHEN ATTACKING',
    },
    {
      kind: 'defense',
      icon: 'icons/upgrade/defense.svg',
      pct: pctDefense,
      desc: 'COMBAT STRENGTH WHEN DEFENDING',
    },
    {
      kind: 'heal',
      icon: 'icons/upgrade/heal.svg',
      pct: pctHeal,
      desc: 'END-OF-TURN HEAL ON OWN TERRITORY (BASE)',
    },
  ];
  for (const d of defs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'upgrade-picker-row';
    const ic = document.createElement('img');
    ic.className = 'upgrade-picker-row-icon';
    ic.src = d.icon;
    ic.alt = '';
    const pctEl = document.createElement('span');
    pctEl.className = 'upgrade-picker-row-pct';
    pctEl.textContent = d.pct;
    const descEl = document.createElement('span');
    descEl.className = 'upgrade-picker-row-desc';
    descEl.textContent = d.desc;
    btn.appendChild(ic);
    btn.appendChild(pctEl);
    btn.appendChild(descEl);
    btn.addEventListener('click', () => {
      playerApplyUnitUpgrade(state, unit.id, d.kind, localPlayer);
      if (gameMode === 'vsAI') scheduleSaveGameState();
      sendStateUpdate();
      render();
      updateUI();
      checkWinner();
    });
    rows.appendChild(btn);
  }
  upgradePickerPanelEl.appendChild(header);
  upgradePickerPanelEl.appendChild(rows);
  upgradePickerPanelEl.classList.add('upgrade-picker-panel--enter');
  upgradePickerPanelEl.addEventListener(
    'animationend',
    (e: AnimationEvent) => {
      if (e.animationName === 'unit-card-enter') {
        upgradePickerPanelEl.classList.remove('upgrade-picker-panel--enter');
      }
    },
    { once: true },
  );
}

function syncUpgradePickerPanel(unit: Unit, unitType: UnitType): void {
  if (unit.upgradePoints >= unitType.upgradePointsToLevel) {
    buildUpgradePickerPanel(unit);
  } else {
    upgradePickerPanelEl.innerHTML = '';
    upgradePickerPanelEl.classList.add('hidden');
  }
}

function patchMovementUnitCardStats(unit: Unit, unitType: UnitType): void {
  const surface = movementUnitCardEl.querySelector('.movement-unit-card-surface');
  if (!surface) return;
  const rem = Math.max(0, unit.movement - unit.movesUsed);
  const moveEl = surface.querySelector('[data-mv-stat="move"]');
  const strEl = surface.querySelector('[data-mv-stat="str"]');
  const hpEl = surface.querySelector('[data-mv-stat="hp"]');
  const upCur = surface.querySelector('[data-mv-extra="cur"]');
  const upReq = surface.querySelector('[data-mv-extra="req"]');
  if (moveEl) moveEl.textContent = String(rem);
  if (strEl) strEl.textContent = String(unit.strength);
  if (hpEl) hpEl.textContent = String(unit.hp);
  if (upCur) upCur.textContent = String(unit.upgradePoints);
  if (upReq) upReq.textContent = String(unitType.upgradePointsToLevel);
  patchMovementUnitCardStars(unit);
}

function buildMovementUnitCardInner(unit: Unit, unitType: UnitType, isEnemy = false): void {
  const statIconMove = 'icons/movement.svg';
  const statIconRange = 'icons/range.svg';
  const statIconStr = 'icons/strength.svg';
  const statIconHp = 'icons/hp.svg';

  movementUnitCardEl.innerHTML = '';

  const surface = document.createElement('div');
  surface.className = 'movement-unit-card-surface movement-unit-card-surface--enter';
  surface.addEventListener(
    'animationend',
    (e: AnimationEvent) => {
      if (e.animationName === 'unit-card-enter') surface.classList.remove('movement-unit-card-surface--enter');
    },
    { once: true },
  );

  const sidebar = document.createElement('div');
  sidebar.className = isEnemy
    ? 'movement-unit-card-sidebar movement-unit-card-sidebar--enemy'
    : 'movement-unit-card-sidebar';
  const sidebarIcon = document.createElement('img');
  sidebarIcon.className = 'movement-unit-card-sidebar-icon';
  sidebarIcon.src = unitType.icon ? `${unitType.icon}` : `icons/${unitType.id}.svg`;
  sidebarIcon.alt = '';
  sidebar.appendChild(sidebarIcon);

  const main = document.createElement('div');
  main.className = 'movement-unit-card-main';

  const title = document.createElement('div');
  title.className = 'movement-unit-card-name';
  title.textContent = unitType.name.toUpperCase();

  const stars = document.createElement('div');
  stars.className = 'movement-unit-card-stars';
  stars.setAttribute('aria-hidden', 'true');
  const starFill = Math.min(3, totalUpgradeTiers(unit));
  for (let i = 0; i < 3; i++) {
    const s = document.createElement('img');
    s.setAttribute('data-mv-star', String(i));
    s.src = i < starFill ? 'icons/star-yellow.svg' : 'icons/star.svg';
    s.alt = '';
    stars.appendChild(s);
  }

  const stats = document.createElement('div');
  stats.className = 'movement-unit-card-stats';

  function addStat(
    modClass: string,
    kind: 'move' | 'str' | 'hp' | 'range',
    iconSrc: string,
  ): HTMLSpanElement {
    const row = document.createElement('div');
    row.className = `unit-card-stat movement-unit-card-stat ${modClass}`;
    const iconWrap = document.createElement('span');
    iconWrap.className = 'unit-card-stat-icon';
    iconWrap.setAttribute('aria-hidden', 'true');
    const iconImg = document.createElement('img');
    iconImg.src = iconSrc;
    iconImg.alt = '';
    const val = document.createElement('span');
    val.className = 'unit-card-stat-value';
    val.setAttribute('data-mv-stat', kind);
    iconWrap.appendChild(iconImg);
    row.appendChild(iconWrap);
    row.appendChild(val);
    row.addEventListener('mouseenter', () => {
      const u = state.selectedUnit !== null ? getUnitById(state, state.selectedUnit) : null;
      if (!u) return;
      let ttTitle: string;
      let ttDesc: string;
      if (kind === 'move') {
        ttTitle = 'Movement';
        const r = Math.max(0, u.movement - u.movesUsed);
        ttDesc =
          r === 0
            ? 'No movement left this turn.'
            : `Hexes this unit can still move this turn (${r} remaining).`;
      } else if (kind === 'range') {
        ttTitle = 'Range';
        ttDesc = 'Maximum hex distance for ranged fire. Move or shoot in one turn, not both.';
      } else if (kind === 'str') {
        ttTitle = 'Strength';
        ttDesc = 'Base combat strength; condition and flanking modify it in battle.';
      } else {
        ttTitle = 'Hit points';
        ttDesc = `Current HP out of maximum (${u.maxHp}). The unit is removed when reduced to zero.`;
      }
      unitStatTooltipEl.innerHTML = `
        <div class="unit-stat-tt-title">${ttTitle}</div>
        <div class="unit-stat-tt-desc">${ttDesc}</div>`;
      positionFixedTooltipBelow(unitStatTooltipEl, row.getBoundingClientRect());
    });
    row.addEventListener('mouseleave', () => {
      unitStatTooltipEl.classList.add('hidden');
    });
    stats.appendChild(row);
    return val;
  }

  const rem = Math.max(0, unit.movement - unit.movesUsed);
  const vMove = addStat('unit-card-stat--move', 'move', statIconMove);
  if (unitType.range != null) {
    const vRange = addStat('unit-card-stat--range', 'range', statIconRange);
    vRange.textContent = String(unitType.range);
  }
  const vStr = addStat('unit-card-stat--str', 'str', statIconStr);
  const vHp = addStat('unit-card-stat--hp', 'hp', statIconHp);
  vMove.textContent = String(rem);
  vStr.textContent = String(unit.strength);
  vHp.textContent = String(unit.hp);

  const extra = document.createElement('div');
  extra.className = 'movement-unit-card-extra';
  const upIcon = document.createElement('img');
  upIcon.className = 'movement-unit-card-extra-icon';
  upIcon.src = 'icons/upgrade-yellow.svg';
  upIcon.alt = '';
  const num = document.createElement('span');
  num.className = 'movement-unit-card-extra-num';
  num.setAttribute('data-mv-extra', 'cur');
  num.textContent = String(unit.upgradePoints);
  const sep = document.createElement('span');
  sep.className = 'movement-unit-card-extra-sep';
  sep.textContent = '/';
  const den = document.createElement('span');
  den.className = 'movement-unit-card-extra-den';
  den.setAttribute('data-mv-extra', 'req');
  den.textContent = String(unitType.upgradePointsToLevel);
  extra.appendChild(upIcon);
  extra.appendChild(num);
  extra.appendChild(sep);
  extra.appendChild(den);
  extra.addEventListener('mouseenter', () => {
    const u = state.selectedUnit !== null ? getUnitById(state, state.selectedUnit) : null;
    if (!u) return;
    const ut = unitTypeForUnit(u);
    unitStatTooltipEl.innerHTML = `
        <div class="unit-stat-tt-title">Upgrade points</div>
        <div class="unit-stat-tt-desc">Earned by dealing damage to enemies and destroying them. Current points / points needed for the next level (${ut.upgradePointsToLevel} for this unit type).</div>`;
    positionFixedTooltipBelow(unitStatTooltipEl, extra.getBoundingClientRect());
  });
  extra.addEventListener('mouseleave', () => {
    unitStatTooltipEl.classList.add('hidden');
  });

  main.appendChild(title);
  main.appendChild(stars);
  main.appendChild(stats);
  main.appendChild(extra);

  surface.appendChild(sidebar);
  surface.appendChild(main);
  movementUnitCardEl.appendChild(surface);
}

function syncMovementUnitCard(): void {
  const offTurnInspect =
    gameMode === 'vsHuman' &&
    state.activePlayer !== localPlayer &&
    !state.winner &&
    vsHumanOffTurnInspectUnitId !== null;

  const onTurnEligible =
    !state.winner &&
    state.phase === 'movement' &&
    state.activePlayer === localPlayer &&
    state.selectedUnit !== null;

  if (!offTurnInspect && !onTurnEligible) {
    movementUnitCardEl.innerHTML = '';
    upgradePickerPanelEl.innerHTML = '';
    upgradePickerPanelEl.classList.add('hidden');
    movementHudStackEl.classList.remove('movement-hud-stack--visible');
    movementUnitCardBoundId = null;
    return;
  }

  const unitId = offTurnInspect ? vsHumanOffTurnInspectUnitId! : state.selectedUnit!;
  const unit = getUnitById(state, unitId);
  if (!unit) {
    if (offTurnInspect) vsHumanOffTurnInspectUnitId = null;
    movementUnitCardEl.innerHTML = '';
    upgradePickerPanelEl.innerHTML = '';
    upgradePickerPanelEl.classList.add('hidden');
    movementHudStackEl.classList.remove('movement-hud-stack--visible');
    movementUnitCardBoundId = null;
    return;
  }

  const unitType = unitTypeForUnit(unit);
  const isNewSelection = movementUnitCardBoundId !== unit.id;
  movementUnitCardBoundId = unit.id;

  movementHudStackEl.classList.add('movement-hud-stack--visible');

  const isEnemy = offTurnInspect || unit.owner !== localPlayer;

  if (isNewSelection) {
    buildMovementUnitCardInner(unit, unitType, isEnemy);
  } else {
    patchMovementUnitCardStats(unit, unitType);
  }

  if (isEnemy) {
    // Enemy unit inspected: show card only, no upgrades
    upgradePickerPanelEl.innerHTML = '';
    upgradePickerPanelEl.classList.add('hidden');
    return;
  }

  syncUpgradePickerPanel(unit, unitType);
}

// ── Board click ───────────────────────────────────────────────────────────────

svg.addEventListener('click', (e: MouseEvent) => {
  if (state.winner) return;

  const hex = getHexFromEvent(e);
  const offTurnInspect =
    gameMode === 'vsHuman' &&
    state.activePlayer !== localPlayer &&
    (state.phase === 'movement' || state.phase === 'production');

  if (offTurnInspect) {
    if (!hex) {
      vsHumanOffTurnInspectUnitId = null;
      render();
      updateUI();
      return;
    }
    const enemyOwner: Owner = localPlayer === PLAYER ? AI : PLAYER;
    const clickedUnit = getUnit(state, hex.col, hex.row);
    if (clickedUnit && clickedUnit.owner === enemyOwner) {
      vsHumanOffTurnInspectUnitId = clickedUnit.id;
    } else {
      vsHumanOffTurnInspectUnitId = null;
    }
    render();
    updateUI();
    return;
  }

  if (state.activePlayer !== localPlayer) return;
  if (!hex) {
    // Empty SVG margin / background (no hex under cursor): clear selection
    if (state.phase === 'movement' && state.selectedUnit !== null) {
      let didInterruptHumanMove = false;
      if (humanMoveAnimCancel && !aiPlaybackInProgress) {
        didInterruptHumanMove = true;
        humanMoveAnimCancel();
        humanMoveAnimCancel = null;
        isAnimating = false;
        if (gameMode === 'vsAI') scheduleSaveGameState();
        render();
        checkWinner();
      }
      if (!isAnimating) {
        clearMovePathPreview();
        state.selectedUnit = null;
        render(); updateUI();
        sendStateUpdate();
        if (didInterruptHumanMove) maybeAutoEnd();
      }
    } else if (state.phase === 'production' && pendingProductionHex !== null) {
      hideUnitPicker();
      render();
      updateUI();
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
    if (gameMode === 'vsAI') scheduleSaveGameState();
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
    const enemyOwner: Owner = localPlayer === PLAYER ? AI : PLAYER;
    if (state.selectedUnit === null) {
      const clickedUnit = getUnit(state, col, row);
      if (clickedUnit && clickedUnit.owner === enemyOwner) {
        // Select enemy unit for inspection (show unit card only, no movement highlights)
        state.selectedUnit = clickedUnit.id;
        render(); updateUI();
        sendStateUpdate();
      } else {
        state = playerSelectUnit(state, col, row, localPlayer);
        render(); updateUI();
        sendStateUpdate();
      }
    } else {
      const target = getUnit(state, col, row);
      if (target && target.owner === localPlayer) {
        clearMovePathPreview();
        state = playerSelectUnit(state, col, row, localPlayer);
        render(); updateUI();
        sendStateUpdate();
      } else {
        const selUnit = getUnitById(state, state.selectedUnit)!;

        // If inspecting an enemy unit, clicking non-own unit switches inspection or deselects
        if (selUnit.owner === enemyOwner) {
          clearMovePathPreview();
          if (target && target.owner === enemyOwner) {
            state.selectedUnit = target.id;
          } else {
            state.selectedUnit = null;
          }
          render(); updateUI();
          sendStateUpdate();
          return;
        }

        // Deselect if clicked hex is not a valid move destination (unless ranged attack on enemy)
        const validMoves = getValidMoves(state, selUnit);
        const clickTarget = getUnit(state, col, row);
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
            if (gameMode === 'vsAI') scheduleSaveGameState();
            checkWinner();
            if (combatVfx && combatVfx.damageFloats.length > 0) {
              isAnimating = true;
              clearBoardPointerHover();
              animStaticHiddenUnitIds.clear();
              render();
              const floats = combatVfx.damageFloats;
              const wsAnim: WsAnimationPayload = { damageFloats: floats };
              if (combatVfx.ranged) wsAnim.ranged = true;
              sendStateUpdate(wsAnim);
              const afterFloats = (): void => {
                humanMoveAnimCancel = null;
                isAnimating = false;
                animStaticHiddenUnitIds.clear();
                if (gameMode === 'vsAI') scheduleSaveGameState();
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
          // If clicking an enemy unit that's not a valid target, switch to inspecting it
          if (clickTarget && clickTarget.owner === enemyOwner) {
            state.selectedUnit = clickTarget.id;
          } else {
            state.selectedUnit = null;
          }
          render(); updateUI();
          sendStateUpdate();
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
        const stackAboveUnits = combatVfx?.attackerAnimAboveUnits ?? true;

        const finishHumanAnim = (): void => {
          humanMoveAnimCancel = null;
          isAnimating = false;
          animStaticHiddenUnitIds.clear();
          if (gameMode === 'vsAI') scheduleSaveGameState();
          render();
          checkWinner();
          maybeAutoEnd();
        };

        const runFloatsOnly = (): void => {
          // Strike/move anims hide units on the static layer; redraw resolved state before floats.
          // Losing attackers are not re-added as ghosts — only post-combat state.units (damage floats are enough).
          syncAnimStaticHidden([]);
          renderState(svg, state, pendingProductionHex, animStaticHiddenUnitIds, localPlayer, undefined, spectatorInspectIdForBoard());
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
            clearBoardPointerHover();
            syncAnimStaticHidden([movingUnitId]);
            renderState(svg, state, pendingProductionHex, animStaticHiddenUnitIds, localPlayer, undefined, spectatorInspectIdForBoard());
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
              true,
              localPlayer,
            );
            humanMoveAnimCancel = combineAnimCancels(cancel);
          } else {
            if (gameMode === 'vsAI') scheduleSaveGameState();
            render();
            updateUI();
            checkWinner();
            sendStateUpdate();
            maybeAutoEnd();
          }
        } else {
          isAnimating = true;
          clearBoardPointerHover();
          const hidden = new Set<number>();
          if (needsMoveAnim) hidden.add(movingUnitId);
          if (sr) hidden.add(sr.attackerId);

          syncAnimStaticHidden(hidden);
          renderState(svg, state, pendingProductionHex, animStaticHiddenUnitIds, localPlayer, undefined, spectatorInspectIdForBoard());
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
          wsPayload.attackerAnimAboveUnits = stackAboveUnits;
          if (combatVfx.meleeAttackerId !== undefined) {
            wsPayload.meleeAttackerId = combatVfx.meleeAttackerId;
          }
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
                    stackAboveUnits,
                    localPlayer,
                  );
                  humanMoveAnimCancel = combineAnimCancels(cSt);
                } else {
                  runFloatsOnly();
                }
              },
              state,
              stackAboveUnits,
              localPlayer,
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
                stackAboveUnits,
                localPlayer,
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
// #board handler before this, so hex/unit clicks never hit this path. Movement HUD (unit card,
// upgrade picker) and the production unit picker are outside the SVG — exclude them so clicks
// there do not clear selection.
document.body.addEventListener('click', (e: MouseEvent) => {
  if (state.winner) return;

  const t = e.target;
  if (!(t instanceof Element)) return;
  if (svg.contains(t)) return;

  if (state.activePlayer !== localPlayer) {
    if (
      gameMode === 'vsHuman' &&
      vsHumanOffTurnInspectUnitId !== null &&
      !movementHudStackEl.contains(t)
    ) {
      vsHumanOffTurnInspectUnitId = null;
      render();
      updateUI();
    }
    return;
  }

  if (state.phase === 'production' && pendingProductionHex !== null) {
    if (unitPickerEl.contains(t)) return;
    hideUnitPicker();
    render();
    updateUI();
    return;
  }

  if (state.phase !== 'movement' || state.selectedUnit === null) return;
  if (movementHudStackEl.contains(t)) return;

  let didInterruptHumanMove = false;
  if (humanMoveAnimCancel && !aiPlaybackInProgress) {
    didInterruptHumanMove = true;
    humanMoveAnimCancel();
    humanMoveAnimCancel = null;
    isAnimating = false;
    if (gameMode === 'vsAI') scheduleSaveGameState();
    render();
    checkWinner();
  }
  if (isAnimating) return;

  clearMovePathPreview();
  state.selectedUnit = null;
  render(); updateUI();
  sendStateUpdate();
  if (didInterruptHumanMove) maybeAutoEnd();
});

// ── End phase button ──────────────────────────────────────────────────────────

endMoveBtn.addEventListener('click', () => {
  if (isAnimating) return;

  if (state.phase === 'production' && state.activePlayer === localPlayer) {
    const tPhaseStart = performance.now();
    if (gameMode === 'vsAI') {
      state = playerEndProduction(state);
      scheduleSaveGameState();
    } else {
      state = vsHumanEndProduction(state, localPlayer);
    }
    hideUnitPicker();
    render(); updateUI(); checkWinner();
    if (gameMode === 'vsAI') {
      // Let movement UI paint first on large boards before any auto-end heavy work runs.
      maybeAutoEndDeferred();
    } else {
      sendStateUpdate();
      maybeAutoEndDeferred();
    }
    perfLog('phase.productionToMovement', performance.now() - tPhaseStart);
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
  // Block input immediately, then yield one frame so "waiting" status can paint
  // before synchronous AI planning starts.
  if (isAnimating) return;
  aiTurnPendingStart = true;
  isAnimating = true;
  clearBoardPointerHover();
  updateUI();
  // Use a macrotask so the "Waiting for AI.." label gets a chance to paint first.
  setTimeout(() => {
    aiTurnPendingStart = false;
    aiPlaybackInProgress = true;
    aiTurnPerfStartMs = performance.now();
    updateUI();

    clearMovePathPreview();
    const tPlanStart = performance.now();
    state = prepareAiTurn(state);
    if (state.winner) {
      aiPlaybackInProgress = false;
      isAnimating = false;
      render();
      updateUI();
      checkWinner();
      maybeAutoEnd();
      if (aiTurnPerfStartMs !== null) {
        perfLog('phase.aiTurnTotal', performance.now() - aiTurnPerfStartMs);
        aiTurnPerfStartMs = null;
      }
      return;
    }

    const aiResult = aiMovement(state);
    perfLog('phase.aiPlanSync', performance.now() - tPlanStart);
    state = aiResult.state;
    const animSteps = aiResult.animSteps;
    const animUnitsBefore = aiResult.animUnitsBefore;
    const animHexStatesBefore = aiResult.animHexStatesBefore;
    const animUnitsAfter = aiResult.animUnitsAfter;

    if (animSteps.length === 0) {
      const { state: next, healFloats } = endTurnAfterAi(state);
      state = next;
      applyImmediateAutoSkipProductionIfNeeded();
      turnSnapshots.push(structuredClone(state));
      scheduleSaveGameState();
      playEndTurnHealFloats(healFloats, () => {
        aiPlaybackInProgress = false;
        render();
        updateUI();
        checkWinner();
        maybeAutoEnd();
        if (aiTurnPerfStartMs !== null) {
          perfLog('phase.aiTurnTotal', performance.now() - aiTurnPerfStartMs);
          aiTurnPerfStartMs = null;
        }
      });
      return;
    }

    syncDamageFloatCssDuration();
    const boardArea = COLS * ROWS;
    const aiAnimScale =
      boardArea >= 1600 ? 0.25 :
      boardArea >= 900 ? 0.4 :
      boardArea >= 400 ? 0.6 :
      1;
    const aiMoveDuration = Math.max(80, Math.round(config.unitMoveSpeed * aiAnimScale));
    const aiStrikeDuration = Math.max(90, Math.round(config.strikeReturnSpeedMs * aiAnimScale));
    const aiFloatDuration = Math.max(180, Math.round(config.damageFloatDurationMs * aiAnimScale));

    const finishAi = (): void => {
      humanMoveAnimCancel = null;
      animStaticHiddenUnitIds.clear();
      const { state: next, healFloats } = endTurnAfterAi(state);
      state = next;
      applyImmediateAutoSkipProductionIfNeeded();
      turnSnapshots.push(structuredClone(state));
      scheduleSaveGameState();
      playEndTurnHealFloats(healFloats, () => {
        aiPlaybackInProgress = false;
        render();
        updateUI();
        checkWinner();
        maybeAutoEnd();
        if (aiTurnPerfStartMs !== null) {
          perfLog('phase.aiTurnTotal', performance.now() - aiTurnPerfStartMs);
          aiTurnPerfStartMs = null;
        }
      });
    };

    const playOneCombatVfx = (
      vfx: CombatVfxPayload,
      unitsBefore: Unit[],
      unitsAfter: Unit[],
      hexTerritoryBeforeStep: Record<string, HexState>,
      onDone: () => void,
    ): void => {
      const floats = vfx.damageFloats;
      const sr = vfx.strikeReturn;

      /**
       * After strike: board already showed the exchange — use unitsAfter for floats.
       * No strike: use unitsBefore for the float beat but hide casualty unit ids so two sprites
       * never stack on one hex; mutual kill uses unitsAfter so the fight hex is empty.
       */
      const runFloats = (afterStrike: boolean): void => {
        const { pick, hiddenUnitIds } = aiDamageFloatDrawParams(unitsBefore, unitsAfter, afterStrike);
        const initial = cloneUnits(pick === 'after' ? unitsAfter : unitsBefore);
        syncAnimStaticHidden(hiddenUnitIds);
        renderState(svg, state, null, animStaticHiddenUnitIds, localPlayer, initial, spectatorInspectIdForBoard(), hexTerritoryBeforeStep);
        updateUI();
        if (floats.length === 0) {
          const ua = cloneUnits(unitsAfter);
          syncAnimStaticHidden([]);
          renderState(svg, state, null, animStaticHiddenUnitIds, localPlayer, ua, spectatorInspectIdForBoard());
          updateUI();
          onDone();
          return;
        }
        const afterDamageFloats = (): void => {
          const ua = cloneUnits(unitsAfter);
          syncAnimStaticHidden([]);
          renderState(svg, state, null, animStaticHiddenUnitIds, localPlayer, ua, spectatorInspectIdForBoard());
          updateUI();
          onDone();
        };
        const playDamageFloats = (): void => {
          const { cancel } = showDamageFloats(svg, floats, aiFloatDuration, afterDamageFloats);
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
        syncAnimStaticHidden([sr.attackerId]);
        renderState(svg, state, null, animStaticHiddenUnitIds, localPlayer, ub, spectatorInspectIdForBoard(), hexTerritoryBeforeStep);
        updateUI();
        const { cancel } = animateStrikeAndReturn(
          svg,
          {
            unit: { ...u },
            fromCol: sr.fromCol,
            fromRow: sr.fromRow,
            enemyCol: sr.enemyCol,
            enemyRow: sr.enemyRow,
            durationMs: aiStrikeDuration,
          },
          () => runFloats(true),
          aiReplayState(state, ub),
          vfx.attackerAnimAboveUnits ?? true,
          localPlayer,
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
        let stackAbove = true;
        const nextStep = animSteps[index + 1];
        if (nextStep?.type === 'combat') {
          stackAbove = nextStep.vfx.attackerAnimAboveUnits ?? true;
        }
        syncAnimStaticHidden([a.unit.id]);
        renderState(svg, state, null, animStaticHiddenUnitIds, localPlayer, before, spectatorInspectIdForBoard(), animHexStatesBefore[index]!);
        updateUI();
        const { cancel } = animateMoves(
          svg,
          [a],
          aiMoveDuration,
          () => runStep(index + 1),
          aiReplayState(state, before),
          stackAbove,
          localPlayer,
        );
        humanMoveAnimCancel = combineAnimCancels(cancel);
      } else {
        playOneCombatVfx(step.vfx, before, animUnitsAfter[index]!, animHexStatesBefore[index]!, () => runStep(index + 1));
      }
    };

    runStep(0);
  }, 0);
}

function leaveEndGameToMainMenu(): void {
  closeLobbyWs();
  hideGameEndScreen();
  hideUnitPicker();
  if (activeStoryIndex !== null) {
    restoreConfigAfterStory();
    buildStoriesList(activeScenarioId);
    storiesOverlayEl.classList.remove('hidden');
  } else {
    setActiveUnitPackage(null);
    setActiveUnitPackagePlayer2(null);
    showMainMenu();
  }
}

gameEndRestartBtn.addEventListener('click', leaveEndGameToMainMenu);

gameEndRetryBtn.addEventListener('click', () => {
  if (gameMode !== 'vsAI' || state.winner === localPlayer) return;
  hideGameEndScreen();
  hideUnitPicker();
  if (activeStoryIndex !== null) {
    startStory(activeStoryIndex);
  } else {
    startGame(createInitialStatePreservingTerrain(state));
  }
});

gameEndNextStoryBtn.addEventListener('click', () => {
  if (pendingNextStoryIndex === null) return;
  const idx = pendingNextStoryIndex;
  pendingNextStoryIndex = null;
  hideGameEndScreen();
  hideUnitPicker();
  restoreConfigAfterStory();
  startStory(idx);
});

gameEndBackMenuBtn.addEventListener('click', () => {
  pendingNextStoryIndex = null;
  leaveEndGameToMainMenu();
});

// ── Auto-end helpers ──────────────────────────────────────────────────────────

function canAffordAnyUnit(): boolean {
  return getAvailableUnitTypes(localPlayer).some(u => state.productionPoints[localPlayer] >= u.cost);
}

function hasAnyValidMove(): boolean {
  return state.units
    .filter(u => u.owner === localPlayer && u.movesUsed < u.movement)
    .some(u => getValidMoves(state, u).length > 0 || getRangedAttackTargets(state, u).length > 0);
}

function shouldAutoSkipProductionPhase(): boolean {
  if (state.phase !== 'production' || state.activePlayer !== localPlayer) return false;
  // No legal empty production hex: skip production.
  if (!hasAnyValidProductionPlacement(state, localPlayer)) return true;
  // Otherwise skip when nothing can be purchased (player can still press NEXT to pass early).
  return !canAffordAnyUnit();
}

function productionEndOptionsForAutoSkip(): EndProductionOptions | undefined {
  return !hasAnyValidProductionPlacement(state, localPlayer)
    ? { skipReason: 'no-placements' }
    : undefined;
}

/**
 * Apply production auto-skip immediately before transient renders (like heal floats).
 */
function applyImmediateAutoSkipProductionIfNeeded(): void {
  if (!shouldAutoSkipProductionPhase()) return;
  const opts = productionEndOptionsForAutoSkip();
  if (gameMode === 'vsAI') {
    state = playerEndProduction(state, opts);
  } else {
    state = vsHumanEndProduction(state, localPlayer, opts);
  }
  hideUnitPicker();
}

function maybeAutoEnd(): void {
  if (isAnimating || state.winner || state.activePlayer !== localPlayer) return;
  if (
    shouldAutoSkipProductionPhase()
  ) {
    const opts = productionEndOptionsForAutoSkip();
    if (gameMode === 'vsAI') {
      state = playerEndProduction(state, opts);
    } else {
      state = vsHumanEndProduction(state, localPlayer, opts);
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
  } else if (state.phase === 'movement' && !hasAnyValidMove()) {
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
  if (gameMode === 'vsAI') {
    resolvePendingAiUpgradeChoices(state);
  }
  turnEl.textContent  = `Turn ${state.turn}`;
  const hidingTransientAutoSkippedProduction = shouldAutoSkipProductionPhase();
  const phaseForDisplay =
    hidingTransientAutoSkippedProduction && state.phase === 'production'
      ? 'movement'
      : state.phase;
  phaseEl.textContent = phaseForDisplay.charAt(0).toUpperCase() + phaseForDisplay.slice(1);
  ppDisplay.textContent = String(state.productionPoints[localPlayer]);

  const isConquest = state.gameMode === 'conquest' && state.conquestPoints;
  const isBreakthrough = state.gameMode === 'breakthrough' && state.sectorOwners && state.sectorOwners.length > 0;

  // Update conquer header — territory % (Domination), Conquer Points (Conquest), or sectors (Breakthrough)
  let localPct: number;
  let opponentPct: number;
  let leftPct: number;
  if (isBreakthrough) {
    const attOw = getBreakthroughAttackerOwner(state);
    const att = state.sectorOwners!.filter(o => o === attOw).length;
    const def = state.sectorOwners!.length - att;
    const youAreAttacker = localPlayer === attOw;
    const youSectors = youAreAttacker ? att : def;
    const oppSectors = youAreAttacker ? def : att;
    playerConquerPctEl.textContent = String(youSectors);
    aiConquerPctEl.textContent = String(oppSectors);
    localPct = youSectors;
    opponentPct = oppSectors;
    const sum = youSectors + oppSectors;
    leftPct = sum > 0 ? Math.round((youSectors / sum) * 100) : 50;
  } else if (isConquest) {
    const cp = state.conquestPoints!;
    const youCp = localPlayer === PLAYER ? cp[PLAYER] : cp[AI];
    const oppCp = localPlayer === PLAYER ? cp[AI] : cp[PLAYER];
    const totalHexes = COLS * ROWS;
    const oppOwner = localPlayer === PLAYER ? AI : PLAYER;
    const localTerPct = Math.round(Object.values(state.hexStates).filter(h => h.owner === localPlayer).length / totalHexes * 100);
    const oppTerPct   = Math.round(Object.values(state.hexStates).filter(h => h.owner === oppOwner).length / totalHexes * 100);
    playerConquerPctEl.textContent = `(${localTerPct}%) ${youCp}`;
    aiConquerPctEl.textContent     = `${oppCp} (${oppTerPct}%)`;
    const sum = youCp + oppCp;
    localPct = youCp;
    opponentPct = oppCp;
    leftPct = sum > 0 ? Math.round((youCp / sum) * 100) : 50;
  } else {
    const totalHexes = COLS * ROWS;
    const playerHexes = Object.values(state.hexStates).filter(h => h.owner === PLAYER).length;
    const aiHexes     = Object.values(state.hexStates).filter(h => h.owner === AI).length;
    const playerPct = Math.round(playerHexes / totalHexes * 100);
    const aiPct     = Math.round(aiHexes / totalHexes * 100);
    localPct    = localPlayer === PLAYER ? playerPct : aiPct;
    opponentPct = localPlayer === PLAYER ? aiPct : playerPct;
    playerConquerPctEl.textContent = `${localPct}%`;
    aiConquerPctEl.textContent     = `${opponentPct}%`;
    const total = localPct + opponentPct;
    leftPct = total > 0 ? Math.round(localPct / total * 100) : 50;
  }

  playerConquerPctEl.classList.remove('conquest-cp-leader');
  aiConquerPctEl.classList.remove('conquest-cp-leader');
  if (isBreakthrough) {
    const youLead = localPct > opponentPct;
    if (localPct !== opponentPct) {
      (youLead ? playerConquerPctEl : aiConquerPctEl).classList.add('conquest-cp-leader');
    }
  } else if (isConquest) {
    const cpKeys = state.controlPointHexes ?? [];
    let playerOwned = 0;
    let aiOwned = 0;
    for (const key of cpKeys) {
      const hex = state.hexStates[key];
      if (!hex) continue;
      if (hex.owner === PLAYER) playerOwned++;
      else if (hex.owner === AI) aiOwned++;
    }
    if (playerOwned !== aiOwned) {
      const playerLeads = playerOwned > aiOwned;
      const localIsPlayer = localPlayer === PLAYER;
      const highlightLocal = playerLeads === localIsPlayer;
      (highlightLocal ? playerConquerPctEl : aiConquerPctEl).classList.add('conquest-cp-leader');
    }
  }

  playerConquerLabel.textContent = 'YOU';
  aiConquerLabel.textContent     = localPlayer === PLAYER && gameMode !== 'vsHuman' ? 'AI' : 'OPPONENT';

  // Two-color bar: left = you (--color-player), right = opponent (--color-ai); renderer uses the same mapping.
  const style = getComputedStyle(document.documentElement);
  const localColor    = style.getPropertyValue('--color-player').trim();
  const opponentColor = style.getPropertyValue('--color-ai').trim();
  conquerBarEl.style.background = '';
  const rightGrow = 100 - leftPct;
  conquerBarLocalEl.style.flex = `${leftPct} 1 0`;
  conquerBarLocalEl.style.background = localColor;
  conquerBarOpponentEl.style.flex = `${rightGrow} 1 0`;
  conquerBarOpponentEl.style.background = opponentColor;

  // Breakthrough toast
  if (isBreakthrough) {
    const attOwner = getBreakthroughAttackerOwner(state);
    const defOwner = getBreakthroughDefenderOwner(state);
    const youAreAttacker = localPlayer === attOwner;
    const activeSid = breakthroughActiveFrontlineSectorIndex(state);
    const cpOccupation = activeSid !== null ? (state.breakthroughCpOccupation?.[activeSid] ?? 0) : 0;
    const defUnitsOnAttackerSector = state.units.some(u => {
      if (u.owner !== defOwner) return false;
      const sid = state.sectorIndexByHex?.[`${u.col},${u.row}`];
      return sid !== undefined && state.sectorOwners![sid] === attOwner;
    });
    let toastText: string;
    let toastVariant: 'gray' | 'yellow' | 'red';
    if (!youAreAttacker && defUnitsOnAttackerSector) {
      toastText = "You lost the sector. Your units have a combat malus if they do not retreat";
      toastVariant = 'red';
    } else if (cpOccupation > 0) {
      if (youAreAttacker) {
        toastText = "We're taking the sector, keep your unit to hold it";
      } else {
        const turns = 2 - cpOccupation;
        toastText = `They're taking the sector, remove their units before ${turns} turn${turns !== 1 ? 's' : ''}`;
      }
      toastVariant = 'yellow';
    } else {
      toastText = youAreAttacker ? "You're the attacker. Conquer the control point to own the sector." : "You're the defender. Hold the control point to keep the sector.";
      toastVariant = 'gray';
    }
    breakthroughToastEl.textContent = toastText;
    breakthroughToastEl.className = `toast-${toastVariant}`;
  } else {
    breakthroughToastEl.className = 'hidden';
  }

  const isMyTurn = state.activePlayer === localPlayer;
  const showAiWaitingStatus = gameMode === 'vsAI' && aiTurnPendingStart;
  const showAiPlanningStatus = gameMode === 'vsAI' && aiPlaybackInProgress;
  if (hidingTransientAutoSkippedProduction) {
    endMoveBtn.style.display = 'none';
    phaseLabelEl.textContent = '';
  } else if (showAiWaitingStatus) {
    endMoveBtn.style.display = 'none';
    phaseLabelEl.textContent = 'Waiting for AI..';
  } else if (showAiPlanningStatus) {
    endMoveBtn.style.display = 'none';
    phaseLabelEl.textContent = 'AI is planning';
  } else
  if ((state.phase === 'production' || state.phase === 'movement') && isMyTurn) {
    endMoveBtn.style.display = 'block';
    phaseLabelEl.textContent = state.phase.toUpperCase();
  } else if (gameMode === 'vsHuman' && !isMyTurn) {
    endMoveBtn.style.display = 'none';
    phaseLabelEl.textContent = 'WAITING...';
  } else {
    endMoveBtn.style.display = 'none';
    phaseLabelEl.textContent = '';
  }

  syncMovementUnitCard();

  logEl.innerHTML = '';
  for (const msg of state.log) {
    const li = document.createElement('li');
    li.textContent = msg;
    logEl.appendChild(li);
  }
}

function checkWinner(): void {
  if (!state.winner) return;
  const showRetry = gameMode === 'vsAI' && state.winner !== localPlayer;
  showGameEndScreenForOutcome(state.winner === localPlayer, state.winReason, state, localPlayer, {
    showRetry,
  });
  if (gameMode === 'vsAI' && state.winner === localPlayer) {
    recordVsAiVictory(state.turn, state.gameMode, state.winReason);
  }
  if (activeStoryIndex !== null && state.winner === localPlayer) {
    handleStoryWin();
    const story = STORIES[activeStoryIndex]!;
    const scenarioStories = STORIES.filter(s => s.scenario === story.scenario);
    const nextInScenario = scenarioStories.indexOf(story) + 1;
    pendingNextStoryIndex = nextInScenario < scenarioStories.length
      ? STORIES.indexOf(scenarioStories[nextInScenario])
      : null;
    configureStoryEndButtons(true, pendingNextStoryIndex !== null);
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
  extraFlankingFrom?: { name: string; bonusPct: number }[];
  breakthroughMalusMultPct?: number;
  breakthroughMalusDeltaPct?: number;
  /** Defender on a river: bonus % to CS from config. */
  riverDefenseBonusPct?: number;
  /** Tank spearhead charge (melee). */
  spearheadBonusPct?: number;
  upgradeLines?: string[];
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
      <div class="tt-cs">CS: ${factors.cs.toFixed(1)}</div>
      <div class="tt-factors">
        <div>· Strength: ${unit.strength}</div>
        <div>· Condition: ${factors.conditionPct}%</div>
        ${factors.flankBonusPct > 0 ? `<div>· Flanking ×${factors.flankCount}: +${factors.flankBonusPct}%</div>` : ''}
        ${(factors.extraFlankingFrom ?? []).map(
          e => `<div>· Extra flanking bonus from ${e.name}: +${e.bonusPct}%</div>`
        ).join('')}
        ${factors.breakthroughMalusMultPct !== undefined && factors.breakthroughMalusDeltaPct !== undefined
          ? `<div>· Breakthrough captured-sector malus: ${factors.breakthroughMalusDeltaPct}% (×${factors.breakthroughMalusMultPct}%)</div>`
          : ''}
        ${factors.riverDefenseBonusPct !== undefined
          ? `<div>· River defense: +${factors.riverDefenseBonusPct}%</div>`
          : ''}
        ${factors.spearheadBonusPct !== undefined
          ? `<div>· Spearhead: +${factors.spearheadBonusPct}%</div>`
          : ''}
        ${(factors.upgradeLines ?? []).map(l => `<div>· ${l}</div>`).join('')}
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
    extraFlankingFrom: fc.extraFlankingFrom.length > 0 ? fc.extraFlankingFrom : undefined,
    spearheadBonusPct: fc.spearheadBonusPct,
    upgradeLines:
      fc.attackerUpgradeForecastLines && fc.attackerUpgradeForecastLines.length > 0
        ? fc.attackerUpgradeForecastLines
        : undefined,
  };
  const defenderFactors: SideFactors = {
    cs: fc.defenderCS,
    conditionPct: fc.defenderConditionPct,
    flankCount: 0,
    flankBonusPct: 0,
    breakthroughMalusMultPct: fc.breakthroughDefenderMalus ? Math.round(config.breakthroughEnemySectorStrengthMult * 100) : undefined,
    breakthroughMalusDeltaPct: fc.breakthroughDefenderMalus ? Math.round((config.breakthroughEnemySectorStrengthMult - 1) * 100) : undefined,
    riverDefenseBonusPct: fc.defenderRiverDefenseBonusPct,
    upgradeLines:
      fc.defenderUpgradeForecastLines && fc.defenderUpgradeForecastLines.length > 0
        ? fc.defenderUpgradeForecastLines
        : undefined,
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
    ${fc.breakthroughDefenderMalus ? '<div class="tt-breakthrough-note">Defender in captured sector: reduced CS.</div>' : ''}
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
  syncBoardPointerHoverFromEvent(e);

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
  if (!attacker || attacker.owner === enemyOwner) {
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

  if (
    !isValidMove &&
    !target &&
    isHexBlockedByOpponentHomeGuardOnly(state, attacker, hex.col, hex.row)
  ) {
    tooltipEl.innerHTML = `<div class="tt-title tt-zoc">Blitz blocked</div>
      <div class="tt-zoc-msg">Blitz not allowed. You cannot blitz to the enemy border when an enemy unit is adjacent.</div>`;
    tooltipEl.classList.remove('hidden');
    svg.classList.remove('cursor-fight');
    positionTooltip(e.pageX, e.pageY);
    return;
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
  if (boardPointerHoverHex !== null) {
    boardPointerHoverHex = null;
    queueBoardUnitPointerHoverApply();
  }
});

const pauseOverlayEl   = document.getElementById('pause-overlay') as HTMLDivElement;
const pauseReturnBtn   = document.getElementById('pause-return-btn') as HTMLButtonElement;
const pauseRestartBtn  = document.getElementById('pause-restart-btn') as HTMLButtonElement;
const pauseContinueBtn = document.getElementById('pause-continue-btn') as HTMLButtonElement;

pauseReturnBtn.addEventListener('click', () => {
  pauseOverlayEl.classList.add('hidden');
  closeLobbyWs();
  hideGameEndScreen();
  hideUnitPicker();
  if (activeStoryIndex !== null) {
    restoreConfigAfterStory();
    buildStoriesList(activeScenarioId);
    storiesOverlayEl.classList.remove('hidden');
  } else {
    setActiveUnitPackage(null);
    setActiveUnitPackagePlayer2(null);
    showMainMenu();
  }
});

pauseRestartBtn.addEventListener('click', () => {
  pauseOverlayEl.classList.add('hidden');
  if (activeStoryIndex !== null) {
    startStory(activeStoryIndex);
  } else {
    startGame(createInitialStatePreservingTerrain(state));
  }
});

pauseContinueBtn.addEventListener('click', () => {
  pauseOverlayEl.classList.add('hidden');
});

// Capture phase + preventDefault: in Tauri/WKWebView, Escape otherwise exits native fullscreen
// before our bubble handler runs; we still want ESC to only toggle the in-game pause menu.
document.addEventListener(
  'keydown',
  (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const inGame = mainMenuOverlayEl.classList.contains('hidden')
      && introOverlayEl.classList.contains('hidden')
      && recapOverlayEl.classList.contains('hidden');
    if (!inGame) return;
    e.preventDefault();
    if (pauseOverlayEl.classList.contains('hidden')) {
      pauseRestartBtn.hidden = gameMode === 'vsHuman';
      pauseOverlayEl.classList.remove('hidden');
    } else {
      pauseOverlayEl.classList.add('hidden');
    }
  },
  true,
);

document.addEventListener('keydown', (e: KeyboardEvent) => {
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
  hideGameEndOverlayForReplay();
  recapOverlayEl.classList.remove('hidden');
}

gameEndRecapBtn.addEventListener('click', openReplayFromEndGame);

recapSliderEl.addEventListener('input', () => {
  renderRecapTurn(parseInt(recapSliderEl.value));
});

recapCloseBtn.addEventListener('click', () => {
  recapOverlayEl.classList.add('hidden');
  revealGameEndScreenAfterReplay();
});

// ── Init ──────────────────────────────────────────────────────────────────────

loadIconDefs(config.unitTypes.map(t => t.icon).filter((i): i is string => !!i));
showMainMenu();

// ── Dev shortcuts (URL param ?dev=<screen>) ───────────────────────────────────
(function applyDevScreen() {
  const dev = new URLSearchParams(window.location.search).get('dev');
  if (!dev) return;
  switch (dev) {
    case 'winner':
      showGameEndScreenForOutcome(true, 'dom_breakthrough', state, localPlayer);
      break;
    case 'loser':
      showGameEndScreenForOutcome(false, 'dom_annihilation', state, localPlayer);
      break;
    case 'disconnected':
      showGameEndScreenDisconnected(state, localPlayer);
      break;
  }
})();
