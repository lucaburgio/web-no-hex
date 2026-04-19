/**
 * End-of-match UI for vs AI and multiplayer: flat layout, battle stats, no screen effects.
 * Call {@link hideGameEndScreen} when leaving the match or starting a new game.
 */
import gsap from 'gsap';
import type { BattleStatsSide, GameState, Owner, WinReason } from './types';
import { normalizeBattleStats } from './game';

/**
 * Entrance animation when the end-game overlay opens (ease-out).
 * Tweak these values to change timing and motion.
 */
export const GAME_END_OPEN_ANIMATION = {
  /** Total duration of the opening tween in seconds. */
  durationSec: 1.5,
  /** Delay after the overlay becomes visible, in seconds. */
  delaySec: 0.2,
  /**
   * GSAP ease name — pick an “out” curve for a clean settle, e.g. power2.out, power3.out, expo.out.
   * @see https://gsap.com/docs/v3/Eases/
   */
  ease: 'power3.out',
  /** Starting vertical offset in px (positive moves content up into place from below). */
  fromTranslateYPx: 24,
  /** Starting scale (1 = no zoom). Slightly below 1 reads as a soft “rise in”. */
  fromScale: 0.985,
  /** Whether to fade from transparent together with the motion. */
  fade: true,
};

const overlayEl = document.getElementById('game-end-overlay') as HTMLDivElement;
const innerEl = document.getElementById('game-end-inner') as HTMLDivElement;
const kickerEl = document.getElementById('game-end-kicker') as HTMLParagraphElement;
const titleEl = document.getElementById('game-end-title') as HTMLHeadingElement;
const subtitleEl = document.getElementById('game-end-subtitle') as HTMLParagraphElement;
const statsSectionEl = document.getElementById('game-end-stats') as HTMLElement;
const statsRowsEl = document.getElementById('game-end-stats-rows') as HTMLElement;
const colYouLabelEl = document.getElementById('game-end-col-you') as HTMLElement;
const colEnemyLabelEl = document.getElementById('game-end-col-enemy') as HTMLElement;
const actionsEl = document.getElementById('game-end-actions') as HTMLDivElement;
const iconEl = document.getElementById('game-end-icon') as HTMLElement;

type Prefer = 'higher' | 'lower';

const STAT_ROWS: { label: string; prefer: Prefer; pick: (s: BattleStatsSide) => number }[] = [
  { label: 'Enemy units destroyed', prefer: 'higher', pick: s => s.enemyUnitsDestroyed },
  { label: 'Total damage inflicted', prefer: 'higher', pick: s => s.damageDealt },
  { label: 'Total damage received', prefer: 'lower', pick: s => s.damageTaken },
  { label: 'Units lost', prefer: 'lower', pick: s => s.unitsLost },
  { label: 'Total units used on the battlefield', prefer: 'higher', pick: s => s.unitsDeployed },
];

function headlineForOutcome(reason: WinReason | undefined, won: boolean): string {
  switch (reason) {
    case 'dom_breakthrough':
      return won ? 'You reached the enemy front line' : 'The enemy reached your front line';
    case 'dom_annihilation':
      return won ? 'All enemy units eliminated' : 'You lost all your units';
    case 'cq_elimination':
      return won ? 'The enemy was completely eliminated' : 'You were completely eliminated';
    case 'cq_both_eliminated':
      return 'Both sides wiped — northern advantage';
    case 'cq_cp_depleted':
      return won ? 'Enemy conquest points depleted' : 'Your conquest points depleted';
    case 'cq_both_cp_depleted':
      return won ? 'More territory when conquest points ran out' : 'Less territory when conquest points ran out';
    case 'bt_attacker_wiped':
      return won ? 'All attacking units eliminated' : 'You lost all your units';
    case 'bt_all_sectors':
      return won ? 'All enemy sectors captured' : 'The enemy captured all your sectors';
    default:
      return won ? 'Victory' : 'Defeat';
  }
}

function valTone(
  youVal: number,
  enemyVal: number,
  prefer: Prefer,
  column: 'you' | 'enemy',
): 'game-end-stat-num--strong' | 'game-end-stat-num--muted' | 'game-end-stat-num--tie' {
  if (youVal === enemyVal) return 'game-end-stat-num--tie';
  const youBetter = prefer === 'higher' ? youVal > enemyVal : youVal < enemyVal;
  if (column === 'you') {
    return youBetter ? 'game-end-stat-num--strong' : 'game-end-stat-num--muted';
  }
  return youBetter ? 'game-end-stat-num--muted' : 'game-end-stat-num--strong';
}

function bracketedValue(n: number, tone: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'game-end-bracket';
  wrap.innerHTML =
    '<span class="game-end-bracket-corner game-end-bracket-corner--tl" aria-hidden="true"></span>'
    + '<span class="game-end-bracket-corner game-end-bracket-corner--tr" aria-hidden="true"></span>'
    + '<span class="game-end-bracket-corner game-end-bracket-corner--bl" aria-hidden="true"></span>'
    + '<span class="game-end-bracket-corner game-end-bracket-corner--br" aria-hidden="true"></span>';
  const num = document.createElement('span');
  num.className = `game-end-stat-num ${tone}`;
  num.textContent = String(n);
  wrap.appendChild(num);
  return wrap;
}

function fillStatsTable(state: GameState, you: Owner): void {
  statsRowsEl.replaceChildren();
  const bs = normalizeBattleStats(state);
  const enemy: Owner = you === 1 ? 2 : 1;
  const sy = bs[you];
  const se = bs[enemy];

  for (const row of STAT_ROWS) {
    const yv = row.pick(sy);
    const ev = row.pick(se);
    const rowEl = document.createElement('div');
    rowEl.className = 'game-end-stat-row';
    const label = document.createElement('span');
    label.className = 'game-end-stat-label';
    label.textContent = row.label;
    rowEl.appendChild(label);
    rowEl.appendChild(bracketedValue(yv, valTone(yv, ev, row.prefer, 'you')));
    rowEl.appendChild(bracketedValue(ev, valTone(yv, ev, row.prefer, 'enemy')));
    statsRowsEl.appendChild(rowEl);
  }
}

export const gameEndRestartBtn = document.getElementById(
  'game-end-restart-btn',
) as HTMLButtonElement;
export const gameEndNextStoryBtn = document.getElementById(
  'game-end-next-story-btn',
) as HTMLButtonElement;
export const gameEndBackMenuBtn = document.getElementById(
  'game-end-back-menu-btn',
) as HTMLButtonElement;
export const gameEndRecapBtn = document.getElementById(
  'game-end-recap-btn',
) as HTMLButtonElement;

/** Show story-specific navigation buttons (win screen). Call with false to reset. */
export function configureStoryEndButtons(show: boolean, hasNext: boolean): void {
  gameEndRestartBtn.classList.toggle('hidden', show);
  gameEndNextStoryBtn.classList.toggle('hidden', !show || !hasNext);
  gameEndBackMenuBtn.classList.toggle('hidden', !show);
}

function resetDisconnectedButtonState(): void {
  gameEndRestartBtn.classList.remove('hidden');
  gameEndRecapBtn.classList.remove('hidden');
  gameEndBackMenuBtn.classList.add('hidden');
  gameEndBackMenuBtn.classList.remove('button-primary');
  gameEndBackMenuBtn.classList.add('button-secondary');
}

function killGameEndOpeningAnimation(): void {
  gsap.killTweensOf(innerEl);
  gsap.set(innerEl, { clearProps: 'opacity,visibility,transform' });
}

/** Plays the configured ease-out entrance on the end-game panel. */
function playGameEndOpeningAnimation(): void {
  const c = GAME_END_OPEN_ANIMATION;
  gsap.killTweensOf(innerEl);
  const from: gsap.TweenVars = {
    y: c.fromTranslateYPx,
    scale: c.fromScale,
  };
  if (c.fade) {
    from.autoAlpha = 0;
  } else {
    from.autoAlpha = 1;
  }
  gsap.fromTo(innerEl, from, {
    y: 0,
    scale: 1,
    autoAlpha: 1,
    duration: c.durationSec,
    delay: c.delaySec,
    ease: c.ease,
  });
}

export function hideGameEndScreen(): void {
  killGameEndOpeningAnimation();
  overlayEl.classList.add('hidden');
  overlayEl.classList.remove('game-end-overlay--disconnected');
  configureStoryEndButtons(false, false);
  resetDisconnectedButtonState();
}

/** Hide only for replay; closing recap can restore without replaying intro. */
export function hideGameEndOverlayForReplay(): void {
  killGameEndOpeningAnimation();
  overlayEl.classList.add('hidden');
}

export function revealGameEndScreenAfterReplay(): void {
  overlayEl.classList.remove('hidden');
  playGameEndOpeningAnimation();
}

export function showGameEndScreenForOutcome(
  won: boolean,
  reason: WinReason | undefined,
  state: GameState,
  perspectiveOwner: Owner,
): void {
  overlayEl.classList.remove('game-end-overlay--disconnected');
  kickerEl.textContent = won ? 'Victory' : 'Defeat';
  titleEl.textContent = headlineForOutcome(reason, won).toUpperCase();
  subtitleEl.textContent = '';
  colYouLabelEl.textContent = 'You';
  colEnemyLabelEl.textContent = 'Enemy';
  statsSectionEl.classList.remove('hidden');
  fillStatsTable(state, perspectiveOwner);
  iconEl.classList.remove('game-end-icon--warn');
  if (!overlayEl.classList.contains('hidden')) return;
  overlayEl.classList.remove('hidden');
  playGameEndOpeningAnimation();
}

export function showGameEndScreenDisconnected(state: GameState, perspectiveOwner: Owner): void {
  overlayEl.classList.add('game-end-overlay--disconnected');
  kickerEl.textContent = 'Disconnected';
  titleEl.textContent = 'OPPONENT LEFT THE MATCH';
  subtitleEl.textContent = '';
  colYouLabelEl.textContent = 'You';
  colEnemyLabelEl.textContent = 'Enemy';
  statsSectionEl.classList.remove('hidden');
  fillStatsTable(state, perspectiveOwner);
  iconEl.classList.add('game-end-icon--warn');
  gameEndRestartBtn.classList.add('hidden');
  gameEndRecapBtn.classList.add('hidden');
  gameEndBackMenuBtn.classList.remove('hidden', 'button-secondary');
  gameEndBackMenuBtn.classList.add('button-primary');
  if (!overlayEl.classList.contains('hidden')) return;
  overlayEl.classList.remove('hidden');
  playGameEndOpeningAnimation();
}
