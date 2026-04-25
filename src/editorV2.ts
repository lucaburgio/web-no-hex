// ── Editor V2 — Polygon-based map editor ────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

// ── Types ─────────────────────────────────────────────────────────────────────

type TerritoryState = 'neutral' | 'allied' | 'enemy';

interface Pt { id: string; x: number; y: number }
interface Edge { id: string; a: string; b: string }
interface Territory { id: string; pointIds: string[]; state: TerritoryState }

// ── Module-level state ────────────────────────────────────────────────────────

let pts: Pt[] = [];
let edges: Edge[] = [];
let territories: Territory[] = [];
let currentPath: string[] = [];      // point IDs in-progress
let mode: 'edit' | 'territory' | 'view' = 'edit';
let isRemovingDot = false;           // remove-dot sub-mode within edit
let hoveredPoint: string | null = null;
let cursorPos: { x: number; y: number } = { x: 0, y: 0 };
let dragPointId: string | null = null;  // point being dragged
let hasDragged = false;                 // true if mouse moved during drag

let _ptCounter = 0;
let _edgeCounter = 0;
let _territoryCounter = 0;

function newPtId(): string  { return `p${++_ptCounter}`; }
function newEdgeId(): string { return `e${++_edgeCounter}`; }
function newTerritoryId(): string { return `t${++_territoryCounter}`; }

// ── DOM refs (set in initEditorV2) ────────────────────────────────────────────

let overlayEl: HTMLElement;
let svgEl: SVGSVGElement;
let canvasAreaEl: HTMLElement;
let btnEdit: HTMLButtonElement;
let btnTerritory: HTMLButtonElement;
let btnView: HTMLButtonElement;
let removeDotBtn: HTMLButtonElement;
let panelEdit: HTMLElement;
let panelTerritory: HTMLElement;

// ── Geometry helpers ──────────────────────────────────────────────────────────

function svgCoords(e: MouseEvent): { x: number; y: number } {
  const rect = svgEl.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function findSnapPoint(x: number, y: number): Pt | null {
  const SNAP_RADIUS = 14;
  let best: Pt | null = null;
  let bestDist = Infinity;
  for (const p of pts) {
    const d = dist(p.x, p.y, x, y);
    if (d < SNAP_RADIUS && d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

/** Ray-casting point-in-polygon test */
function pointInPolygon(x: number, y: number, polygon: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function hasEdge(aId: string, bId: string): boolean {
  return edges.some(
    (e) => (e.a === aId && e.b === bId) || (e.a === bId && e.b === aId)
  );
}

function addEdge(aId: string, bId: string): void {
  if (!hasEdge(aId, bId)) {
    edges.push({ id: newEdgeId(), a: aId, b: bId });
  }
}

// ── Cycle detection ───────────────────────────────────────────────────────────

/**
 * DFS to find ALL simple paths from start→end, excluding the edge (exA–exB).
 * Paths are limited to MAX_CYCLE_LENGTH nodes to keep search tractable.
 */
const MAX_CYCLE_LENGTH = 24;
function findAllPathsDFS(start: string, end: string, exA: string, exB: string): string[][] {
  const results: string[][] = [];
  const stack: Array<{ path: string[]; visited: Set<string> }> = [
    { path: [start], visited: new Set([start]) },
  ];
  while (stack.length) {
    const { path, visited } = stack.pop()!;
    const cur = path[path.length - 1];
    for (const e of edges) {
      if ((e.a === exA && e.b === exB) || (e.a === exB && e.b === exA)) continue;
      let nb: string | null = null;
      if (e.a === cur) nb = e.b;
      else if (e.b === cur) nb = e.a;
      if (!nb) continue;
      if (nb === end && path.length >= 2) {
        // Closed a cycle — only keep it if no existing territory has the same point set
        results.push([...path, end]);
      } else if (!visited.has(nb) && path.length < MAX_CYCLE_LENGTH) {
        const newVisited = new Set(visited);
        newVisited.add(nb);
        stack.push({ path: [...path, nb], visited: newVisited });
      }
    }
  }
  return results;
}

/**
 * After adding edge aId–bId, find ALL new cycles that now close and create
 * a territory for each one not already represented.
 */
function tryAutoCloseTerritory(aId: string, bId: string): void {
  const allPaths = findAllPathsDFS(bId, aId, aId, bId);
  for (const path of allPaths) {
    // path = [bId, …, aId]; cycle = [aId, bId, …, second-to-last]
    const cycle = [aId, ...path.slice(0, -1)];
    if (cycle.length < 3) continue;

    const cycleSet = new Set(cycle);

    // Skip if an identical territory already exists
    const exists = territories.some(
      (t) => t.pointIds.length === cycle.length && t.pointIds.every((id) => cycleSet.has(id))
    );
    if (exists) continue;

    // Skip non-minimal cycles: if this cycle is a strict superset of any existing
    // territory, it encloses that territory and is not a face of the planar map.
    const isSuperset = territories.some(
      (t) => t.pointIds.length < cycle.length && t.pointIds.every((id) => cycleSet.has(id))
    );
    if (isSuperset) continue;

    territories.push({ id: newTerritoryId(), pointIds: cycle, state: 'neutral' });
  }
}

// ── Resize ────────────────────────────────────────────────────────────────────

function resizeSvg(): void {
  const w = canvasAreaEl.clientWidth;
  const h = canvasAreaEl.clientHeight;
  svgEl.setAttribute('width', String(w));
  svgEl.setAttribute('height', String(h));
  svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function ptById(id: string): Pt | undefined {
  return pts.find((p) => p.id === id);
}

function territoryPoints(t: Territory): Array<{ x: number; y: number }> {
  return t.pointIds.map((id) => {
    const p = ptById(id);
    return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
  });
}

function territoryPointsAttr(t: Territory): string {
  return territoryPoints(t)
    .map((p) => `${p.x},${p.y}`)
    .join(' ');
}

function stateBorderColor(state: TerritoryState): string {
  if (state === 'allied') return '#2563eb';
  if (state === 'enemy') return '#dc2626';
  return 'transparent';
}

// ── Shared-border helpers ─────────────────────────────────────────────────────

/** Returns ordered edge pairs [(p0,p1),(p1,p2),...,(pn,p0)] for a territory polygon. */
function polygonEdgePairs(t: Territory): Array<[string, string]> {
  return t.pointIds.map((id, i) => [id, t.pointIds[(i + 1) % t.pointIds.length]] as [string, string]);
}

function edgePairsMatch(a: [string, string], b: [string, string]): boolean {
  return (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);
}

/**
 * Returns true if edge (aId, bId) of territory t is shared with another
 * territory of the same non-neutral state.
 */
function isEdgeSharedWithSameState(t: Territory, edge: [string, string]): boolean {
  if (t.state === 'neutral') return false;
  for (const other of territories) {
    if (other.id === t.id || other.state !== t.state) continue;
    if (polygonEdgePairs(other).some((e) => edgePairsMatch(e, edge))) return true;
  }
  return false;
}

function render(): void {
  // Ensure defs element exists and is first
  let defsEl = svgEl.querySelector('defs') as SVGDefsElement | null;
  if (!defsEl) {
    defsEl = document.createElementNS(SVG_NS, 'defs') as SVGDefsElement;
    svgEl.prepend(defsEl);
  }
  // Rebuild defs clip paths
  defsEl.innerHTML = '';

  for (const t of territories) {
    const clipPath = document.createElementNS(SVG_NS, 'clipPath');
    clipPath.setAttribute('id', `ev2-clip-${t.id}`);
    const clipPoly = document.createElementNS(SVG_NS, 'polygon');
    clipPoly.setAttribute('points', territoryPointsAttr(t));
    clipPath.appendChild(clipPoly);
    defsEl.appendChild(clipPath);
  }

  // ── Territory layer ──────────────────────────────────────────────────────
  const territoryLayer = svgEl.querySelector('#ev2-territory-layer') as SVGGElement;
  territoryLayer.innerHTML = '';

  for (const t of territories) {
    const pts_str = territoryPointsAttr(t);

    const group = document.createElementNS(SVG_NS, 'g');

    // Filled polygon
    const fill = document.createElementNS(SVG_NS, 'polygon');
    fill.setAttribute('class', `ev2-territory-fill ev2-state-${t.state}`);
    fill.setAttribute('points', pts_str);
    group.appendChild(fill);

    // Inner border — drawn edge-by-edge so shared same-state borders are suppressed
    if (t.state !== 'neutral') {
      const borderColor = stateBorderColor(t.state);
      for (const [aId, bId] of polygonEdgePairs(t)) {
        if (isEdgeSharedWithSameState(t, [aId, bId])) continue;
        const pa = ptById(aId);
        const pb = ptById(bId);
        if (!pa || !pb) continue;
        const seg = document.createElementNS(SVG_NS, 'line');
        seg.setAttribute('x1', String(pa.x));
        seg.setAttribute('y1', String(pa.y));
        seg.setAttribute('x2', String(pb.x));
        seg.setAttribute('y2', String(pb.y));
        seg.setAttribute('stroke', borderColor);
        seg.setAttribute('stroke-width', '8');
        seg.setAttribute('stroke-linecap', 'square');
        seg.setAttribute('fill', 'none');
        seg.setAttribute('clip-path', `url(#ev2-clip-${t.id})`);
        group.appendChild(seg);
      }
    }

    // Click handler for territory mode
    group.addEventListener('click', () => {
      if (mode !== 'territory') return;
      const nextState: Record<TerritoryState, TerritoryState> = {
        neutral: 'allied',
        allied: 'enemy',
        enemy: 'neutral',
      };
      t.state = nextState[t.state];
      render();
    });

    territoryLayer.appendChild(group);
  }

  // ── Edge layer ───────────────────────────────────────────────────────────
  const edgeLayer = svgEl.querySelector('#ev2-edge-layer') as SVGGElement;
  edgeLayer.innerHTML = '';

  for (const edge of edges) {
    const pa = ptById(edge.a);
    const pb = ptById(edge.b);
    if (!pa || !pb) continue;
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('class', 'ev2-edge');
    line.setAttribute('x1', String(pa.x));
    line.setAttribute('y1', String(pa.y));
    line.setAttribute('x2', String(pb.x));
    line.setAttribute('y2', String(pb.y));
    edgeLayer.appendChild(line);
  }

  // ── Point layer ──────────────────────────────────────────────────────────
  const pointLayer = svgEl.querySelector('#ev2-point-layer') as SVGGElement;
  pointLayer.innerHTML = '';

  if (mode !== 'view') {
    const firstPathPointId = currentPath.length > 0 ? currentPath[0] : null;

    for (const p of pts) {
      const circle = document.createElementNS(SVG_NS, 'circle');
      const isHovered = p.id === hoveredPoint;
      const isCloseable = p.id === firstPathPointId && currentPath.length >= 3;
      const isDeleteTarget = isRemovingDot && isHovered;

      let cls = 'ev2-point';
      if (isDeleteTarget)      cls += ' ev2-point-delete';
      else if (isCloseable)    cls += ' ev2-point-closeable';
      else if (isHovered)      cls += ' ev2-point-hover';

      circle.setAttribute('class', cls);
      circle.setAttribute('cx', String(p.x));
      circle.setAttribute('cy', String(p.y));
      circle.setAttribute('r', isHovered || isCloseable ? '7' : '5');
      pointLayer.appendChild(circle);
    }
  }

  // ── Preview layer ────────────────────────────────────────────────────────
  const previewLayer = svgEl.querySelector('#ev2-preview-layer') as SVGGElement;
  previewLayer.innerHTML = '';

  if (mode === 'edit' && currentPath.length > 0) {
    const lastId = currentPath[currentPath.length - 1];
    const lastPt = ptById(lastId);
    if (lastPt) {
      const snapPt = findSnapPoint(cursorPos.x, cursorPos.y);
      const tx = snapPt ? snapPt.x : cursorPos.x;
      const ty = snapPt ? snapPt.y : cursorPos.y;

      const previewLine = document.createElementNS(SVG_NS, 'line');
      previewLine.setAttribute('class', 'ev2-preview-line');
      previewLine.setAttribute('x1', String(lastPt.x));
      previewLine.setAttribute('y1', String(lastPt.y));
      previewLine.setAttribute('x2', String(tx));
      previewLine.setAttribute('y2', String(ty));
      previewLayer.appendChild(previewLine);
    }
  }
}

// ── Mode switching ────────────────────────────────────────────────────────────

function setMode(newMode: 'edit' | 'territory' | 'view'): void {
  mode = newMode;
  isRemovingDot = false;
  currentPath = [];

  btnEdit.classList.toggle('active', mode === 'edit');
  btnTerritory.classList.toggle('active', mode === 'territory');
  btnView.classList.toggle('active', mode === 'view');

  panelEdit.classList.toggle('hidden', mode !== 'edit');
  panelTerritory.classList.toggle('hidden', mode !== 'territory');

  // Reset remove-dot button visual
  if (removeDotBtn) removeDotBtn.classList.remove('active');

  svgEl.style.cursor = mode === 'edit' ? 'crosshair' : 'default';

  render();
}

// ── Remove point ──────────────────────────────────────────────────────────────

function removePoint(ptId: string): void {
  // Drop all territories that used this point (polygon is now invalid)
  territories = territories.filter((t) => !t.pointIds.includes(ptId));
  // Drop all edges touching this point
  edges = edges.filter((e) => e.a !== ptId && e.b !== ptId);
  // Drop the point itself
  pts = pts.filter((p) => p.id !== ptId);
  // Clean up current path
  currentPath = currentPath.filter((id) => id !== ptId);
}

// ── Edit mode click handling ──────────────────────────────────────────────────

function handleEditClick(e: MouseEvent): void {
  const { x, y } = svgCoords(e);

  // Remove-dot sub-mode: click a point to destroy it
  if (isRemovingDot) {
    const snap = findSnapPoint(x, y);
    if (snap) { removePoint(snap.id); render(); }
    return;
  }

  const snap = findSnapPoint(x, y);

  let edgeAdded: [string, string] | null = null;

  if (snap) {
    const snapId = snap.id;

    if (currentPath.length > 0) {
      const lastId = currentPath[currentPath.length - 1];

      if (snapId !== lastId) {
        addEdge(lastId, snapId);
        edgeAdded = [lastId, snapId];

        if (currentPath.includes(snapId)) {
          // Snapped to a point already in the path (first or intermediate) → close/end
          currentPath = [];
        } else {
          currentPath.push(snapId);
        }
      }
      // If snap === last point, ignore (no-op)
    } else {
      // Start a new path from this existing point
      currentPath.push(snapId);
    }
  } else {
    // Place a new point
    const newPt: Pt = { id: newPtId(), x, y };
    pts.push(newPt);
    if (currentPath.length > 0) {
      const lastId = currentPath[currentPath.length - 1];
      addEdge(lastId, newPt.id);
      edgeAdded = [lastId, newPt.id];
    }
    currentPath.push(newPt.id);
  }

  // Auto-detect a closed territory whenever an edge is added
  if (edgeAdded) {
    tryAutoCloseTerritory(edgeAdded[0], edgeAdded[1]);
  }

  render();
}

// ── Territory mode click handling ─────────────────────────────────────────────

function handleTerritoryClick(e: MouseEvent): void {
  const { x, y } = svgCoords(e);

  // Check from last to first (topmost rendered)
  for (let i = territories.length - 1; i >= 0; i--) {
    const t = territories[i];
    const polygon = territoryPoints(t);
    if (pointInPolygon(x, y, polygon)) {
      const nextState: Record<TerritoryState, TerritoryState> = {
        neutral: 'allied',
        allied: 'enemy',
        enemy: 'neutral',
      };
      t.state = nextState[t.state];
      render();
      return;
    }
  }
}

// ── Undo ──────────────────────────────────────────────────────────────────────

function undo(): void {
  if (currentPath.length === 0) return;

  const removedId = currentPath.pop()!;

  // Remove the edge connecting the previous point to the removed point
  if (currentPath.length > 0) {
    const prevId = currentPath[currentPath.length - 1];
    const edgeIdx = edges.findIndex(
      (e) => (e.a === prevId && e.b === removedId) || (e.a === removedId && e.b === prevId)
    );
    if (edgeIdx !== -1) edges.splice(edgeIdx, 1);
  }

  // Remove the point if it's not referenced by any remaining edge or territory
  const isUsed =
    edges.some((e) => e.a === removedId || e.b === removedId) ||
    territories.some((t) => t.pointIds.includes(removedId));

  if (!isUsed) {
    pts = pts.filter((p) => p.id !== removedId);
  }

  render();
}

// ── Clear ─────────────────────────────────────────────────────────────────────

function clearAll(): void {
  pts = [];
  edges = [];
  territories = [];
  currentPath = [];
  hoveredPoint = null;
  _ptCounter = 0;
  _edgeCounter = 0;
  _territoryCounter = 0;
  render();
}

// ── Export / Import ───────────────────────────────────────────────────────────

function exportState(): void {
  const data = { version: 1, pts, edges, territories };
  const json = JSON.stringify(data, null, 2);
  navigator.clipboard.writeText(json).then(() => {
    const btn = document.getElementById('ev2-export-btn') as HTMLButtonElement;
    const original = btn.textContent!;
    btn.textContent = 'COPIED!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  }).catch(() => {
    // Fallback: show in the import modal textarea (read-only)
    const textarea = document.getElementById('ev2-import-textarea') as HTMLTextAreaElement;
    textarea.value = json;
    textarea.readOnly = true;
    showImportModal();
  });
}

function importFromJson(json: string): void {
  const data = JSON.parse(json);
  if (!Array.isArray(data.pts) || !Array.isArray(data.edges) || !Array.isArray(data.territories)) {
    throw new Error('Invalid format: missing pts, edges, or territories arrays.');
  }
  pts = data.pts as Pt[];
  edges = data.edges as Edge[];
  territories = data.territories as Territory[];
  currentPath = [];
  hoveredPoint = null;

  // Restore counters from max IDs so new IDs don't collide
  const maxNum = (arr: Array<{ id: string }>, prefix: string) =>
    arr.reduce((m, x) => Math.max(m, parseInt(x.id.slice(prefix.length)) || 0), 0);
  _ptCounter        = maxNum(pts, 'p');
  _edgeCounter      = maxNum(edges, 'e');
  _territoryCounter = maxNum(territories, 't');
}

function showImportModal(): void {
  const modal = document.getElementById('ev2-import-modal') as HTMLElement;
  const textarea = document.getElementById('ev2-import-textarea') as HTMLTextAreaElement;
  modal.classList.remove('hidden');
  textarea.readOnly = false;
  textarea.focus();
}

function hideImportModal(): void {
  const modal = document.getElementById('ev2-import-modal') as HTMLElement;
  modal.classList.add('hidden');
  const errorEl = document.getElementById('ev2-import-error') as HTMLElement;
  errorEl.textContent = '';
  errorEl.classList.add('hidden');
}

// ── Exported API ──────────────────────────────────────────────────────────────

let _initialized = false;
let _onBack: (() => void) | null = null;

export function initEditorV2(onBack: () => void): void {
  _onBack = onBack;

  if (_initialized) return;
  _initialized = true;

  overlayEl      = document.getElementById('editor-v2-overlay') as HTMLElement;
  svgEl          = document.getElementById('ev2-svg') as unknown as SVGSVGElement;
  canvasAreaEl   = document.getElementById('ev2-canvas-area') as HTMLElement;
  btnEdit        = document.getElementById('ev2-btn-edit') as HTMLButtonElement;
  btnTerritory   = document.getElementById('ev2-btn-territory') as HTMLButtonElement;
  btnView        = document.getElementById('ev2-btn-view') as HTMLButtonElement;
  removeDotBtn   = document.getElementById('ev2-remove-dot-btn') as HTMLButtonElement;
  panelEdit      = document.getElementById('ev2-panel-edit') as HTMLElement;
  panelTerritory = document.getElementById('ev2-panel-territory') as HTMLElement;

  // Create SVG layers
  for (const id of ['ev2-territory-layer', 'ev2-edge-layer', 'ev2-point-layer', 'ev2-preview-layer']) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('id', id);
    svgEl.appendChild(g);
  }

  // SVG mouse events
  svgEl.addEventListener('mousedown', (e: MouseEvent) => {
    if (overlayEl.classList.contains('hidden')) return;
    if (mode === 'view') return;                // no drag in view mode
    if (isRemovingDot) return;                  // remove-dot uses click, not drag
    const { x, y } = svgCoords(e);
    const snap = findSnapPoint(x, y);
    if (snap) {
      dragPointId = snap.id;
      hasDragged = false;
      e.preventDefault();                       // prevent text selection while dragging
    }
  });

  svgEl.addEventListener('mousemove', (e: MouseEvent) => {
    if (overlayEl.classList.contains('hidden')) return;
    const { x, y } = svgCoords(e);
    cursorPos = { x, y };

    if (dragPointId) {
      const pt = pts.find((p) => p.id === dragPointId);
      if (pt) { pt.x = x; pt.y = y; hasDragged = true; }
      svgEl.style.cursor = 'grabbing';
      render();
      return;
    }

    const snap = findSnapPoint(x, y);
    hoveredPoint = snap ? snap.id : null;
    // Show grab cursor when hovering a point in non-view mode
    if (snap && mode !== 'view') svgEl.style.cursor = 'grab';
    else svgEl.style.cursor = mode === 'edit' && !isRemovingDot ? 'crosshair'
                             : mode === 'edit' && isRemovingDot ? 'cell'
                             : 'default';
    render();
  });

  window.addEventListener('mouseup', () => {
    if (dragPointId) {
      dragPointId = null;
      // Restore cursor
      svgEl.style.cursor = mode === 'edit' && !isRemovingDot ? 'crosshair'
                         : mode === 'edit' && isRemovingDot  ? 'cell'
                         : 'default';
    }
  });

  svgEl.addEventListener('click', (e: MouseEvent) => {
    if (overlayEl.classList.contains('hidden')) return;
    if (hasDragged) { hasDragged = false; return; }  // was a drag, not a tap
    if (mode === 'edit') {
      handleEditClick(e);
    } else if (mode === 'territory') {
      handleTerritoryClick(e);
    }
  });

  // Keyboard
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (overlayEl.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      currentPath = [];
      render();
    }
  });

  // Mode buttons
  btnEdit.addEventListener('click', () => setMode('edit'));
  btnTerritory.addEventListener('click', () => setMode('territory'));
  btnView.addEventListener('click', () => setMode('view'));

  // Remove-dot toggle (within edit mode)
  removeDotBtn.addEventListener('click', () => {
    isRemovingDot = !isRemovingDot;
    removeDotBtn.classList.toggle('active', isRemovingDot);
    svgEl.style.cursor = isRemovingDot ? 'cell' : 'crosshair';
    render();
  });

  const undoBtn = document.getElementById('ev2-undo-btn') as HTMLButtonElement;
  undoBtn.addEventListener('click', () => undo());

  const clearBtn = document.getElementById('ev2-clear-btn') as HTMLButtonElement;
  clearBtn.addEventListener('click', () => clearAll());

  const backBtn = document.getElementById('ev2-back-btn') as HTMLButtonElement;
  backBtn.addEventListener('click', () => {
    hideEditorV2();
    _onBack?.();
  });

  // Export / Import
  (document.getElementById('ev2-export-btn') as HTMLButtonElement)
    .addEventListener('click', () => exportState());

  (document.getElementById('ev2-import-btn') as HTMLButtonElement)
    .addEventListener('click', () => {
      const textarea = document.getElementById('ev2-import-textarea') as HTMLTextAreaElement;
      textarea.value = '';
      textarea.readOnly = false;
      showImportModal();
    });

  (document.getElementById('ev2-import-confirm-btn') as HTMLButtonElement)
    .addEventListener('click', () => {
      const textarea = document.getElementById('ev2-import-textarea') as HTMLTextAreaElement;
      const errorEl  = document.getElementById('ev2-import-error') as HTMLElement;
      try {
        importFromJson(textarea.value.trim());
        hideImportModal();
        render();
      } catch (err) {
        errorEl.textContent = err instanceof Error ? err.message : 'Failed to parse JSON.';
        errorEl.classList.remove('hidden');
      }
    });

  (document.getElementById('ev2-import-cancel-btn') as HTMLButtonElement)
    .addEventListener('click', () => hideImportModal());

  // Resize observer
  const ro = new ResizeObserver(() => {
    if (!overlayEl.classList.contains('hidden')) {
      resizeSvg();
      render();
    }
  });
  ro.observe(canvasAreaEl);
}

export function showEditorV2(): void {
  overlayEl.classList.remove('hidden');

  // Reset state
  pts = [];
  edges = [];
  territories = [];
  currentPath = [];
  hoveredPoint = null;
  cursorPos = { x: 0, y: 0 };
  _ptCounter = 0;
  _edgeCounter = 0;
  _territoryCounter = 0;

  // Reset mode to edit
  mode = 'edit';
  isRemovingDot = false;
  btnEdit.classList.add('active');
  btnTerritory.classList.remove('active');
  btnView.classList.remove('active');
  removeDotBtn.classList.remove('active');
  panelEdit.classList.remove('hidden');
  panelTerritory.classList.add('hidden');
  svgEl.style.cursor = 'crosshair';

  resizeSvg();
  render();
}

export function hideEditorV2(): void {
  overlayEl.classList.add('hidden');
}
