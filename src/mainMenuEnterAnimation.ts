/**
 * Main menu enter animation — tweak timing, easing, and motion here.
 * Logo eases in from the left; the button column from the right.
 */
export const mainMenuEnterAnimation = {
  /** Duration of each enter (milliseconds) */
  durationMs: 520,
  /** CSS easing (e.g. cubic-bezier or "ease-out") */
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  /** Extra delay before the menu column starts (milliseconds) */
  menuDelayMs: 80,
  logo: {
    /** Starting horizontal offset in px (negative = from the left) */
    fromTranslateXpx: -56,
    fromOpacity: 0,
  },
  menu: {
    /** Starting horizontal offset in px (positive = from the right) */
    fromTranslateXpx: 56,
    fromOpacity: 0,
  },
} as const;

const ENTER_CLASS = 'main-menu-enter-anim';

export function applyMainMenuEnterAnimationVars(overlay: HTMLElement): void {
  const c = mainMenuEnterAnimation;
  const s = overlay.style;
  s.setProperty('--main-menu-enter-duration', `${c.durationMs}ms`);
  s.setProperty('--main-menu-enter-easing', c.easing);
  s.setProperty('--main-menu-enter-menu-delay', `${c.menuDelayMs}ms`);
  s.setProperty('--main-menu-logo-x0', `${c.logo.fromTranslateXpx}px`);
  s.setProperty('--main-menu-logo-o0', String(c.logo.fromOpacity));
  s.setProperty('--main-menu-menu-x0', `${c.menu.fromTranslateXpx}px`);
  s.setProperty('--main-menu-menu-o0', String(c.menu.fromOpacity));
}

/**
 * Run enter motion whenever the main menu becomes visible (including returning from sub-screens).
 */
export function playMainMenuEnterAnimation(els: {
  overlay: HTMLElement;
  logo: HTMLElement;
  menuColumn: HTMLElement;
}): void {
  applyMainMenuEnterAnimationVars(els.overlay);
  const { logo, menuColumn } = els;
  logo.classList.remove(ENTER_CLASS);
  menuColumn.classList.remove(ENTER_CLASS);
  void logo.offsetWidth;
  logo.classList.add(ENTER_CLASS);
  menuColumn.classList.add(ENTER_CLASS);
}
