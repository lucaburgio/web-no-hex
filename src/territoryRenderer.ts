/**
 * Territory-based SVG renderer for polygon maps.
 * Uses exact territory polygon shapes from the map definition.
 */

import type { GameState, Owner } from './types';
import type { TerritoryGraphData, TerritoryMapTerritory } from './territoryMap';
import { PLAYER, AI, getUnit, getValidMoves, isValidProductionPlacement } from './game';
import mountainPatternSrc from '../public/images/misc/mountain-pattern.png';

// ── Colors matching editorV2.css ───────────────────────────────────────────────
const COLOR_NEUTRAL_FILL   = '#fafafa';
const COLOR_NEUTRAL_STROKE = '#CDCDCD';
const COLOR_PLAYER_FILL    = '#eff6ff';
const COLOR_PLAYER_STROKE  = '#5EB1FF';
const COLOR_AI_FILL        = '#fff1f2';
const COLOR_AI_STROKE      = '#FE775E';
const COLOR_OUTER_STROKE   = '#4C4D4C';
const COLOR_SECTOR_STROKE  = '#4C4D4C';
const STROKE_WIDTH_INNER   = 2;
const STROKE_WIDTH_OUTER   = 2.5;
const STROKE_WIDTH_SECTOR  = 2.5;
const SECTOR_DASH          = '8 8';

const COLOR_SELECTED_STROKE  = '#fbbf24';
const COLOR_VALID_MOVE_STROKE = '#22c55e';
const COLOR_PRODUCTION_STROKE = '#3b82f6';
const STROKE_WIDTH_HIGHLIGHT  = 3;

const HP_BAR_WIDTH  = 36;
const HP_BAR_HEIGHT = 5;
const UNIT_IMG_SIZE = 28;

const SVG_NS = 'http://www.w3.org/2000/svg';

// ── Renderer state (per SVGSVGElement) ────────────────────────────────────────

interface RendererState {
  graph: TerritoryGraphData;
  mountainPatternId: string;
}

const rendererStateMap = new WeakMap<SVGSVGElement, RendererState>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function createSvgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
}


function pointsToPath(pointIds: string[], points: Record<string, { x: number; y: number }>): string {
  const coords = pointIds.map(pid => points[pid]).filter(Boolean) as { x: number; y: number }[];
  if (coords.length < 2) return '';
  return coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + ' Z';
}

function computeMapExtents(graph: TerritoryGraphData): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pt of Object.values(graph.points)) {
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }
  return { minX, minY, maxX, maxY };
}

function setAttrIfChanged(el: SVGElement, attr: string, value: string): void {
  if (el.getAttribute(attr) !== value) el.setAttribute(attr, value);
}

// ── Edge classification ───────────────────────────────────────────────────────

/**
 * For each edge (pair of point IDs), count how many territories include BOTH endpoints.
 * An edge is "outer" (boundary) if only one territory claims it.
 */
function classifyEdges(graph: TerritoryGraphData): {
  outerEdges: Set<string>;
  innerEdges: Map<string, [string, string]>; // edgeKey → [tidA, tidB]
  sectorBorderEdges: Set<string>;
} {
  const { mapDef, territories } = graph;

  // Map from edgeKey → list of territory IDs that own it
  const edgeTerritories = new Map<string, string[]>();

  for (const t of mapDef.territories) {
    const n = t.pointIds.length;
    for (let i = 0; i < n; i++) {
      const a = t.pointIds[i]!;
      const b = t.pointIds[(i + 1) % n]!;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const list = edgeTerritories.get(key);
      if (list) list.push(t.id);
      else edgeTerritories.set(key, [t.id]);
    }
  }

  const outerEdges = new Set<string>();
  const innerEdges = new Map<string, [string, string]>();

  for (const [key, tids] of edgeTerritories) {
    if (tids.length === 1) {
      outerEdges.add(key);
    } else if (tids.length === 2) {
      innerEdges.set(key, [tids[0]!, tids[1]!]);
    }
  }

  // Build sector lookup
  const tidToSector = new Map<string, string>();
  for (const sec of graph.sectors) {
    for (const tid of sec.territoryIds) tidToSector.set(tid, sec.id);
  }

  // A sector border edge is an inner edge where the two territories are in different sectors
  const sectorBorderEdges = new Set<string>();
  for (const [key, [tidA, tidB]] of innerEdges) {
    const secA = tidToSector.get(tidA);
    const secB = tidToSector.get(tidB);
    if (secA && secB && secA !== secB) {
      sectorBorderEdges.add(key);
    }
  }

  return { outerEdges, innerEdges, sectorBorderEdges };
}

// ── initTerritoryRenderer ─────────────────────────────────────────────────────

export function initTerritoryRenderer(svgEl: SVGSVGElement, graph: TerritoryGraphData): void {
  // Clear existing content
  svgEl.innerHTML = '';

  const { minX, minY, maxX, maxY } = computeMapExtents(graph);
  const pad = 24;
  const vbX = minX - pad;
  const vbY = minY - pad;
  const vbW = maxX - minX + 2 * pad;
  const vbH = maxY - minY + 2 * pad;
  svgEl.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
  svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Define mountain pattern
  const defs = createSvgEl('defs');
  svgEl.appendChild(defs);

  const patternId = 'trr-mountain-pattern';
  const pattern = createSvgEl('pattern');
  pattern.id = patternId;
  pattern.setAttribute('patternUnits', 'userSpaceOnUse');
  pattern.setAttribute('width', '64');
  pattern.setAttribute('height', '64');
  const patImg = createSvgEl('image');
  patImg.setAttribute('href', mountainPatternSrc);
  patImg.setAttribute('width', '64');
  patImg.setAttribute('height', '64');
  pattern.appendChild(patImg);
  defs.appendChild(pattern);

  // Create layer groups
  const layers = [
    'trr-fills',
    'trr-inner-borders',
    'trr-outer-borders',
    'trr-sector-borders',
    'trr-highlights',
    'trr-control-points',
    'trr-units',
  ];
  for (const id of layers) {
    const g = createSvgEl('g');
    g.id = id;
    svgEl.appendChild(g);
  }

  rendererStateMap.set(svgEl, { graph, mountainPatternId: patternId });
}

// ── getTerritoryFromEvent ─────────────────────────────────────────────────────

export function getTerritoryFromEvent(e: MouseEvent, svgEl: SVGSVGElement): { col: number; row: number } | null {
  const rs = rendererStateMap.get(svgEl);
  if (!rs) return null;

  const target = e.target as SVGElement | null;
  if (!target) return null;

  // Walk up from event target to find data-territory-id
  let el: SVGElement | null = target;
  while (el && el !== (svgEl as unknown as SVGElement)) {
    const tid = el.dataset?.['territoryId'];
    if (tid) {
      const t = rs.graph.territories[tid];
      if (t) return { col: t.virtualCol, row: t.virtualRow };
    }
    el = el.parentElement as SVGElement | null;
  }
  return null;
}

// ── renderTerritoryState ──────────────────────────────────────────────────────

export function renderTerritoryState(
  svgElement: SVGSVGElement,
  state: GameState,
  graph: TerritoryGraphData,
  productionKey: string | null,
  hiddenUnitIds: Set<number>,
  localPlayer: Owner,
): void {
  const rs = rendererStateMap.get(svgElement);
  if (!rs || rs.graph !== graph) {
    // Re-init if graph changed
    initTerritoryRenderer(svgElement, graph);
  }
  const patternId = rendererStateMap.get(svgElement)!.mountainPatternId;
  const { mapDef, points } = graph;

  // Determine what is highlighted
  const selectedUnit = state.selectedUnit !== null ? state.units.find(u => u.id === state.selectedUnit) ?? null : null;
  const validMoves = selectedUnit ? getValidMoves(state, selectedUnit) : [];
  const validMoveKeys = new Set(validMoves.map(([c, r]) => `${c},${r}`));

  // Production placement highlights
  const productionHex = productionKey;
  const productionPlacementKeys = new Set<string>();
  if (state.phase === 'production') {
    for (const t of mapDef.territories) {
      const node = graph.territories[t.id];
      if (!node) continue;
      if (isValidProductionPlacement(state, node.virtualCol, node.virtualRow, localPlayer)) {
        productionPlacementKeys.add(node.virtualKey);
      }
    }
  }

  const { outerEdges, sectorBorderEdges } = classifyEdges(graph);

  // ── Fills layer ─────────────────────────────────────────────────────────────
  const fillsLayer = svgElement.querySelector('#trr-fills')!;
  // Sync fill polygons keyed by territory id
  const existingFills = new Map<string, SVGPathElement>();
  for (const child of Array.from(fillsLayer.children)) {
    const tid = (child as SVGElement).dataset['territoryId'];
    if (tid) existingFills.set(tid, child as SVGPathElement);
  }

  const seenFills = new Set<string>();
  for (const t of mapDef.territories) {
    const node = graph.territories[t.id];
    if (!node) continue;
    seenFills.add(t.id);

    let pathEl = existingFills.get(t.id);
    if (!pathEl) {
      pathEl = document.createElementNS(SVG_NS, 'path') as SVGPathElement;
      pathEl.dataset['territoryId'] = t.id;
      fillsLayer.appendChild(pathEl);
    }

    const d = pointsToPath(t.pointIds, points);
    setAttrIfChanged(pathEl, 'd', d);

    // Determine fill
    let fill: string;
    if (t.state === 'mountain') {
      fill = `url(#${patternId})`;
    } else {
      const hs = state.hexStates[node.virtualKey];
      if (!hs) {
        fill = COLOR_NEUTRAL_FILL;
      } else if (hs.owner === localPlayer) {
        fill = COLOR_PLAYER_FILL;
      } else {
        fill = COLOR_AI_FILL;
      }
    }
    setAttrIfChanged(pathEl, 'fill', fill);
    setAttrIfChanged(pathEl, 'stroke', 'none');
    pathEl.style.cursor = t.state === 'mountain' ? 'default' : 'pointer';
  }
  // Remove disappeared
  for (const [tid, el] of existingFills) {
    if (!seenFills.has(tid)) el.remove();
  }

  // ── Inner borders layer ─────────────────────────────────────────────────────
  const innerLayer = svgElement.querySelector('#trr-inner-borders')!;
  // Draw a stroke path per territory polygon (inner borders share between territories)
  // Simple approach: draw each territory's full polygon outline
  const existingInner = new Map<string, SVGPathElement>();
  for (const child of Array.from(innerLayer.children)) {
    const tid = (child as SVGElement).dataset['territoryId'];
    if (tid) existingInner.set(tid, child as SVGPathElement);
  }
  const seenInner = new Set<string>();
  for (const t of mapDef.territories) {
    seenInner.add(t.id);
    let pathEl = existingInner.get(t.id);
    if (!pathEl) {
      pathEl = document.createElementNS(SVG_NS, 'path') as SVGPathElement;
      pathEl.dataset['territoryId'] = t.id;
      pathEl.setAttribute('fill', 'none');
      pathEl.setAttribute('pointer-events', 'none');
      innerLayer.appendChild(pathEl);
    }
    const d = pointsToPath(t.pointIds, points);
    setAttrIfChanged(pathEl, 'd', d);

    const node = graph.territories[t.id];
    const hs = node ? state.hexStates[node.virtualKey] : undefined;
    let stroke = COLOR_NEUTRAL_STROKE;
    if (t.state === 'mountain') stroke = COLOR_NEUTRAL_STROKE;
    else if (hs?.owner === localPlayer) stroke = COLOR_PLAYER_STROKE;
    else if (hs?.owner !== undefined && hs.owner !== localPlayer) stroke = COLOR_AI_STROKE;

    setAttrIfChanged(pathEl, 'stroke', stroke);
    setAttrIfChanged(pathEl, 'stroke-width', String(STROKE_WIDTH_INNER));
    setAttrIfChanged(pathEl, 'stroke-linejoin', 'round');
  }
  for (const [tid, el] of existingInner) {
    if (!seenInner.has(tid)) el.remove();
  }

  // ── Outer borders layer ─────────────────────────────────────────────────────
  const outerLayer = svgElement.querySelector('#trr-outer-borders')!;
  // Draw outer boundary edges as individual lines
  // Build edge geometry from mapDef.edges
  const edgeById = new Map<string, { a: string; b: string }>();
  for (const edge of mapDef.edges) {
    edgeById.set(edge.id, { a: edge.a, b: edge.b });
  }

  // Build set of outer edge point-pair keys
  const existingOuter = new Map<string, SVGLineElement>();
  for (const child of Array.from(outerLayer.children)) {
    const ek = (child as SVGElement).dataset['edgeKey'];
    if (ek) existingOuter.set(ek, child as SVGLineElement);
  }

  const seenOuter = new Set<string>();
  for (const edgeKey of outerEdges) {
    seenOuter.add(edgeKey);
    let lineEl = existingOuter.get(edgeKey);
    if (!lineEl) {
      lineEl = document.createElementNS(SVG_NS, 'line') as SVGLineElement;
      lineEl.dataset['edgeKey'] = edgeKey;
      lineEl.setAttribute('pointer-events', 'none');
      lineEl.setAttribute('stroke', COLOR_OUTER_STROKE);
      lineEl.setAttribute('stroke-width', String(STROKE_WIDTH_OUTER));
      lineEl.setAttribute('stroke-linecap', 'round');
      outerLayer.appendChild(lineEl);
    }
    const [pidA, pidB] = edgeKey.split('|');
    const ptA = pidA ? points[pidA] : undefined;
    const ptB = pidB ? points[pidB] : undefined;
    if (ptA && ptB) {
      setAttrIfChanged(lineEl, 'x1', String(ptA.x));
      setAttrIfChanged(lineEl, 'y1', String(ptA.y));
      setAttrIfChanged(lineEl, 'x2', String(ptB.x));
      setAttrIfChanged(lineEl, 'y2', String(ptB.y));
    }
  }
  for (const [ek, el] of existingOuter) {
    if (!seenOuter.has(ek)) el.remove();
  }

  // ── Sector borders layer ────────────────────────────────────────────────────
  const sectorLayer = svgElement.querySelector('#trr-sector-borders')!;
  const existingSector = new Map<string, SVGLineElement>();
  for (const child of Array.from(sectorLayer.children)) {
    const ek = (child as SVGElement).dataset['edgeKey'];
    if (ek) existingSector.set(ek, child as SVGLineElement);
  }
  const seenSector = new Set<string>();
  for (const edgeKey of sectorBorderEdges) {
    seenSector.add(edgeKey);
    let lineEl = existingSector.get(edgeKey);
    if (!lineEl) {
      lineEl = document.createElementNS(SVG_NS, 'line') as SVGLineElement;
      lineEl.dataset['edgeKey'] = edgeKey;
      lineEl.setAttribute('pointer-events', 'none');
      lineEl.setAttribute('stroke', COLOR_SECTOR_STROKE);
      lineEl.setAttribute('stroke-width', String(STROKE_WIDTH_SECTOR));
      lineEl.setAttribute('stroke-dasharray', SECTOR_DASH);
      lineEl.setAttribute('stroke-linecap', 'round');
      sectorLayer.appendChild(lineEl);
    }
    const [pidA, pidB] = edgeKey.split('|');
    const ptA = pidA ? points[pidA] : undefined;
    const ptB = pidB ? points[pidB] : undefined;
    if (ptA && ptB) {
      setAttrIfChanged(lineEl, 'x1', String(ptA.x));
      setAttrIfChanged(lineEl, 'y1', String(ptA.y));
      setAttrIfChanged(lineEl, 'x2', String(ptB.x));
      setAttrIfChanged(lineEl, 'y2', String(ptB.y));
    }
  }
  for (const [ek, el] of existingSector) {
    if (!seenSector.has(ek)) el.remove();
  }

  // ── Highlights layer ────────────────────────────────────────────────────────
  const highlightLayer = svgElement.querySelector('#trr-highlights')!;
  const existingHL = new Map<string, SVGPathElement>();
  for (const child of Array.from(highlightLayer.children)) {
    const tid = (child as SVGElement).dataset['territoryId'];
    if (tid) existingHL.set(tid, child as SVGPathElement);
  }
  const seenHL = new Set<string>();

  const processHighlight = (t: TerritoryMapTerritory, stroke: string): void => {
    seenHL.add(t.id);
    let pathEl = existingHL.get(t.id);
    if (!pathEl) {
      pathEl = document.createElementNS(SVG_NS, 'path') as SVGPathElement;
      pathEl.dataset['territoryId'] = t.id;
      pathEl.setAttribute('fill', 'none');
      pathEl.setAttribute('pointer-events', 'none');
      highlightLayer.appendChild(pathEl);
    }
    const d = pointsToPath(t.pointIds, points);
    setAttrIfChanged(pathEl, 'd', d);
    setAttrIfChanged(pathEl, 'stroke', stroke);
    setAttrIfChanged(pathEl, 'stroke-width', String(STROKE_WIDTH_HIGHLIGHT));
    setAttrIfChanged(pathEl, 'stroke-linejoin', 'round');
  };

  for (const t of mapDef.territories) {
    if (t.state === 'mountain') continue;
    const node = graph.territories[t.id];
    if (!node) continue;

    const key = node.virtualKey;
    const isSelected = selectedUnit && selectedUnit.col === node.virtualCol && selectedUnit.row === node.virtualRow;
    const isValidMove = validMoveKeys.has(key);
    const isProductionPlacement = productionPlacementKeys.has(key);

    if (isSelected) {
      processHighlight(t, COLOR_SELECTED_STROKE);
    } else if (isValidMove) {
      processHighlight(t, COLOR_VALID_MOVE_STROKE);
    } else if (isProductionPlacement) {
      processHighlight(t, COLOR_PRODUCTION_STROKE);
    }
  }
  for (const [tid, el] of existingHL) {
    if (!seenHL.has(tid)) el.remove();
  }

  // ── Control points layer ────────────────────────────────────────────────────
  const cpLayer = svgElement.querySelector('#trr-control-points')!;
  const existingCP = new Map<string, SVGGElement>();
  for (const child of Array.from(cpLayer.children)) {
    const cpid = (child as SVGElement).dataset['cpId'];
    if (cpid) existingCP.set(cpid, child as SVGGElement);
  }
  const seenCP = new Set<string>();

  const activeCpHexes = new Set([
    ...state.controlPointHexes,
    ...state.sectorControlPointHex.filter(k => k),
  ]);
  for (const cp of Object.values(graph.controlPoints)) {
    const t = graph.territories[cp.territoryId];
    if (!t) continue;
    if (!activeCpHexes.has(t.virtualKey)) continue;

    seenCP.add(cp.id);
    let g = existingCP.get(cp.id);
    if (!g) {
      g = document.createElementNS(SVG_NS, 'g') as SVGGElement;
      g.dataset['cpId'] = cp.id;
      g.setAttribute('pointer-events', 'none');
      cpLayer.appendChild(g);

      const circle = document.createElementNS(SVG_NS, 'circle') as SVGCircleElement;
      circle.setAttribute('r', '8');
      circle.setAttribute('fill', '#eab308');
      circle.setAttribute('stroke', '#92400e');
      circle.setAttribute('stroke-width', '1.5');
      g.appendChild(circle);

      const label = document.createElementNS(SVG_NS, 'text') as SVGTextElement;
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'middle');
      label.setAttribute('font-size', '8');
      label.setAttribute('fill', '#1c1917');
      label.setAttribute('font-weight', 'bold');
      label.textContent = 'CP';
      g.appendChild(label);
    }

    const cx = t.centroid.x;
    const cy = t.centroid.y - 20; // offset upward from centroid
    setAttrIfChanged(g, 'transform', `translate(${cx},${cy})`);
  }
  for (const [cpid, el] of existingCP) {
    if (!seenCP.has(cpid)) el.remove();
  }

  // ── Units layer ─────────────────────────────────────────────────────────────
  const unitsLayer = svgElement.querySelector('#trr-units')!;
  const existingUnits = new Map<number, SVGGElement>();
  for (const child of Array.from(unitsLayer.children)) {
    const uid = (child as SVGElement).dataset['unitId'];
    if (uid !== undefined) existingUnits.set(Number(uid), child as SVGGElement);
  }
  const seenUnits = new Set<number>();

  for (const unit of state.units) {
    if (hiddenUnitIds.has(unit.id)) continue;
    const node = graph.territories[
      graph.keyToId[`${unit.col},${unit.row}`] ?? ''
    ];
    if (!node) continue;

    seenUnits.add(unit.id);
    let g = existingUnits.get(unit.id);
    if (!g) {
      g = document.createElementNS(SVG_NS, 'g') as SVGGElement;
      g.dataset['unitId'] = String(unit.id);
      g.dataset['territoryId'] = graph.keyToId[`${unit.col},${unit.row}`] ?? '';
      unitsLayer.appendChild(g);

      // Unit icon
      const img = document.createElementNS(SVG_NS, 'image') as SVGImageElement;
      img.dataset['role'] = 'icon';
      img.setAttribute('width', String(UNIT_IMG_SIZE));
      img.setAttribute('height', String(UNIT_IMG_SIZE));
      img.setAttribute('x', String(-UNIT_IMG_SIZE / 2));
      img.setAttribute('y', String(-UNIT_IMG_SIZE / 2));
      img.setAttribute('pointer-events', 'none');
      g.appendChild(img);

      // HP bar background
      const hpBg = document.createElementNS(SVG_NS, 'rect') as SVGRectElement;
      hpBg.dataset['role'] = 'hp-bg';
      hpBg.setAttribute('x', String(-HP_BAR_WIDTH / 2));
      hpBg.setAttribute('y', String(UNIT_IMG_SIZE / 2 + 2));
      hpBg.setAttribute('width', String(HP_BAR_WIDTH));
      hpBg.setAttribute('height', String(HP_BAR_HEIGHT));
      hpBg.setAttribute('rx', '2');
      hpBg.setAttribute('fill', '#374151');
      hpBg.setAttribute('pointer-events', 'none');
      g.appendChild(hpBg);

      // HP bar fill
      const hpFill = document.createElementNS(SVG_NS, 'rect') as SVGRectElement;
      hpFill.dataset['role'] = 'hp-fill';
      hpFill.setAttribute('x', String(-HP_BAR_WIDTH / 2));
      hpFill.setAttribute('y', String(UNIT_IMG_SIZE / 2 + 2));
      hpFill.setAttribute('height', String(HP_BAR_HEIGHT));
      hpFill.setAttribute('rx', '2');
      hpFill.setAttribute('pointer-events', 'none');
      g.appendChild(hpFill);
    }

    const cx = node.centroid.x;
    const cy = node.centroid.y;
    setAttrIfChanged(g, 'transform', `translate(${cx},${cy})`);

    // Update icon
    const img = g.querySelector<SVGImageElement>('[data-role="icon"]');
    if (img && unit.icon) {
      setAttrIfChanged(img, 'href', unit.icon);
    }

    // Update HP bar
    const hpFill = g.querySelector<SVGRectElement>('[data-role="hp-fill"]');
    if (hpFill) {
      const pct = Math.max(0, Math.min(1, unit.hp / unit.maxHp));
      const w = Math.round(pct * HP_BAR_WIDTH);
      setAttrIfChanged(hpFill, 'width', String(w));
      const hpColor = pct > 0.6 ? '#22c55e' : pct > 0.3 ? '#eab308' : '#ef4444';
      setAttrIfChanged(hpFill, 'fill', hpColor);
    }

    // Dim tired units
    const isTired = unit.movesUsed >= unit.movement && state.phase === 'movement';
    g.style.opacity = isTired ? '0.5' : '1';
  }

  // Remove disappeared units
  for (const [uid, el] of existingUnits) {
    if (!seenUnits.has(uid)) el.remove();
  }
}
