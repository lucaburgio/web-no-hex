/**
 * Single end-of-match UI for vs AI and multiplayer: same markup, styles, and GSAP intro.
 * Call {@link hideGameEndScreen} when leaving the match or starting a new game.
 */
import {
  playMpResultIntro,
  revertMpResultIntro,
  DEFAULT_MP_RESULT_VARIANT,
} from './mpResultOverlay';
import type { WinReason } from './types';

const overlayEl = document.getElementById('game-end-overlay') as HTMLDivElement;
const msgEl = document.getElementById('game-end-msg') as HTMLParagraphElement;
const subtitleEl = document.getElementById('game-end-subtitle') as HTMLParagraphElement;
const actionsEl = document.getElementById('game-end-actions') as HTMLDivElement;

function getWinReasonSubtitle(reason: WinReason | undefined, won: boolean): string {
  switch (reason) {
    case 'dom_breakthrough':
      return won ? 'You reached the enemy front line' : 'The enemy reached your front line';
    case 'dom_annihilation':
      return won ? 'You eliminated all enemy units' : 'You lost all your units';
    case 'cq_elimination':
      return won ? 'The enemy was completely eliminated' : 'You were completely eliminated';
    case 'cq_both_eliminated':
      return won ? 'Both sides wiped — northern advantage' : 'Both sides wiped — northern advantage';
    case 'cq_cp_depleted':
      return won ? 'The enemy ran out of conquest points' : 'You ran out of conquest points';
    case 'cq_both_cp_depleted':
      return won ? 'You held more territory when conquest points ran out' : 'The enemy held more territory when conquest points ran out';
    case 'bt_attacker_wiped':
      return won ? 'You eliminated all attacking units' : 'You lost all your units';
    case 'bt_all_sectors':
      return won ? 'You captured all enemy sectors' : 'The enemy captured all your sectors';
    default:
      return '';
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

export function hideGameEndScreen(): void {
  revertMpResultIntro();
  overlayEl.classList.add('hidden');
  configureStoryEndButtons(false, false);
  gameEndRestartBtn.classList.remove('hidden');
  gameEndRecapBtn.classList.remove('hidden');
  gameEndBackMenuBtn.classList.add('secondary');
}

/** Hide only for replay; preserves GSAP state so closing recap can restore without replaying intro. */
export function hideGameEndOverlayForReplay(): void {
  overlayEl.classList.add('hidden');
}

export function revealGameEndScreenAfterReplay(): void {
  overlayEl.classList.remove('hidden');
}

export function showGameEndScreenForOutcome(won: boolean, reason?: WinReason): void {
  msgEl.textContent = won ? 'victory' : 'you lost';
  subtitleEl.textContent = getWinReasonSubtitle(reason, won);
  if (!overlayEl.classList.contains('hidden')) return;
  overlayEl.classList.remove('hidden');
  playMpResultIntro(DEFAULT_MP_RESULT_VARIANT, {
    overlay: overlayEl,
    text: msgEl,
    actions: actionsEl,
  });
}

export function showGameEndScreenDisconnected(): void {
  msgEl.textContent = 'opponent disconnected';
  subtitleEl.textContent = '';
  gameEndRestartBtn.classList.add('hidden');
  gameEndRecapBtn.classList.add('hidden');
  gameEndBackMenuBtn.classList.remove('hidden', 'secondary');
  if (!overlayEl.classList.contains('hidden')) return;
  overlayEl.classList.remove('hidden');
  playMpResultIntro(DEFAULT_MP_RESULT_VARIANT, {
    overlay: overlayEl,
    text: msgEl,
    actions: actionsEl,
  });
}
