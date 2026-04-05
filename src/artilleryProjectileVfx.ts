import gsap from 'gsap';

/** Pixel coordinates in SVG user space (same as board rendering). */
export interface ArtilleryPoint {
  x: number;
  y: number;
}

/** Styling for ranged artillery shell streaks and impact rings on the defender hex. */
export interface ArtilleryProjectileStyle {
  duration: number;
  streakWidth: number;
  color: string;
  accentColor: string;
  impactScale: number;
  impactDuration: number;
}

/** Default reds: `style.css` --color-red-700 / --color-red-500 */
const DEFAULT_STYLE: ArtilleryProjectileStyle = {
  duration: 1.55,
  streakWidth: 6,
  color: '#BD4E4E',
  accentColor: '#ff6b6b',
  impactScale: 3.2,
  impactDuration: 0.88,
};

function mergeStyle(overrides?: Partial<ArtilleryProjectileStyle>): ArtilleryProjectileStyle {
  return { ...DEFAULT_STYLE, ...overrides };
}

function ns<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

/**
 * Expanding ring at impact. The circle is created when this callback runs (see GSAP `timeline.add`
 * function-returning-tween), not when the parent timeline is constructed — so no dots at impacts
 * before each shell arrives.
 */
function impactRing(
  parent: SVGGElement,
  at: ArtilleryPoint,
  style: ArtilleryProjectileStyle,
  scale = 1,
): gsap.core.Timeline {
  const maxR = 28 * style.impactScale * scale;
  const duration = style.impactDuration * (0.75 + 0.25 * scale);
  const opacity0 = 0.75 + 0.15 * scale;
  return gsap.timeline().add(
    (() => {
      const ring = ns('circle');
      ring.setAttribute('cx', String(at.x));
      ring.setAttribute('cy', String(at.y));
      ring.setAttribute('r', '4');
      ring.setAttribute('fill', style.accentColor);
      ring.setAttribute('stroke', style.accentColor);
      ring.setAttribute('stroke-width', '4');
      ring.setAttribute('opacity', String(opacity0));
      parent.appendChild(ring);
      return gsap.to(ring, {
        attr: { r: maxR },
        opacity: 0,
        duration,
        ease: 'power2.out',
      });
      // GSAP nests returned tweens; Callback type is void-only in @types/gsap.
    }) as () => void,
  );
}

const easePower3In = gsap.parseEase('power3.in');

function lerpPoint(a: ArtilleryPoint, b: ArtilleryPoint, t: number): ArtilleryPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * One shell streak: quick fade-in, trail grows, head accelerates in (power3.in).
 */
function directStreakSegment(
  root: SVGGElement,
  from: ArtilleryPoint,
  to: ArtilleryPoint,
  style: ArtilleryProjectileStyle,
  durationScale: number,
  impactScale = 0.55,
): gsap.core.Timeline {
  const fadeInLinear = 0.09;
  const growFullLinear = 0.42;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const pathLen = Math.hypot(dx, dy) || 1;
  const ux = dx / pathLen;
  const uy = dy / pathLen;
  const maxTrail = Math.min(28, pathLen * 0.92);

  const streak = ns('line');
  streak.setAttribute('x1', String(from.x));
  streak.setAttribute('y1', String(from.y));
  streak.setAttribute('x2', String(from.x));
  streak.setAttribute('y2', String(from.y));
  streak.setAttribute('stroke', style.color);
  streak.setAttribute('stroke-width', String(style.streakWidth * (0.85 + 0.15 * impactScale)));
  streak.setAttribute('stroke-linecap', 'round');
  streak.setAttribute('opacity', '0');
  root.appendChild(streak);

  const flight = style.duration * 0.42 * durationScale;
  const linear = { t: 0 };
  const tl = gsap.timeline();

  tl.to(linear, {
    t: 1,
    duration: flight,
    ease: 'none',
    onUpdate: (): void => {
      const w = linear.t;
      const move = easePower3In(w);
      const head = lerpPoint(from, to, move);

      const growT = Math.min(1, w / growFullLinear);
      const trailLen = maxTrail * (1 - (1 - growT) * (1 - growT));

      let tailX = head.x - ux * trailLen;
      let tailY = head.y - uy * trailLen;
      const along = (head.x - from.x) * ux + (head.y - from.y) * uy;
      if (trailLen > along) {
        tailX = from.x;
        tailY = from.y;
      }

      streak.setAttribute('x1', String(tailX));
      streak.setAttribute('y1', String(tailY));
      streak.setAttribute('x2', String(head.x));
      streak.setAttribute('y2', String(head.y));

      const opacity = Math.min(1, w / fadeInLinear);
      streak.setAttribute('opacity', String(opacity));
    },
  })
    .to(streak, { opacity: 0, duration: 0.045 }, '-=0.015')
    .add(impactRing(root, to, { ...style, impactDuration: style.impactDuration * 1.05 }, impactScale));
  return tl;
}

const SHELL_COUNT = 6;
const DEFAULT_HEX_RADIUS = 120;

/** Non-sequential order across the fan (shell indices 0 = left … 5 = right). */
const FIRE_ORDER_SHUFFLE: readonly number[] = [5, 2, 4, 0, 3, 1];

function hexFanShellEndpoints(
  shellIndex: number,
  c: ArtilleryPoint,
  R: number,
): { from: ArtilleryPoint; impact: ArtilleryPoint } {
  const t = SHELL_COUNT > 1 ? shellIndex / (SHELL_COUNT - 1) : 0;
  const spread = (t - 0.5) * R * 1.15;
  const impact: ArtilleryPoint = { x: c.x + spread, y: c.y + R * 0.28 };
  const from: ArtilleryPoint = { x: c.x + spread * 0.88, y: c.y - R * 2.12 };
  return { from, impact };
}

/** Mirror Y across horizontal line through center so streak direction matches screen after board Y-flip. */
function mirrorFanYAcrossCenter(
  c: ArtilleryPoint,
  from: ArtilleryPoint,
  impact: ArtilleryPoint,
): { from: ArtilleryPoint; impact: ArtilleryPoint } {
  return {
    from: { x: from.x, y: 2 * c.y - from.y },
    impact: { x: impact.x, y: 2 * c.y - impact.y },
  };
}

function buildHexFanShuffleTimeline(
  root: SVGGElement,
  c: ArtilleryPoint,
  R: number,
  style: ArtilleryProjectileStyle,
  mirrorFanY: boolean,
): gsap.core.Timeline {
  const stagger = 0.072;
  const tl = gsap.timeline();
  FIRE_ORDER_SHUFFLE.forEach((shellIndex, step) => {
    let { from, impact } = hexFanShellEndpoints(shellIndex, c, R);
    if (mirrorFanY) {
      ({ from, impact } = mirrorFanYAcrossCenter(c, from, impact));
    }
    tl.add(directStreakSegment(root, from, impact, style, 0.4, 0.52), step * stagger);
  });
  return tl;
}

export interface PlayDefenderHexBarrageOptions {
  center: ArtilleryPoint;
  hexRadius?: number;
  styleOverrides?: Partial<ArtilleryProjectileStyle>;
  /** Target layer (e.g. `#vfx-layer`); required. */
  parent: SVGGElement;
  onComplete?: () => void;
  /**
   * Mirror shell fan across the horizontal through `center` (swap vertical offset of from/impact).
   * Use when the board is drawn with a parent Y-flip (vs-human guest) so shells still read as arriving from above.
   */
  mirrorFanY?: boolean;
}

export interface ArtilleryProjectileHandle {
  cancel: () => void;
  timeline: gsap.core.Timeline;
}

/**
 * Six shell streaks on the defender hex (shuffled fan salvo, theme reds). Removes DOM on finish or cancel.
 */
export function playDefenderHexBarrage(options: PlayDefenderHexBarrageOptions): ArtilleryProjectileHandle {
  const {
    center,
    hexRadius = DEFAULT_HEX_RADIUS,
    styleOverrides,
    parent,
    onComplete,
    mirrorFanY = false,
  } = options;

  const root = ns('g');
  root.setAttribute('class', 'artillery-hex-barrage-vfx');
  parent.appendChild(root);

  const tl = buildHexFanShuffleTimeline(root, center, hexRadius, mergeStyle(styleOverrides), mirrorFanY);

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
