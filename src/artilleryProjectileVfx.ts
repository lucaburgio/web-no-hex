import gsap from 'gsap';

/** Pixel coordinates in SVG user space (same as board rendering). */
export interface ArtilleryPoint {
  x: number;
  y: number;
}

export type ArtilleryVfxPresetId =
  | 'ballisticArc'
  | 'directStreak'
  | 'mortarVolley'
  | 'guidedWobble'
  | 'plasmaDrop';

/** Tweakable knobs for projectile visuals (merged per preset). */
export interface ArtilleryProjectileStyle {
  /** Flight duration in seconds. */
  duration: number;
  /** Shell / projectile radius in SVG units. */
  shellRadius: number;
  /** Peak height of arc above the chord from→to (negative = bow downward). */
  arcHeight: number;
  /** Stroke width for streak-style shells. */
  streakWidth: number;
  /** Primary fill/stroke color. */
  color: string;
  /** Secondary (trail, glow) color. */
  accentColor: string;
  /** Impact pulse scale multiplier. */
  impactScale: number;
  /** How long the impact ring lasts (s). */
  impactDuration: number;
}

const DEFAULT_STYLE: ArtilleryProjectileStyle = {
  duration: 0.55,
  shellRadius: 6,
  arcHeight: 72,
  streakWidth: 4,
  color: '#c45c3e',
  accentColor: '#f4a574',
  impactScale: 2.2,
  impactDuration: 0.28,
};

export const ARTILLERY_VFX_LABELS: Record<ArtilleryVfxPresetId, string> = {
  ballisticArc: 'Ballistic arc — rotating shell, high arc, impact ring',
  directStreak: 'Direct streak — fast flat shot, motion-style fade',
  mortarVolley: 'Mortar volley — three staggered smaller shells',
  guidedWobble: 'Guided wobble — arc with lateral sine wobble',
  plasmaDrop: 'Plasma drop — glowing drop, ease-in slam',
};

function mergeStyle(overrides?: Partial<ArtilleryProjectileStyle>): ArtilleryProjectileStyle {
  return { ...DEFAULT_STYLE, ...overrides };
}

function quadBezier(p0: ArtilleryPoint, p1: ArtilleryPoint, p2: ArtilleryPoint, t: number): ArtilleryPoint {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

function midpoint(a: ArtilleryPoint, b: ArtilleryPoint): ArtilleryPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function ns<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

function impactRing(
  parent: SVGGElement,
  at: ArtilleryPoint,
  style: ArtilleryProjectileStyle,
): gsap.core.Timeline {
  const ring = ns('circle');
  ring.setAttribute('cx', String(at.x));
  ring.setAttribute('cy', String(at.y));
  ring.setAttribute('r', '4');
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', style.accentColor);
  ring.setAttribute('stroke-width', '2');
  ring.setAttribute('opacity', '0.9');
  parent.appendChild(ring);
  return gsap.timeline().to(ring, {
    attr: { r: 28 * style.impactScale },
    opacity: 0,
    duration: style.impactDuration,
    ease: 'power2.out',
  });
}

export interface PlayArtilleryProjectileOptions {
  svg: SVGSVGElement;
  from: ArtilleryPoint;
  to: ArtilleryPoint;
  preset: ArtilleryVfxPresetId;
  /** Optional style overrides (e.g. duration, colors). */
  styleOverrides?: Partial<ArtilleryProjectileStyle>;
  /** If set, projectiles are appended here; otherwise a transient group is appended to `svg`. */
  parent?: SVGGElement;
  onComplete?: () => void;
}

export interface ArtilleryProjectileHandle {
  cancel: () => void;
  timeline: gsap.core.Timeline;
}

/**
 * Plays a one-off artillery projectile VFX between two points. Removes DOM on finish or cancel.
 * Safe to call from game code once a preset is chosen; tweak via {@link ArtilleryProjectileStyle}.
 */
export function playArtilleryProjectile(options: PlayArtilleryProjectileOptions): ArtilleryProjectileHandle {
  const {
    svg,
    from,
    to,
    preset,
    styleOverrides,
    parent: parentOpt,
    onComplete,
  } = options;

  const root = ns('g');
  root.setAttribute('class', 'artillery-projectile-vfx');
  const parent = parentOpt ?? svg;
  parent.appendChild(root);

  const base = mergeStyle(styleOverrides);
  let tl: gsap.core.Timeline;

  switch (preset) {
    case 'ballisticArc':
      tl = presetBallisticArc(root, from, to, base);
      break;
    case 'directStreak':
      tl = presetDirectStreak(root, from, to, base);
      break;
    case 'mortarVolley':
      tl = presetMortarVolley(root, from, to, base);
      break;
    case 'guidedWobble':
      tl = presetGuidedWobble(root, from, to, base);
      break;
    case 'plasmaDrop':
      tl = presetPlasmaDrop(root, from, to, base);
      break;
    default: {
      const _exhaustive: never = preset;
      throw new Error(`Unknown preset: ${_exhaustive}`);
    }
  }

  const cleanup = (): void => {
    root.remove();
    onComplete?.();
  };

  tl.eventCallback('onComplete', cleanup);

  return {
    timeline: tl,
    cancel: (): void => {
      tl.kill();
      root.remove();
    },
  };
}

function presetBallisticArc(
  root: SVGGElement,
  from: ArtilleryPoint,
  to: ArtilleryPoint,
  style: ArtilleryProjectileStyle,
): gsap.core.Timeline {
  const mid = midpoint(from, to);
  const control: ArtilleryPoint = { x: mid.x, y: mid.y - style.arcHeight };
  const g = ns('g');
  const shell = ns('circle');
  shell.setAttribute('r', String(style.shellRadius));
  shell.setAttribute('fill', style.color);
  shell.setAttribute('stroke', '#2a1810');
  shell.setAttribute('stroke-width', '1.5');
  g.appendChild(shell);
  root.appendChild(g);

  const pos = { t: 0, rot: 0 };
  const tl = gsap.timeline();
  tl.to(pos, {
    t: 1,
    duration: style.duration,
    ease: 'power2.in',
    onUpdate: (): void => {
      const p = quadBezier(from, control, to, pos.t);
      g.setAttribute('transform', `translate(${p.x} ${p.y}) rotate(${pos.rot})`);
    },
  }).to(
    pos,
    { rot: 720, duration: style.duration, ease: 'none' },
    0,
  );
  tl.add(impactRing(root, to, style));
  return tl;
}

function presetDirectStreak(
  root: SVGGElement,
  from: ArtilleryPoint,
  to: ArtilleryPoint,
  style: ArtilleryProjectileStyle,
): gsap.core.Timeline {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const streak = ns('line');
  streak.setAttribute('x1', String(from.x));
  streak.setAttribute('y1', String(from.y));
  streak.setAttribute('x2', String(from.x + ux * 14));
  streak.setAttribute('y2', String(from.y + uy * 14));
  streak.setAttribute('stroke', style.color);
  streak.setAttribute('stroke-width', String(style.streakWidth));
  streak.setAttribute('stroke-linecap', 'round');
  streak.setAttribute('opacity', '1');
  root.appendChild(streak);

  const head = { x: from.x, y: from.y };
  const tl = gsap.timeline();
  tl.to(head, {
    x: to.x,
    y: to.y,
    duration: style.duration * 0.42,
    ease: 'power3.in',
    onUpdate: (): void => {
      streak.setAttribute('x2', String(head.x));
      streak.setAttribute('y2', String(head.y));
      streak.setAttribute('x1', String(head.x - ux * 22));
      streak.setAttribute('y1', String(head.y - uy * 22));
    },
  })
    .to(streak, { opacity: 0, duration: 0.06 }, '-=0.02')
    .add(impactRing(root, to, { ...style, impactDuration: style.impactDuration * 1.1 }));
  return tl;
}

function presetMortarVolley(
  root: SVGGElement,
  from: ArtilleryPoint,
  to: ArtilleryPoint,
  style: ArtilleryProjectileStyle,
): gsap.core.Timeline {
  const mid = midpoint(from, to);
  const control: ArtilleryPoint = { x: mid.x, y: mid.y - style.arcHeight * 0.85 };
  const tl = gsap.timeline();
  const offsets = [-0.02, 0, 0.02];
  const scales = [0.75, 0.9, 0.8];

  offsets.forEach((startAt, i) => {
    const g = ns('g');
    const shell = ns('circle');
    const r = style.shellRadius * scales[i]!;
    shell.setAttribute('r', String(r));
    shell.setAttribute('fill', style.color);
    shell.setAttribute('stroke', '#3d2918');
    shell.setAttribute('stroke-width', '1');
    g.appendChild(shell);
    root.appendChild(g);
    const pos = { t: 0 };
    const d = style.duration * (0.92 + i * 0.04);
    tl.to(
      pos,
      {
        t: 1,
        duration: d,
        ease: 'power2.in',
        onUpdate: (): void => {
          const p = quadBezier(from, control, to, pos.t);
          g.setAttribute('transform', `translate(${p.x} ${p.y})`);
        },
      },
      startAt,
    );
  });

  tl.add(impactRing(root, to, style), '-=0.08');
  return tl;
}

function presetGuidedWobble(
  root: SVGGElement,
  from: ArtilleryPoint,
  to: ArtilleryPoint,
  style: ArtilleryProjectileStyle,
): gsap.core.Timeline {
  const mid = midpoint(from, to);
  const control: ArtilleryPoint = { x: mid.x, y: mid.y - style.arcHeight * 0.9 };
  const g = ns('g');
  const shell = ns('circle');
  shell.setAttribute('r', String(style.shellRadius * 0.95));
  shell.setAttribute('fill', style.color);
  shell.setAttribute('stroke', style.accentColor);
  shell.setAttribute('stroke-width', '2');
  g.appendChild(shell);
  root.appendChild(g);

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  const wobbleAmp = 10;

  const pos = { t: 0 };
  const tl = gsap.timeline();
  tl.to(pos, {
    t: 1,
    duration: style.duration,
    ease: 'power1.inOut',
    onUpdate: (): void => {
      const base = quadBezier(from, control, to, pos.t);
      const w = Math.sin(pos.t * Math.PI * 5) * wobbleAmp * (1 - pos.t * 0.3);
      g.setAttribute('transform', `translate(${base.x + px * w} ${base.y + py * w})`);
    },
  }).add(impactRing(root, to, style));
  return tl;
}

function presetPlasmaDrop(
  root: SVGGElement,
  from: ArtilleryPoint,
  to: ArtilleryPoint,
  style: ArtilleryProjectileStyle,
): gsap.core.Timeline {
  const defs = ns('defs');
  const fid = `glow-${Math.random().toString(36).slice(2, 9)}`;
  const filter = ns('filter');
  filter.setAttribute('id', fid);
  const blur = ns('feGaussianBlur');
  blur.setAttribute('stdDeviation', '3');
  blur.setAttribute('result', 'blur');
  filter.appendChild(blur);
  defs.appendChild(filter);
  root.appendChild(defs);

  const high: ArtilleryPoint = {
    x: from.x + (to.x - from.x) * 0.35,
    y: from.y - Math.max(100, style.arcHeight * 1.4),
  };
  const g = ns('g');
  const core = ns('circle');
  core.setAttribute('r', String(style.shellRadius * 0.85));
  core.setAttribute('fill', style.accentColor);
  const glow = ns('circle');
  glow.setAttribute('r', String(style.shellRadius * 1.6));
  glow.setAttribute('fill', style.color);
  glow.setAttribute('opacity', '0.55');
  glow.setAttribute('filter', `url(#${fid})`);
  g.appendChild(glow);
  g.appendChild(core);
  root.appendChild(g);

  const pos = { t: 0 };
  const tl = gsap.timeline();
  tl.to(pos, {
    t: 1,
    duration: style.duration * 1.05,
    ease: 'power4.in',
    onUpdate: (): void => {
      const p = quadBezier(high, midpoint(high, to), to, pos.t);
      const slam = pos.t > 0.94 ? 1 + (pos.t - 0.94) / 0.06 * 0.25 : 0.85 + pos.t * 0.3;
      g.setAttribute('transform', `translate(${p.x} ${p.y}) scale(${slam})`);
    },
  }).add(
    impactRing(root, to, {
      ...style,
      accentColor: style.accentColor,
      impactDuration: style.impactDuration * 1.15,
    }),
  );
  return tl;
}

/** All preset ids for iteration (e.g. test page). */
export const ARTILLERY_VFX_PRESET_IDS: ArtilleryVfxPresetId[] = [
  'ballisticArc',
  'directStreak',
  'mortarVolley',
  'guidedWobble',
  'plasmaDrop',
];
