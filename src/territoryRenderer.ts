/**
 * Territory-based SVG renderer for polygon maps.
 * Uses the exact same CSS classes and SVG elements as the map editor for a 1:1 visual match.
 * Requires mapEditor.css (loaded via index.html).
 */

import type { GameState, HexState, Owner, Unit } from './types';
import type { TerritoryGraphData, TerritoryMapTerritory, TerritoryMapDef } from './territoryMap';
import { computeRedundantPartitionParentIds } from './territoryMap';
import {
  getValidMoves,
  isValidProductionPlacement,
  getRangedAttackTargets,
  PLAYER,
  AI,
  getUnit,
  isInEnemyZoC,
  getBoardNeighbors,
  getOpponentHomeGuardBlockedHexes,
} from './game';
import { ensureMovePathPreviewLayer, inlineIcon, mountBoardUnitChipContents } from './renderer';
import mountainPatternSrc from '../public/images/misc/mountain-pattern.png';
import outsideBorderPatternSrc from '../public/images/misc/outside-border-pattern.png';
import zocPatternSrc from '../public/images/misc/zoc-pattern.png';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Match `#board` / `renderer.ts` so SVG territory hits use the app pointer art, not the OS cursor. */
const TERRITORY_HOVER_CURSOR = "url('/icons/pointer.svg') 13 14, pointer";
const TERRITORY_MOUNTAIN_CURSOR = "url('/icons/pointer.svg') 13 14, default";

// Game-specific highlight colors (no map-editor equivalent)
const STROKE_WIDTH_HIGHLIGHT = 2;
/** Territory production marker: `public/icons/plus.svg` (preloaded in main via loadIconDefs). */
const PROD_PLACEMENT_ICON_SRC = 'icons/plus.svg';
const PROD_PLACEMENT_ICON_PX = 18;

interface RendererState {
  graph: TerritoryGraphData;
  edgeTerritoryIndex: Map<string, string[]>;
}

const rendererStateMap = new WeakMap<SVGSVGElement, RendererState>();
const rangedGlowMapTr = new WeakMap<SVGSVGElement, Map<string, SVGPolygonElement>>();

/** Optional draw overrides for move / combat animation frames (mirrors {@link renderState} ideas). */
export interface RenderTerritoryStateOptions {
  unitDrawOverride?: readonly Unit[] | null;
  hexStatesDrawOverride?: Record<string, HexState> | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mksvg<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
}

function setAttrIfChanged(el: SVGElement, attr: string, value: string): void {
  if (el.getAttribute(attr) !== value) el.setAttribute(attr, value);
}

/** Dashed inter-sector lines and “breakthrough only” designer notes follow the current game mode. */
function syncTerritoryMapModeDecorations(svgElement: SVGSVGElement, state: GameState): void {
  const isBreakthrough = state.gameMode === 'breakthrough';

  const sectorBorderLayer = svgElement.querySelector('#ev2-sector-border-layer') as SVGGElement | null;
  if (sectorBorderLayer) {
    if (isBreakthrough) {
      if (sectorBorderLayer.getAttribute('display') === 'none') sectorBorderLayer.removeAttribute('display');
    } else {
      if (sectorBorderLayer.getAttribute('display') !== 'none') sectorBorderLayer.setAttribute('display', 'none');
    }
  }

  const noteLayer = svgElement.querySelector('#ev2-note-layer') as SVGGElement | null;
  if (noteLayer) {
    for (const child of Array.from(noteLayer.children)) {
      const g = child as SVGGElement;
      const v = g.getAttribute('data-note-visibility') ?? 'always';
      const hide = v === 'breakthroughOnly' && !isBreakthrough;
      if (hide) {
        if (g.getAttribute('display') !== 'none') g.setAttribute('display', 'none');
      } else {
        if (g.getAttribute('display') === 'none') g.removeAttribute('display');
      }
    }
  }
}

function undirectedEdgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function territoryPointsAttr(t: TerritoryMapTerritory, points: Record<string, { x: number; y: number }>): string {
  return t.pointIds
    .map(pid => points[pid])
    .filter((p): p is { x: number; y: number } => !!p)
    .map(p => `${p.x},${p.y}`)
    .join(' ');
}

function territoryPathD(t: TerritoryMapTerritory, points: Record<string, { x: number; y: number }>): string {
  const coords = t.pointIds.map(pid => points[pid]).filter((p): p is { x: number; y: number } => !!p);
  if (coords.length < 2) return '';
  return coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + ' Z';
}

function computeMapExtents(pts: Record<string, { x: number; y: number }>): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pt of Object.values(pts)) {
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Build edge-key → [territory-ids] index from territory polygon edge pairs. */
function buildEdgeTerritoryIndex(mapDef: TerritoryMapDef): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const t of mapDef.territories) {
    const n = t.pointIds.length;
    for (let i = 0; i < n; i++) {
      const a = t.pointIds[i]!;
      const b = t.pointIds[(i + 1) % n]!;
      const key = undirectedEdgeKey(a, b);
      const list = index.get(key);
      if (list) { if (!list.includes(t.id)) list.push(t.id); }
      else index.set(key, [t.id]);
    }
  }
  return index;
}

/**
 * Build the outer perimeter SVG path — edges touching exactly one territory.
 * The resulting path is stroked with the outer-border pattern at 144px width,
 * matching the map editor's perimeter rendering.
 */
function buildOuterBorderPath(
  mapDef: TerritoryMapDef,
  points: Record<string, { x: number; y: number }>,
  edgeTerritoryIndex: Map<string, string[]>,
): string {
  const redundantPartitionParentIds = computeRedundantPartitionParentIds(mapDef);
  // Collect outer edge point-id keys
  const allKeys = new Set<string>();
  for (const t of mapDef.territories) {
    const n = t.pointIds.length;
    for (let i = 0; i < n; i++) allKeys.add(undirectedEdgeKey(t.pointIds[i]!, t.pointIds[(i + 1) % n]!));
  }

  const outerKeys: string[] = [];
  for (const key of allKeys) {
    const tids = edgeTerritoryIndex.get(key);
    const effective = tids?.filter((tid) => !redundantPartitionParentIds.has(tid)) ?? [];
    if (effective.length === 1) outerKeys.push(key);
  }
  if (outerKeys.length === 0) return '';

  // Build point adjacency for chaining outer segments into polylines
  const adj = new Map<string, string[]>();
  for (const key of outerKeys) {
    const [pa, pb] = key.split('|') as [string, string];
    if (!adj.has(pa)) adj.set(pa, []);
    if (!adj.has(pb)) adj.set(pb, []);
    adj.get(pa)!.push(pb);
    adj.get(pb)!.push(pa);
  }

  const visited = new Set<string>();
  let d = '';

  for (const key of outerKeys) {
    const [startPid] = key.split('|') as [string, string];
    if (visited.has(startPid)) continue;

    const chain: string[] = [startPid];
    visited.add(startPid);
    let cur = startPid;
    let prevId: string | null = null;

    while (true) {
      const next = (adj.get(cur) ?? []).find(id => id !== prevId && !visited.has(id));
      if (!next) break;
      visited.add(next);
      prevId = cur;
      cur = next;
      chain.push(cur);
    }

    const closed = (adj.get(chain[chain.length - 1]!) ?? []).includes(chain[0]!);
    if (chain.length >= 2) {
      const pts = chain.map(pid => points[pid]).filter((p): p is { x: number; y: number } => !!p);
      d += `M ${pts[0]!.x},${pts[0]!.y}`;
      for (let i = 1; i < pts.length; i++) d += ` L ${pts[i]!.x},${pts[i]!.y}`;
      if (closed) d += ' Z';
    }
  }

  return d;
}

/**
 * Build the inset border path for a territory, ported directly from the map editor's
 * buildInsetBorderPath. Edges shared with same-owner neighbors are suppressed.
 */
function buildInsetBorderPath(
  t: TerritoryMapTerritory,
  edgeTerritoryIndex: Map<string, string[]>,
  points: Record<string, { x: number; y: number }>,
  inset: number,
  suppressEdge: (neighborTid: string | null) => boolean,
): string {
  const tPts = t.pointIds.map(pid => points[pid]).filter((p): p is { x: number; y: number } => !!p);
  const n = tPts.length;
  if (n < 3) return '';

  // Signed area (SVG y-down): positive = CW → right normal points inward
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = tPts[i]!, b = tPts[(i + 1) % n]!;
    area += a.x * b.y - b.x * a.y;
  }
  const cw = area > 0 ? 1 : -1;

  const edgePairs: [string, string][] = t.pointIds.map((id, i) => [id, t.pointIds[(i + 1) % t.pointIds.length]!]);

  const suppressed = edgePairs.map(([aId, bId]) => {
    const key = undirectedEdgeKey(aId, bId);
    const tids = edgeTerritoryIndex.get(key);
    const neighborTid = tids?.find(tid => tid !== t.id) ?? null;
    return suppressEdge(neighborTid);
  });

  type OE = { ax: number; ay: number; bx: number; by: number };
  const off: OE[] = edgePairs.map(([aId, bId]) => {
    const pa = points[aId], pb = points[bId];
    if (!pa || !pb) return { ax: 0, ay: 0, bx: 0, by: 0 };
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.5) return { ax: pa.x, ay: pa.y, bx: pb.x, by: pb.y };
    const nx = cw * dy / len, ny = cw * -dx / len;
    return { ax: pa.x + nx * inset, ay: pa.y + ny * inset, bx: pb.x + nx * inset, by: pb.y + ny * inset };
  });

  function miterJoin(i: number, j: number): { x: number; y: number } | null {
    const o1 = off[i]!, o2 = off[j]!;
    const dx1 = o1.bx - o1.ax, dy1 = o1.by - o1.ay;
    const dx2 = o2.bx - o2.ax, dy2 = o2.by - o2.ay;
    const denom = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(denom) < 0.001) return null;
    const param = ((o2.ax - o1.ax) * dy2 - (o2.ay - o1.ay) * dx2) / denom;
    if (param < -2 || param > 3) return null;
    return { x: o1.ax + param * dx1, y: o1.ay + param * dy1 };
  }

  if (suppressed.every(s => !s)) {
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const jp = miterJoin(i, j);
      if (jp) { pts.push(jp); } else { pts.push({ x: off[i]!.bx, y: off[i]!.by }); pts.push({ x: off[j]!.ax, y: off[j]!.ay }); }
    }
    return 'M ' + pts.map(p => `${p.x},${p.y}`).join(' L ') + ' Z';
  }

  // Mixed suppression → open sub-paths per run of non-suppressed edges
  let pathD = '';
  for (let start = 0; start < n; start++) {
    if (suppressed[start] || !suppressed[(start - 1 + n) % n]) continue;
    const pts: { x: number; y: number }[] = [{ x: off[start]!.ax, y: off[start]!.ay }];
    let i = start;
    while (true) {
      const next = (i + 1) % n;
      if (suppressed[next] || next === start) { pts.push({ x: off[i]!.bx, y: off[i]!.by }); break; }
      const jp = miterJoin(i, next);
      if (jp) { pts.push(jp); } else { pts.push({ x: off[i]!.bx, y: off[i]!.by }); pts.push({ x: off[next]!.ax, y: off[next]!.ay }); }
      i = next;
    }
    if (pts.length >= 2) pathD += 'M ' + pts.map(p => `${p.x},${p.y}`).join(' L ') + ' ';
  }
  return pathD;
}

// ── initTerritoryRenderer ─────────────────────────────────────────────────────

export function initTerritoryRenderer(svgEl: SVGSVGElement, graph: TerritoryGraphData): void {
  svgEl.innerHTML = '';

  const { mapDef, points } = graph;
  const { minX, minY, maxX, maxY } = computeMapExtents(points);
  // 80px padding so the 72px outer-border pattern overhang is fully visible
  const pad = 80;
  svgEl.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`);
  svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svgEl.setAttribute('width', String(maxX - minX + 2 * pad));
  svgEl.setAttribute('height', String(maxY - minY + 2 * pad));
  svgEl.style.overflow = 'visible';

  const edgeTerritoryIndex = buildEdgeTerritoryIndex(mapDef);
  const redundantPartitionParentIds = computeRedundantPartitionParentIds(mapDef);

  // ── Defs — same pattern IDs as map editor so CSS fill references resolve ──────
  const defs = mksvg('defs');
  svgEl.appendChild(defs);

  const outerPattern = mksvg('pattern');
  outerPattern.id = 'ev2-outer-border-pattern';
  outerPattern.setAttribute('patternUnits', 'userSpaceOnUse');
  outerPattern.setAttribute('width', '48');
  outerPattern.setAttribute('height', '48');
  const outerImg = mksvg('image');
  outerImg.setAttribute('href', outsideBorderPatternSrc);
  outerImg.setAttribute('width', '48');
  outerImg.setAttribute('height', '48');
  outerPattern.appendChild(outerImg);
  defs.appendChild(outerPattern);

  const mountainPattern = mksvg('pattern');
  mountainPattern.id = 'ev2-mountain-pattern';
  mountainPattern.setAttribute('patternUnits', 'userSpaceOnUse');
  mountainPattern.setAttribute('width', '60');
  mountainPattern.setAttribute('height', '60');
  const mountainImg = mksvg('image');
  mountainImg.setAttribute('href', mountainPatternSrc);
  mountainImg.setAttribute('width', '60');
  mountainImg.setAttribute('height', '60');
  mountainPattern.appendChild(mountainImg);
  defs.appendChild(mountainPattern);

  const zocPattern = mksvg('pattern');
  zocPattern.id = 'ev2-zoc-pattern';
  zocPattern.setAttribute('patternUnits', 'userSpaceOnUse');
  zocPattern.setAttribute('width', '60');
  zocPattern.setAttribute('height', '60');
  const zocImg = mksvg('image');
  zocImg.setAttribute('href', zocPatternSrc);
  zocImg.setAttribute('width', '60');
  zocImg.setAttribute('height', '60');
  zocPattern.appendChild(zocImg);
  defs.appendChild(zocPattern);

  const prodEnemyHatch = mksvg('pattern');
  prodEnemyHatch.id = 'ev2-prod-enemy-hatch';
  prodEnemyHatch.setAttribute('patternUnits', 'userSpaceOnUse');
  prodEnemyHatch.setAttribute('width', '10');
  prodEnemyHatch.setAttribute('height', '10');
  const peBg = mksvg('rect');
  peBg.setAttribute('width', '10');
  peBg.setAttribute('height', '10');
  peBg.setAttribute('fill', 'var(--color-production-disabled-enemy-stripe-base)');
  const peFg = mksvg('path');
  peFg.setAttribute(
    'd',
    'M0,10 L10,0 M-2.5,2.5 L2.5,-2.5 M7.5,12.5 L12.5,7.5',
  );
  peFg.setAttribute('stroke', 'var(--color-production-disabled-enemy-stripe-light)');
  peFg.setAttribute('stroke-width', '2.5');
  peFg.setAttribute('fill', 'none');
  prodEnemyHatch.appendChild(peBg);
  prodEnemyHatch.appendChild(peFg);
  defs.appendChild(prodEnemyHatch);

  // Clip paths per territory (same as map editor)
  for (const t of mapDef.territories) {
    const clipPath = mksvg('clipPath');
    clipPath.id = `ev2-clip-${t.id}`;
    const clipPoly = mksvg('polygon');
    clipPoly.setAttribute('points', territoryPointsAttr(t, points));
    clipPath.appendChild(clipPoly);
    defs.appendChild(clipPath);
  }

  // ── Layers — same IDs as map editor ────────────────────────────────────────────
  for (const id of [
    'ev2-outer-border-layer',
    'ev2-territory-layer',
    'ev2-edge-layer',
    'ev2-sector-border-layer',
    'ev2-cp-layer',
    'ev2-note-layer',
    'trr-prod-markers',
    'trr-highlights',
    'trr-ranged-glow',
    'trr-units',
  ]) {
    const g = mksvg('g');
    g.id = id;
    svgEl.appendChild(g);
  }

  // ── ev2-outer-border-layer ────────────────────────────────────────────────────
  const outerBorderLayer = svgEl.querySelector('#ev2-outer-border-layer') as SVGGElement;
  outerBorderLayer.setAttribute('pointer-events', 'none');
  const outerPathD = buildOuterBorderPath(mapDef, points, edgeTerritoryIndex);
  if (outerPathD) {
    const perimPath = mksvg('path');
    perimPath.setAttribute('d', outerPathD);
    perimPath.setAttribute('fill', 'none');
    perimPath.setAttribute('stroke', 'url(#ev2-outer-border-pattern)');
    perimPath.setAttribute('stroke-width', '144');
    perimPath.setAttribute('stroke-linecap', 'butt');
    perimPath.setAttribute('stroke-linejoin', 'round');
    outerBorderLayer.appendChild(perimPath);
  }

  // ── ev2-territory-layer ───────────────────────────────────────────────────────
  // Create stable per-territory groups. Fill class and border path are updated
  // on each renderTerritoryState call when ownership changes.
  const territoryLayer = svgEl.querySelector('#ev2-territory-layer') as SVGGElement;
  for (const t of mapDef.territories) {
    const group = mksvg('g');
    group.setAttribute('data-ev2-territory-id', t.id);
    group.setAttribute('data-territory-id', t.id);

    const fill = mksvg('polygon');
    fill.setAttribute('class', 'ev2-territory-fill ev2-state-neutral');
    fill.setAttribute('points', territoryPointsAttr(t, points));
    if (t.state === 'mountain') {
      fill.style.cursor = TERRITORY_MOUNTAIN_CURSOR;
      fill.setAttribute('pointer-events', 'none');
    } else {
      fill.style.cursor = TERRITORY_HOVER_CURSOR;
    }
    group.appendChild(fill);

    // Border compositing group — only shown for owned (allied/enemy) territories
    if (t.state !== 'mountain') {
      const borderGroup = mksvg('g');
      borderGroup.setAttribute('class', 'ev2-territory-border ev2-border-allied');
      borderGroup.setAttribute('pointer-events', 'none');
      borderGroup.setAttribute('display', 'none');

      const glowEl = mksvg('path');
      glowEl.setAttribute('class', 'ev2-border-glow');
      borderGroup.appendChild(glowEl);

      const lineEl = mksvg('path');
      lineEl.setAttribute('class', 'ev2-border-line');
      borderGroup.appendChild(lineEl);

      group.appendChild(borderGroup);
    }

    territoryLayer.appendChild(group);
  }

  // ── ev2-edge-layer (static — topology never changes) ─────────────────────────
  const edgeLayer = svgEl.querySelector('#ev2-edge-layer') as SVGGElement;
  edgeLayer.setAttribute('pointer-events', 'none');

  const glowGroup = mksvg('g');
  glowGroup.setAttribute('class', 'ev2-edge-glow-group');
  glowGroup.setAttribute('pointer-events', 'none');
  edgeLayer.appendChild(glowGroup);

  for (const edge of mapDef.edges) {
    const pa = points[edge.a], pb = points[edge.b];
    if (!pa || !pb) continue;

    const glow = mksvg('line');
    glow.setAttribute('class', 'ev2-edge-glow');
    glow.setAttribute('x1', String(pa.x)); glow.setAttribute('y1', String(pa.y));
    glow.setAttribute('x2', String(pb.x)); glow.setAttribute('y2', String(pb.y));
    glowGroup.appendChild(glow);

    const tids = edgeTerritoryIndex.get(undirectedEdgeKey(edge.a, edge.b));
    const effective = tids?.filter((tid) => !redundantPartitionParentIds.has(tid)) ?? [];
    const isOuter = effective.length === 1;
    const line = mksvg('line');
    line.setAttribute('class', isOuter ? 'ev2-edge ev2-edge-outer' : 'ev2-edge');
    line.setAttribute('x1', String(pa.x)); line.setAttribute('y1', String(pa.y));
    line.setAttribute('x2', String(pb.x)); line.setAttribute('y2', String(pb.y));
    edgeLayer.appendChild(line);
  }

  // ── ev2-sector-border-layer (static) ─────────────────────────────────────────
  const sectorBorderLayer = svgEl.querySelector('#ev2-sector-border-layer') as SVGGElement;
  sectorBorderLayer.setAttribute('pointer-events', 'none');

  if (graph.sectors.length > 0) {
    const tidToSector = new Map<string, string>();
    for (const sec of graph.sectors) for (const tid of sec.territoryIds) tidToSector.set(tid, sec.id);

    for (const edge of mapDef.edges) {
      const key = undirectedEdgeKey(edge.a, edge.b);
      const tids = edgeTerritoryIndex.get(key);
      if (!tids || tids.length !== 2) continue;
      const secA = tidToSector.get(tids[0]!), secB = tidToSector.get(tids[1]!);
      if (!secA || !secB || secA === secB) continue;
      const pa = points[edge.a], pb = points[edge.b];
      if (!pa || !pb) continue;
      const line = mksvg('line');
      line.setAttribute('class', 'ev2-sector-border');
      line.setAttribute('x1', String(pa.x)); line.setAttribute('y1', String(pa.y));
      line.setAttribute('x2', String(pb.x)); line.setAttribute('y2', String(pb.y));
      sectorBorderLayer.appendChild(line);
    }
  }

  // ── ev2-note-layer (static) ───────────────────────────────────────────────────
  const noteLayer = svgEl.querySelector('#ev2-note-layer') as SVGGElement;
  noteLayer.setAttribute('pointer-events', 'none');

  for (const note of mapDef.notes ?? []) {
    const anchorMap: Record<string, string> = { left: 'start', center: 'middle', right: 'end' };
    const anchor = anchorMap[note.align ?? 'center'] ?? 'middle';
    const g = mksvg('g');
    g.setAttribute('data-note-id', note.id);
    g.setAttribute(
      'data-note-visibility',
      note.visibility === 'breakthroughOnly' ? 'breakthroughOnly' : 'always',
    );

    if (note.maxWidth) {
      const mw = note.maxWidth;
      const foX = note.align === 'center' ? note.x - mw / 2 : note.align === 'right' ? note.x - mw : note.x;
      const fo = mksvg('foreignObject');
      fo.setAttribute('x', String(foX));
      fo.setAttribute('y', String(note.y - 20));
      fo.setAttribute('width', String(mw));
      fo.setAttribute('height', '2000');
      const div = document.createElementNS('http://www.w3.org/1999/xhtml', 'div') as HTMLElement;
      div.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      div.className = 'ev2-note-fo-text';
      div.textContent = note.text || ' ';
      fo.appendChild(div);
      g.appendChild(fo);
    } else {
      const textEl = mksvg('text');
      textEl.setAttribute('class', 'ev2-note-text');
      textEl.setAttribute('x', String(note.x));
      textEl.setAttribute('y', String(note.y - 8));
      textEl.setAttribute('text-anchor', anchor);
      textEl.textContent = note.text || ' ';
      g.appendChild(textEl);
    }

    noteLayer.appendChild(g);
  }

  ensureMovePathPreviewLayer(svgEl);

  rendererStateMap.set(svgEl, { graph, edgeTerritoryIndex });
  rangedGlowMapTr.delete(svgEl);
}

// ── getTerritoryFromEvent ─────────────────────────────────────────────────────

export function getTerritoryFromEvent(e: MouseEvent, svgEl: SVGSVGElement): { col: number; row: number } | null {
  const rs = rendererStateMap.get(svgEl);
  if (!rs) return null;
  const g = rs.graph;
  const raw = e.target;
  const startEl: Element | null =
    raw instanceof Element ? raw : raw instanceof Text ? raw.parentElement : null;
  if (!startEl) return null;

  // 1) Prefer [data-col][data-row] (map chip, hit layers). Matches unit g under #trr-units even
  // when data-territory-id is empty or territories[tid] is out of sync.
  const withV = startEl.closest('[data-col][data-row]');
  if (withV) {
    const cStr = withV.getAttribute('data-col');
    const rStr = withV.getAttribute('data-row');
    if (cStr != null && rStr != null) {
      const col = parseInt(cStr, 10);
      const row = parseInt(rStr, 10);
      if (!Number.isNaN(col) && !Number.isNaN(row) && graphHasVirtualCell(g, col, row)) {
        return { col, row };
      }
    }
  }
  // 2) ev2-territory / notes: walk up and resolve from territory id
  let el: Element | null = startEl;
  while (el && el !== svgEl) {
    const tid = el.getAttribute('data-territory-id') || el.getAttribute('data-ev2-territory-id');
    if (tid) {
      const t = g.territories[tid];
      if (t) return { col: t.virtualCol, row: t.virtualRow };
    }
    el = el.parentElement;
  }
  return null;
}

function graphHasVirtualCell(gra: { keyToId: Record<string, string> }, col: number, row: number): boolean {
  return gra.keyToId[`${col},${row}`] !== undefined;
}

// ── renderTerritoryState ──────────────────────────────────────────────────────

export function renderTerritoryState(
  svgElement: SVGSVGElement,
  state: GameState,
  graph: TerritoryGraphData,
  productionKey: string | null,
  hiddenUnitIds: Set<number>,
  localPlayer: Owner,
  opts?: RenderTerritoryStateOptions | null,
): void {
  const rs = rendererStateMap.get(svgElement);
  if (!rs || rs.graph !== graph) initTerritoryRenderer(svgElement, graph);

  const { mapDef, points, territories } = graph;
  const edgeTerritoryIndex = rendererStateMap.get(svgElement)!.edgeTerritoryIndex;

  syncTerritoryMapModeDecorations(svgElement, state);

  const unitsForDraw = opts?.unitDrawOverride != null ? opts.unitDrawOverride : state.units;
  const hexStatesForDraw = opts?.hexStatesDrawOverride != null ? opts.hexStatesDrawOverride : state.hexStates;

  let selectedUnitHl =
    state.selectedUnit !== null ? (state.units.find(u => u.id === state.selectedUnit) ?? null) : null;
  if (selectedUnitHl && selectedUnitHl.owner !== localPlayer) selectedUnitHl = null;
  if (
    selectedUnitHl &&
    state.activePlayer !== localPlayer &&
    selectedUnitHl.owner === localPlayer
  ) {
    selectedUnitHl = null;
  }
  const validMoves = selectedUnitHl ? getValidMoves(state, selectedUnitHl) : [];
  const validMoveKeys = new Set(validMoves.map(([c, r]) => `${c},${r}`));

  const productionPlacementKeys = new Set<string>();
  if (state.phase === 'production' && state.activePlayer === localPlayer) {
    for (const t of mapDef.territories) {
      const node = territories[t.id];
      if (node && isValidProductionPlacement(state, node.virtualCol, node.virtualRow, localPlayer)) {
        productionPlacementKeys.add(node.virtualKey);
      }
    }
  }

  /** Selected unit territory + valid-move destinations: same inset border treatment as allied/enemy */
  const moveHighlightTids = new Set<string>();
  for (const t of mapDef.territories) {
    if (t.state === 'mountain') continue;
    const node = territories[t.id];
    if (!node) continue;
    const key = node.virtualKey;
    const isSel = !!(
      selectedUnitHl &&
      selectedUnitHl.col === node.virtualCol &&
      selectedUnitHl.row === node.virtualRow
    );
    if (isSel || validMoveKeys.has(key)) moveHighlightTids.add(t.id);
  }

  const zocEnemy: Owner = localPlayer === PLAYER ? AI : PLAYER;
  const zocKeys = new Set<string>();
  if (selectedUnitHl && isInEnemyZoC(state, selectedUnitHl.col, selectedUnitHl.row, zocEnemy)) {
    for (const [nc, nr] of getBoardNeighbors(selectedUnitHl.col, selectedUnitHl.row)) {
      const zKey = `${nc},${nr}`;
      if (!getUnit(state, nc, nr) && isInEnemyZoC(state, nc, nr, zocEnemy)) {
        zocKeys.add(zKey);
      }
    }
  }
  if (selectedUnitHl && state.phase === 'movement' && state.activePlayer === localPlayer) {
    for (const [c, r] of getOpponentHomeGuardBlockedHexes(state, selectedUnitHl)) {
      zocKeys.add(`${c},${r}`);
    }
  }

  function ownerState(tid: string): 'neutral' | 'allied' | 'enemy' {
    const node = territories[tid];
    if (!node) return 'neutral';
    const hs = hexStatesForDraw[node.virtualKey];
    if (!hs) return 'neutral';
    return hs.owner === localPlayer ? 'allied' : 'enemy';
  }

  const inLocalProd = state.phase === 'production' && state.activePlayer === localPlayer;

  // ── ev2-territory-layer ───────────────────────────────────────────────────────
  const territoryLayer = svgElement.querySelector('#ev2-territory-layer')!;

  for (const t of mapDef.territories) {
    const group = territoryLayer.querySelector(`[data-ev2-territory-id="${t.id}"]`) as SVGGElement | null;
    if (!group) continue;

    const fillPoly = group.querySelector('.ev2-territory-fill') as SVGElement | null;
    const borderGroup = group.querySelector('.ev2-territory-border') as SVGGElement | null;

    const nodeTerr = territories[t.id];
    const virtKey = nodeTerr?.virtualKey ?? '';
    const isProdSel = productionKey != null && virtKey === productionKey;

    const vizState: 'neutral' | 'allied' | 'enemy' | 'mountain' =
      t.state === 'mountain' ? 'mountain' : ownerState(t.id);

    const isMoveHl = moveHighlightTids.has(t.id);
    const isZocHl =
      !isMoveHl && t.state !== 'mountain' && virtKey !== '' && zocKeys.has(virtKey);

    let prodFillMod = '';
    if (!isMoveHl && !isZocHl && inLocalProd && t.state !== 'mountain') {
      if (isProdSel) prodFillMod = ' ev2-prod-selected';
      else if (productionPlacementKeys.has(virtKey)) prodFillMod = ' ev2-prod-placement';
      else if (vizState === 'allied') prodFillMod = ' ev2-prod-dim-friendly';
      else if (vizState === 'enemy') prodFillMod = ' ev2-prod-dim-enemy';
    }

    if (fillPoly) {
      const baseFill = isMoveHl
        ? `ev2-territory-fill ev2-state-${vizState} ev2-fill-move-highlight`
        : isZocHl
          ? `ev2-territory-fill ev2-state-zoc`
          : `ev2-territory-fill ev2-state-${vizState}${prodFillMod}`;
      if (fillPoly.getAttribute('class') !== baseFill) fillPoly.setAttribute('class', baseFill);
    }

    if (borderGroup) {
      if (isMoveHl) {
        if (borderGroup.getAttribute('display') === 'none') borderGroup.removeAttribute('display');

        const borderCls = 'ev2-territory-border ev2-border-move-highlight';
        if (borderGroup.getAttribute('class') !== borderCls) borderGroup.setAttribute('class', borderCls);

        const suppressEdge = (neighborTid: string | null): boolean =>
          neighborTid !== null && ownerState(neighborTid) === vizState;

        const borderD = buildInsetBorderPath(t, edgeTerritoryIndex, points, -10, suppressEdge);
        const glowEl = borderGroup.querySelector('.ev2-border-glow') as SVGElement | null;
        const lineEl = borderGroup.querySelector('.ev2-border-line') as SVGElement | null;
        if (glowEl) setAttrIfChanged(glowEl, 'd', borderD);
        if (lineEl) setAttrIfChanged(lineEl, 'd', borderD);
      } else if (isZocHl) {
        if (borderGroup.getAttribute('display') === 'none') borderGroup.removeAttribute('display');

        const borderCls = 'ev2-territory-border ev2-border-zoc';
        if (borderGroup.getAttribute('class') !== borderCls) borderGroup.setAttribute('class', borderCls);

        const suppressZocEdge = (neighborTid: string | null): boolean => {
          if (neighborTid === null) return false;
          const nk = territories[neighborTid]?.virtualKey ?? '';
          return nk !== '' && zocKeys.has(nk);
        };

        const borderD = buildInsetBorderPath(t, edgeTerritoryIndex, points, -10, suppressZocEdge);
        const glowEl = borderGroup.querySelector('.ev2-border-glow') as SVGElement | null;
        const lineEl = borderGroup.querySelector('.ev2-border-line') as SVGElement | null;
        if (glowEl) setAttrIfChanged(glowEl, 'd', borderD);
        if (lineEl) setAttrIfChanged(lineEl, 'd', borderD);
      } else if (vizState === 'neutral' || vizState === 'mountain') {
        if (borderGroup.getAttribute('display') !== 'none') borderGroup.setAttribute('display', 'none');
      } else {
        if (borderGroup.getAttribute('display') === 'none') borderGroup.removeAttribute('display');

        let prodBorderMod = '';
        if (!isMoveHl && inLocalProd) {
          if (isProdSel) prodBorderMod = ' ev2-prod-selected-border';
          else if (productionPlacementKeys.has(virtKey)) prodBorderMod = ' ev2-prod-placement-border';
          else prodBorderMod = ' ev2-prod-dim-border';
        }

        const borderCls = `ev2-territory-border ev2-border-${vizState}${prodBorderMod}`;
        if (borderGroup.getAttribute('class') !== borderCls) borderGroup.setAttribute('class', borderCls);

        const suppressEdge = (neighborTid: string | null): boolean =>
          neighborTid !== null && ownerState(neighborTid) === vizState;

        const borderD = buildInsetBorderPath(t, edgeTerritoryIndex, points, -10, suppressEdge);
        const glowEl = borderGroup.querySelector('.ev2-border-glow') as SVGElement | null;
        const lineEl = borderGroup.querySelector('.ev2-border-line') as SVGElement | null;
        if (glowEl) setAttrIfChanged(glowEl, 'd', borderD);
        if (lineEl) setAttrIfChanged(lineEl, 'd', borderD);
      }
    }
  }

  // ── trr-highlights ────────────────────────────────────────────────────────────
  const highlightLayer = svgElement.querySelector('#trr-highlights')!;
  const existingHL = new Map<string, SVGPathElement>();
  for (const child of Array.from(highlightLayer.children)) {
    const tid = (child as SVGElement).getAttribute('data-territory-id');
    if (tid) existingHL.set(tid, child as SVGPathElement);
  }
  const seenHL = new Set<string>();

  for (const t of mapDef.territories) {
    if (t.state === 'mountain') continue;
    const node = territories[t.id];
    if (!node) continue;
    const key = node.virtualKey;

    const isProduction = productionPlacementKeys.has(key);

    let stroke: string | null = null;
    if (isProduction) {
      stroke =
        productionKey === key
          ? 'var(--color-production-territory-selected-stroke)'
          : 'var(--color-production-territory-border)';
    }

    if (stroke) {
      seenHL.add(t.id);
      let pathEl = existingHL.get(t.id);
      if (!pathEl) {
        pathEl = document.createElementNS(SVG_NS, 'path') as SVGPathElement;
        pathEl.setAttribute('data-territory-id', t.id);
        pathEl.setAttribute('pointer-events', 'none');
        highlightLayer.appendChild(pathEl);
      }
      setAttrIfChanged(pathEl, 'd', territoryPathD(t, points));
      setAttrIfChanged(pathEl, 'fill', 'none');
      setAttrIfChanged(pathEl, 'stroke', stroke);
      setAttrIfChanged(pathEl, 'stroke-width', String(STROKE_WIDTH_HIGHLIGHT));
      setAttrIfChanged(pathEl, 'stroke-linejoin', 'round');
    }
  }
  for (const [tid, el] of existingHL) if (!seenHL.has(tid)) el.remove();

  const prodMarkerLayer = svgElement.querySelector('#trr-prod-markers')!;
  prodMarkerLayer.replaceChildren();
  if (inLocalProd) {
    for (const t of mapDef.territories) {
      if (t.state === 'mountain') continue;
      const nodePm = territories[t.id];
      if (!nodePm || !productionPlacementKeys.has(nodePm.virtualKey)) continue;
      // Polygon centroid from buildTerritoryGraph (vertex average); matches unit/CP placement.
      const cx = nodePm.centroid.x;
      const cy = nodePm.centroid.y;
      const g = mksvg('g');
      g.setAttribute('data-territory-id', t.id);
      g.setAttribute('pointer-events', 'none');
      const plus = inlineIcon(
        PROD_PLACEMENT_ICON_SRC,
        cx,
        cy,
        PROD_PLACEMENT_ICON_PX,
        'var(--color-dark)',
        '1',
        'trr-prod-marker',
      );
      if (!plus) continue;
      g.appendChild(plus);
      prodMarkerLayer.appendChild(g);
    }
  }

  // ── ev2-cp-layer ──────────────────────────────────────────────────────────────
  const cpLayer = svgElement.querySelector('#ev2-cp-layer')!;
  const existingCP = new Map<string, SVGGElement>();
  for (const child of Array.from(cpLayer.children)) {
    const cpid = (child as SVGElement).getAttribute('data-cp-id');
    if (cpid) existingCP.set(cpid, child as SVGGElement);
  }
  const seenCP = new Set<string>();

  const activeCpHexes = new Set([
    ...state.controlPointHexes,
    ...state.sectorControlPointHex.flat(),
  ]);

  for (const cp of Object.values(graph.controlPoints)) {
    const t = territories[cp.territoryId];
    if (!t || !activeCpHexes.has(t.virtualKey)) continue;

    seenCP.add(cp.id);
    let g = existingCP.get(cp.id);
    if (!g) {
      g = document.createElementNS(SVG_NS, 'g') as SVGGElement;
      g.setAttribute('data-cp-id', cp.id);
      g.setAttribute('pointer-events', 'none');
      cpLayer.appendChild(g);

      const bg = document.createElementNS(SVG_NS, 'rect') as SVGRectElement;
      bg.setAttribute('class', 'ev2-cp-label-bg');
      bg.setAttribute('rx', '0');
      g.appendChild(bg);

      const label = document.createElementNS(SVG_NS, 'text') as SVGTextElement;
      label.setAttribute('class', 'ev2-cp-label');
      label.textContent = cp.name;
      g.appendChild(label);

      const dot = document.createElementNS(SVG_NS, 'circle') as SVGCircleElement;
      dot.setAttribute('class', 'ev2-cp-dot');
      dot.setAttribute('r', '4');
      g.appendChild(dot);
    }

    const cx = t.centroid.x, cy = t.centroid.y;
    const label = g.querySelector<SVGTextElement>('.ev2-cp-label')!;
    setAttrIfChanged(label, 'x', String(cx));
    setAttrIfChanged(label, 'y', String(cy - 14));

    const dot = g.querySelector<SVGCircleElement>('.ev2-cp-dot')!;
    setAttrIfChanged(dot, 'cx', String(cx));
    setAttrIfChanged(dot, 'cy', String(cy));

    const bg = g.querySelector<SVGRectElement>('.ev2-cp-label-bg')!;
    try {
      const pad = 4, bb = label.getBBox();
      bg.setAttribute('x', String(bb.x - pad));
      bg.setAttribute('y', String(bb.y - pad));
      bg.setAttribute('width', String(bb.width + pad * 2));
      bg.setAttribute('height', String(bb.height + pad * 2));
    } catch (_) { /* getBBox unavailable when SVG is hidden */ }
  }
  for (const [cpid, el] of existingCP) if (!seenCP.has(cpid)) el.remove();

  // ── trr-units (same map chip as hex {@link mountBoardUnitChipContents}) ───────
  let selectedUnitTr =
    state.selectedUnit !== null ? (state.units.find(u => u.id === state.selectedUnit) ?? null) : null;
  if (selectedUnitTr && selectedUnitTr.owner !== localPlayer) selectedUnitTr = null;
  if (
    selectedUnitTr &&
    state.activePlayer !== localPlayer &&
    selectedUnitTr.owner === localPlayer
  ) {
    selectedUnitTr = null;
  }
  const rangedTargetKeysTr = new Set<string>();
  if (selectedUnitTr && state.phase === 'movement' && state.activePlayer === localPlayer) {
    for (const t of getRangedAttackTargets(state, selectedUnitTr)) {
      rangedTargetKeysTr.add(`${t.col},${t.row}`);
    }
  }
  const productionTiredVisualTr =
    state.phase === 'production' && state.activePlayer === localPlayer;

  const rangedGlowLayer = svgElement.querySelector('#trr-ranged-glow') as SVGGElement | null;
  if (rangedGlowLayer) {
    let glowMap = rangedGlowMapTr.get(svgElement);
    if (!glowMap) {
      glowMap = new Map();
      rangedGlowMapTr.set(svgElement, glowMap);
    }
    for (const key of [...glowMap.keys()]) {
      if (!rangedTargetKeysTr.has(key)) {
        glowMap.get(key)?.remove();
        glowMap.delete(key);
      }
    }
    for (const key of rangedTargetKeysTr) {
      if (glowMap.has(key)) continue;
      const tid = graph.keyToId[key];
      const tDef = tid ? mapDef.territories.find(t => t.id === tid) : null;
      if (!tDef) continue;
      const poly = document.createElementNS(SVG_NS, 'polygon') as SVGPolygonElement;
      poly.setAttribute('points', territoryPointsAttr(tDef, points));
      poly.setAttribute('class', 'ranged-target-glow-overlay');
      rangedGlowLayer.appendChild(poly);
      glowMap.set(key, poly);
    }
  }

  const unitsLayer = svgElement.querySelector('#trr-units')!;
  const existingUnits = new Map<number, SVGGElement>();
  for (const child of Array.from(unitsLayer.children)) {
    const uid = (child as SVGElement).getAttribute('data-unit-id');
    if (uid !== null) existingUnits.set(Number(uid), child as SVGGElement);
  }
  const seenUnits = new Set<number>();

  for (const unit of unitsForDraw) {
    if (hiddenUnitIds.has(unit.id)) continue;
    const node = territories[graph.keyToId[`${unit.col},${unit.row}`] ?? ''];
    if (!node) continue;

    seenUnits.add(unit.id);
    let g = existingUnits.get(unit.id);
    if (!g) {
      g = document.createElementNS(SVG_NS, 'g') as SVGGElement;
      g.setAttribute('data-unit-id', String(unit.id));
      g.setAttribute('data-territory-id', graph.keyToId[`${unit.col},${unit.row}`] ?? '');
      unitsLayer.appendChild(g);
    }

    const cx = node.centroid.x;
    const cy = node.centroid.y;
    setAttrIfChanged(g, 'class', 'board-unit');
    setAttrIfChanged(g, 'data-col', String(node.virtualCol));
    setAttrIfChanged(g, 'data-row', String(node.virtualRow));
    setAttrIfChanged(g, 'transform', `translate(${cx},${cy})`);
    g.style.opacity = '1';

    mountBoardUnitChipContents(g, {
      state,
      unit,
      localPlayer,
      x: cx,
      y: cy,
      dc: node.virtualCol,
      dr: node.virtualRow,
      displayHp: unit.hp,
      productionTiredVisual: productionTiredVisualTr,
      rangedTargetKeys: rangedTargetKeysTr,
      localSpectatorInspectUnitId: null,
    });
  }
  for (const [uid, el] of existingUnits) if (!seenUnits.has(uid)) el.remove();
}
