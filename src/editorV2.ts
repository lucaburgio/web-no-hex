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
let mode: 'edit' | 'territory' = 'edit';
let hoveredPoint: string | null = null;
let cursorPos: { x: number; y: number } = { x: 0, y: 0 };

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

/** BFS shortest path from start→end, excluding the edge (exA–exB). */
function findPathBFS(start: string, end: string, exA: string, exB: string): string[] | null {
  const queue: string[][] = [[start]];
  const visited = new Set<string>([start]);
  while (queue.length) {
    const path = queue.shift()!;
    const cur = path[path.length - 1];
    if (cur === end) return path;
    for (const e of edges) {
      if ((e.a === exA && e.b === exB) || (e.a === exB && e.b === exA)) continue;
      let nb: string | null = null;
      if (e.a === cur) nb = e.b;
      else if (e.b === cur) nb = e.a;
      if (nb && !visited.has(nb)) {
        visited.add(nb);
        queue.push([...path, nb]);
      }
    }
  }
  return null;
}

/**
 * After adding edge aId–bId, check if a cycle now exists.
 * If so, and the cycle isn't already a territory, create one.
 */
function tryAutoCloseTerritory(aId: string, bId: string): void {
  // Find path from bId back to aId using existing edges, excluding the new edge
  const path = findPathBFS(bId, aId, aId, bId);
  if (!path || path.length < 3) return; // need ≥3 edges for a valid polygon

  // path = [bId, …, aId]; cycle points = [aId, bId, …, second-to-last]
  const cycle = [aId, ...path.slice(0, -1)];
  if (cycle.length < 3) return;

  // Skip if a territory with the same point set already exists
  const cycleSet = new Set(cycle);
  const exists = territories.some(
    (t) => t.pointIds.length === cycle.length && t.pointIds.every((id) => cycleSet.has(id))
  );
  if (!exists) {
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
    const borderColor = stateBorderColor(t.state);

    const group = document.createElementNS(SVG_NS, 'g');

    // Filled polygon
    const fill = document.createElementNS(SVG_NS, 'polygon');
    fill.setAttribute('class', `ev2-territory-fill ev2-state-${t.state}`);
    fill.setAttribute('points', pts_str);
    group.appendChild(fill);

    // Inner border polygon (only for non-neutral)
    if (t.state !== 'neutral') {
      const border = document.createElementNS(SVG_NS, 'polygon');
      border.setAttribute('points', pts_str);
      border.setAttribute('fill', 'none');
      border.setAttribute('stroke-width', '8');
      border.setAttribute('stroke', borderColor);
      border.setAttribute('clip-path', `url(#ev2-clip-${t.id})`);
      group.appendChild(border);
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

  const firstPathPointId = currentPath.length > 0 ? currentPath[0] : null;

  for (const p of pts) {
    const circle = document.createElementNS(SVG_NS, 'circle');
    const isHovered = p.id === hoveredPoint;
    const isCloseable = p.id === firstPathPointId && currentPath.length >= 3;

    let cls = 'ev2-point';
    if (isCloseable) cls += ' ev2-point-closeable';
    else if (isHovered) cls += ' ev2-point-hover';

    circle.setAttribute('class', cls);
    circle.setAttribute('cx', String(p.x));
    circle.setAttribute('cy', String(p.y));
    circle.setAttribute('r', isHovered || isCloseable ? '7' : '5');
    pointLayer.appendChild(circle);
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

function setMode(newMode: 'edit' | 'territory'): void {
  mode = newMode;

  btnEdit.classList.toggle('active', mode === 'edit');
  btnTerritory.classList.toggle('active', mode === 'territory');

  panelEdit.classList.toggle('hidden', mode !== 'edit');
  panelTerritory.classList.toggle('hidden', mode !== 'territory');

  svgEl.style.cursor = mode === 'edit' ? 'crosshair' : 'default';

  render();
}

// ── Edit mode click handling ──────────────────────────────────────────────────

function handleEditClick(e: MouseEvent): void {
  const { x, y } = svgCoords(e);
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
  panelEdit      = document.getElementById('ev2-panel-edit') as HTMLElement;
  panelTerritory = document.getElementById('ev2-panel-territory') as HTMLElement;

  // Create SVG layers
  for (const id of ['ev2-territory-layer', 'ev2-edge-layer', 'ev2-point-layer', 'ev2-preview-layer']) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('id', id);
    svgEl.appendChild(g);
  }

  // SVG mouse events
  svgEl.addEventListener('mousemove', (e: MouseEvent) => {
    if (overlayEl.classList.contains('hidden')) return;
    const { x, y } = svgCoords(e);
    cursorPos = { x, y };
    const snap = findSnapPoint(x, y);
    hoveredPoint = snap ? snap.id : null;
    render();
  });

  svgEl.addEventListener('click', (e: MouseEvent) => {
    if (overlayEl.classList.contains('hidden')) return;
    if (mode === 'edit') {
      handleEditClick(e);
    } else {
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

  // Sidebar buttons
  btnEdit.addEventListener('click', () => setMode('edit'));
  btnTerritory.addEventListener('click', () => setMode('territory'));

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
  btnEdit.classList.add('active');
  btnTerritory.classList.remove('active');
  panelEdit.classList.remove('hidden');
  panelTerritory.classList.add('hidden');
  svgEl.style.cursor = 'crosshair';

  resizeSvg();
  render();
}

export function hideEditorV2(): void {
  overlayEl.classList.add('hidden');
}
