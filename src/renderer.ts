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
import type { GameState, HexState, Owner, Unit } from './types';
import config from './gameconfig';
import mountainHex01 from '../public/images/misc/mountain-hex/mountain-01.png';
import mountainHex02 from '../public/images/misc/mountain-hex/mountain-02.png';
import mountainHex03 from '../public/images/misc/mountain-hex/mountain-03.png';
import mountainHex04 from '../public/images/misc/mountain-hex/mountain-04.png';
import mountainHex05 from '../public/images/misc/mountain-hex/mountain-05.png';
import mountainHex06 from '../public/images/misc/mountain-hex/mountain-06.png';
import mountainHex07 from '../public/images/misc/mountain-hex/mountain-07.png';
import { riverSegmentDisplay } from './rivers';
import type { TerritoryGraphData } from './territoryMap';
import { boardPixelForVirtualHex } from './territoryMap';

const MOUNTAIN_HEX_TEXTURES = [mountainHex01, mountainHex02, mountainHex03, mountainHex04, mountainHex05, mountainHex06, mountainHex07] as const;

/** Shield silhouette in 50×64 design space; scaled in JS. Styled via `.board-unit__body` in `style.css`. */
export const BOARD_UNIT_SILHOUETTE_D =
  'M0 0h47v58l-23.5 5L0 58z';

/** BFS path distance: hexes with distance 0, 1, or 2 from any friendly unit are in vision. */
const FOG_VISION_HEX_DISTANCE = 2;

/** Keys `col,row` reachable within {@link FOG_VISION_HEX_DISTANCE} steps of any `localPlayer` unit. */
function buildLocalPlayerVisionKeys(
  units: readonly Unit[],
  localPlayer: Owner,
  cols: number,
  rows: number,
): Set<string> {
  const dist = new Map<string, number>();
  const q: [number, number][] = [];
  for (const u of units) {
    if (u.owner !== localPlayer) continue;
    const k = `${u.col},${u.row}`;
    if (dist.has(k)) continue;
    dist.set(k, 0);
    q.push([u.col, u.row]);
  }
  for (let i = 0; i < q.length; i++) {
    const [c, r] = q[i]!;
    const d = dist.get(`${c},${r}`) ?? 0;
    if (d >= FOG_VISION_HEX_DISTANCE) continue;
    for (const [nc, nr] of getNeighbors(c, r, cols, rows)) {
      const nk = `${nc},${nr}`;
      if (dist.has(nk)) continue;
      const nd = d + 1;
      dist.set(nk, nd);
      if (nd < FOG_VISION_HEX_DISTANCE) q.push([nc, nr]);
    }
  }
  return new Set(dist.keys());
}

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

/** Deterministic p1/p2 when counts tie (per mountain hex `key`); same mixing as {@link mountainHexTextureUrl}. */
function mountainTerritoryTieBreakP1P2(key: string): 'p1' | 'p2' {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % 2 === 0 ? 'p1' : 'p2';
}

/**
 * Strict plurality: the side with the highest count wins.
 * P1–P2 two-way max ties (e.g. 3–3–0) use a stable pick by `key`. Other two-way ties (e.g. 3–0–3) stay neutral.
 * Three-way tie (2–2–2): keep `prev` if it is p1/p2, else same stable pick by `key`.
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
  if (tieCount === 2) {
    if (nP1 === nP2 && nP1 === max && nNeutral < max) {
      const key = opts?.key;
      return key ? mountainTerritoryTieBreakP1P2(key) : 'p1';
    }
    return 'neutral';
  }
  if (tieCount === 3) {
    const prev = opts?.prev;
    if (prev === 'p1' || prev === 'p2') return prev;
    const key = opts?.key;
    return key ? mountainTerritoryTieBreakP1P2(key) : 'p1';
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
 * Visual-only mountain tints: majority per hex (P1–P2 two-way max ties use a stable side; P1/P2 vs neutral ties stay neutral; 2–2–2 uses prev or key); adjacent mountains contribute their
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
  const trrUnits = parent.querySelector('#trr-units');
  const hexHitLayer = parent.querySelector('#hex-hit-layer');
  if (aboveStaticUnits) {
    if (hexHitLayer) parent.insertBefore(animLayer, hexHitLayer);
    else if (trrUnits) parent.insertBefore(animLayer, trrUnits.nextSibling);
    else parent.appendChild(animLayer);
  } else {
    if (unitLayer) parent.insertBefore(animLayer, unitLayer);
    else if (trrUnits) parent.insertBefore(animLayer, trrUnits);
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

function boardPixelForMoveAnim(
  col: number,
  row: number,
  territoryGraph: TerritoryGraphData | null | undefined,
): { x: number; y: number } {
  if (territoryGraph) {
    const p = boardPixelForVirtualHex(territoryGraph, col, row);
    if (p) return p;
  }
  return hexToPixel(col, row);
}

function pixelPathForAnimation(
  anim: MoveAnimation,
  territoryGraph?: TerritoryGraphData | null,
): { x: number; y: number }[] {
  if (anim.pathHexes && anim.pathHexes.length >= 2) {
    return anim.pathHexes.map(([c, r]) => boardPixelForMoveAnim(c, r, territoryGraph));
  }
  return [
    boardPixelForMoveAnim(anim.fromCol, anim.fromRow, territoryGraph),
    boardPixelForMoveAnim(anim.toCol, anim.toRow, territoryGraph),
  ];
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

function inlineIcon(
  iconSrc: string | undefined,
  x: number,
  y: number,
  size: number,
  color: string,
  opacity: string,
  /** Optional class on the root `<g>` (e.g. `board-unit__icon`). */
  rootClass?: string,
): SVGGElement | null {
  if (!iconSrc) return null;
  const def = iconDefsCache[iconSrc];
  if (!def) return null;
  const scale = size / def.viewBox;
  const g = svgEl('g');
  if (rootClass) g.setAttribute('class', rootClass);
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
  hexFog: string;
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
  /** Map unit shield card (design ref). */
  boardUnitCardFill: string;
  boardUnitBorder: string;
  boardUnitBorderWidth: number;
  boardUnitBorderSelected: string;
  boardUnitBorderSelectedWidth: number;
  boardUnitBracket: string;
  boardUnitBracketWidth: number;
  boardUnitBracketSelected: string;
  boardUnitBracketSelectedWidth: number;
  boardUnitHpFriendly: string;
  boardUnitHpFriendlyTired: string;
  boardUnitHpEnemy: string;
  boardUnitHpSelected: string;
  boardUnitIconSilhouette: string;
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

function readCssNumber(raw: string, fallback: number): number {
  const t = raw.trim().replace(/px$/i, '');
  if (!t) return fallback;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : fallback;
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
    hexFog:          v('--color-fog'),
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

    boardUnitCardFill:            v('--color-board-unit-card-fill') || '#FFFFFF',
    boardUnitBorder:              v('--color-board-unit-border') || '#C8C8C8',
    boardUnitBorderWidth:         readCssNumber(v('--color-board-unit-border-width'), 3.5),
    boardUnitBorderSelected:      v('--color-board-unit-border-selected') || '#000000',
    boardUnitBorderSelectedWidth: readCssNumber(v('--color-board-unit-border-selected-width'), 3.5),
    boardUnitBracket:             v('--color-board-unit-bracket') || '#C8C8C8',
    boardUnitBracketWidth:        readCssNumber(v('--color-board-unit-bracket-width'), 3),
    boardUnitBracketSelected:     v('--color-board-unit-bracket-selected') || '#000000',
    boardUnitBracketSelectedWidth: readCssNumber(v('--color-board-unit-bracket-selected-width'), 2),
    boardUnitHpFriendly:          v('--color-board-unit-hp-friendly') || '#7FBFFF',
    boardUnitHpFriendlyTired:     v('--color-board-unit-hp-friendly-tired') || '#6BA8E6',
    boardUnitHpEnemy:             v('--color-board-unit-hp-enemy') || '#FF8C8C',
    boardUnitHpSelected:          v('--color-board-unit-hp-selected') || '#FFCC00',
    boardUnitIconSilhouette:      v('--color-board-unit-icon-silhouette') || '#0A0A0A',
  };
  return C;
}

/** Selection ring for map unit chip (same rules as hex/unit selection in {@link renderState}). */
export function unitIsVisuallySelectedForBoard(
  state: GameState,
  unit: Unit,
  localPlayer: Owner,
  localSpectatorInspectUnitId?: number | null,
): boolean {
  if (localSpectatorInspectUnitId != null && unit.id === localSpectatorInspectUnitId) return true;
  if (state.selectedUnit !== unit.id) return false;
  if (state.activePlayer === localPlayer) return true;
  return unit.owner === state.activePlayer;
}

function statePackageForUnitOwner(state: GameState, owner: Owner): string {
  const p1 = state.unitPackage ?? 'standard';
  const p2 = state.unitPackagePlayer2 || p1;
  return owner === PLAYER ? p1 : p2;
}

function factionIconHrefFromPackage(pkg: string): string {
  const map: Record<string, string> = {
    'us-ww2': '/icons/scenarios/us-ww2.svg',
    'de-ww2': '/icons/scenarios/de-ww2.svg',
    'ru-ww2': '/icons/scenarios/ru-ww2.svg',
    'jp-ww2': '/icons/scenarios/jp-ww2.svg',
  };
  return map[pkg] ?? '/icons/shield.svg';
}

function packageForUnitOnBoard(unit: Unit, state: GameState | null | undefined): string {
  if (state) return statePackageForUnitOwner(state, unit.owner);
  const ut = config.unitTypes.find(t => t.id === unit.unitTypeId);
  return ut?.package ?? 'standard';
}

function boardUnitUpgradeStarCount(unit: Unit): number {
  const n =
    unit.upgradeAttack + unit.upgradeDefense + unit.upgradeFlanking + unit.upgradeHeal;
  return Math.min(5, Math.max(0, n));
}

function mapUnitHpFillColor(
  c: Colors,
  isSelected: boolean,
  isFriendly: boolean,
  friendlyMovementTired: boolean,
): string {
  if (isSelected) return c.boardUnitHpSelected;
  if (isFriendly) return friendlyMovementTired ? c.boardUnitHpFriendlyTired : c.boardUnitHpFriendly;
  return c.boardUnitHpEnemy;
}

interface MapUnitChipStyle {
  bodyFill: string;
  bodyStroke: string;
  bodyStrokeW: number;
  bracketStroke: string;
  bracketStrokeW: number;
  hpFill: string;
  iconColor: string;
}

function mapUnitChipStyle(
  c: Colors,
  opts: {
    isSelected: boolean;
    isFriendly: boolean;
    isRangedTarget: boolean;
    friendlyMovementTired: boolean;
  },
): MapUnitChipStyle {
  const bodyFill = c.boardUnitCardFill;
  const bodyStroke = opts.isSelected ? c.boardUnitBorderSelected : c.boardUnitBorder;
  const bodyStrokeW = opts.isSelected ? c.boardUnitBorderSelectedWidth : c.boardUnitBorderWidth;
  let bracketStroke = opts.isSelected ? c.boardUnitBracketSelected : c.boardUnitBracket;
  let bracketStrokeW = opts.isSelected ? c.boardUnitBracketSelectedWidth : c.boardUnitBracketWidth;
  if (opts.isRangedTarget && !opts.isSelected) {
    bracketStroke = c.rangedTarget;
    bracketStrokeW = Math.max(bracketStrokeW, 1.6);
  }
  const hpFill = mapUnitHpFillColor(
    c,
    opts.isSelected,
    opts.isFriendly,
    opts.friendlyMovementTired,
  );
  const iconColor = c.boardUnitIconSilhouette;
  return { bodyFill, bodyStroke, bodyStrokeW, bracketStroke, bracketStrokeW, hpFill, iconColor };
}

function boardUnitBracketsPathD(cx: number, cy: number, halfW: number, halfH: number, leg: number): string {
  const hw = halfW;
  const hh = halfH;
  const l = leg;
  return [
    `M ${cx - hw} ${cy - hh + l} L ${cx - hw} ${cy - hh} L ${cx - hw + l} ${cy - hh}`,
    `M ${cx + hw - l} ${cy - hh} L ${cx + hw} ${cy - hh} L ${cx + hw} ${cy - hh + l}`,
    `M ${cx - hw} ${cy + hh - l} L ${cx - hw} ${cy + hh} L ${cx - hw + l} ${cy + hh}`,
    `M ${cx + hw - l} ${cy + hh} L ${cx + hw} ${cy + hh} L ${cx + hw} ${cy + hh - l}`,
  ].join(' ');
}

function svgFactionImage(x: number, y: number, w: number, h: number, href: string): SVGImageElement {
  const im = svgEl('image');
  im.setAttribute('class', 'board-unit__faction');
  im.setAttribute('x', String(x));
  im.setAttribute('y', String(y));
  im.setAttribute('width', String(w));
  im.setAttribute('height', String(h));
  im.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  im.setAttribute('href', href);
  im.setAttributeNS('http://www.w3.org/1999/xlink', 'href', href);
  im.setAttribute('pointer-events', 'none');
  return im;
}

function appendBoardUnitStars(
  parent: SVGGElement,
  xCenter: number,
  starCenterY: number,
  starCount: number,
  starSize: number,
): void {
  if (starCount <= 0) return;
  const g = svgEl('g');
  g.setAttribute('class', 'board-unit__stars');
  g.setAttribute('pointer-events', 'none');
  const spacing = starSize * 1.2;
  const totalW = (starCount - 1) * spacing;
  for (let i = 0; i < starCount; i++) {
    const cx = xCenter - totalW / 2 + i * spacing;
    const starG = inlineIcon('icons/star.svg', cx, starCenterY, starSize, '#0a0a0a', '1');
    if (starG) g.appendChild(starG);
  }
  parent.appendChild(g);
}

/** Arguments for {@link mountBoardUnitChipContents} (hex grid + polygon territory). */
export interface MountBoardUnitChipParams {
  state: GameState;
  unit: Unit;
  localPlayer: Owner;
  /** Board pixel center (hex center or territory centroid). */
  x: number;
  y: number;
  dc: number;
  dr: number;
  displayHp: number;
  productionTiredVisual: boolean;
  rangedTargetKeys: Set<string>;
  localSpectatorInspectUnitId?: number | null;
  /** When false, skip ranged artillery aim decoration (optional). */
  showRangedAimOverlay?: boolean;
}

/** Clears `unitWrap` children and repaints the map unit chip (shield, brackets, faction, icon, stars, HP). */
export function mountBoardUnitChipContents(
  unitWrap: SVGGElement,
  p: MountBoardUnitChipParams,
): void {
  while (unitWrap.firstChild) unitWrap.removeChild(unitWrap.firstChild);

  const c = colors();
  const hpRatio = p.unit.maxHp > 0 ? Math.min(1, Math.max(0, p.displayHp / p.unit.maxHp)) : 0;
  const isSelected = unitIsVisuallySelectedForBoard(p.state, p.unit, p.localPlayer, p.localSpectatorInspectUnitId);
  const isRangedTarget = p.rangedTargetKeys.has(`${p.dc},${p.dr}`);
  const movementTired =
    p.state.phase === 'movement' &&
    p.state.activePlayer === p.unit.owner &&
    p.unit.movesUsed >= p.unit.movement;
  const tired = movementTired || p.productionTiredVisual;
  const isFriendly = p.unit.owner === p.localPlayer;
  const friendlyMovementTired = movementTired && isFriendly;
  const chip = mapUnitChipStyle(c, {
    isSelected,
    isFriendly,
    isRangedTarget,
    friendlyMovementTired,
  });
  const opacity = '1';
  const iconOpacity = tired ? String(config.tiredIconOpacity) : '1';
  const showAim = p.showRangedAimOverlay !== false;

  const sc = (HEX_SIZE * 1.1) / 50;
  const unitEl = svgEl('path');
  unitEl.setAttribute('class', 'board-unit__body');
  unitEl.setAttribute('d', BOARD_UNIT_SILHOUETTE_D);
  unitEl.setAttribute('fill', chip.bodyFill);
  unitEl.setAttribute('stroke', chip.bodyStroke);
  unitEl.setAttribute('stroke-width', String(chip.bodyStrokeW / sc));
  unitEl.setAttribute('opacity', opacity);
  unitEl.setAttribute('data-col', String(p.dc));
  unitEl.setAttribute('data-row', String(p.dr));
  unitEl.setAttribute('transform', `translate(${p.x - 25 * sc},${p.y - 32 * sc}) scale(${sc})`);
  unitEl.style.cursor = "url('/icons/pointer.svg') 13 14, pointer";
  unitWrap.appendChild(unitEl);

  const barW = HEX_SIZE * 0.74;
  const barH = HEX_SIZE * 0.1;
  const barX = p.x - barW / 1.83;
  const barY = p.y + HEX_SIZE * 0.38;

  const barBg = svgEl('rect');
  barBg.setAttribute('class', 'board-unit__hp-bg');
  barBg.setAttribute('x', String(barX));
  barBg.setAttribute('y', String(barY));
  barBg.setAttribute('width', String(barW));
  barBg.setAttribute('height', String(barH));
  barBg.setAttribute('pointer-events', 'none');
  barBg.setAttribute('opacity', opacity);
  unitWrap.appendChild(barBg);

  const barFill = svgEl('rect');
  barFill.setAttribute('class', 'board-unit__hp-fill');
  barFill.setAttribute('x', String(barX));
  barFill.setAttribute('y', String(barY));
  barFill.setAttribute('width', String(barW * hpRatio));
  barFill.setAttribute('height', String(barH));
  barFill.setAttribute('fill', chip.hpFill);
  barFill.setAttribute('pointer-events', 'none');
  barFill.setAttribute('opacity', opacity);
  unitWrap.appendChild(barFill);

  const iconCx = p.x - HEX_SIZE * 0.03;
  const iconCy = p.y - HEX_SIZE * 0.12;
  const bracketHalf = HEX_SIZE * 0.36;
  const bracketHalfH = HEX_SIZE * 0.4;
  const bracketLeg = HEX_SIZE * 0.2;
  const bracketPath = svgEl('path');
  bracketPath.setAttribute('class', 'board-unit__brackets');
  bracketPath.setAttribute('d', boardUnitBracketsPathD(iconCx, iconCy, bracketHalf, bracketHalfH, bracketLeg));
  bracketPath.setAttribute('fill', 'none');
  bracketPath.setAttribute('stroke', chip.bracketStroke);
  bracketPath.setAttribute('stroke-width', String(chip.bracketStrokeW));
  bracketPath.setAttribute('stroke-linecap', 'square');
  bracketPath.setAttribute('pointer-events', 'none');
  unitWrap.appendChild(bracketPath);

  const facHref = factionIconHrefFromPackage(packageForUnitOnBoard(p.unit, p.state));
  const facW = 11 * sc;
  const facX = p.x - 25 * sc + 2.5 * sc;
  const facY = p.y - 32 * sc + 2 * sc;
  unitWrap.appendChild(svgFactionImage(facX, facY, facW, facW, facHref));

  const icon = p.unit.icon ?? unitIcon(p.unit.unitTypeId);
  const iconEl = inlineIcon(icon, iconCx, iconCy, HEX_SIZE * 0.4, chip.iconColor, iconOpacity, 'board-unit__icon');
  if (iconEl) unitWrap.appendChild(iconEl);

  const starN = boardUnitUpgradeStarCount(p.unit);
  const starSize = HEX_SIZE * 0.14;
  const starY = p.y - 32 * sc - starSize * 0.55;
  appendBoardUnitStars(unitWrap, p.x, starY, starN, starSize);

  if (showAim && isRangedTarget) {
    const aim = inlineIcon('icons/artillery.svg', p.x, p.y - HEX_SIZE * 1, HEX_SIZE * 0.5, c.rangedTarget, opacity);
    if (aim) {
      const aimWrap = svgEl('g');
      aimWrap.setAttribute('class', 'ranged-target-aim');
      aimWrap.setAttribute('pointer-events', 'none');
      aimWrap.appendChild(aim);
      unitWrap.appendChild(aimWrap);
    }
  }
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

function syncSvgAttr(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

interface RenderDomCache {
  hexPolys: SVGPolygonElement[][];
  hexHitPolys: SVGPolygonElement[][];
  hexLayer: SVGGElement | null;
  unitLayer: SVGGElement | null;
  riverLayer: SVGGElement | null;
  mountainLayer: SVGGElement | null;
  controlPointLayer: SVGGElement | null;
  prodStrokeLayer: SVGGElement | null;
  sectorOutlineLayer: SVGGElement | null;
  sectorOutlineDefender: SVGPathElement | null;
  sectorOutlinePrimary: SVGPathElement | null;
  sectorOutlineSecondary: SVGPathElement | null;
  markerLayer: SVGGElement | null;
  moveBoundary: SVGPathElement | null;
}

const renderDomCacheBySvg = new WeakMap<SVGSVGElement, RenderDomCache>();
/** Persistent CP groups by hex key — cleared in {@link initRenderer} so nodes are not stale after rebuild. */
const controlPointGroupsBySvg = new WeakMap<SVGSVGElement, Map<string, SVGGElement>>();

export interface InitRendererOptions {
  /** When true (vs-human guest), mirror the board through its center (horizontal + vertical). */
  flipBoardY?: boolean;
}

export function initRenderer(svgElement: SVGSVGElement, options?: InitRendererOptions): void {
  document.getElementById('board-prod-marker-hover-style')?.remove();
  svgElement.innerHTML = '';
  controlPointGroupsBySvg.delete(svgElement);
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
  const boardId = svgElement.id || 'board';

  const sectorOutlineDefender = svgEl('path');
  sectorOutlineDefender.id = `${boardId}-sector-outline-defender`;
  sectorOutlineDefender.setAttribute('fill', 'none');
  sectorOutlineDefender.setAttribute('pointer-events', 'none');
  sectorOutlineDefender.setAttribute('display', 'none');
  sectorOutlineLayer.appendChild(sectorOutlineDefender);

  const sectorOutlinePrimary = svgEl('path');
  sectorOutlinePrimary.id = `${boardId}-sector-outline-primary`;
  sectorOutlinePrimary.setAttribute('fill', 'none');
  sectorOutlinePrimary.setAttribute('pointer-events', 'none');
  sectorOutlinePrimary.setAttribute('display', 'none');
  sectorOutlineLayer.appendChild(sectorOutlinePrimary);

  const sectorOutlineSecondary = svgEl('path');
  sectorOutlineSecondary.id = `${boardId}-sector-outline-secondary`;
  sectorOutlineSecondary.setAttribute('fill', 'none');
  sectorOutlineSecondary.setAttribute('pointer-events', 'none');
  sectorOutlineSecondary.setAttribute('display', 'none');
  sectorOutlineLayer.appendChild(sectorOutlineSecondary);

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
  const hexHitPolys: SVGPolygonElement[][] = [];
  for (let r = 0; r < ROWS; r++) {
    hexHitPolys[r] = [];
    for (let col = 0; col < COLS; col++) {
      const { x, y } = hexToPixel(col, r);
      const hit = svgEl('polygon');
      hit.setAttribute('id', `hex-hit-${col}-${r}`);
      hit.setAttribute('points', hexPoints(x, y));
      hit.setAttribute('data-col', String(col));
      hit.setAttribute('data-row', String(r));
      hit.setAttribute('fill', 'rgba(0,0,0,0)');
      hit.setAttribute('stroke', 'none');
      hit.setAttribute('pointer-events', 'all');
      hit.style.cursor = "url('/icons/pointer.svg') 13 14, pointer";
      hexHitLayer.appendChild(hit);
      hexHitPolys[r]![col] = hit;
    }
  }
  boardViewRoot.appendChild(hexHitLayer);

  renderDomCacheBySvg.set(svgElement, {
    hexPolys,
    hexHitPolys,
    hexLayer,
    unitLayer,
    riverLayer,
    mountainLayer,
    controlPointLayer,
    prodStrokeLayer,
    sectorOutlineLayer,
    sectorOutlineDefender,
    sectorOutlinePrimary,
    sectorOutlineSecondary,
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
  /** When `skipFogOfWar`, ignore {@link config.fogOfWar} (e.g. end-game turn recap). */
  renderOptions?: { skipFogOfWar?: boolean },
): void {
  const tRenderStart = performance.now();
  const trackHpBars = svgElement.id === 'board' && !unitDrawOverride;
  const now = performance.now();
  if (trackHpBars) syncHpBarAnimState(state, now);

  const stateTerritoryDraw: GameState =
    hexStatesDrawOverride != null ? { ...state, hexStates: hexStatesDrawOverride } : state;

  const c = colors();
  const visionKeys =
    config.fogOfWar && !renderOptions?.skipFogOfWar
      ? buildLocalPlayerVisionKeys(state.units, localPlayer, COLS, ROWS)
      : null;
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
  if (visionKeys) {
    for (const key of mountainSet) {
      if (visionKeys.has(key)) continue;
      const f = mountainTerritoryFillByKey.get(key);
      if (
        f === c.hexPlayer ||
        f === c.hexAi ||
        f === c.hexPlayerDimmed ||
        f === c.hexAiDimmed
      ) {
        mountainTerritoryFillByKey.set(key, c.hexFog);
      }
    }
  }

  let selectedUnit = state.selectedUnit !== null ? getUnitById(state, state.selectedUnit) : null;
  if (selectedUnit && selectedUnit.owner !== localPlayer) selectedUnit = null;
  // Opponent's turn + our unit id in selectedUnit: active player is inspecting our unit (multiplayer).
  // Do not show move highlights / selection on our board — that reads like we're moving.
  if (selectedUnit && state.activePlayer !== localPlayer && selectedUnit.owner === localPlayer) {
    selectedUnit = null;
  }

  /** Tint for unit shape only — hex/move overlays use `selectedUnit` above. */
  const isUnitVisuallySelected = (unit: Unit): boolean =>
    unitIsVisuallySelectedForBoard(state, unit, localPlayer, localSpectatorInspectUnitId);

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

      const inVision   = !visionKeys || visionKeys.has(key);
      const boardOverlay = isSelectedHex || isZoc || isValidMove || isProdSelected || canPlace;
      if (visionKeys && !inVision && !boardOverlay) {
        fill = c.hexFog;
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
      if (hexDimmed && hexState && inVision) {
        if (hexState.owner === localPlayer) fill = c.hexPlayerDimmed;
        else fill = c.hexAiDimmed;
      }
      const opacityDimmed = inVision && hexDimmed && fill !== c.hexPlayerDimmed && fill !== c.hexAiDimmed;
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

      const isProdPassThrough =
        state.phase === 'production' && state.activePlayer === localPlayer && canPlace && !isProdSelected;
      poly.classList.toggle('hex-prod-candidate', isProdPassThrough);
      const hit = domCache?.hexHitPolys?.[r]?.[col];
      if (hit) hit.setAttribute('pointer-events', isProdPassThrough ? 'none' : 'all');

      if (prodOverlayStroke && prodStrokeLayer) {
        const overlay = svgEl('polygon');
        overlay.setAttribute('points', poly.getAttribute('points') ?? '');
        overlay.setAttribute('fill', 'none');
        overlay.setAttribute('stroke', prodOverlayStroke);
        overlay.setAttribute('stroke-width', '2.5');
        overlay.setAttribute('stroke-dasharray', `${DASH} ${GAP}`);
        overlay.setAttribute('stroke-dashoffset', String(DASH_OFFSET));
        overlay.setAttribute('opacity', inVision && hexDimmed ? '0.2' : '1');
        overlay.setAttribute('pointer-events', 'none');
        prodStrokeLayer.appendChild(overlay);
      }
      poly.style.cursor = "url('/icons/pointer.svg') 13 14, auto";

      const markerParent =
        markerLayer ?? domCache?.hexLayer ?? (svgElement.querySelector('#hex-layer') as SVGGElement);

      if (
        inVision &&
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
  // Reuse the same path nodes so CSS animations (faction-frontline-secondary, etc.) do not restart every render.
  const sectorOutlineLayerEl = domCache?.sectorOutlineLayer ?? (svgElement.querySelector('#sector-outline-layer') as SVGGElement | null);
  const boardId = svgElement.id || 'board';
  const pathSectorDef =
    domCache?.sectorOutlineDefender ??
    (sectorOutlineLayerEl?.querySelector(`#${boardId}-sector-outline-defender`) as SVGPathElement | null);
  const pathSectorPrimary =
    domCache?.sectorOutlinePrimary ??
    (sectorOutlineLayerEl?.querySelector(`#${boardId}-sector-outline-primary`) as SVGPathElement | null);
  const pathSectorSecondary =
    domCache?.sectorOutlineSecondary ??
    (sectorOutlineLayerEl?.querySelector(`#${boardId}-sector-outline-secondary`) as SVGPathElement | null);

  if (sectorOutlineLayerEl && pathSectorDef && pathSectorPrimary && pathSectorSecondary) {
    const setSectorPathDisplay = (p: SVGPathElement, vis: boolean): void => {
      syncSvgAttr(p, 'display', vis ? 'inline' : 'none');
    };

    const hideSectorOutlines = (): void => {
      setSectorPathDisplay(pathSectorDef, false);
      setSectorPathDisplay(pathSectorPrimary, false);
      setSectorPathDisplay(pathSectorSecondary, false);
    };

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
        syncSvgAttr(pathSectorDef, 'd', dDef);
        syncSvgAttr(pathSectorDef, 'stroke', 'rgba(0,0,0,0.3)');
        syncSvgAttr(pathSectorDef, 'stroke-opacity', '0');
        syncSvgAttr(pathSectorDef, 'stroke-width', '2.5');
        syncSvgAttr(pathSectorDef, 'stroke-linejoin', 'round');
        syncSvgAttr(pathSectorDef, 'stroke-linecap', 'round');
        syncSvgAttr(pathSectorDef, 'pointer-events', 'none');
        syncSvgAttr(pathSectorDef, 'class', 'sector-outline sector-outline-defender-internal');
        setSectorPathDisplay(pathSectorDef, true);
      } else {
        setSectorPathDisplay(pathSectorDef, false);
      }

      const dInter = buildInterSectorBoundaryPath(state.sectorIndexByHex, state.sectorOwners, COLS, ROWS);
      if (dInter) {
        syncSvgAttr(pathSectorPrimary, 'd', dInter);
        syncSvgAttr(pathSectorSecondary, 'd', dInter);
        syncSvgAttr(pathSectorPrimary, 'fill', 'none');
        syncSvgAttr(pathSectorSecondary, 'fill', 'none');
        syncSvgAttr(pathSectorPrimary, 'stroke-width', '2');
        syncSvgAttr(pathSectorSecondary, 'stroke-width', '8');
        syncSvgAttr(pathSectorPrimary, 'stroke-linejoin', 'round');
        syncSvgAttr(pathSectorSecondary, 'stroke-linejoin', 'round');
        syncSvgAttr(pathSectorPrimary, 'stroke-linecap', 'round');
        syncSvgAttr(pathSectorSecondary, 'stroke-linecap', 'round');
        syncSvgAttr(pathSectorPrimary, 'pointer-events', 'none');
        syncSvgAttr(pathSectorSecondary, 'pointer-events', 'none');
        const clsPri =
          state.phase === 'production'
            ? 'sector-outline sector-outline-between faction-frontline faction-frontline--production'
            : 'sector-outline sector-outline-between faction-frontline';
        const clsSec =
          state.phase === 'production'
            ? 'sector-outline sector-outline-between faction-frontline-secondary faction-frontline-secondary--production'
            : 'sector-outline sector-outline-between faction-frontline-secondary';
        syncSvgAttr(pathSectorPrimary, 'class', clsPri);
        syncSvgAttr(pathSectorSecondary, 'class', clsSec);
        setSectorPathDisplay(pathSectorPrimary, true);
        setSectorPathDisplay(pathSectorSecondary, true);
      } else {
        setSectorPathDisplay(pathSectorPrimary, false);
        setSectorPathDisplay(pathSectorSecondary, false);
      }
    } else if (state.gameMode === 'conquest' || state.gameMode === 'domination') {
      setSectorPathDisplay(pathSectorDef, false);
      const dFaction = buildInterFactionBoundaryPath(
        stateTerritoryDraw.hexStates,
        mountainSet,
        mtnTerritoryCategoryByKey,
        COLS,
        ROWS,
      );
      if (dFaction) {
        syncSvgAttr(pathSectorPrimary, 'd', dFaction);
        syncSvgAttr(pathSectorSecondary, 'd', dFaction);
        syncSvgAttr(pathSectorPrimary, 'fill', 'none');
        syncSvgAttr(pathSectorSecondary, 'fill', 'none');
        syncSvgAttr(pathSectorPrimary, 'stroke-width', '2');
        syncSvgAttr(pathSectorSecondary, 'stroke-width', '8');
        syncSvgAttr(pathSectorPrimary, 'stroke-linejoin', 'round');
        syncSvgAttr(pathSectorSecondary, 'stroke-linejoin', 'round');
        syncSvgAttr(pathSectorPrimary, 'stroke-linecap', 'round');
        syncSvgAttr(pathSectorSecondary, 'stroke-linecap', 'round');
        syncSvgAttr(pathSectorPrimary, 'pointer-events', 'none');
        syncSvgAttr(pathSectorSecondary, 'pointer-events', 'none');
        const clsPri =
          state.phase === 'production'
            ? 'faction-frontline faction-frontline--production'
            : 'faction-frontline';
        const clsSec =
          state.phase === 'production'
            ? 'faction-frontline-secondary faction-frontline-secondary--production'
            : 'faction-frontline-secondary';
        syncSvgAttr(pathSectorPrimary, 'class', clsPri);
        syncSvgAttr(pathSectorSecondary, 'class', clsSec);
        setSectorPathDisplay(pathSectorPrimary, true);
        setSectorPathDisplay(pathSectorSecondary, true);
      } else {
        setSectorPathDisplay(pathSectorPrimary, false);
        setSectorPathDisplay(pathSectorSecondary, false);
      }
    } else {
      hideSectorOutlines();
    }
  }

  const controlPointLayer = domCache?.controlPointLayer ?? (svgElement.querySelector('#control-point-layer') as SVGGElement | null);
  if (controlPointLayer) {
    let cpMap = controlPointGroupsBySvg.get(svgElement);
    if (!cpMap) {
      cpMap = new Map();
      controlPointGroupsBySvg.set(svgElement, cpMap);
    }

    const cpKeys = state.controlPointHexes ?? [];
    const desiredKeys: string[] = [];
    for (const key of cpKeys) {
      if (mountainSet.has(key)) continue;
      if (visionKeys && !visionKeys.has(key)) continue;
      desiredKeys.push(key);
    }
    const desired = new Set(desiredKeys);

    for (const key of [...cpMap.keys()]) {
      if (!desired.has(key)) {
        cpMap.get(key)?.remove();
        cpMap.delete(key);
      }
    }

    const iw = HEX_SIZE * 0.5;
    const ih = HEX_SIZE * 0.5;
    const cpStrokeW = '2.5';

    for (const key of desiredKeys) {
      const [mc, mr] = key.split(',').map(Number);
      const { x, y } = hexToPixel(mc, mr);
      let ringStroke = '#6B6B6B';
      if (state.gameMode === 'breakthrough' && state.sectorOwners?.length && state.sectorIndexByHex) {
        const sid = state.sectorIndexByHex[key];
        if (sid !== undefined && state.sectorOwners[sid] !== undefined) {
          ringStroke = paletteBaseForOwner(state.sectorOwners[sid]!, localPlayer, c);
        }
      }

      let root = cpMap.get(key);
      if (!root) {
        root = svgEl('g');
        root.setAttribute('data-cp-key', key);
        root.setAttribute('pointer-events', 'none');

        const ring = svgEl('polygon');
        ring.setAttribute('class', 'control-point-ring');
        ring.setAttribute('fill', 'none');
        ring.setAttribute('stroke-linejoin', 'round');
        ring.setAttribute('pointer-events', 'none');

        const img = svgEl('image');
        img.setAttribute('href', '/icons/control-point.svg');
        img.setAttribute('pointer-events', 'none');

        if (flipBoardY) {
          const upright = svgUprightAt(x, y);
          upright.appendChild(ring);
          upright.appendChild(img);
          root.appendChild(upright);
        } else {
          root.appendChild(ring);
          root.appendChild(img);
        }
        controlPointLayer.appendChild(root);
        cpMap.set(key, root);
      }

      const ringEl = root.querySelector('.control-point-ring') as SVGPolygonElement | null;
      const imgEl = root.querySelector('image') as SVGImageElement | null;
      if (ringEl) {
        const pts = hexPoints(x, y);
        syncSvgAttr(ringEl, 'points', pts);
        syncSvgAttr(ringEl, 'stroke', ringStroke);
        syncSvgAttr(ringEl, 'stroke-width', cpStrokeW);
      }
      if (imgEl) {
        syncSvgAttr(imgEl, 'x', String(x - iw / 2));
        syncSvgAttr(imgEl, 'y', String(y - ih / 2));
        syncSvgAttr(imgEl, 'width', String(iw));
        syncSvgAttr(imgEl, 'height', String(ih));
      }
      if (flipBoardY) {
        const upright = root.firstElementChild as SVGGElement | null;
        if (upright) {
          const tr = `translate(${x},${y}) scale(-1,-1) translate(${-x},${-y})`;
          syncSvgAttr(upright, 'transform', tr);
        }
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
    if (
      visionKeys &&
      unit.owner !== localPlayer &&
      !visionKeys.has(`${unit.col},${unit.row}`)
    ) {
      continue;
    }
    const dc = unit.col;
    const dr = unit.row;
    const { x, y } = hexToPixel(dc, dr);

    const unitRoot = flipBoardY ? svgUprightAt(x, y) : null;
    if (unitRoot) unitLayer.appendChild(unitRoot);
    const uParent: SVGGElement = unitRoot ?? unitLayer;

    const unitWrap = svgEl('g');
    unitWrap.setAttribute('class', 'board-unit');
    unitWrap.setAttribute('data-col', String(dc));
    unitWrap.setAttribute('data-row', String(dr));
    uParent.appendChild(unitWrap);

    mountBoardUnitChipContents(unitWrap, {
      state,
      unit,
      localPlayer,
      x,
      y,
      dc,
      dr,
      displayHp: displayHpByUnit.get(unit.id) ?? unit.hp,
      productionTiredVisual: productionFocusHexes.size > 0,
      rangedTargetKeys,
      localSpectatorInspectUnitId,
    });
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
  /** When set, move paths use territory centroids (polygon maps) instead of {@link hexToPixel}. */
  territoryGraph?: TerritoryGraphData | null,
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
    const pixelPath = pixelPathForAnimation(anim, territoryGraph);

    const spriteRoot = flipBoardY ? svgEl('g') : null;
    const layer: SVGGElement = spriteRoot ?? animLayer!;
    if (spriteRoot) animLayer!.appendChild(spriteRoot);

    const unitSc = (HEX_SIZE * 1.1) / 50;
    const unitWrap = svgEl('g');
    unitWrap.setAttribute('class', 'board-unit board-unit--moving');
    layer.appendChild(unitWrap);

    const chipFromLive = (st: GameState | null | undefined, u: Unit, _nowMs: number): MapUnitChipStyle => {
      const liveU = st ? getUnitById(st, u.id) : null;
      const movesUsed = liveU?.movesUsed ?? u.movesUsed;
      const stForSel = st;
      const isSelected = stForSel ? unitIsVisuallySelectedForBoard(stForSel, u, localPlayer, null) : false;
      const isFriendly = u.owner === localPlayer;
      const friendlyMt =
        !!st &&
        st.phase === 'movement' &&
        st.activePlayer === u.owner &&
        movesUsed >= u.movement &&
        isFriendly;
      return mapUnitChipStyle(c, {
        isSelected,
        isFriendly,
        isRangedTarget: false,
        friendlyMovementTired: friendlyMt,
      });
    };

    const chip0 = chipFromLive(liveStateForHp ?? null, anim.unit, performance.now());

    const unitBody = svgEl('path');
    unitBody.setAttribute('class', 'board-unit__body');
    unitBody.setAttribute('d', BOARD_UNIT_SILHOUETTE_D);
    unitBody.setAttribute('fill', chip0.bodyFill);
    unitBody.setAttribute('stroke', chip0.bodyStroke);
    unitBody.setAttribute('stroke-width', String(chip0.bodyStrokeW / unitSc));
    unitBody.setAttribute('pointer-events', 'none');
    unitWrap.appendChild(unitBody);

    const animBarW = HEX_SIZE * 0.58;
    const barH = HEX_SIZE * 0.1;
    const barBg = svgEl('rect');
    barBg.setAttribute('class', 'board-unit__hp-bg');
    barBg.setAttribute('width', String(animBarW)); barBg.setAttribute('height', String(barH));
    barBg.setAttribute('pointer-events', 'none');
    unitWrap.appendChild(barBg);

    const live0 = liveStateForHp ? getUnitById(liveStateForHp, anim.unit.id) : null;
    const maxHp0 = live0?.maxHp ?? anim.unit.maxHp;
    const displayHp0 = live0 ? getBoardVisualHp(live0, performance.now()) : anim.unit.hp;
    const hpRatio0 = maxHp0 > 0 ? Math.min(1, Math.max(0, displayHp0 / maxHp0)) : 0;
    const barFill = svgEl('rect');
    barFill.setAttribute('class', 'board-unit__hp-fill');
    barFill.setAttribute('width', String(animBarW * hpRatio0)); barFill.setAttribute('height', String(barH));
    barFill.setAttribute('fill', chip0.hpFill);
    barFill.setAttribute('pointer-events', 'none');
    unitWrap.appendChild(barFill);

    const hex0 = boardPixelForMoveAnim(anim.fromCol, anim.fromRow, territoryGraph);
    const iconCx0 = hex0.x;
    const iconCy0 = hex0.y - HEX_SIZE * 0.34;
    const bracketHalf = HEX_SIZE * 0.22;
    const bracketHalfH = HEX_SIZE * 0.42;
    const bracketLeg = HEX_SIZE * 0.11;
    const bracketPath = svgEl('path');
    bracketPath.setAttribute('class', 'board-unit__brackets');
    bracketPath.setAttribute('d', boardUnitBracketsPathD(iconCx0, iconCy0, bracketHalf, bracketHalfH, bracketLeg));
    bracketPath.setAttribute('fill', 'none');
    bracketPath.setAttribute('stroke', chip0.bracketStroke);
    bracketPath.setAttribute('stroke-width', String(chip0.bracketStrokeW));
    bracketPath.setAttribute('stroke-linecap', 'square');
    bracketPath.setAttribute('pointer-events', 'none');
    unitWrap.appendChild(bracketPath);

    const facHref = factionIconHrefFromPackage(packageForUnitOnBoard(anim.unit, liveStateForHp));
    const facW = 11 * unitSc;
    const factionImg = svgFactionImage(
      hex0.x - 25 * unitSc + 2.5 * unitSc,
      hex0.y - 32 * unitSc + 2 * unitSc,
      facW,
      facW,
      facHref,
    );
    unitWrap.appendChild(factionImg);

    const iconSrc = anim.unit.icon ?? unitIcon(anim.unit.unitTypeId);
    const iconSize = HEX_SIZE * 0.4;
    const iconEl = inlineIcon(iconSrc, 0, 0, iconSize, chip0.iconColor, '1', 'board-unit__icon');
    const iconWrapper = svgEl('g');
    iconWrapper.setAttribute('pointer-events', 'none');
    if (iconEl) iconWrapper.appendChild(iconEl);
    unitWrap.appendChild(iconWrapper);

    const starN = boardUnitUpgradeStarCount(anim.unit);
    const starSize = HEX_SIZE * 0.14;
    const starsOuter = svgEl('g');
    starsOuter.setAttribute('class', 'board-unit__stars');
    starsOuter.setAttribute('pointer-events', 'none');
    if (starN > 0) {
      const spacing = starSize * 1.2;
      const totalW = (starN - 1) * spacing;
      for (let si = 0; si < starN; si++) {
        const lx = -totalW / 2 + si * spacing;
        const sg = inlineIcon('icons/star.svg', lx, 0, starSize, '#0a0a0a', '1');
        if (sg) starsOuter.appendChild(sg);
      }
      unitWrap.appendChild(starsOuter);
    }

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
      const chip = chipFromLive(liveStateForHp ?? null, anim.unit, now);
      barFill.setAttribute('width', String(animBarW * hpRatio));
      barFill.setAttribute('fill', chip.hpFill);
      unitBody.setAttribute('fill', chip.bodyFill);
      unitBody.setAttribute('stroke', chip.bodyStroke);
      unitBody.setAttribute('stroke-width', String(chip.bodyStrokeW / unitSc));
      bracketPath.setAttribute('stroke', chip.bracketStroke);
      bracketPath.setAttribute('stroke-width', String(chip.bracketStrokeW));

      const iconCx = x;
      const iconCy = y - HEX_SIZE * 0.34;
      bracketPath.setAttribute('d', boardUnitBracketsPathD(iconCx, iconCy, bracketHalf, bracketHalfH, bracketLeg));
      factionImg.setAttribute('x', String(x - 25 * unitSc + 2.5 * unitSc));
      factionImg.setAttribute('y', String(y - 32 * unitSc + 2 * unitSc));
      factionImg.setAttribute('width', String(facW));
      factionImg.setAttribute('height', String(facW));
      if (starN > 0) {
        starsOuter.setAttribute('transform', `translate(${x},${y - 32 * unitSc - starSize * 0.55})`);
      }

      if (spriteRoot) {
        spriteRoot.setAttribute('transform', `translate(${x},${y}) scale(-1,-1) translate(${-x},${-y})`);
      }
      unitBody.setAttribute('transform', `translate(${x - 25 * unitSc},${y - 32 * unitSc}) scale(${unitSc})`);
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
          unitWrap.remove();
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
  territoryGraph?: TerritoryGraphData | null,
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
    boardPixelForMoveAnim(fromCol, fromRow, territoryGraph),
    boardPixelForMoveAnim(enemyCol, enemyRow, territoryGraph),
    boardPixelForMoveAnim(fromCol, fromRow, territoryGraph),
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

  const chipFromLiveStrike = (st: GameState | null | undefined, u: Unit, _now: number): MapUnitChipStyle => {
    const liveU = st ? getUnitById(st, u.id) : null;
    const movesUsed = liveU?.movesUsed ?? u.movesUsed;
    const isSelected = st ? unitIsVisuallySelectedForBoard(st, u, localPlayer, null) : false;
    const isFriendly = u.owner === localPlayer;
    const friendlyMt =
      !!st &&
      st.phase === 'movement' &&
      st.activePlayer === u.owner &&
      movesUsed >= u.movement &&
      isFriendly;
    return mapUnitChipStyle(c, {
      isSelected,
      isFriendly,
      isRangedTarget: false,
      friendlyMovementTired: friendlyMt,
    });
  };

  const live0 = liveStateForHp ? getUnitById(liveStateForHp, unit.id) : null;
  const maxHp0 = live0?.maxHp ?? unit.maxHp;
  const displayHp0 = live0 ? getBoardVisualHp(live0, performance.now()) : unit.hp;
  const hpRatio0 = maxHp0 > 0 ? Math.min(1, Math.max(0, displayHp0 / maxHp0)) : 0;
  const unitSc = (HEX_SIZE * 1.1) / 50;
  const chip0 = chipFromLiveStrike(liveStateForHp ?? null, unit, performance.now());

  const unitWrap = svgEl('g');
  unitWrap.setAttribute('class', 'board-unit board-unit--moving');
  layer.appendChild(unitWrap);

  const unitBody = svgEl('path');
  unitBody.setAttribute('class', 'board-unit__body');
  unitBody.setAttribute('d', BOARD_UNIT_SILHOUETTE_D);
  unitBody.setAttribute('fill', chip0.bodyFill);
  unitBody.setAttribute('stroke', chip0.bodyStroke);
  unitBody.setAttribute('stroke-width', String(chip0.bodyStrokeW / unitSc));
  unitBody.setAttribute('pointer-events', 'none');
  unitWrap.appendChild(unitBody);

  const animBarW = HEX_SIZE * 0.58;
  const barH = HEX_SIZE * 0.1;
  const barBg = svgEl('rect');
  barBg.setAttribute('class', 'board-unit__hp-bg');
  barBg.setAttribute('width', String(animBarW));
  barBg.setAttribute('height', String(barH));
  barBg.setAttribute('pointer-events', 'none');
  unitWrap.appendChild(barBg);

  const barFill = svgEl('rect');
  barFill.setAttribute('class', 'board-unit__hp-fill');
  barFill.setAttribute('width', String(animBarW * hpRatio0));
  barFill.setAttribute('height', String(barH));
  barFill.setAttribute('fill', chip0.hpFill);
  barFill.setAttribute('pointer-events', 'none');
  unitWrap.appendChild(barFill);

  const hex0 = boardPixelForMoveAnim(fromCol, fromRow, territoryGraph);
  const iconCx0 = hex0.x;
  const iconCy0 = hex0.y - HEX_SIZE * 0.34;
  const bracketHalf = HEX_SIZE * 0.22;
  const bracketHalfH = HEX_SIZE * 0.42;
  const bracketLeg = HEX_SIZE * 0.11;
  const bracketPath = svgEl('path');
  bracketPath.setAttribute('class', 'board-unit__brackets');
  bracketPath.setAttribute('d', boardUnitBracketsPathD(iconCx0, iconCy0, bracketHalf, bracketHalfH, bracketLeg));
  bracketPath.setAttribute('fill', 'none');
  bracketPath.setAttribute('stroke', chip0.bracketStroke);
  bracketPath.setAttribute('stroke-width', String(chip0.bracketStrokeW));
  bracketPath.setAttribute('stroke-linecap', 'square');
  bracketPath.setAttribute('pointer-events', 'none');
  unitWrap.appendChild(bracketPath);

  const facHref = factionIconHrefFromPackage(packageForUnitOnBoard(unit, liveStateForHp));
  const facW = 11 * unitSc;
  const factionImg = svgFactionImage(
    hex0.x - 25 * unitSc + 2.5 * unitSc,
    hex0.y - 32 * unitSc + 2 * unitSc,
    facW,
    facW,
    facHref,
  );
  unitWrap.appendChild(factionImg);

  const iconSrc = unit.icon ?? unitIcon(unit.unitTypeId);
  const iconSize = HEX_SIZE * 0.4;
  const iconEl = inlineIcon(iconSrc, 0, 0, iconSize, chip0.iconColor, '1', 'board-unit__icon');
  const iconWrapper = svgEl('g');
  iconWrapper.setAttribute('pointer-events', 'none');
  if (iconEl) iconWrapper.appendChild(iconEl);
  unitWrap.appendChild(iconWrapper);

  const starN = boardUnitUpgradeStarCount(unit);
  const starSize = HEX_SIZE * 0.14;
  const starsOuter = svgEl('g');
  starsOuter.setAttribute('class', 'board-unit__stars');
  starsOuter.setAttribute('pointer-events', 'none');
  if (starN > 0) {
    const spacing = starSize * 1.2;
    const totalW = (starN - 1) * spacing;
    for (let si = 0; si < starN; si++) {
      const lx = -totalW / 2 + si * spacing;
      const sg = inlineIcon('icons/star.svg', lx, 0, starSize, '#0a0a0a', '1');
      if (sg) starsOuter.appendChild(sg);
    }
    unitWrap.appendChild(starsOuter);
  }

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
    const chip = chipFromLiveStrike(liveStateForHp ?? null, unit, now);
    barFill.setAttribute('width', String(animBarW * hpRatio));
    barFill.setAttribute('fill', chip.hpFill);
    unitBody.setAttribute('fill', chip.bodyFill);
    unitBody.setAttribute('stroke', chip.bodyStroke);
    unitBody.setAttribute('stroke-width', String(chip.bodyStrokeW / unitSc));
    bracketPath.setAttribute('stroke', chip.bracketStroke);
    bracketPath.setAttribute('stroke-width', String(chip.bracketStrokeW));

    const iconCx = x;
    const iconCy = y - HEX_SIZE * 0.34;
    bracketPath.setAttribute('d', boardUnitBracketsPathD(iconCx, iconCy, bracketHalf, bracketHalfH, bracketLeg));
    factionImg.setAttribute('x', String(x - 25 * unitSc + 2.5 * unitSc));
    factionImg.setAttribute('y', String(y - 32 * unitSc + 2 * unitSc));
    factionImg.setAttribute('width', String(facW));
    factionImg.setAttribute('height', String(facW));
    if (starN > 0) {
      starsOuter.setAttribute('transform', `translate(${x},${y - 32 * unitSc - starSize * 0.55})`);
    }

    if (spriteRoot) {
      spriteRoot.setAttribute('transform', `translate(${x},${y}) scale(-1,-1) translate(${-x},${-y})`);
    }
    unitBody.setAttribute('transform', `translate(${x - 25 * unitSc},${y - 32 * unitSc}) scale(${unitSc})`);
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
        unitWrap.remove();
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
  territoryGraph?: TerritoryGraphData | null,
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
    const { x, y } = boardPixelForMoveAnim(e.col, e.row, territoryGraph);
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
  territoryGraph?: TerritoryGraphData | null,
): { cancel: () => void } {
  return showHexFloatBadges(svgElement, entries, durationMs, onDone, 'damage', territoryGraph);
}

/** Green +N badges for end-of-turn healing (same motion/layout as damage floats). */
export function showHealFloats(
  svgElement: SVGSVGElement,
  entries: { col: number; row: number; amount: number }[],
  durationMs: number,
  onDone: () => void,
  territoryGraph?: TerritoryGraphData | null,
): { cancel: () => void } {
  return showHexFloatBadges(svgElement, entries, durationMs, onDone, 'heal', territoryGraph);
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
  territoryGraph?: TerritoryGraphData | null,
): ArtilleryProjectileHandle {
  let vfxLayer = svgElement.querySelector('#vfx-layer') as SVGGElement | null;
  if (!vfxLayer) {
    vfxLayer = svgEl('g');
    vfxLayer.id = 'vfx-layer';
    vfxLayer.setAttribute('pointer-events', 'none');
    getBoardVfxParent(svgElement).appendChild(vfxLayer);
  }
  const { x, y } = boardPixelForMoveAnim(col, row, territoryGraph);
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
