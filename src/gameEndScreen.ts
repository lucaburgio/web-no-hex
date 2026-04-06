/**
 * Single end-of-match UI for vs AI and multiplayer: same markup, styles, and GSAP intro.
 * Call {@link hideGameEndScreen} when leaving the match or starting a new game.
 */
import {
  playMpResultIntro,
  revertMpResultIntro,
  DEFAULT_MP_RESULT_VARIANT,
} from './mpResultOverlay';

const overlayEl = document.getElementById('game-end-overlay') as HTMLDivElement;
const msgEl = document.getElementById('game-end-msg') as HTMLParagraphElement;
const actionsEl = document.getElementById('game-end-actions') as HTMLDivElement;

export const gameEndRestartBtn = document.getElementById(
  'game-end-restart-btn',
) as HTMLButtonElement;
export const gameEndRecapBtn = document.getElementById(
  'game-end-recap-btn',
) as HTMLButtonElement;

export function hideGameEndScreen(): void {
  revertMpResultIntro();
  overlayEl.classList.add('hidden');
}

/** Hide only for replay; preserves GSAP state so closing recap can restore without replaying intro. */
export function hideGameEndOverlayForReplay(): void {
  overlayEl.classList.add('hidden');
}

export function revealGameEndScreenAfterReplay(): void {
  overlayEl.classList.remove('hidden');
}

export function showGameEndScreenForOutcome(won: boolean): void {
  msgEl.textContent = won ? 'victory' : 'you lost';
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
  if (!overlayEl.classList.contains('hidden')) return;
  overlayEl.classList.remove('hidden');
  playMpResultIntro(DEFAULT_MP_RESULT_VARIANT, {
    overlay: overlayEl,
    text: msgEl,
    actions: actionsEl,
  });
}
