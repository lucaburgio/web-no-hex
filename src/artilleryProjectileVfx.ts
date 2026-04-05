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

/** Defender-hex-only barrage: 5–6 short direct-streak shells, all localized on the target hex. */
export type ArtilleryHexBarragePresetId =
  | 'hexFan'
  | 'hexColumn'
  | 'hexConverge'
  | 'hexSalvo'
  | 'hexBracket';

/** Tweakable knobs for projectile visuals (merged per preset). */
export interface ArtilleryProjectileStyle {
  /** Flight duration in seconds (full attacker→defender shot; hex barrage scales this down). */
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
  scale = 1,
): gsap.core.Timeline {
  const ring = ns('circle');
  ring.setAttribute('cx', String(at.x));
  ring.setAttribute('cy', String(at.y));
  ring.setAttribute('r', '4');
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', style.accentColor);
  ring.setAttribute('stroke-width', String(Math.max(1, 1.5 * scale)));
  ring.setAttribute('opacity', String(0.75 + 0.15 * scale));
  parent.appendChild(ring);
  const maxR = 28 * style.impactScale * scale;
  return gsap.timeline().to(ring, {
    attr: { r: maxR },
    opacity: 0,
    duration: style.impactDuration * (0.75 + 0.25 * scale),
    ease: 'power2.out',
  });
}

/**
 * One fast direct streak (same visual language as full-board direct streak, tunable length).
 * @param durationScale multiplies the base streak flight time (short hex-local shots use ~0.3–0.45).
 */
function directStreakSegment(
  root: SVGGElement,
  from: ArtilleryPoint,
  to: ArtilleryPoint,
  style: ArtilleryProjectileStyle,
  durationScale: number,
  impactScale = 0.55,
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
  streak.setAttribute('stroke-width', String(style.streakWidth * (0.85 + 0.15 * impactScale)));
  streak.setAttribute('stroke-linecap', 'round');
  streak.setAttribute('opacity', '1');
  root.appendChild(streak);

  const head = { x: from.x, y: from.y };
  const flight = style.duration * 0.42 * durationScale;
  const tl = gsap.timeline();
  tl.to(head, {
    x: to.x,
    y: to.y,
    duration: flight,
    ease: 'power3.in',
    onUpdate: (): void => {
      streak.setAttribute('x2', String(head.x));
      streak.setAttribute('y2', String(head.y));
      streak.setAttribute('x1', String(head.x - ux * 22));
      streak.setAttribute('y1', String(head.y - uy * 22));
    },
  })
    .to(streak, { opacity: 0, duration: 0.05 }, '-=0.02')
    .add(impactRing(root, to, { ...style, impactDuration: style.impactDuration * 1.05 }, impactScale));
  return tl;
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
  return directStreakSegment(root, from, to, style, 1, 1);
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

// ── Defender-hex-only barrage (direct-streak shells localized on target hex) ──

const HEX_BARRAGE_SHELLS = 6;
const DEFAULT_HEX_RADIUS = 28;

export const ARTILLERY_HEX_BARRAGE_LABELS: Record<ArtilleryHexBarragePresetId, string> = {
  hexFan:
    'Fan — six streaks from a shallow arc above; impacts sweep across the hex like a bracketing salvo',
  hexColumn:
    'Column — six near-vertical drops with slight horizontal jitter, top-to-bottom ripples on the hex',
  hexConverge:
    'Converge — shells dive inward from six directions around the rim into a tight central cluster',
  hexSalvo:
    'Salvo — rapid tight group: very fast streaks with minimal stagger, machine-gun feel on one footprint',
  hexBracket:
    'Bracket — alternating left/right pairs from the top edge, impacts ping-pong across the hex face',
};

export const ARTILLERY_HEX_BARRAGE_PRESET_IDS: ArtilleryHexBarragePresetId[] = [
  'hexFan',
  'hexColumn',
  'hexConverge',
  'hexSalvo',
  'hexBracket',
];

export interface PlayDefenderHexBarrageOptions {
  svg: SVGSVGElement;
  /** Center of the defender hex in SVG space (e.g. from hex center pixel coords). */
  center: ArtilleryPoint;
  /** Approximate hex extent from center (vertex distance); impacts stay within ~this band. */
  hexRadius?: number;
  preset: ArtilleryHexBarragePresetId;
  styleOverrides?: Partial<ArtilleryProjectileStyle>;
  parent?: SVGGElement;
  onComplete?: () => void;
}

/**
 * Plays 5–6 short direct-streak shells whose motion stays on/near the defender hex (no line from attacker).
 * Intended for ranged artillery feedback on the target tile.
 */
export function playDefenderHexBarrage(options: PlayDefenderHexBarrageOptions): ArtilleryProjectileHandle {
  const {
    svg,
    center,
    hexRadius = DEFAULT_HEX_RADIUS,
    preset,
    styleOverrides,
    parent: parentOpt,
    onComplete,
  } = options;

  const root = ns('g');
  root.setAttribute('class', 'artillery-hex-barrage-vfx');
  const parent = parentOpt ?? svg;
  parent.appendChild(root);

  const base = mergeStyle(styleOverrides);
  let tl: gsap.core.Timeline;

  switch (preset) {
    case 'hexFan':
      tl = presetHexFan(root, center, hexRadius, base);
      break;
    case 'hexColumn':
      tl = presetHexColumn(root, center, hexRadius, base);
      break;
    case 'hexConverge':
      tl = presetHexConverge(root, center, hexRadius, base);
      break;
    case 'hexSalvo':
      tl = presetHexSalvo(root, center, hexRadius, base);
      break;
    case 'hexBracket':
      tl = presetHexBracket(root, center, hexRadius, base);
      break;
    default: {
      const _exhaustive: never = preset;
      throw new Error(`Unknown hex barrage preset: ${_exhaustive}`);
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

function presetHexFan(
  root: SVGGElement,
  c: ArtilleryPoint,
  R: number,
  style: ArtilleryProjectileStyle,
): gsap.core.Timeline {
  const tl = gsap.timeline();
  for (let i = 0; i < HEX_BARRAGE_SHELLS; i++) {
    const t = HEX_BARRAGE_SHELLS > 1 ? i / (HEX_BARRAGE_SHELLS - 1) : 0;
    const spread = (t - 0.5) * R * 1.15;
    const impact: ArtilleryPoint = { x: c.x + spread, y: c.y + R * 0.28 };
    const from: ArtilleryPoint = { x: c.x + spread * 0.88, y: c.y - R * 1.12 };
    tl.add(directStreakSegment(root, from, impact, style, 0.4, 0.52), i * 0.072);
  }
  return tl;
}

function presetHexColumn(
  root: SVGGElement,
  c: ArtilleryPoint,
  R: number,
  style: ArtilleryProjectileStyle,
): gsap.core.Timeline {
  const tl = gsap.timeline();
  const jitters = [-6, 5, -4, 7, -5, 4];
  for (let i = 0; i < HEX_BARRAGE_SHELLS; i++) {
    const jx = jitters[i] ?? 0;
    const impact: ArtilleryPoint = {
      x: c.x + jx,
      y: c.y - R * 0.42 + (i / (HEX_BARRAGE_SHELLS - 1)) * R * 0.88,
    };
    const from: ArtilleryPoint = { x: impact.x + (i % 2 === 0 ? 3 : -3), y: impact.y - R * 0.92 };
    tl.add(directStreakSegment(root, from, impact, style, 0.42, 0.5), i * 0.085);
  }
  return tl;
}

function presetHexConverge(
  root: SVGGElement,
  c: ArtilleryPoint,
  R: number,
  style: ArtilleryProjectileStyle,
): gsap.core.Timeline {
  const tl = gsap.timeline();
  for (let i = 0; i < HEX_BARRAGE_SHELLS; i++) {
    const ang = (i / HEX_BARRAGE_SHELLS) * Math.PI * 2 - Math.PI / 2;
    const outer = R * 1.5;
    const from: ArtilleryPoint = {
      x: c.x + Math.cos(ang) * outer,
      y: c.y + Math.sin(ang) * outer,
    };
    const land: ArtilleryPoint = {
      x: c.x + Math.cos(ang) * R * 0.2,
      y: c.y + Math.sin(ang) * R * 0.2,
    };
    tl.add(directStreakSegment(root, from, land, style, 0.34, 0.46), i * 0.058);
  }
  return tl;
}

function presetHexSalvo(
  root: SVGGElement,
  c: ArtilleryPoint,
  R: number,
  style: ArtilleryProjectileStyle,
): gsap.core.Timeline {
  const tl = gsap.timeline();
  const cluster: ArtilleryPoint[] = [
    { x: 0, y: 0 },
    { x: 7, y: -5 },
    { x: -6, y: 4 },
    { x: 5, y: 6 },
    { x: -7, y: -3 },
    { x: 4, y: -7 },
  ];
  for (let i = 0; i < HEX_BARRAGE_SHELLS; i++) {
    const o = cluster[i]!;
    const impact: ArtilleryPoint = { x: c.x + o.x, y: c.y + o.y };
    const from: ArtilleryPoint = {
      x: c.x + o.x * 0.35,
      y: c.y - R * 0.88 + o.y * 0.15,
    };
    tl.add(directStreakSegment(root, from, impact, style, 0.24, 0.4), i * 0.038);
  }
  return tl;
}

function presetHexBracket(
  root: SVGGElement,
  c: ArtilleryPoint,
  R: number,
  style: ArtilleryProjectileStyle,
): gsap.core.Timeline {
  const tl = gsap.timeline();
  for (let i = 0; i < HEX_BARRAGE_SHELLS; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    const impact: ArtilleryPoint = {
      x: c.x + side * R * 0.44,
      y: c.y - R * 0.05 + row * R * 0.16,
    };
    const from: ArtilleryPoint = {
      x: c.x + side * R * 0.38,
      y: c.y - R * 1.02,
    };
    tl.add(directStreakSegment(root, from, impact, style, 0.38, 0.48), i * 0.078);
  }
  return tl;
}

/** All preset ids for iteration (e.g. legacy test page). */
export const ARTILLERY_VFX_PRESET_IDS: ArtilleryVfxPresetId[] = [
  'ballisticArc',
  'directStreak',
  'mortarVolley',
  'guidedWobble',
  'plasmaDrop',
];
