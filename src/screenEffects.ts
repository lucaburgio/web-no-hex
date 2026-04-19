/**
 * Reusable screen-level animation effects.
 * Import and call from any screen; all effects self-clean on revert.
 */
import gsap from 'gsap';

// ── Tweakable Config ─────────────────────────────────────────────────────────
// Adjust these constants to tune each effect without touching the logic below.

/** Config for the full-screen glitch burst. */
export const GLITCH_CONFIG = {
  /** Total glitch burst duration in seconds. */
  duration: 0.7,
  /** Opacity of the color-channel split layers (0–1). */
  channelOpacity: 0.22,
  /** Horizontal pixel shift applied to each color channel. */
  channelOffset: 10,
  /** Number of rapid flicker frames within the burst. */
  flickerSteps: 8,
  /** Peak opacity of the glitch layer during flicker (0–1). */
  flickerPeakOpacity: 0.5,
  /** Duration of the initial hard flash in seconds. */
  flashDuration: 0.055,
  /** Opacity of the scan-line overlay during glitch (0 = off). */
  scanLineOpacity: 0.09,
};

/** Config for the slow cinematic zoom-out on text elements. */
export const SLOW_ZOOM_CONFIG = {
  /** Starting scale (zoomed in). E.g. 1.2 = 20% larger than normal. */
  fromScale: 1.2,
  /** Ending scale (normal). */
  toScale: 1,
  /** Zoom duration in seconds — keep high for a slow-motion feel. */
  duration: 5.5,
  /** GSAP ease string for the zoom curve. */
  ease: 'power1.out',
  /** Delay before the zoom begins, in seconds. */
  delay: 0.45,
};

// ── Internal state ───────────────────────────────────────────────────────────

let slowZoomTargets: HTMLElement[] = [];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Plays a one-shot full-screen glitch burst.
 * Creates and auto-removes a DOM overlay — safe to call on any screen.
 */
export function playGlitchEffect(config = GLITCH_CONFIG): void {
  const layer = document.createElement('div');
  layer.className = 'glitch-layer';
  document.body.appendChild(layer);

  if (config.scanLineOpacity > 0) {
    const lines = document.createElement('div');
    lines.className = 'glitch-scanlines';
    layer.appendChild(lines);
    gsap.set(lines, { opacity: config.scanLineOpacity });
  }

  const red = document.createElement('div');
  const blue = document.createElement('div');
  red.className = 'glitch-channel glitch-channel--red';
  blue.className = 'glitch-channel glitch-channel--blue';
  layer.appendChild(red);
  layer.appendChild(blue);

  gsap.set(layer, { opacity: 0 });
  gsap.set(red, { x: config.channelOffset, opacity: config.channelOpacity });
  gsap.set(blue, { x: -config.channelOffset, opacity: config.channelOpacity });

  const stepDur = (config.duration - config.flashDuration) / (config.flickerSteps + 2);
  const tl = gsap.timeline({ onComplete: () => layer.remove() });

  // Initial hard flash
  tl.to(layer, { opacity: config.flickerPeakOpacity, duration: config.flashDuration, ease: 'none' });

  // Rapid flicker
  for (let i = 0; i < config.flickerSteps; i++) {
    const t = i % 2 === 0
      ? config.flickerPeakOpacity * (0.25 + Math.random() * 0.45)
      : config.flickerPeakOpacity * (0.55 + Math.random() * 0.45);
    tl.to(layer, { opacity: t, duration: stepDur, ease: 'none' });
  }

  // Fade out channels and layer together
  tl.to([red, blue], { opacity: 0, x: 0, duration: stepDur * 2, ease: 'power2.out' }, '<');
  tl.to(layer, { opacity: 0, duration: stepDur * 2, ease: 'power2.in' });
}

/**
 * Applies a slow cinematic zoom-out (scale-down) to one or more elements.
 * The elements start scaled up and ease back to normal size.
 * Call {@link revertScreenEffects} to clean up when the screen is dismissed.
 */
export function playSlowZoomOut(
  elements: HTMLElement | HTMLElement[],
  config = SLOW_ZOOM_CONFIG,
): void {
  const els = Array.isArray(elements) ? elements : [elements];
  slowZoomTargets = [...els];

  gsap.set(els, { scale: config.fromScale });
  gsap.to(els, {
    scale: config.toScale,
    duration: config.duration,
    ease: config.ease,
    delay: config.delay,
  });
}

/** Kill active screen effects and clear their inline styles. */
export function revertScreenEffects(): void {
  if (slowZoomTargets.length > 0) {
    gsap.killTweensOf(slowZoomTargets);
    gsap.set(slowZoomTargets, { clearProps: 'scale,transform' });
    slowZoomTargets = [];
  }
  document.querySelectorAll('.glitch-layer').forEach(el => el.remove());
}
