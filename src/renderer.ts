import gsap from 'gsap';
import { playDefenderHexBarrage } from './artilleryProjectileVfx';
import type { ArtilleryProjectileHandle } from './artilleryProjectileVfx';
import { hexToPixel, hexPoints, hexFillPoints, HEX_SIZE, getNeighbors } from './hex';
import {
  COLS,
  ROWS,
  PLAYER,
  AI,
  getUnit,
  getUnitById,
  hasHomeProductionAccess,
  isValidProductionPlacement,
  getValidMoves,
  getRangedAttackTargets,
  isInEnemyZoC,
  getOpponentHomeGuardBlockedHexes,
  getBreakthroughDefenderOwner,
} from './game';
import type { Owner } from './types';
import type { GameState, HexState, Unit } from './types';
import config from './gameconfig';
import mountainHex01 from '../public/images/misc/mountain-hex/mountain-01.png';
import mountainHex02 from '../public/images/misc/mountain-hex/mountain-02.png';
import mountainHex03 from '../public/images/misc/mountain-hex/mountain-03.png';
import mountainHex04 from '../public/images/misc/mountain-hex/mountain-04.png';
import mountainHex05 from '../public/images/misc/mountain-hex/mountain-05.png';
import mountainHex06 from '../public/images/misc/mountain-hex/mountain-06.png';
import mountainHex07 from '../public/images/misc/mountain-hex/mountain-07.png';
import { riverSegmentDisplay } from './rivers';

const MOUNTAIN_HEX_TEXTURES = [mountainHex01, mountainHex02, mountainHex03, mountainHex04, mountainHex05, mountainHex06, mountainHex07] as const;

/** Stable pseudo-random pick so each mountain hex keeps the same art across re-renders. */
function mountainHexTextureUrl(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return MOUNTAIN_HEX_TEXTURES[h % MOUNTAIN_HEX_TEXTURES.length];
}

/** Same hex fill mapping as conquered cells (`localPlayer` = “your” palette). */
function hexTerrainFillForOwner(owner: Owner, localPlayer: Owner, c: Colors): string {
  return owner === localPlayer ? c.hexPlayer : c.hexAi;
}

function hexTerrainDimmedFillForOwner(owner: Owner, localPlayer: Owner, c: Colors): string {
  return owner === localPlayer ? c.hexPlayerDimmed : c.hexAiDimmed;
}

/** Resolved mountain tint faction (visual-only). */
type MountainTerritoryCategory = 'p1' | 'p2' | 'neutral';

/**
 * Strict plurality: the side with the highest count wins.
 * Two-way ties (e.g. 3–3–0) → neutral. Three-way tie (e.g. 2–2–2): keep `prev` if it is p1/p2, else stable pick by `key`.
 */
function mountainTerritoryCategoryFromCounts(
  nP1: number,
  nP2: number,
  nNeutral: number,
  opts?: { prev?: MountainTerritoryCategory; key?: string },
): MountainTerritoryCategory {
  const max = Math.max(nP1, nP2, nNeutral);
  const tieCount = (nP1 === max ? 1 : 0) + (nP2 === max ? 1 : 0) + (nNeutral === max ? 1 : 0);
  if (tieCount === 1) {
    if (nP1 === max) return 'p1';
    if (nP2 === max) return 'p2';
    return 'neutral';
  }
  if (tieCount === 3) {
    const prev = opts?.prev;
    if (prev === 'p1' || prev === 'p2') return prev;
    const key = opts?.key;
    if (key) {
      let h = 0;
      for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
      return h % 2 === 0 ? 'p1' : 'p2';
    }
    return 'p1';
  }
  return 'neutral';
}

function countMountainNeighborSides(
  state: GameState,
  col: number,
  row: number,
  mountainSet: Set<string>,
  mountainCategory: Map<string, MountainTerritoryCategory>,
): { nP1: number; nP2: number; nNeutral: number } {
  let nP1 = 0;
  let nP2 = 0;
  let nNeutral = 0;
  for (const [nc, nr] of getNeighbors(col, row, COLS, ROWS)) {
    const nk = `${nc},${nr}`;
    if (mountainSet.has(nk)) {
      const mc = mountainCategory.get(nk) ?? 'neutral';
      if (mc === 'p1') nP1 += 1;
      else if (mc === 'p2') nP2 += 1;
      else nNeutral += 1;
      continue;
    }
    const hs = state.hexStates[nk];
    if (!hs) nNeutral += 1;
    else if (hs.owner === PLAYER) nP1 += 1;
    else nP2 += 1;
  }
  return { nP1, nP2, nNeutral };
}

/**
 * Same plurality + ridge propagation as mountain tints: used for fill colors and conquest/domi frontlines.
 */
function resolveMountainTerritoryCategoryByKey(
  state: GameState,
  mountainSet: Set<string>,
): Map<string, MountainTerritoryCategory> {
  const out = new Map<string, MountainTerritoryCategory>();
  if (mountainSet.size === 0) return out;

  const keys = [...mountainSet];
  const passableOnly = new Map<string, MountainTerritoryCategory>();
  for (const key of keys) {
    const [col, row] = key.split(',').map(Number);
    let nP1 = 0;
    let nP2 = 0;
    let nNeutral = 0;
    for (const [nc, nr] of getNeighbors(col, row, COLS, ROWS)) {
      const nk = `${nc},${nr}`;
      if (mountainSet.has(nk)) continue;
      const hs = state.hexStates[nk];
      if (!hs) nNeutral += 1;
      else if (hs.owner === PLAYER) nP1 += 1;
      else nP2 += 1;
    }
    passableOnly.set(key, mountainTerritoryCategoryFromCounts(nP1, nP2, nNeutral, { key }));
  }

  let prev = passableOnly;
  const MAX_ITER = 64;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const next = new Map<string, MountainTerritoryCategory>();
    for (const key of keys) {
      const [col, row] = key.split(',').map(Number);
      const { nP1, nP2, nNeutral } = countMountainNeighborSides(state, col, row, mountainSet, prev);
      next.set(key, mountainTerritoryCategoryFromCounts(nP1, nP2, nNeutral, { prev: prev.get(key), key }));
    }
    let stable = true;
    for (const key of keys) {
      if (prev.get(key) !== next.get(key)) {
        stable = false;
        break;
      }
    }
    if (stable) break;
    prev = next;
  }

  for (const key of keys) {
    out.set(key, prev.get(key) ?? 'neutral');
  }
  return out;
}

/**
 * Visual-only mountain tints: majority per hex (two-way ties → neutral; three-way 2–2–2 keeps a side); adjacent mountains contribute their
 * **current** resolved category so color propagates along ridges (Jacobi iteration to fixed point).
 * Production focus uses the same dimmed player/AI hex colors as owned territory in {@link renderState}.
 */
function computeMountainTerritoryFillByKey(
  state: GameState,
  mountainSet: Set<string>,
  localPlayer: Owner,
  c: Colors,
  productionFocusHexes: Set<string>,
  unitByHex: Map<string, Unit>,
  mtnCategoryByKey?: Map<string, MountainTerritoryCategory>,
): Map<string, string> {
  const out = new Map<string, string>();
  const categoryMap = mtnCategoryByKey ?? resolveMountainTerritoryCategoryByKey(state, mountainSet);
  if (categoryMap.size === 0) return out;

  const keys = [...mountainSet];
  for (const key of keys) {
    const cat = categoryMap.get(key) ?? 'neutral';
    const ownerForTint: Owner | null = cat === 'p1' ? PLAYER : cat === 'p2' ? AI : null;
    const hexOccupied = unitByHex.has(key);
    const mountainDimmed =
      productionFocusHexes.size > 0 &&
      state.phase === 'production' &&
      state.activePlayer === localPlayer &&
      ownerForTint != null &&
      (!productionFocusHexes.has(key) || hexOccupied);
    const fill =
      ownerForTint == null
        ? c.hexNeutral
        : mountainDimmed
          ? hexTerrainDimmedFillForOwner(ownerForTint, localPlayer, c)
          : hexTerrainFillForOwner(ownerForTint, localPlayer, c);
    out.set(key, fill);
  }
  return out;
}

/** Margin in px between SVG edge and board origin (must match {@link initRenderer}). */
export const BOARD_MARGIN = 100;

/** Vertical midpoint of hex *centers* in board-local space (used for vs-human guest view flip). */
export function boardCenterY(): number {
  return (HEX_SIZE * 1.5 * (ROWS - 1)) / 2;
}

/** Horizontal midpoint of hex *centers* in board-local space (vs-human guest view flip). */
export function boardCenterX(): number {
  let minX = Infinity;
  let maxX = -Infinity;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = hexToPixel(c, r).x;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  return (minX + maxX) / 2;
}

/**
 * Vs-human guest: reflect the board through the center so the northern home row reads toward the
 * bottom of the screen and left/right match a full horizontal + vertical flip (same idea as
 * defender map mirroring in solo / custom matches).
 */
export function boardViewFlipTransform(): string {
  const xMid = boardCenterX();
  const yMid = boardCenterY();
  return `translate(${xMid},${yMid}) scale(-1,-1) translate(${-xMid},${-yMid})`;
}

function getBoardViewRoot(svg: SVGSVGElement): SVGGElement | null {
  return svg.querySelector('#board-view-root') as SVGGElement | null;
}

/** Parent for VFX/anim layers: under `#board-view-root` when present so they share margin + flip. */
function getBoardVfxParent(svg: SVGSVGElement): SVGElement {
  return getBoardViewRoot(svg) ?? svg;
}

/**
 * SVG paint order: insert `#anim-layer` before `#unit-layer` so static units draw on top, or
 * before `#hex-hit-layer` so the animated attacker draws above units but under invisible hits.
 */
function positionAnimLayer(svgElement: SVGSVGElement, aboveStaticUnits: boolean): SVGGElement {
  const parent = getBoardVfxParent(svgElement);
  let animLayer = svgElement.querySelector('#anim-layer') as SVGGElement | null;
  if (!animLayer) {
    animLayer = svgEl('g');
    animLayer.id = 'anim-layer';
    animLayer.setAttribute('pointer-events', 'none');
  }
  const unitLayer = parent.querySelector('#unit-layer');
  const hexHitLayer = parent.querySelector('#hex-hit-layer');
  if (aboveStaticUnits) {
    if (hexHitLayer) parent.insertBefore(animLayer, hexHitLayer);
    else parent.appendChild(animLayer);
  } else {
    if (unitLayer) parent.insertBefore(animLayer, unitLayer);
    else parent.appendChild(animLayer);
  }
  return animLayer;
}

/** Default stack: anim layer between units and hex hits (empty layer is harmless). */
function resetAnimLayerStackOrder(svgElement: SVGSVGElement): void {
  positionAnimLayer(svgElement, true);
}

/** Hover move-path preview timeline (legacy; chevron train uses SMIL + CSS). */
let movePathPreviewTl: gsap.core.Timeline | null = null;

/** Chevron shape; timing scales with path length so spacing feels even (proposal 23 family). */
const MOVE_PATH_CHEVRON_POINTS = '-20,-10 -6,-10 3,0 -6,10 -20,10 -10,0';
/** Chevrons per hex edge along the route (1 hex step → this many; 2 steps → 2×, etc.). */
const MOVE_PATH_CHEVRONS_PER_HEX_STEP = 2;
/** Phase gap between consecutive chevrons; one loop duration = chevronCount × this. */
const MOVE_PATH_CHEVRON_STAGGER_SEC = 0.4;

export interface MoveAnimation {
  unit: Unit;      // snapshot of the unit before moving (owner/hp for colour)
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
  /** Hex centers from start to destination (inclusive); if omitted, falls back to a straight segment (e.g. old sync). Player and AI both pass this from getMovePath. */
  pathHexes?: [number, number][];
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/** Last committed game HP we showed (per unit); used to detect changes and drive bar animation. */
let lastRenderedGameHp = new Map<number, number>();
/** In-flight HP bar tweens: visual HP lerps from fromHp → toHp. */
let hpBarAnim = new Map<number, { fromHp: number; toHp: number; maxHp: number; startMs: number }>();
let boardRenderCallback: (() => void) | null = null;
let hpBarRafScheduled = false;

/** Runs after `#board` unit layer paints so hover classes can be applied on the next frame (CSS transitions). */
let boardPostPaintCallback: (() => void) | null = null;
let boardPostPaintRaf = 0;

type PerfSection =
  | 'render.total'
  | 'render.productionEligibility'
  | 'render.hexPass'
  | 'render.unitsPass';

interface PerfBucket {
  count: number;
  totalMs: number;
  maxMs: number;
}

const perfBuckets = new Map<PerfSection, PerfBucket>();
let perfLastFlushMs = 0;

function perfEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const qs = new URLSearchParams(window.location.search);
  return qs.get('perf') === '1';
}

function perfRecord(section: PerfSection, ms: number): void {
  if (!perfEnabled()) return;
  const prev = perfBuckets.get(section) ?? { count: 0, totalMs: 0, maxMs: 0 };
  prev.count += 1;
  prev.totalMs += ms;
  prev.maxMs = Math.max(prev.maxMs, ms);
  perfBuckets.set(section, prev);
}

function perfMaybeFlush(): void {
  if (!perfEnabled()) return;
  const now = performance.now();
  if (now - perfLastFlushMs < 2000) return;
  perfLastFlushMs = now;
  for (const [section, b] of perfBuckets) {
    if (b.count === 0) continue;
    const avg = b.totalMs / b.count;
    console.log(`[perf] ${section}: avg=${avg.toFixed(2)}ms max=${b.maxMs.toFixed(2)}ms samples=${b.count}`);
  }
  perfBuckets.clear();
}

/** Wire the main board redraw (e.g. `() => render()`) so HP bars can tick after damage/healing. */
export function setBoardRenderCallback(cb: (() => void) | null): void {
  boardRenderCallback = cb;
}

/** Wire post-paint work for the main board (e.g. pointer-hover class toggles). */
export function setBoardPostPaintCallback(cb: (() => void) | null): void {
  boardPostPaintCallback = cb;
}

/**
 * Schedule {@link setBoardPostPaintCallback} for the next animation frame (coalesced).
 * Used after repainting units and on pointer moves so hover styles can transition from a real baseline.
 */
export function queueBoardUnitPointerHoverApply(): void {
  if (boardPostPaintRaf !== 0) return;
  boardPostPaintRaf = requestAnimationFrame(() => {
    boardPostPaintRaf = 0;
    boardPostPaintCallback?.();
  });
}

function scheduleHpBarFrame(): void {
  if (hpBarRafScheduled || !boardRenderCallback) return;
  hpBarRafScheduled = true;
  requestAnimationFrame(() => {
    hpBarRafScheduled = false;
    boardRenderCallback!();
  });
}

function clearHpBarAnimationState(): void {
  lastRenderedGameHp.clear();
  hpBarAnim.clear();
}

/** Visual HP for bar + color tiers (may differ from `unit.hp` while animating). */
export function getBoardVisualHp(unit: Unit, now: number = performance.now()): number {
  return visualHpForUnit(unit, now);
}

function visualHpForUnit(unit: Unit, now: number): number {
  const anim = hpBarAnim.get(unit.id);
  if (!anim) return unit.hp;
  const dur = config.hpBarAnimDurationMs;
  const t = dur <= 0 ? 1 : Math.min(1, (now - anim.startMs) / dur);
  const hp = anim.fromHp + (anim.toHp - anim.fromHp) * easeOutQuad(t);
  if (t >= 1) {
    hpBarAnim.delete(unit.id);
    lastRenderedGameHp.set(unit.id, unit.hp);
  }
  return Math.max(0, hp);
}

function syncHpBarAnimState(state: GameState, now: number): void {
  const alive = new Set(state.units.map(u => u.id));
  for (const id of lastRenderedGameHp.keys()) {
    if (!alive.has(id)) lastRenderedGameHp.delete(id);
  }
  for (const id of hpBarAnim.keys()) {
    if (!alive.has(id)) hpBarAnim.delete(id);
  }

  const dur = config.hpBarAnimDurationMs;

  for (const unit of state.units) {
    const existing = hpBarAnim.get(unit.id);
    if (existing) {
      if (existing.toHp !== unit.hp) {
        const t = dur <= 0 ? 1 : Math.min(1, (now - existing.startMs) / dur);
        const fromVisual =
          existing.fromHp + (existing.toHp - existing.fromHp) * easeOutQuad(t);
        hpBarAnim.set(unit.id, {
          fromHp: fromVisual,
          toHp: unit.hp,
          maxHp: unit.maxHp,
          startMs: now,
        });
      }
      continue;
    }
    const prev = lastRenderedGameHp.get(unit.id);
    if (prev === undefined) {
      lastRenderedGameHp.set(unit.id, unit.hp);
    } else if (prev !== unit.hp) {
      hpBarAnim.set(unit.id, {
        fromHp: prev,
        toHp: unit.hp,
        maxHp: unit.maxHp,
        startMs: now,
      });
    }
  }

  let anyInProgress = false;
  for (const [, anim] of hpBarAnim) {
    if (dur > 0 && now - anim.startMs < dur) {
      anyInProgress = true;
      break;
    }
  }
  if (anyInProgress) scheduleHpBarFrame();
}

/** Position at fraction `t01` (0–1) of total arc length along the polyline. */
function positionOnPolyline(points: { x: number; y: number }[], t01: number): { x: number; y: number } {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0]!;
  const t = Math.min(1, Math.max(0, t01));
  const segLens: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1]!.x - points[i]!.x;
    const dy = points[i + 1]!.y - points[i]!.y;
    const seg = Math.hypot(dx, dy);
    segLens.push(seg);
    total += seg;
  }
  if (total <= 0) return points[points.length - 1]!;
  let targetDist = t * total;
  for (let i = 0; i < segLens.length; i++) {
    const seg = segLens[i]!;
    if (targetDist <= seg) {
      const ratio = seg === 0 ? 0 : targetDist / seg;
      return {
        x: points[i]!.x + (points[i + 1]!.x - points[i]!.x) * ratio,
        y: points[i]!.y + (points[i + 1]!.y - points[i]!.y) * ratio,
      };
    }
    targetDist -= seg;
  }
  return points[points.length - 1]!;
}

function pixelPathForAnimation(anim: MoveAnimation): { x: number; y: number }[] {
  if (anim.pathHexes && anim.pathHexes.length >= 2) {
    return anim.pathHexes.map(([c, r]) => hexToPixel(c, r));
  }
  return [hexToPixel(anim.fromCol, anim.fromRow), hexToPixel(anim.toCol, anim.toRow)];
}

function unitIcon(unitTypeId: string): string | undefined {
  return config.unitTypes.find(t => t.id === unitTypeId)?.icon;
}

interface IconDef { viewBox: number; mode: 'stroke' | 'fill'; paths: string[]; }

const iconDefsCache: Record<string, IconDef> = {};

export async function loadIconDefs(iconPaths: string[]): Promise<void> {
  const unique = [...new Set(iconPaths.filter((p): p is string => !!p))];
  await Promise.all(unique.map(async (iconPath) => {
    if (iconDefsCache[iconPath]) return;
    try {
      const res = await fetch(`${iconPath}`);
      const text = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'image/svg+xml');
      const svgRoot = doc.querySelector('svg');
      if (!svgRoot) return;
      const vb = svgRoot.getAttribute('viewBox')?.split(/[\s,]+/).map(Number) ?? [];
      const viewBox = vb.length >= 3 ? vb[2] : 48;
      const pathEls = Array.from(doc.querySelectorAll('path'));
      const paths = pathEls.map(p => p.getAttribute('d')).filter((d): d is string => !!d);
      const mode: 'fill' | 'stroke' = pathEls.some(p => {
        const s = p.getAttribute('stroke');
        return !!s && s !== 'none';
      }) && !pathEls.some(p => {
        const f = p.getAttribute('fill');
        return !!f && f !== 'none';
      }) ? 'stroke' : 'fill';
      iconDefsCache[iconPath] = { viewBox, mode, paths };
    } catch (e) {
      console.warn(`[renderer] Failed to load icon: ${iconPath}`, e);
    }
  }));
}

function inlineIcon(iconSrc: string | undefined, x: number, y: number, size: number, color: string, opacity: string): SVGGElement | null {
  if (!iconSrc) return null;
  const def = iconDefsCache[iconSrc];
  if (!def) return null;
  const scale = size / def.viewBox;
  const g = svgEl('g');
  g.setAttribute('transform', `translate(${x - size / 2},${y - size / 2}) scale(${scale})`);
  if (def.mode === 'fill') {
    g.setAttribute('fill', color);
    g.setAttribute('stroke', 'none');
  } else {
    g.setAttribute('fill', 'none');
    g.setAttribute('stroke', color);
    g.setAttribute('stroke-width', String(2 / scale));
    g.setAttribute('stroke-linecap', 'round');
    g.setAttribute('stroke-linejoin', 'round');
  }
  g.setAttribute('opacity', opacity);
  g.setAttribute('pointer-events', 'none');
  for (const d of def.paths) {
    const p = svgEl('path');
    p.setAttribute('d', d);
    g.appendChild(p);
  }
  return g;
}

// Corner-bracket dash params — one full cycle = one hex edge (HEX_SIZE)
const BRACKET     = 0.22;
const DASH        = HEX_SIZE * BRACKET * 2;
const GAP         = HEX_SIZE * (1 - BRACKET * 2);
const DASH_OFFSET = HEX_SIZE * BRACKET;

// CSS color variables — read once after DOM is ready, then cached
interface Colors {
  bg: string;
  player: string;
  ai: string;
  unitSelected: string;
  hexSelected: string;
  hexMove: string;
  hexPlayer: string;
  hexAi: string;
  hexPlayerDimmed: string;
  hexAiDimmed: string;
  hexCanPlace: string;
  hexProdSelected: string;
  hexZoc: string;
  hexNeutral: string;
  hexStroke: string;
  hexProdStroke: string;
  unitIconColor: string;
  moveBorder: string;
  hpHigh: string;
  hpMid: string;
  hpLow: string;
  hpTired: string;
  playerTired: string;
  aiTired: string;
  aiDuringProduction: string;
  rangedTarget: string;
  colorDark: string;
}

/** Local side uses theme `--color-player*`; opponent uses `--color-ai*` — same for P1 and P2 (no CSS guest swap). */
function paletteBaseForOwner(owner: Owner, localPlayer: Owner, c: Colors): string {
  return owner === localPlayer ? c.player : c.ai;
}

let C: Colors | null = null;

/** Call after theme CSS variables change so the next draw re-reads :root. */
export function invalidateColorsCache(): void {
  C = null;
}

function colors(): Colors {
  if (C) return C;
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(n).trim();
  C = {
    bg:              v('--color-bg'),
    player:          v('--color-player'),
    ai:              v('--color-ai'),
    unitSelected:    v('--color-unit-selected'),
    hexSelected:     v('--color-hex-selected'),
    hexMove:         v('--color-hex-valid-move'),
    hexPlayer:       v('--color-hex-player'),
    hexAi:           v('--color-hex-ai'),
    hexPlayerDimmed: v('--color-hex-player-dimmed'),
    hexAiDimmed:     v('--color-hex-ai-dimmed'),
    hexCanPlace:     v('--color-hex-can-place'),
    hexProdSelected: v('--color-hex-prod-selected'),
    hexZoc:          v('--color-hex-zoc'),
    hexNeutral:      v('--color-hex-neutral'),
    hexStroke:       v('--color-hex-stroke'),
    hexProdStroke:   v('--color-hex-prod-stroke'),
    unitIconColor:   v('--color-unit-icon'),
    moveBorder:      v('--color-move-border'),
    hpHigh:          v('--color-hp-high'),
    hpMid:           v('--color-hp-mid'),
    hpLow:           v('--color-hp-low'),
    hpTired:         v('--color-hp-tired'),
    playerTired:     v('--color-player-tired'),
    aiTired:         v('--color-ai-tired'),
    aiDuringProduction: v('--color-ai-during-production'),
    rangedTarget:    v('--color-red-700'),
    colorDark:       v('--color-dark'),
  };
  return C;
}

// Neighbor direction → edge index mapping (edge i spans vertex i to vertex (i+1)%6).
// Vertex i sits at angle (60*i − 30)° in pointy-top orientation (y-axis down).
//   Edge 0 (v0–v1): right (E)        Edge 3 (v3–v4): left (W)
//   Edge 1 (v1–v2): lower-right (SE) Edge 4 (v4–v5): upper-left (NW)
//   Edge 2 (v2–v3): lower-left (SW)  Edge 5 (v5–v0): upper-right (NE)
const DIRS_EVEN: [number, number][] = [[1,0],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1]]; // even rows
const DIRS_ODD:  [number, number][] = [[1,0],[1,1],[0,1],[-1,0],[0,-1],[1,-1]];   // odd rows

// Build an SVG path `d` tracing only the outer boundary of a set of hexes.
// Each boundary edge (where a neighbor is outside the set) is emitted as M…L.
function buildBoundaryPath(hexSet: Set<string>): string {
  if (hexSet.size === 0) return '';
  let d = '';
  for (const key of hexSet) {
    const [c, r] = key.split(',').map(Number);
    const { x, y } = hexToPixel(c, r);
    const dirs = r % 2 === 0 ? DIRS_EVEN : DIRS_ODD;
    for (let i = 0; i < 6; i++) {
      const [dc, dr] = dirs[i];
      if (!hexSet.has(`${c + dc},${r + dr}`)) {
        const a1 = (Math.PI / 180) * (60 * i - 30);
        const a2 = (Math.PI / 180) * (60 * (i + 1) - 30);
        const x1 = (x + HEX_SIZE * Math.cos(a1)).toFixed(2);
        const y1 = (y + HEX_SIZE * Math.sin(a1)).toFixed(2);
        const x2 = (x + HEX_SIZE * Math.cos(a2)).toFixed(2);
        const y2 = (y + HEX_SIZE * Math.sin(a2)).toFixed(2);
        d += `M${x1},${y1}L${x2},${y2}`;
      }
    }
  }
  return d;
}

/** Unit-length segments on the outer boundary of the full playable grid (same edge dirs as {@link buildBoundaryPath}). */
function collectBoardOuterPerimeterSegments(cols: number, rows: number): { x1: number; y1: number; x2: number; y2: number }[] {
  const segs: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const { x, y } = hexToPixel(c, r);
      const dirs = r % 2 === 0 ? DIRS_EVEN : DIRS_ODD;
      for (let i = 0; i < 6; i++) {
        const [dc, dr] = dirs[i]!;
        const nc = c + dc;
        const nr = r + dr;
        if (nc >= 0 && nc < cols && nr >= 0 && nr < rows) continue;
        const a1 = (Math.PI / 180) * (60 * i - 30);
        const a2 = (Math.PI / 180) * (60 * (i + 1) - 30);
        segs.push({
          x1: x + HEX_SIZE * Math.cos(a1),
          y1: y + HEX_SIZE * Math.sin(a1),
          x2: x + HEX_SIZE * Math.cos(a2),
          y2: y + HEX_SIZE * Math.sin(a2),
        });
      }
    }
  }
  return segs;
}

/** Merge boundary segments into one closed ring so stroke dashes run continuously around the board. */
function chainEdgeSegmentsToClosedPath(
  segments: { x1: number; y1: number; x2: number; y2: number }[],
): string {
  if (segments.length === 0) return '';
  const q = (n: number) => Math.round(n * 100) / 100;
  const key = (x: number, y: number) => `${q(x)},${q(y)}`;
  type P = { x: number; y: number };
  const neighbors = new Map<string, string[]>();
  const coords = new Map<string, P>();
  function addEdge(a: P, b: P): void {
    const ka = key(a.x, a.y);
    const kb = key(b.x, b.y);
    if (ka === kb) return;
    coords.set(ka, a);
    coords.set(kb, b);
    if (!neighbors.has(ka)) neighbors.set(ka, []);
    if (!neighbors.has(kb)) neighbors.set(kb, []);
    neighbors.get(ka)!.push(kb);
    neighbors.get(kb)!.push(ka);
  }
  for (const s of segments) {
    addEdge({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
  }
  const sortedKeys = [...coords.keys()].sort((a, b) => {
    const [ax, ay] = a.split(',').map(Number);
    const [bx, by] = b.split(',').map(Number);
    if (ay !== by) return ay - by;
    return ax - bx;
  });
  const start = sortedKeys[0]!;
  const pathPts: P[] = [];
  let prev = '';
  let curr = start;
  const maxIter = segments.length * 3 + 10;
  for (let iter = 0; iter < maxIter; iter++) {
    pathPts.push(coords.get(curr)!);
    let nbrs = (neighbors.get(curr) ?? []).filter((n) => n !== prev);
    nbrs = [...new Set(nbrs)].sort();
    if (nbrs.length === 0) break;
    const next = nbrs[0]!;
    if (next === start && pathPts.length > 1) break;
    prev = curr;
    curr = next;
  }
  if (pathPts.length < 3) return '';
  let d = `M${pathPts[0]!.x.toFixed(2)},${pathPts[0]!.y.toFixed(2)}`;
  for (let i = 1; i < pathPts.length; i++) {
    d += `L${pathPts[i]!.x.toFixed(2)},${pathPts[i]!.y.toFixed(2)}`;
  }
  d += 'Z';
  return d;
}

function buildBoardOuterHexPath(cols: number, rows: number): string {
  const segs = collectBoardOuterPerimeterSegments(cols, rows);
  return chainEdgeSegmentsToClosedPath(segs);
}

/** Lexicographic order on (row, col) so edge dedup works for col ≥ 10. */
function hexKeyLess(a: string, b: string): boolean {
  const [ac, ar] = a.split(',').map(Number);
  const [bc, br] = b.split(',').map(Number);
  if (ar !== br) return ar < br;
  return ac < bc;
}

function appendHexEdgeToPath(
  d: string,
  x: number,
  y: number,
  edgeIndex: number,
): string {
  const a1 = (Math.PI / 180) * (60 * edgeIndex - 30);
  const a2 = (Math.PI / 180) * (60 * (edgeIndex + 1) - 30);
  const x1 = (x + HEX_SIZE * Math.cos(a1)).toFixed(2);
  const y1 = (y + HEX_SIZE * Math.sin(a1)).toFixed(2);
  const x2 = (x + HEX_SIZE * Math.cos(a2)).toFixed(2);
  const y2 = (y + HEX_SIZE * Math.sin(a2)).toFixed(2);
  return d + `M${x1},${y1}L${x2},${y2}`;
}

/** Edges between hexes whose sectors have different political owners (attacker vs defender). */
function buildInterSectorBoundaryPath(
  sectorIndexByHex: Record<string, number>,
  sectorOwners: Owner[],
  cols: number,
  rows: number,
): string {
  let d = '';
  for (const key of Object.keys(sectorIndexByHex)) {
    const sid = sectorIndexByHex[key]!;
    const [c, r] = key.split(',').map(Number);
    const { x, y } = hexToPixel(c, r);
    const dirs = r % 2 === 0 ? DIRS_EVEN : DIRS_ODD;
    for (let i = 0; i < 6; i++) {
      const [dc, dr] = dirs[i]!;
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const nk = `${nc},${nr}`;
      const nid = sectorIndexByHex[nk];
      if (nid === undefined || nid === sid) continue;
      if (sectorOwners[sid] === sectorOwners[nid]) continue;
      if (!hexKeyLess(key, nk)) continue;
      d = appendHexEdgeToPath(d, x, y, i);
    }
  }
  return d;
}

/** P1 / P2 for passable owned hex; same from {@link resolveMountainTerritoryCategoryByKey} for mountains. */
function effectiveTerritoryOwnerAt(
  key: string,
  hexStates: Record<string, { owner: Owner }>,
  mountainSet: Set<string>,
  mtnCategory: Map<string, MountainTerritoryCategory>,
): Owner | null {
  if (mountainSet.has(key)) {
    const cat = mtnCategory.get(key) ?? 'neutral';
    if (cat === 'p1') return PLAYER;
    if (cat === 'p2') return AI;
    return null;
  }
  const hs = hexStates[key];
  return hs ? hs.owner : null;
}

/** Edges where adjacent cells resolve to different factions (passable ownership + mountain tint categories). */
function buildInterFactionBoundaryPath(
  hexStates: Record<string, { owner: Owner }>,
  mountainSet: Set<string>,
  mtnCategory: Map<string, MountainTerritoryCategory>,
  cols: number,
  rows: number,
): string {
  let d = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const key = `${c},${r}`;
      const a = effectiveTerritoryOwnerAt(key, hexStates, mountainSet, mtnCategory);
      const { x, y } = hexToPixel(c, r);
      const dirs = r % 2 === 0 ? DIRS_EVEN : DIRS_ODD;
      for (let i = 0; i < 6; i++) {
        const [dc, dr] = dirs[i]!;
        const nc = c + dc;
        const nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const nk = `${nc},${nr}`;
        if (!hexKeyLess(key, nk)) continue;
        const b = effectiveTerritoryOwnerAt(nk, hexStates, mountainSet, mtnCategory);
        if (a == null || b == null || a === b) continue;
        d = appendHexEdgeToPath(d, x, y, i);
      }
    }
  }
  return d;
}

/** Edges between two different sectors both still held by the defender. */
function buildDefenderOnlySectorBoundaryPath(
  sectorIndexByHex: Record<string, number>,
  sectorOwners: Owner[],
  cols: number,
  rows: number,
  defenderOwner: Owner,
): string {
  let d = '';
  for (const key of Object.keys(sectorIndexByHex)) {
    const sid = sectorIndexByHex[key]!;
    const [c, r] = key.split(',').map(Number);
    const { x, y } = hexToPixel(c, r);
    const dirs = r % 2 === 0 ? DIRS_EVEN : DIRS_ODD;
    for (let i = 0; i < 6; i++) {
      const [dc, dr] = dirs[i]!;
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const nk = `${nc},${nr}`;
      const nid = sectorIndexByHex[nk];
      if (nid === undefined || nid === sid) continue;
      if (sectorOwners[sid] !== defenderOwner || sectorOwners[nid] !== defenderOwner) continue;
      if (!hexKeyLess(key, nk)) continue;
      d = appendHexEdgeToPath(d, x, y, i);
    }
  }
  return d;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

/** Counter-flip upright content when the board is under {@link boardViewFlipTransform} (scale -1,-1). */
function svgUprightAt(x: number, y: number): SVGGElement {
  const g = svgEl('g');
  g.setAttribute('transform', `translate(${x},${y}) scale(-1,-1) translate(${-x},${-y})`);
  return g;
}

interface RenderDomCache {
  hexPolys: SVGPolygonElement[][];
  hexLayer: SVGGElement | null;
  unitLayer: SVGGElement | null;
  riverLayer: SVGGElement | null;
  mountainLayer: SVGGElement | null;
  controlPointLayer: SVGGElement | null;
  prodStrokeLayer: SVGGElement | null;
  sectorOutlineLayer: SVGGElement | null;
  markerLayer: SVGGElement | null;
  moveBoundary: SVGPathElement | null;
}

const renderDomCacheBySvg = new WeakMap<SVGSVGElement, RenderDomCache>();

export interface InitRendererOptions {
  /** When true (vs-human guest), mirror the board through its center (horizontal + vertical). */
  flipBoardY?: boolean;
}

export function initRenderer(svgElement: SVGSVGElement, options?: InitRendererOptions): void {
  svgElement.innerHTML = '';
  const flipBoardY = !!options?.flipBoardY;
  svgElement.dataset.boardFlipY = flipBoardY ? '1' : '';
  const c = colors();

  const boardMargin = BOARD_MARGIN;
  const W = COLS * HEX_SIZE * Math.sqrt(3) + boardMargin * 2;
  const H = 1.5 * HEX_SIZE * (ROWS - 1) + boardMargin * 2;

  svgElement.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svgElement.setAttribute('width', String(W));
  svgElement.setAttribute('height', String(H));
  svgElement.style.overflow = 'visible';

  const bg = svgEl('rect');
  bg.setAttribute('width', String(W));
  bg.setAttribute('height', String(H));
  bg.setAttribute('fill', 'transparent');
  svgElement.appendChild(bg);

  const boardOrigin = svgEl('g');
  boardOrigin.id = 'board-origin';
  boardOrigin.setAttribute('transform', `translate(${boardMargin},${boardMargin})`);

  const boardViewRoot = svgEl('g');
  boardViewRoot.id = 'board-view-root';
  if (flipBoardY) {
    boardViewRoot.setAttribute('transform', boardViewFlipTransform());
  }
  boardOrigin.appendChild(boardViewRoot);
  svgElement.appendChild(boardOrigin);

  const hexLayer = svgEl('g');
  hexLayer.id = 'hex-layer';
  boardViewRoot.appendChild(hexLayer);

  const boardPerimeterLayer = svgEl('g');
  boardPerimeterLayer.id = 'board-perimeter-layer';
  boardPerimeterLayer.setAttribute('pointer-events', 'none');
  const boardPerimeterPath = svgEl('path');
  boardPerimeterPath.classList.add('board-perimeter-outline');
  boardPerimeterPath.setAttribute('fill', 'none');
  boardPerimeterPath.setAttribute('d', buildBoardOuterHexPath(COLS, ROWS));
  boardPerimeterLayer.appendChild(boardPerimeterPath);
  boardViewRoot.appendChild(boardPerimeterLayer);

  const sectorOutlineLayer = svgEl('g');
  sectorOutlineLayer.id = 'sector-outline-layer';
  sectorOutlineLayer.setAttribute('pointer-events', 'none');
  boardViewRoot.appendChild(sectorOutlineLayer);

  const unitLayer = svgEl('g');
  unitLayer.id = 'unit-layer';
  unitLayer.setAttribute('pointer-events', 'none');
  boardViewRoot.appendChild(unitLayer);

  const hexPolys: SVGPolygonElement[][] = [];
  for (let r = 0; r < ROWS; r++) {
    hexPolys[r] = [];
    for (let col = 0; col < COLS; col++) {
      const { x, y } = hexToPixel(col, r);

      const poly = svgEl('polygon');
      poly.setAttribute('points', hexFillPoints(x, y));
      poly.setAttribute('id', `hex-${col}-${r}`);
      poly.setAttribute('data-col', String(col));
      poly.setAttribute('data-row', String(r));
      poly.setAttribute('fill', c.hexNeutral);
      poly.setAttribute('stroke', 'none');
      poly.setAttribute('stroke-width', '0');
      poly.style.cursor = "url('/icons/pointer.svg') 13 14, pointer";
      hexLayer.appendChild(poly);
      hexPolys[r]![col] = poly;

    }
  }

  // River texture layer (above hex fills, below mountains and units)
  const riverLayer = svgEl('g');
  riverLayer.id = 'river-layer';
  riverLayer.setAttribute('pointer-events', 'none');
  hexLayer.appendChild(riverLayer);

  // Mountain icon layer (above river art, below units)
  const mountainLayer = svgEl('g');
  mountainLayer.id = 'mountain-layer';
  mountainLayer.setAttribute('pointer-events', 'none');
  hexLayer.appendChild(mountainLayer);

  const controlPointLayer = svgEl('g');
  controlPointLayer.id = 'control-point-layer';
  controlPointLayer.setAttribute('pointer-events', 'none');
  hexLayer.appendChild(controlPointLayer);

  const markerLayer = svgEl('g');
  markerLayer.id = 'marker-layer';
  markerLayer.setAttribute('pointer-events', 'none');
  hexLayer.appendChild(markerLayer);

  // Production placement dashed stroke (above mountain art so corners aren’t clipped)
  const prodStrokeLayer = svgEl('g');
  prodStrokeLayer.id = 'prod-stroke-layer';
  prodStrokeLayer.setAttribute('pointer-events', 'none');
  hexLayer.appendChild(prodStrokeLayer);

  // Movement area boundary overlay (drawn above hexes, below units)
  const boundary = svgEl('path');
  boundary.setAttribute('id', 'move-boundary');
  boundary.setAttribute('fill', 'none');
  boundary.setAttribute('stroke-linecap', 'round');
  boundary.setAttribute('stroke-linejoin', 'round');
  boundary.setAttribute('pointer-events', 'none');
  hexLayer.appendChild(boundary);

  // Movement path preview (above hex layer, below units): dashed track + SMIL chevron train (proposal 23).
  const movePathLayer = svgEl('g');
  movePathLayer.id = 'move-path-layer';
  movePathLayer.setAttribute('pointer-events', 'none');
  boardViewRoot.insertBefore(movePathLayer, unitLayer);

  const movePathDefs = svgEl('defs');
  const movePathGeom = svgEl('path');
  movePathGeom.id = `${svgElement.id}-move-path-geom`;
  movePathGeom.setAttribute('d', 'M0,0');
  movePathGeom.setAttribute('fill', 'none');
  movePathGeom.setAttribute('stroke', 'none');
  movePathDefs.appendChild(movePathGeom);

  const pathLine = svgEl('polyline');
  pathLine.id = 'move-path-line';
  pathLine.setAttribute('fill', 'none');
  pathLine.setAttribute('pointer-events', 'none');

  const movePathChevronTrain = svgEl('g');
  movePathChevronTrain.setAttribute('class', 'move-path-chevron-train');

  movePathLayer.appendChild(movePathDefs);
  movePathLayer.appendChild(pathLine);
  movePathLayer.appendChild(movePathChevronTrain);

  // Full-hex invisible targets on top of unit artwork so clicks always map to a cell (getHexFromEvent).
  const hexHitLayer = svgEl('g');
  hexHitLayer.id = 'hex-hit-layer';
  for (let r = 0; r < ROWS; r++) {
    for (let col = 0; col < COLS; col++) {
      const { x, y } = hexToPixel(col, r);
      const hit = svgEl('polygon');
      hit.setAttribute('points', hexPoints(x, y));
      hit.setAttribute('data-col', String(col));
      hit.setAttribute('data-row', String(r));
      hit.setAttribute('fill', 'rgba(0,0,0,0)');
      hit.setAttribute('stroke', 'none');
      hit.setAttribute('pointer-events', 'all');
      hit.style.cursor = "url('/icons/pointer.svg') 13 14, pointer";
      hexHitLayer.appendChild(hit);
    }
  }
  boardViewRoot.appendChild(hexHitLayer);

  renderDomCacheBySvg.set(svgElement, {
    hexPolys,
    hexLayer,
    unitLayer,
    riverLayer,
    mountainLayer,
    controlPointLayer,
    prodStrokeLayer,
    sectorOutlineLayer,
    markerLayer,
    moveBoundary: boundary,
  });

  if (svgElement.id === 'board') clearHpBarAnimationState();
}

export function renderState(
  svgElement: SVGSVGElement,
  state: GameState,
  productionHex: { col: number; row: number } | null = null,
  hiddenUnitIds: Set<number> = new Set(),
  localPlayer: Owner = PLAYER,
  /**
   * When set, draw this unit list instead of state.units (AI turn replay).
   * Skips HP bar tween sync so bars match the snapshot, not end-of-turn state.
   */
  unitDrawOverride?: Unit[] | null,
  /** vs human only: local-only unit id highlight while waiting for your turn (not synced). */
  localSpectatorInspectUnitId?: number | null,
  /**
   * When set (e.g. vs-AI replay), paint territory / frontlines from this map instead of `state.hexStates`
   * so hex colors stay in sync with staged move animations.
   */
  hexStatesDrawOverride?: Record<string, HexState> | null,
): void {
  const tRenderStart = performance.now();
  const trackHpBars = svgElement.id === 'board' && !unitDrawOverride;
  const now = performance.now();
  if (trackHpBars) syncHpBarAnimState(state, now);

  const stateTerritoryDraw: GameState =
    hexStatesDrawOverride != null ? { ...state, hexStates: hexStatesDrawOverride } : state;

  const c = colors();
  const domCache = renderDomCacheBySvg.get(svgElement);
  const unitLayer = domCache?.unitLayer ?? (svgElement.querySelector('#unit-layer') as SVGGElement);
  unitLayer.innerHTML = '';

  const mountainSet = new Set(state.mountainHexes ?? []);
  const unitByHex = new Map<string, Unit>();
  for (const u of state.units) unitByHex.set(`${u.col},${u.row}`, u);

  const canPlaceHexes = new Set<string>();
  const productionFocusHexes = new Set<string>();
  const homeRow = localPlayer === PLAYER ? ROWS - 1 : 0;
  if (state.phase === 'production' && state.activePlayer === localPlayer) {
    const tProdStart = performance.now();
    for (let r = 0; r < ROWS; r++) {
      for (let col = 0; col < COLS; col++) {
        const key = `${col},${r}`;
        const hex = stateTerritoryDraw.hexStates[key];
        if (isValidProductionPlacement(state, col, r, localPlayer)) {
          canPlaceHexes.add(key);
        }
        if (r === homeRow && hex && hex.owner === localPlayer) {
          productionFocusHexes.add(key);
        }
      }
    }
    for (const [key, hex] of Object.entries(stateTerritoryDraw.hexStates)) {
      if (hex.owner === localPlayer && hex.isProduction) productionFocusHexes.add(key);
    }
    perfRecord('render.productionEligibility', performance.now() - tProdStart);
  }

  /** Per mountain key: territory-adjacency tint after propagating along mountain adjacency. */
  const mtnTerritoryCategoryByKey = resolveMountainTerritoryCategoryByKey(stateTerritoryDraw, mountainSet);
  const mountainTerritoryFillByKey = computeMountainTerritoryFillByKey(
    stateTerritoryDraw,
    mountainSet,
    localPlayer,
    c,
    productionFocusHexes,
    unitByHex,
    mtnTerritoryCategoryByKey,
  );

  let selectedUnit = state.selectedUnit !== null ? getUnitById(state, state.selectedUnit) : null;
  if (selectedUnit && selectedUnit.owner !== localPlayer) selectedUnit = null;
  // Opponent's turn + our unit id in selectedUnit: active player is inspecting our unit (multiplayer).
  // Do not show move highlights / selection on our board — that reads like we're moving.
  if (selectedUnit && state.activePlayer !== localPlayer && selectedUnit.owner === localPlayer) {
    selectedUnit = null;
  }

  /** Tint for unit shape only — hex/move overlays use `selectedUnit` above. */
  const isUnitVisuallySelected = (unit: Unit): boolean => {
    if (localSpectatorInspectUnitId != null && unit.id === localSpectatorInspectUnitId) return true;
    if (state.selectedUnit !== unit.id) return false;
    if (state.activePlayer === localPlayer) return true;
    // Opponent's turn: show their selection only on units they own (moving), not when they inspect yours
    return unit.owner === state.activePlayer;
  };

  const rangedTargetKeys = new Set<string>();
  if (selectedUnit && state.phase === 'movement' && state.activePlayer === localPlayer) {
    for (const t of getRangedAttackTargets(state, selectedUnit)) {
      rangedTargetKeys.add(`${t.col},${t.row}`);
    }
  }

  const validMoveHexes = new Set<string>();
  if (selectedUnit) {
    for (const [col, row] of getValidMoves(state, selectedUnit)) {
      validMoveHexes.add(`${col},${row}`);
    }
  }

  // Full move area = selected hex + valid destinations (used for perimeter outline)
  const moveAreaHexes = new Set<string>(validMoveHexes);
  if (selectedUnit) moveAreaHexes.add(`${selectedUnit.col},${selectedUnit.row}`);

  const zocEnemy: Owner = localPlayer === PLAYER ? AI : PLAYER;
  const zocHexes = new Set<string>();
  if (selectedUnit && isInEnemyZoC(state, selectedUnit.col, selectedUnit.row, zocEnemy)) {
    // Unit is locked in ZoC: highlight empty neighbors it cannot retreat to (also in ZoC)
    for (const [nc, nr] of getNeighbors(selectedUnit.col, selectedUnit.row, COLS, ROWS)) {
      const key = `${nc},${nr}`;
      if (!getUnit(state, nc, nr) && isInEnemyZoC(state, nc, nr, zocEnemy)) {
        zocHexes.add(key);
      }
    }
  }
  if (selectedUnit && state.phase === 'movement' && state.activePlayer === localPlayer) {
    for (const [c, r] of getOpponentHomeGuardBlockedHexes(state, selectedUnit)) {
      zocHexes.add(`${c},${r}`);
    }
  }

  // Update move area perimeter outline
  const boundary = domCache?.moveBoundary ?? (svgElement.querySelector('#move-boundary') as SVGPathElement | null);
  if (boundary) {
    if (moveAreaHexes.size > 0) {
      boundary.setAttribute('d', buildBoundaryPath(moveAreaHexes));
      boundary.setAttribute('stroke', c.moveBorder);
      boundary.setAttribute('stroke-width', '2');
      boundary.setAttribute('stroke-dasharray', '4 4');
      boundary.setAttribute('stroke-linecap', 'butt');
    } else {
      boundary.setAttribute('d', '');
    }
  }

  const prodStrokeLayer = domCache?.prodStrokeLayer ?? (svgElement.querySelector('#prod-stroke-layer') as SVGGElement | null);
  if (prodStrokeLayer) prodStrokeLayer.innerHTML = '';
  const markerLayer = domCache?.markerLayer ?? (svgElement.querySelector('#marker-layer') as SVGGElement | null);
  if (markerLayer) markerLayer.innerHTML = '';

  const tHexStart = performance.now();
  // Update each hex polygon
  for (let r = 0; r < ROWS; r++) {
    for (let col = 0; col < COLS; col++) {
      const poly = domCache?.hexPolys[r]?.[col] ?? (svgElement.querySelector(`#hex-${col}-${r}`) as SVGPolygonElement | null);
      if (!poly) continue;

      const key                = `${col},${r}`;
      const isMountain         = mountainSet.has(key);
      const hexState           = stateTerritoryDraw.hexStates[key];
      const isSelectedHex      = selectedUnit && col === selectedUnit.col && r === selectedUnit.row;
      const isValidMove        = validMoveHexes.has(key);
      const isZoc              = zocHexes.has(key);
      const canPlace           = canPlaceHexes.has(key);
      const isProdSelected     = productionHex && col === productionHex.col && r === productionHex.row;
      const isConquered        = !!hexState;

      let fill   = c.hexNeutral;
      let stroke = 'transparent';

      if (isMountain) {
        fill = mountainTerritoryFillByKey.get(key) ?? c.hexNeutral;
      } else if (isSelectedHex) {
        fill = c.hexSelected;
      } else if (isZoc) {
        fill = c.hexZoc;
      } else if (isValidMove) {
        fill = c.hexMove;
      } else if (isProdSelected) {
        fill   = c.hexProdSelected;
        stroke = c.hexProdStroke;
      } else if (canPlace) {
        fill   = c.hexCanPlace;
        stroke = c.hexStroke;
      } else if (isConquered) {
        if (hexState.owner === localPlayer) {
          fill = c.hexPlayer;
        } else {
          fill   = c.hexAi;
          stroke = 'transparent';
        }
      }

      // Draw dashed production stroke above #mountain-layer (SVG paint order), not on the base hex polygon.
      let prodOverlayStroke: string | null = null;
      if (!isSelectedHex && !isZoc && !isValidMove) {
        if (isProdSelected) prodOverlayStroke = c.hexProdStroke;
        else if (canPlace) prodOverlayStroke = c.hexStroke;
      }
      if (prodOverlayStroke) stroke = 'transparent';

      const hexOccupied = unitByHex.has(key);
      const hexDimmed = productionFocusHexes.size > 0 && isConquered && (!productionFocusHexes.has(key) || hexOccupied) && !isProdSelected;
      if (hexDimmed && hexState) {
        if (hexState.owner === localPlayer) fill = c.hexPlayerDimmed;
        else fill = c.hexAiDimmed;
      }
      const opacityDimmed = hexDimmed && fill !== c.hexPlayerDimmed && fill !== c.hexAiDimmed;
      poly.setAttribute('fill', fill);
      if (stroke === 'transparent') {
        poly.setAttribute('stroke', 'none');
        poly.setAttribute('stroke-width', '0');
        poly.removeAttribute('stroke-dasharray');
        poly.removeAttribute('stroke-dashoffset');
      } else {
        poly.setAttribute('stroke', stroke);
        poly.setAttribute('stroke-width', '2.5');
        poly.setAttribute('stroke-dasharray', `${DASH} ${GAP}`);
        poly.setAttribute('stroke-dashoffset', String(DASH_OFFSET));
      }
      poly.setAttribute('opacity', opacityDimmed ? '0.2' : '1');

      if (prodOverlayStroke && prodStrokeLayer) {
        const overlay = svgEl('polygon');
        overlay.setAttribute('points', poly.getAttribute('points') ?? '');
        overlay.setAttribute('fill', 'none');
        overlay.setAttribute('stroke', prodOverlayStroke);
        overlay.setAttribute('stroke-width', '2.5');
        overlay.setAttribute('stroke-dasharray', `${DASH} ${GAP}`);
        overlay.setAttribute('stroke-dashoffset', String(DASH_OFFSET));
        overlay.setAttribute('opacity', hexDimmed ? '0.2' : '1');
        overlay.setAttribute('pointer-events', 'none');
        prodStrokeLayer.appendChild(overlay);
      }
      poly.style.cursor = "url('/icons/pointer.svg') 13 14, auto";

      const markerParent =
        markerLayer ?? domCache?.hexLayer ?? (svgElement.querySelector('#hex-layer') as SVGGElement);

      if (
        hexState &&
        hexState.isProduction &&
        !isSelectedHex &&
        !isValidMove &&
        state.phase !== 'production'
      ) {
        const { x, y } = hexToPixel(col, r);
        const s = HEX_SIZE * 0.18;
        const diamond = svgEl('polygon');
        diamond.setAttribute('points', `${x},${y - s} ${x + s},${y} ${x},${y + s} ${x - s},${y}`);
        diamond.setAttribute('fill', paletteBaseForOwner(hexState.owner, localPlayer, c));
        diamond.setAttribute('opacity', hexDimmed ? '0.08' : '0.4');
        diamond.setAttribute('pointer-events', 'none');
        diamond.setAttribute('id', `marker-${col}-${r}`);
        markerParent.appendChild(diamond);
      }

      if (state.phase === 'production' && canPlace && !isSelectedHex && !isValidMove) {
        const { x, y } = hexToPixel(col, r);
        const iw = HEX_SIZE * 0.4;
        const plusOpacity = hexDimmed ? '0.12' : '0.92';
        const half = iw / 2;
        const sw = Math.max(1, iw * (2 / 16));
        const plusStroke = isProdSelected ? c.colorDark : '#ffffff';
        const g = svgEl('g');
        g.setAttribute('opacity', plusOpacity);
        g.setAttribute('pointer-events', 'none');
        g.setAttribute('id', `marker-prod-plus-${col}-${r}`);
        const lineH = svgEl('line');
        lineH.setAttribute('x1', String(x - half));
        lineH.setAttribute('y1', String(y));
        lineH.setAttribute('x2', String(x + half));
        lineH.setAttribute('y2', String(y));
        lineH.setAttribute('stroke', plusStroke);
        lineH.setAttribute('stroke-width', String(sw));
        lineH.setAttribute('stroke-linecap', 'butt');
        const lineV = svgEl('line');
        lineV.setAttribute('x1', String(x));
        lineV.setAttribute('y1', String(y - half));
        lineV.setAttribute('x2', String(x));
        lineV.setAttribute('y2', String(y + half));
        lineV.setAttribute('stroke', plusStroke);
        lineV.setAttribute('stroke-width', String(sw));
        lineV.setAttribute('stroke-linecap', 'butt');
        g.appendChild(lineH);
        g.appendChild(lineV);
        markerParent.appendChild(g);
      }
    }
  }
  perfRecord('render.hexPass', performance.now() - tHexStart);

  const flipBoardY = svgElement.dataset.boardFlipY === '1';

  // Draw river textures (clipped to hex shape, below mountains)
  const riverLayer = domCache?.riverLayer ?? (svgElement.querySelector('#river-layer') as SVGGElement | null);
  if (riverLayer) {
    riverLayer.innerHTML = '';
    const riverHexes = state.riverHexes ?? [];
    if (riverHexes.length > 0) {
      const clipIdPrefix = `${svgElement.id || 'board'}-riv-clip`;
      const defs = svgEl('defs');
      for (const rh of riverHexes) {
        const { x, y } = hexToPixel(rh.col, rh.row);
        const clip = svgEl('clipPath');
        clip.setAttribute('id', `${clipIdPrefix}-${rh.col}-${rh.row}`);
        clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
        const clipPoly = svgEl('polygon');
        clipPoly.setAttribute('points', hexPoints(x, y));
        clip.appendChild(clipPoly);
        defs.appendChild(clip);
      }
      riverLayer.appendChild(defs);

      const iw = HEX_SIZE * Math.sqrt(3);
      const ih = HEX_SIZE * 2;
      for (const rh of riverHexes) {
        // Vs-human guest: prefer `river-hex-inverted/` when the board is flipped (dataset.boardFlipY).
        const { url, counterFlipUpright } = riverSegmentDisplay(rh.segment, flipBoardY);
        if (!url) continue;
        const { x, y } = hexToPixel(rh.col, rh.row);
        const clipped = svgEl('g');
        clipped.setAttribute('clip-path', `url(#${clipIdPrefix}-${rh.col}-${rh.row})`);
        clipped.setAttribute('pointer-events', 'none');
        const img = svgEl('image');
        img.setAttribute('href', url);
        img.setAttribute('x', String(x - iw / 2));
        img.setAttribute('y', String(y - ih / 2));
        img.setAttribute('width', String(iw));
        img.setAttribute('height', String(ih));
        img.setAttribute('pointer-events', 'none');
        if (counterFlipUpright) {
          const upright = svgUprightAt(x, y);
          upright.appendChild(img);
          clipped.appendChild(upright);
        } else {
          clipped.appendChild(img);
        }
        riverLayer.appendChild(clipped);
      }
    }
  }

  // Draw mountain textures (clipped to hex shape)
  const mountainLayer = domCache?.mountainLayer ?? (svgElement.querySelector('#mountain-layer') as SVGGElement | null);
  if (mountainLayer) {
    mountainLayer.innerHTML = '';
    const clipIdPrefix = `${svgElement.id || 'board'}-mtn-clip`;
    const defs = svgEl('defs');
    for (const key of mountainSet) {
      const [mc, mr] = key.split(',').map(Number);
      const { x, y } = hexToPixel(mc, mr);
      const clip = svgEl('clipPath');
      clip.setAttribute('id', `${clipIdPrefix}-${mc}-${mr}`);
      clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
      const clipPoly = svgEl('polygon');
      clipPoly.setAttribute('points', hexPoints(x, y));
      clip.appendChild(clipPoly);
      defs.appendChild(clip);
    }
    mountainLayer.appendChild(defs);

    const iw = HEX_SIZE * Math.sqrt(3);
    const ih = HEX_SIZE * 2;
    for (const key of mountainSet) {
      const [mc, mr] = key.split(',').map(Number);
      const { x, y } = hexToPixel(mc, mr);
      const clipped = svgEl('g');
      clipped.setAttribute('clip-path', `url(#${clipIdPrefix}-${mc}-${mr})`);
      clipped.setAttribute('pointer-events', 'none');
      const img = svgEl('image');
      img.setAttribute('href', mountainHexTextureUrl(key));
      img.setAttribute('x', String(x - iw / 2));
      img.setAttribute('y', String(y - ih / 2));
      img.setAttribute('width', String(iw));
      img.setAttribute('height', String(ih));
      img.setAttribute('pointer-events', 'none');
      if (flipBoardY) {
        const upright = svgUprightAt(x, y);
        upright.appendChild(img);
        clipped.appendChild(upright);
      } else {
        clipped.appendChild(img);
      }
      const mtnFill = mountainTerritoryFillByKey.get(key) ?? c.hexNeutral;
      if (mtnFill !== c.hexNeutral) {
        const tint = svgEl('polygon');
        tint.setAttribute('points', hexPoints(x, y));
        tint.setAttribute('fill', mtnFill);
        tint.setAttribute('opacity', '0.42');
        tint.setAttribute('pointer-events', 'none');
        tint.setAttribute('style', 'mix-blend-mode: multiply');
        clipped.appendChild(tint);
      }
      mountainLayer.appendChild(clipped);
    }
  }
  // Breakthrough: sector political borders. Conquest / domination: frontline between owned hexes.
  const sectorOutlineLayerEl = domCache?.sectorOutlineLayer ?? (svgElement.querySelector('#sector-outline-layer') as SVGGElement | null);
  if (sectorOutlineLayerEl) {
    sectorOutlineLayerEl.innerHTML = '';
    if (
      state.gameMode === 'breakthrough' &&
      state.sectorIndexByHex &&
      Object.keys(state.sectorIndexByHex).length > 0 &&
      state.sectorOwners?.length
    ) {
      const dDef = buildDefenderOnlySectorBoundaryPath(
        state.sectorIndexByHex,
        state.sectorOwners,
        COLS,
        ROWS,
        getBreakthroughDefenderOwner(state),
      );
      if (dDef) {
        const pDef = svgEl('path');
        pDef.setAttribute('d', dDef);
        pDef.setAttribute('fill', 'none');
        pDef.setAttribute('stroke', 'rgba(0,0,0,0.3)');
        pDef.setAttribute('stroke-opacity', '0.3');
        pDef.setAttribute('stroke-width', '2.5');
        pDef.setAttribute('stroke-linejoin', 'round');
        pDef.setAttribute('stroke-linecap', 'round');
        pDef.setAttribute('pointer-events', 'none');
        pDef.setAttribute('class', 'sector-outline sector-outline-defender-internal');
        sectorOutlineLayerEl.appendChild(pDef);
      }
      const d = buildInterSectorBoundaryPath(state.sectorIndexByHex, state.sectorOwners, COLS, ROWS);
      if (d) {
        const path = svgEl('path');
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'var(--color-dark)');
        path.setAttribute('stroke-width', '2.5');
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('pointer-events', 'none');
        path.setAttribute('class', 'sector-outline sector-outline-between');
        sectorOutlineLayerEl.appendChild(path);
      }
    } else if (state.gameMode === 'conquest' || state.gameMode === 'domination') {
      const dFaction = buildInterFactionBoundaryPath(
        stateTerritoryDraw.hexStates,
        mountainSet,
        mtnTerritoryCategoryByKey,
        COLS,
        ROWS,
      );
      // frontline border between owned hexes of different factions
      if (dFaction) {
        const path = svgEl('path');
        path.setAttribute('d', dFaction);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'rgba(0,0,0,1)');
        path.setAttribute('stroke-width', '2.5');
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('pointer-events', 'none');
        path.setAttribute('class', 'faction-frontline');
        sectorOutlineLayerEl.appendChild(path);
      }
    }
  }

  const controlPointLayer = domCache?.controlPointLayer ?? (svgElement.querySelector('#control-point-layer') as SVGGElement | null);
  if (controlPointLayer) {
    controlPointLayer.innerHTML = '';
    const cpKeys = state.controlPointHexes ?? [];
    const iw = HEX_SIZE * 0.5;
    const ih = HEX_SIZE * 0.5;
    for (const key of cpKeys) {
      if (mountainSet.has(key)) continue;
      const [mc, mr] = key.split(',').map(Number);
      const { x, y } = hexToPixel(mc, mr);
      const ring = svgEl('polygon');
      ring.setAttribute('points', hexPoints(x, y));
      ring.setAttribute('fill', 'none');
      let ringStroke = '#6B6B6B';
      if (state.gameMode === 'breakthrough' && state.sectorOwners?.length && state.sectorIndexByHex) {
        const sid = state.sectorIndexByHex[key];
        if (sid !== undefined && state.sectorOwners[sid] !== undefined) {
          ringStroke = paletteBaseForOwner(state.sectorOwners[sid]!, localPlayer, c);
        }
      }
      ring.setAttribute('stroke', ringStroke);
      ring.setAttribute('stroke-width', state.gameMode === 'breakthrough' ? '2.5' : '2.5');
      ring.setAttribute('stroke-linejoin', 'round');
      ring.setAttribute('pointer-events', 'none');
      ring.setAttribute('class', 'control-point-ring');

      const img = svgEl('image');
      img.setAttribute('href', '/icons/control-point.svg');
      img.setAttribute('x', String(x - iw / 2));
      img.setAttribute('y', String(y - ih / 2));
      img.setAttribute('width', String(iw));
      img.setAttribute('height', String(ih));
      img.setAttribute('pointer-events', 'none');
      if (flipBoardY) {
        const upright = svgUprightAt(x, y);
        upright.appendChild(ring);
        upright.appendChild(img);
        controlPointLayer.appendChild(upright);
      } else {
        controlPointLayer.appendChild(ring);
        controlPointLayer.appendChild(img);
      }
    }
  }

  // Advance HP bar tweens for every unit (including hidden — moving/strike sprites skip
  // the draw loop, so we must tick visualHpForUnit for them or their bars never animate).
  const displayHpByUnit = new Map<number, number>();
  const unitsToDraw = unitDrawOverride ?? state.units;
  if (trackHpBars) {
    for (const unit of state.units) {
      displayHpByUnit.set(unit.id, visualHpForUnit(unit, now));
    }
  } else if (unitDrawOverride) {
    for (const unit of unitDrawOverride) {
      displayHpByUnit.set(unit.id, unit.hp);
    }
  }

  const tUnitsStart = performance.now();
  // Draw units
  for (const unit of unitsToDraw) {
    if (hiddenUnitIds.has(unit.id)) continue;
    const dc = unit.col;
    const dr = unit.row;
    const { x, y } = hexToPixel(dc, dr);
    const isSelected = isUnitVisuallySelected(unit);
    const displayHp  = displayHpByUnit.get(unit.id) ?? unit.hp;
    const hpRatio    = displayHp / unit.maxHp;

    const baseColor = paletteBaseForOwner(unit.owner, localPlayer, c);
    const isRangedTarget = rangedTargetKeys.has(`${dc},${dr}`);
    const movementTired =
      state.phase === 'movement' &&
      state.activePlayer === unit.owner &&
      unit.movesUsed >= unit.movement;
    const productionTiredVisual =
      state.phase === 'production' && productionFocusHexes.size > 0;
    const tired = movementTired || productionTiredVisual;
    const tiredBase =
      unit.owner === localPlayer
        ? c.playerTired
        : productionTiredVisual
          ? c.aiDuringProduction
          : c.aiTired;
    const fill =
      isRangedTarget ? c.rangedTarget : isSelected ? c.unitSelected : tired ? tiredBase : baseColor;
    const opacity = '1';
    const iconOpacity = tired ? String(config.tiredIconOpacity) : '1';

    const unitRoot = flipBoardY ? svgUprightAt(x, y) : null;
    if (unitRoot) unitLayer.appendChild(unitRoot);
    const uParent: SVGGElement = unitRoot ?? unitLayer;

    const unitWrap = svgEl('g');
    unitWrap.setAttribute('class', 'board-unit');
    unitWrap.setAttribute('data-col', String(dc));
    unitWrap.setAttribute('data-row', String(dr));
    uParent.appendChild(unitWrap);

    const UNIT_PATH_D = 'M0 44.1143V0H25H50V44.1143L25 64L0 44.1143Z';
    const sc = (HEX_SIZE * 1.1) / 50;
    const unitEl = svgEl('path');
    unitEl.setAttribute('d', UNIT_PATH_D);
    unitEl.setAttribute('fill', fill);
    unitEl.setAttribute('stroke', 'none');
    unitEl.setAttribute('opacity', opacity);
    unitEl.setAttribute('data-col', String(dc));
    unitEl.setAttribute('data-row', String(dr));
    unitEl.setAttribute('transform', `translate(${x - 25 * sc},${y - 32 * sc}) scale(${sc})`);
    unitEl.style.cursor = "url('/icons/pointer.svg') 13 14, pointer";
    unitWrap.appendChild(unitEl);

    // HP bar (inside shape)
    const barW = HEX_SIZE * 0.58;
    const barH = HEX_SIZE * 0.1;
    const barX = x - barW / 2;
    const barY = y + HEX_SIZE * 0.13;

    const barBg = svgEl('rect');
    barBg.setAttribute('x', String(barX)); barBg.setAttribute('y', String(barY));
    barBg.setAttribute('width', String(barW)); barBg.setAttribute('height', String(barH));
    barBg.setAttribute('fill', '#222'); barBg.setAttribute('rx', '1');
    barBg.setAttribute('pointer-events', 'none');
    barBg.setAttribute('opacity', opacity);
    unitWrap.appendChild(barBg);

    const barColor = tired ? c.hpTired : hpRatio > 0.6 ? c.hpHigh : hpRatio > 0.3 ? c.hpMid : c.hpLow;
    const barFill = svgEl('rect');
    barFill.setAttribute('x', String(barX)); barFill.setAttribute('y', String(barY));
    barFill.setAttribute('width', String(barW * hpRatio)); barFill.setAttribute('height', String(barH));
    barFill.setAttribute('fill', barColor); barFill.setAttribute('rx', '1');
    barFill.setAttribute('pointer-events', 'none');
    barFill.setAttribute('opacity', opacity);
    unitWrap.appendChild(barFill);

    // Icon (shifted up inside shape)
    const icon = unit.icon ?? unitIcon(unit.unitTypeId);
    const iconColor = isRangedTarget ? '#ffffff' : c.unitIconColor;
    const iconEl = inlineIcon(icon, x, y - HEX_SIZE * 0.34, HEX_SIZE * 0.4, iconColor, iconOpacity);
    if (iconEl) unitWrap.appendChild(iconEl);

    if (isRangedTarget) {
      const aim = inlineIcon('icons/artillery.svg', x, y - HEX_SIZE * 1, HEX_SIZE * 0.5, c.rangedTarget, opacity);
      if (aim) {
        const aimWrap = svgEl('g');
        aimWrap.setAttribute('class', 'ranged-target-aim');
        aimWrap.setAttribute('pointer-events', 'none');
        aimWrap.appendChild(aim);
        unitWrap.appendChild(aimWrap);
      }
    }
  }
  perfRecord('render.unitsPass', performance.now() - tUnitsStart);
  perfRecord('render.total', performance.now() - tRenderStart);
  perfMaybeFlush();
  if (svgElement.id === 'board') queueBoardUnitPointerHoverApply();
}

// Animate a list of unit moves in parallel, then call onDone once.
// During animation the caller should hide the moving units from the static render
// (pass their ids to renderState's hiddenUnitIds) so they don't ghost at the destination.
// Call cancel() to stop frames, clear the anim layer, and skip onDone (caller handles completion).
export function animateMoves(
  svgElement: SVGSVGElement,
  animations: MoveAnimation[],
  durationMs: number,
  onDone: () => void,
  /** When set, HP bar on the moving sprite uses live state + board HP tween each frame. */
  liveStateForHp?: GameState | null,
  /** False = draw below `#unit-layer` (e.g. losing attacker); true = above units, under hex hits. */
  stackAboveStaticUnits: boolean = true,
  localPlayer: Owner = PLAYER,
): { cancel: () => void } {
  const noopCancel = (): void => {};

  if (animations.length === 0 || durationMs <= 0) {
    onDone();
    return { cancel: noopCancel };
  }

  const c = colors();
  const flipBoardY = svgElement.dataset.boardFlipY === '1';

  const animLayer = positionAnimLayer(svgElement, stackAboveStaticUnits);
  animLayer.setAttribute('pointer-events', 'none');
  animLayer.innerHTML = '';

  let cancelled = false;
  let doneCalled = false;

  function callDoneOnce(): void {
    if (cancelled || doneCalled) return;
    doneCalled = true;
    onDone();
  }

  const cancel = (): void => {
    if (cancelled || doneCalled) return;
    cancelled = true;
    animLayer!.innerHTML = '';
    resetAnimLayerStackOrder(svgElement);
  };

  let completed = 0;

  for (const anim of animations) {
    const pixelPath = pixelPathForAnimation(anim);
    const baseColor = paletteBaseForOwner(anim.unit.owner, localPlayer, c);

    const spriteRoot = flipBoardY ? svgEl('g') : null;
    const layer: SVGGElement = spriteRoot ?? animLayer!;
    if (spriteRoot) animLayer!.appendChild(spriteRoot);

    const UNIT_PATH_D = 'M0 44.1143V0H25H50V44.1143L25 64L0 44.1143Z';
    const animFill = baseColor;
    const unitSc = (HEX_SIZE * 1.1) / 50;
    const circle = svgEl('path');
    circle.setAttribute('d', UNIT_PATH_D);
    circle.setAttribute('fill', animFill);
    circle.setAttribute('stroke', 'none');
    circle.setAttribute('pointer-events', 'none');
    layer.appendChild(circle);

    const animBarW = HEX_SIZE * 0.58;
    const barH = HEX_SIZE * 0.1;
    const barBg = svgEl('rect');
    barBg.setAttribute('width', String(animBarW)); barBg.setAttribute('height', String(barH));
    barBg.setAttribute('fill', '#222'); barBg.setAttribute('rx', '1');
    barBg.setAttribute('pointer-events', 'none');
    layer.appendChild(barBg);

    const live0 = liveStateForHp ? getUnitById(liveStateForHp, anim.unit.id) : null;
    const maxHp0 = live0?.maxHp ?? anim.unit.maxHp;
    const displayHp0 = live0 ? getBoardVisualHp(live0, performance.now()) : anim.unit.hp;
    const hpRatio0 = maxHp0 > 0 ? Math.min(1, Math.max(0, displayHp0 / maxHp0)) : 0;
    const barColor0 = hpRatio0 > 0.6 ? c.hpHigh : hpRatio0 > 0.3 ? c.hpMid : c.hpLow;
    const barFill = svgEl('rect');
    barFill.setAttribute('width', String(animBarW * hpRatio0)); barFill.setAttribute('height', String(barH));
    barFill.setAttribute('fill', barColor0); barFill.setAttribute('rx', '1');
    barFill.setAttribute('pointer-events', 'none');
    layer.appendChild(barFill);

    const iconSrc = anim.unit.icon ?? unitIcon(anim.unit.unitTypeId);
    const iconSize = HEX_SIZE * 0.4;
    // Place icon at (0,0) so its internal scale stays fixed; a wrapper <g> handles translation each frame.
    const iconEl = inlineIcon(iconSrc, 0, 0, iconSize, c.unitIconColor, '1');
    const iconWrapper = svgEl('g');
    iconWrapper.setAttribute('pointer-events', 'none');
    if (iconEl) iconWrapper.appendChild(iconEl);
    layer.appendChild(iconWrapper);

    const startTime = performance.now();

    (function step(now: number): void {
      if (cancelled) return;

      const t    = Math.min((now - startTime) / durationMs, 1);
      const ease = easeInOutQuad(t);
      const { x, y } = positionOnPolyline(pixelPath, ease);

      const live = liveStateForHp ? getUnitById(liveStateForHp, anim.unit.id) : null;
      const maxHp = live?.maxHp ?? anim.unit.maxHp;
      const displayHp = live ? getBoardVisualHp(live, now) : anim.unit.hp;
      const hpRatio = maxHp > 0 ? Math.min(1, Math.max(0, displayHp / maxHp)) : 0;
      const barColor = hpRatio > 0.6 ? c.hpHigh : hpRatio > 0.3 ? c.hpMid : c.hpLow;
      barFill.setAttribute('width', String(animBarW * hpRatio));
      barFill.setAttribute('fill', barColor);

      if (spriteRoot) {
        spriteRoot.setAttribute('transform', `translate(${x},${y}) scale(-1,-1) translate(${-x},${-y})`);
      }
      circle.setAttribute('transform', `translate(${x - 25 * unitSc},${y - 32 * unitSc}) scale(${unitSc})`);
      barBg.setAttribute('x',   String(x - animBarW / 2));
      barBg.setAttribute('y',   String(y + HEX_SIZE * 0.13));
      barFill.setAttribute('x', String(x - animBarW / 2));
      barFill.setAttribute('y', String(y + HEX_SIZE * 0.13));
      iconWrapper.setAttribute('transform', `translate(${x},${y - HEX_SIZE * 0.34})`);

      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        if (cancelled) return;
        if (spriteRoot) {
          spriteRoot.remove();
        } else {
          circle.remove(); barBg.remove(); barFill.remove(); iconWrapper.remove();
        }
        completed++;
        if (completed >= animations.length) {
          animLayer!.innerHTML = '';
          resetAnimLayerStackOrder(svgElement);
          callDoneOnce();
        }
      }
    })(performance.now());
  }

  return { cancel };
}


export interface StrikeReturnParams {
  unit: Unit;
  fromCol: number;
  fromRow: number;
  enemyCol: number;
  enemyRow: number;
  durationMs: number;
  /** Fires once when the unit reaches the enemy hex (halfway along the out-and-back path). */
  onHit?: () => void;
}

/** Melee: attacker moves onto the defender hex and returns (both units survived). */
export function animateStrikeAndReturn(
  svgElement: SVGSVGElement,
  params: StrikeReturnParams,
  onDone: () => void,
  /** When set, HP bar on the sprite uses live state + board HP tween each frame. */
  liveStateForHp?: GameState | null,
  stackAboveStaticUnits: boolean = true,
  localPlayer: Owner = PLAYER,
): { cancel: () => void } {
  const noopCancel = (): void => {};
  const { unit, fromCol, fromRow, enemyCol, enemyRow, durationMs, onHit } = params;

  if (durationMs <= 0) {
    onHit?.();
    resetAnimLayerStackOrder(svgElement);
    onDone();
    return { cancel: noopCancel };
  }

  const pixelPath = [
    hexToPixel(fromCol, fromRow),
    hexToPixel(enemyCol, enemyRow),
    hexToPixel(fromCol, fromRow),
  ];

  const c = colors();
  const flipBoardY = svgElement.dataset.boardFlipY === '1';

  const animLayer = positionAnimLayer(svgElement, stackAboveStaticUnits);
  animLayer.setAttribute('pointer-events', 'none');
  animLayer.innerHTML = '';

  let cancelled = false;
  let doneCalled = false;
  let hitCalled = false;

  function callDoneOnce(): void {
    if (cancelled || doneCalled) return;
    doneCalled = true;
    onDone();
  }

  const cancel = (): void => {
    if (cancelled || doneCalled) return;
    cancelled = true;
    animLayer!.innerHTML = '';
    resetAnimLayerStackOrder(svgElement);
  };

  const spriteRoot = flipBoardY ? svgEl('g') : null;
  const layer: SVGGElement = spriteRoot ?? animLayer!;
  if (spriteRoot) animLayer.appendChild(spriteRoot);

  const baseColor = paletteBaseForOwner(unit.owner, localPlayer, c);
  const live0 = liveStateForHp ? getUnitById(liveStateForHp, unit.id) : null;
  const maxHp0 = live0?.maxHp ?? unit.maxHp;
  const displayHp0 = live0 ? getBoardVisualHp(live0, performance.now()) : unit.hp;
  const hpRatio0 = maxHp0 > 0 ? Math.min(1, Math.max(0, displayHp0 / maxHp0)) : 0;
  const UNIT_PATH_D = 'M0 44.1143V0H25H50V44.1143L25 64L0 44.1143Z';
  const unitSc = (HEX_SIZE * 1.1) / 50;

  const circle = svgEl('path');
  circle.setAttribute('d', UNIT_PATH_D);
  circle.setAttribute('fill', baseColor);
  circle.setAttribute('stroke', 'none');
  circle.setAttribute('pointer-events', 'none');
  layer.appendChild(circle);

  const animBarW = HEX_SIZE * 0.58;
  const barH = HEX_SIZE * 0.1;
  const barBg = svgEl('rect');
  barBg.setAttribute('width', String(animBarW));
  barBg.setAttribute('height', String(barH));
  barBg.setAttribute('fill', '#222');
  barBg.setAttribute('rx', '1');
  barBg.setAttribute('pointer-events', 'none');
  layer.appendChild(barBg);

  const barColor0 = hpRatio0 > 0.6 ? c.hpHigh : hpRatio0 > 0.3 ? c.hpMid : c.hpLow;
  const barFill = svgEl('rect');
  barFill.setAttribute('width', String(animBarW * hpRatio0));
  barFill.setAttribute('height', String(barH));
  barFill.setAttribute('fill', barColor0);
  barFill.setAttribute('rx', '1');
  barFill.setAttribute('pointer-events', 'none');
  layer.appendChild(barFill);

  const iconSrc = unit.icon ?? unitIcon(unit.unitTypeId);
  const iconSize = HEX_SIZE * 0.4;
  const iconEl = inlineIcon(iconSrc, 0, 0, iconSize, c.unitIconColor, '1');
  const iconWrapper = svgEl('g');
  iconWrapper.setAttribute('pointer-events', 'none');
  if (iconEl) iconWrapper.appendChild(iconEl);
  layer.appendChild(iconWrapper);

  const startTime = performance.now();

  (function step(now: number): void {
    if (cancelled) return;

    const t = Math.min((now - startTime) / durationMs, 1);
    const ease = easeInOutQuad(t);
    const { x, y } = positionOnPolyline(pixelPath, ease);

    if (!hitCalled && t >= 0.5) {
      hitCalled = true;
      onHit?.();
    }

    const live = liveStateForHp ? getUnitById(liveStateForHp, unit.id) : null;
    const maxHp = live?.maxHp ?? unit.maxHp;
    const displayHp = live ? getBoardVisualHp(live, now) : unit.hp;
    const hpRatio = maxHp > 0 ? Math.min(1, Math.max(0, displayHp / maxHp)) : 0;
    const barColor = hpRatio > 0.6 ? c.hpHigh : hpRatio > 0.3 ? c.hpMid : c.hpLow;
    barFill.setAttribute('width', String(animBarW * hpRatio));
    barFill.setAttribute('fill', barColor);

    if (spriteRoot) {
      spriteRoot.setAttribute('transform', `translate(${x},${y}) scale(-1,-1) translate(${-x},${-y})`);
    }
    circle.setAttribute('transform', `translate(${x - 25 * unitSc},${y - 32 * unitSc}) scale(${unitSc})`);
    barBg.setAttribute('x', String(x - animBarW / 2));
    barBg.setAttribute('y', String(y + HEX_SIZE * 0.13));
    barFill.setAttribute('x', String(x - animBarW / 2));
    barFill.setAttribute('y', String(y + HEX_SIZE * 0.13));
    iconWrapper.setAttribute('transform', `translate(${x},${y - HEX_SIZE * 0.34})`);

    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      if (cancelled) return;
      if (spriteRoot) {
        spriteRoot.remove();
      } else {
        circle.remove();
        barBg.remove();
        barFill.remove();
        iconWrapper.remove();
      }
      animLayer!.innerHTML = '';
      resetAnimLayerStackOrder(svgElement);
      callDoneOnce();
    }
  })(performance.now());

  return { cancel };
}

type FloatBadgeKind = 'damage' | 'heal';

function showHexFloatBadges(
  svgElement: SVGSVGElement,
  entries: { col: number; row: number; amount: number }[],
  durationMs: number,
  onDone: () => void,
  kind: FloatBadgeKind,
): { cancel: () => void } {
  const noopCancel = (): void => {};

  if (entries.length === 0 || durationMs <= 0) {
    onDone();
    return { cancel: noopCancel };
  }

  const flipBoardY = svgElement.dataset.boardFlipY === '1';

  let vfxLayer = svgElement.querySelector('#vfx-layer') as SVGGElement | null;
  if (!vfxLayer) {
    vfxLayer = svgEl('g');
    vfxLayer.id = 'vfx-layer';
    vfxLayer.setAttribute('pointer-events', 'none');
    getBoardVfxParent(svgElement).appendChild(vfxLayer);
  }

  let cancelled = false;
  let doneCalled = false;
  let timer: number | null = null;

  function callDoneOnce(): void {
    if (cancelled || doneCalled) return;
    doneCalled = true;
    onDone();
  }

  const cancel = (): void => {
    if (cancelled || doneCalled) return;
    cancelled = true;
    if (vfxLayer) vfxLayer.innerHTML = '';
    if (timer !== null) window.clearTimeout(timer);
  };

  const rootClass = kind === 'damage' ? 'damage-float-root' : 'heal-float-root';
  const bgClass = kind === 'damage' ? 'damage-float-bg' : 'heal-float-bg';
  const labelClass = kind === 'damage' ? 'damage-float-label' : 'heal-float-label';

  const stackIndexByHex = new Map<string, number>();
  const STACK_STEP = 20;
  for (const e of entries) {
    const { x, y } = hexToPixel(e.col, e.row);
    const key = `${e.col},${e.row}`;
    const stack = stackIndexByHex.get(key) ?? 0;
    stackIndexByHex.set(key, stack + 1);
    // Board Y-flip negates vertical offset from hex center → invert base + stagger so badges stay north of the unit.
    const staggerY = flipBoardY ? stack * STACK_STEP : -stack * STACK_STEP;
    const yAnchor = flipBoardY ? y + HEX_SIZE * 0.72 + staggerY : y - HEX_SIZE * 0.72 + staggerY;
    const label = kind === 'damage' ? String(e.amount) : `heal +${e.amount}`;
    const outer = svgEl('g');
    outer.setAttribute('transform', `translate(${x},${yAnchor})`);

    const g = svgEl('g');
    g.setAttribute('class', rootClass);

    const textW = Math.max(22, 7 + label.length * 7);
    const h = 16;
    const rect = svgEl('rect');
    rect.setAttribute('class', bgClass);
    rect.setAttribute('x', String(-textW / 2));
    rect.setAttribute('y', String(-h / 2));
    rect.setAttribute('width', String(textW));
    rect.setAttribute('height', String(h));
    rect.setAttribute('rx', '3');

    const text = svgEl('text');
    text.setAttribute('class', labelClass);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('y', '4');
    text.setAttribute('font-size', '11');
    text.setAttribute('font-weight', '700');
    text.textContent = label;

    g.appendChild(rect);
    g.appendChild(text);
    if (flipBoardY) {
      const upright = svgEl('g');
      upright.setAttribute('transform', 'scale(-1,-1)');
      upright.appendChild(g);
      outer.appendChild(upright);
    } else {
      outer.appendChild(g);
    }
    vfxLayer.appendChild(outer);
  }

  timer = window.setTimeout(() => {
    if (cancelled) return;
    vfxLayer!.innerHTML = '';
    callDoneOnce();
  }, durationMs);

  return { cancel };
}

export function showDamageFloats(
  svgElement: SVGSVGElement,
  entries: { col: number; row: number; amount: number }[],
  durationMs: number,
  onDone: () => void,
): { cancel: () => void } {
  return showHexFloatBadges(svgElement, entries, durationMs, onDone, 'damage');
}

/** Green +N badges for end-of-turn healing (same motion/layout as damage floats). */
export function showHealFloats(
  svgElement: SVGSVGElement,
  entries: { col: number; row: number; amount: number }[],
  durationMs: number,
  onDone: () => void,
): { cancel: () => void } {
  return showHexFloatBadges(svgElement, entries, durationMs, onDone, 'heal');
}

/** Clears combat VFX layers (#anim-layer, #vfx-layer) without invoking callbacks. */
export function clearCombatVfxLayers(svgElement: SVGSVGElement): void {
  const anim = svgElement.querySelector('#anim-layer') as SVGGElement | null;
  if (anim) anim.innerHTML = '';
  resetAnimLayerStackOrder(svgElement);
  const vfx = svgElement.querySelector('#vfx-layer') as SVGGElement | null;
  if (vfx) vfx.innerHTML = '';
}

const ARTILLERY_HEX_RADIUS_SCALE = 0.55;

/**
 * Artillery ranged attack: shuffled fan shell streaks on the defender hex (theme reds).
 * Coordinates match the board / damage floats (same layer transform as {@link showDamageFloats}).
 */
export function playRangedArtilleryHexBarrageVfx(
  svgElement: SVGSVGElement,
  col: number,
  row: number,
  onComplete?: () => void,
): ArtilleryProjectileHandle {
  let vfxLayer = svgElement.querySelector('#vfx-layer') as SVGGElement | null;
  if (!vfxLayer) {
    vfxLayer = svgEl('g');
    vfxLayer.id = 'vfx-layer';
    vfxLayer.setAttribute('pointer-events', 'none');
    getBoardVfxParent(svgElement).appendChild(vfxLayer);
  }
  const { x, y } = hexToPixel(col, row);
  return playDefenderHexBarrage({
    parent: vfxLayer,
    center: { x, y },
    hexRadius: HEX_SIZE * ARTILLERY_HEX_RADIUS_SCALE,
    mirrorFanY: svgElement.dataset.boardFlipY === '1',
    onComplete,
  });
}

export function getHexFromEvent(e: MouseEvent): { col: number; row: number } | null {
  const target = (e.target as Element).closest('[data-col]') as HTMLElement | null;
  if (!target) return null;
  return { col: parseInt(target.dataset['col']!), row: parseInt(target.dataset['row']!) };
}

// Draw (or clear) the movement path preview from the unit to a hovered valid-move hex.
// `path` is an array of [col, row] pairs including the unit's start hex; pass [] to clear.
// Visual style matches public/move-path-proposals.html proposal 23: marching dashed track + glowing chevron train.
export function renderMovePath(svgElement: SVGSVGElement, path: [number, number][]): void {
  const pathLine = svgElement.querySelector('#move-path-line') as SVGPolylineElement | null;
  if (!pathLine) return;

  movePathPreviewTl?.kill();
  movePathPreviewTl = null;
  gsap.killTweensOf(pathLine);
  pathLine.removeAttribute('style');

  const movePathLayer = pathLine.parentElement as SVGGElement | null;
  const geomId = `${svgElement.id}-move-path-geom`;
  const geom = svgElement.querySelector(`#${geomId}`) as SVGPathElement | null;
  const chevronTrain = movePathLayer?.querySelector('g.move-path-chevron-train') ?? null;

  if (path.length < 2) {
    pathLine.setAttribute('points', '');
    pathLine.removeAttribute('stroke-dasharray');
    pathLine.removeAttribute('stroke-dashoffset');
    pathLine.removeAttribute('class');
    if (geom) geom.setAttribute('d', '');
    if (chevronTrain) chevronTrain.replaceChildren();
    return;
  }

  const xy = path.map(([c, r]) => hexToPixel(c, r));
  const pointsAttr = xy.map(({ x, y }) => `${x},${y}`).join(' ');
  const d = `M ${xy.map(({ x, y }) => `${x},${y}`).join(' L ')}`;

  pathLine.setAttribute('points', pointsAttr);
  pathLine.setAttribute('class', 'move-path-preview-track');
  pathLine.setAttribute('fill', 'none');

  if (geom) geom.setAttribute('d', d);

  if (chevronTrain) {
    chevronTrain.replaceChildren();
    const href = `#${geomId}`;
    const hexSteps = path.length - 1;
    const chevronCount = MOVE_PATH_CHEVRONS_PER_HEX_STEP * hexSteps;
    const durSec = chevronCount * MOVE_PATH_CHEVRON_STAGGER_SEC;

    for (let i = 0; i < chevronCount; i++) {
      const poly = svgEl('polygon');
      poly.setAttribute('class', 'move-path-chev');
      poly.setAttribute('fill', 'var(--color-unit-selected)');
      poly.setAttribute('points', MOVE_PATH_CHEVRON_POINTS);

      const am = svgEl('animateMotion');
      am.setAttribute('dur', `${durSec}s`);
      am.setAttribute('repeatCount', 'indefinite');
      am.setAttribute('rotate', 'auto');
      am.setAttribute('calcMode', 'linear');
      am.setAttribute('keyPoints', '0;1');
      am.setAttribute('keyTimes', '0;1');
      if (i > 0) {
        am.setAttribute('begin', `-${(i * MOVE_PATH_CHEVRON_STAGGER_SEC).toFixed(2)}s`);
      }

      const mp = svgEl('mpath');
      mp.setAttribute('href', href);

      am.appendChild(mp);
      poly.appendChild(am);
      chevronTrain.appendChild(poly);
    }
  }
}
