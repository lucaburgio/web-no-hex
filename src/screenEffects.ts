/**
 * Reusable screen-level animation effects.
 * Import and call from any screen; all effects self-clean on revert.
 */
import gsap from 'gsap';

// ── Tweakable Config ─────────────────────────────────────────────────────────
// Adjust these constants to tune each effect without touching the logic below.

/** Config for the full-screen band-displacement glitch burst. */
export const GLITCH_CONFIG = {
  /** Total burst duration in seconds. */
  duration: 0.5,
  /** Max number of displaced bands drawn per frame during peak intensity. */
  maxBands: 4,
  /**
   * Max height of a single band in pixels.
   * Bands are power-distributed so most are thin; a few are thick.
   */
  maxBandHeight: 90,
  /** Max horizontal pixel displacement of a band (positive = right, negative = left). */
  maxDisplacement: 160,
  /** Primary band color (dark bands). CSS color string. */
  bandColor: 'rgba(210, 210, 210, 0.95)',
  /** Accent band color (occasional bright/colored flash). CSS color string. */
  accentColor: 'rgba(118, 118, 118, 0.88)',
  /** 0–1 probability that a given band uses the accent color instead of the primary. */
  accentChance: 0.2,
  /**
   * Opacity of horizontal scan-line overlay (0 = off).
   * Drawn every 4px to simulate CRT/digital artifacts.
   */
  scanLineOpacity: 0.05,
  /**
   * If true, the glitch fades out gradually toward the end rather than cutting abruptly.
   * Intensity and band count taper off as time progresses.
   */
  fadeOut: true,
};

/** Config for the slow cinematic zoom-out on text elements. */
export const SLOW_ZOOM_CONFIG = {
  /** Starting scale (zoomed in). E.g. 1.2 = 20% larger than normal. */
  fromScale: 1.2,
  /** Ending scale (normal). */
  toScale: 1,
  /** Zoom duration in seconds — keep high for a slow-motion feel. */
  duration: 8.5,
  /** GSAP ease string for the zoom curve. */
  ease: 'power1.out',
  /** Delay before the zoom begins, in seconds. */
  delay: 0.05,
};

// ── Internal state ───────────────────────────────────────────────────────────

let slowZoomTargets: HTMLElement[] = [];
let glitchRafId: number | null = null;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Plays a one-shot full-screen band-displacement glitch burst.
 * Uses a canvas overlay: horizontal bands of the display are shifted sideways
 * each frame, producing a VHS/digital-corruption appearance.
 * Creates and auto-removes its canvas — safe to call on any screen.
 */
export function playGlitchEffect(config = GLITCH_CONFIG): void {
  if (glitchRafId !== null) {
    cancelAnimationFrame(glitchRafId);
    glitchRafId = null;
    document.querySelector('.glitch-canvas')?.remove();
  }

  const canvas = document.createElement('canvas');
  canvas.className = 'glitch-canvas';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.style.cssText =
    'position:fixed;inset:0;width:200%;margin-left:-50%;height:100%;z-index:9999;pointer-events:none;';
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d')!;
  const startTime = performance.now();
  const durationMs = config.duration * 1000;

  function frame(now: number) {
    const elapsed = now - startTime;
    if (elapsed >= durationMs) {
      canvas.remove();
      glitchRafId = null;
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const progress = elapsed / durationMs;
    // Intensity: strong at start, tapers in last 40% if fadeOut is on
    const intensity = config.fadeOut
      ? progress < 0.6 ? 1 : 1 - (progress - 0.6) / 0.4
      : 1;

    const numBands = Math.max(1, Math.round((1 + Math.random() * config.maxBands) * intensity));

    for (let i = 0; i < numBands; i++) {
      // Power distribution skews toward thin bands with occasional thick ones
      const h = Math.pow(Math.random(), 1.8) * config.maxBandHeight * (0.3 + intensity * 0.7) + 1;
      const y = Math.random() * canvas.height;
      // Displacement: random direction, scaled by intensity
      const x = (Math.random() < 0.5 ? 1 : -1)
        * Math.random() * config.maxDisplacement * intensity;

      const useAccent = Math.random() < config.accentChance;
      ctx.fillStyle = useAccent ? config.accentColor : config.bandColor;
      ctx.globalAlpha = (0.45 + Math.random() * 0.55) * intensity;
      ctx.fillRect(x, y, canvas.width, h);
    }

    // Scan lines
    if (config.scanLineOpacity > 0) {
      ctx.globalAlpha = config.scanLineOpacity * intensity;
      ctx.fillStyle = '#000';
      for (let sy = 0; sy < canvas.height; sy += 4) {
        ctx.fillRect(0, sy, canvas.width, 1);
      }
    }

    glitchRafId = requestAnimationFrame(frame);
  }

  glitchRafId = requestAnimationFrame(frame);
}

/**
 * Applies a slow cinematic zoom-out (scale-down) to one or more elements.
 * Elements start scaled up and ease back to normal over a long duration.
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
  if (glitchRafId !== null) {
    cancelAnimationFrame(glitchRafId);
    glitchRafId = null;
  }
  document.querySelector('.glitch-canvas')?.remove();

  if (slowZoomTargets.length > 0) {
    gsap.killTweensOf(slowZoomTargets);
    gsap.set(slowZoomTargets, { clearProps: 'scale,transform' });
    slowZoomTargets = [];
  }
}
