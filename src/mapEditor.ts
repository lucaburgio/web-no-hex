// ── Map editor — Polygon-based territory maps ───────────────────────────────

import mountainPatternSrc from '../public/images/misc/mountain-pattern.png';
import { sanitizeTerritoryMapDef, type TerritoryMapDef } from './territoryMap';

const SVG_NS = 'http://www.w3.org/2000/svg';

// ── Types ─────────────────────────────────────────────────────────────────────

type TerritoryState = 'neutral' | 'allied' | 'enemy' | 'mountain';
type TerritoryTool = TerritoryState | 'controlpoint';

interface Pt { id: string; x: number; y: number }
interface Edge { id: string; a: string; b: string }
interface Territory { id: string; pointIds: string[]; state: TerritoryState }
interface ControlPoint { id: string; territoryId: string; name: string }
interface Note { id: string; x: number; y: number; text: string; align: 'left' | 'center' | 'right'; maxWidth?: number }
interface Sector { id: string; name: string; territoryIds: string[] }

// ── Module-level state ────────────────────────────────────────────────────────

let pts: Pt[] = [];
let edges: Edge[] = [];
let territories: Territory[] = [];
let controlPoints: ControlPoint[] = [];
let notes: Note[] = [];
let sectors: Sector[] = [];
let currentPath: string[] = [];      // point IDs in-progress
let mode: 'edit' | 'borders' | 'territory' | 'sectors' | 'view' = 'edit';
let isRemovingDot = false;           // remove-dot sub-mode within edit
let isNoteTool = false;              // note placement sub-mode within edit
let territoryTool: TerritoryTool = 'allied';
let selectedEdgeIds = new Set<string>();
let selectedTerritoryId: string | null = null;
let selectedSectorTerritoryIds = new Set<string>();
let editingSectorId: string | null = null;
let bordersError: string | null = null;
let hoveredPoint: string | null = null;
let cursorPos: { x: number; y: number } = { x: 0, y: 0 };
let dragPointId: string | null = null;  // point being dragged
let dragNoteId: string | null = null;   // note being dragged
let hasDragged = false;                 // true if mouse moved during drag

// Pan / zoom state
let panX = 0;
let panY = 0;
let zoom = 1;
let isPanning = false;
let hasPanned = false;
let spaceDown = false;
let panStartClientX = 0;
let panStartClientY = 0;
let panStartPanX = 0;
let panStartPanY = 0;

let _ptCounter = 0;
let _edgeCounter = 0;
let _territoryCounter = 0;
let _cpCounter = 0;
let _noteCounter = 0;
let _sectorCounter = 0;

function newPtId(): string  { return `p${++_ptCounter}`; }
function newEdgeId(): string { return `e${++_edgeCounter}`; }
function newTerritoryId(): string { return `t${++_territoryCounter}`; }
function newCpId(): string { return `cp${++_cpCounter}`; }
function newNoteId(): string { return `note${++_noteCounter}`; }
function newSectorId(): string { return `sec${++_sectorCounter}`; }

// ── DOM refs (set in initMapEditor) ────────────────────────────────────────────

let overlayEl: HTMLElement;
let svgEl: SVGSVGElement;
let canvasAreaEl: HTMLElement;
let btnEdit: HTMLButtonElement;
let btnTerritory: HTMLButtonElement;
let btnView: HTMLButtonElement;
let btnBorders: HTMLButtonElement;
let removeDotBtn: HTMLButtonElement;
let noteToolBtn: HTMLButtonElement;
let panelEdit: HTMLElement;
let panelBorders: HTMLElement;
let panelTerritory: HTMLElement;
let btnSectors: HTMLButtonElement;
let panelSectors: HTMLElement;

// ── Geometry helpers ──────────────────────────────────────────────────────────

function svgCoords(e: MouseEvent): { x: number; y: number } {
  const rect = svgEl.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / zoom + panX,
    y: (e.clientY - rect.top) / zoom + panY,
  };
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

function findSnapNote(x: number, y: number): Note | null {
  const SNAP_RADIUS = 14;
  let best: Note | null = null;
  let bestDist = Infinity;
  for (const n of notes) {
    const d = dist(n.x, n.y, x, y);
    if (d < SNAP_RADIUS && d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  return best;
}

/**
 * d3.polygonContains — ray parity over edges (d3-polygon, proven on dense meshes).
 * Uses same (x,y) space as the SVG polygon vertices.
 */
function pointInPolygon(x: number, y: number, polygon: Array<{ x: number; y: number }>): boolean {
  const n = polygon.length;
  if (n < 3) return false;
  const p0 = polygon[n - 1]!;
  let x0 = p0.x, y0 = p0.y;
  let x1, y1;
  let inside = false;
  for (let i = 0; i < n; i++) {
    const p = polygon[i]!;
    x1 = p.x; y1 = p.y;
    if ((y1 > y) !== (y0 > y) && x < ((x0 - x1) * (y - y1)) / (y0 - y1) + x1) inside = !inside;
    x0 = x1; y0 = y1;
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

// ── Auto-detect territories from planar graph ────────────────────────────────

/**
 * Finds all enclosed faces in the drawn planar graph using a DCEL half-edge
 * traversal and saves them as new territories (skipping duplicates and the
 * outer/infinite face).
 *
 * For each undirected edge {a,b} we create two directed half-edges: (a→b) and
 * (b→a).  For half-edge h = (u→v) the "next" half-edge in the face is the one
 * that leaves v making the most clockwise turn — i.e. the outgoing edge from v
 * that comes just *before* the twin (v→u) in the CCW-sorted list around v.
 * Traversing these "next" pointers traces every face.  Faces with positive
 * signed area (in SVG coords where y increases downward) are interior faces;
 * the outer (infinite) face has negative area and is discarded.
 */
function autoDetectTerritories(): { added: number; skipped: number } {
  if (edges.length < 3) return { added: 0, skipped: 0 };

  // Flat arrays keyed by half-edge index (edge i → HE 2i and 2i+1)
  const totalHE = edges.length * 2;
  const heFrom:    string[]  = new Array(totalHE);
  const heTo:      string[]  = new Array(totalHE);
  const heTwin:    number[]  = new Array(totalHE);
  const heNext:    number[]  = new Array(totalHE);
  const heVisited: boolean[] = new Array(totalHE).fill(false);

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    const idx = i * 2;
    heFrom[idx]     = e.a; heTo[idx]     = e.b; heTwin[idx]     = idx + 1;
    heFrom[idx + 1] = e.b; heTo[idx + 1] = e.a; heTwin[idx + 1] = idx;
  }

  // Outgoing half-edge lists per vertex, sorted CCW by angle
  const outgoing = new Map<string, number[]>();
  for (let i = 0; i < totalHE; i++) {
    const from = heFrom[i]!;
    let list = outgoing.get(from);
    if (!list) { list = []; outgoing.set(from, list); }
    list.push(i);
  }
  for (const indices of outgoing.values()) {
    indices.sort((a, b) => {
      const pfa = ptById(heFrom[a]!)!; const pta = ptById(heTo[a]!)!;
      const pfb = ptById(heFrom[b]!)!; const ptb = ptById(heTo[b]!)!;
      return Math.atan2(pta.y - pfa.y, pta.x - pfa.x) -
             Math.atan2(ptb.y - pfb.y, ptb.x - pfb.x);
    });
  }

  // next(h) = outgoing[h.to][ (pos_of_twin - 1 + n) % n ]
  // This picks the most clockwise turn from the twin's direction around the vertex.
  for (let i = 0; i < totalHE; i++) {
    const toVtx  = heTo[i]!;
    const outList = outgoing.get(toVtx)!;
    const pos = outList.indexOf(heTwin[i]!);
    heNext[i] = outList[(pos - 1 + outList.length) % outList.length]!;
  }

  // Traverse faces
  let added = 0;
  let skipped = 0;

  for (let start = 0; start < totalHE; start++) {
    if (heVisited[start]) continue;

    const face: string[] = [];
    let cur = start;
    while (!heVisited[cur]) {
      heVisited[cur] = true;
      face.push(heFrom[cur]!);
      cur = heNext[cur]!;
    }

    if (face.length < 3) continue;

    // Signed area via shoelace — positive in SVG coords (y-down) = CW winding = interior face
    let area = 0;
    for (let j = 0; j < face.length; j++) {
      const pj = ptById(face[j]!)!;
      const pk = ptById(face[(j + 1) % face.length]!)!;
      area += pj.x * pk.y - pk.x * pj.y;
    }
    if (area <= 0) continue; // outer / infinite face

    if (territories.some((t) => samePointSetAsTerritory(t, face))) {
      skipped++;
      continue;
    }

    territories.push({ id: newTerritoryId(), pointIds: face, state: 'neutral' });
    added++;
  }

  render();
  return { added, skipped };
}

// ── Close loop from selected border edges (Borders mode) ────────────────────

function samePointSetAsTerritory(t: Territory, pointIds: string[]): boolean {
  if (t.pointIds.length !== pointIds.length) return false;
  const a = new Set(t.pointIds);
  const b = new Set(pointIds);
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

/**
 * Selected edges must form one simple cycle: 2 edges per point, |E| = |V|, connected.
 * Returns pointIds in order around the loop (not repeating the first at the end).
 */
function cycleFromSelectedEdges(selected: Set<string>): { ok: true; pointIds: string[] } | { ok: false; error: string } {
  const el = edges.filter((e) => selected.has(e.id));
  if (el.length < 3) return { ok: false, error: 'Select at least 3 edges.' };

  const deg = new Map<string, number>();
  for (const e of el) {
    deg.set(e.a, (deg.get(e.a) || 0) + 1);
    deg.set(e.b, (deg.get(e.b) || 0) + 1);
  }
  for (const c of deg.values()) {
    if (c !== 2) {
      return { ok: false, error: 'Each point must be touched by exactly two selected edges (one closed loop).' };
    }
  }
  if (el.length !== deg.size) {
    return { ok: false, error: 'Selection must be a single closed loop (same number of edges and corners).' };
  }

  const e0 = el[0]!;
  const pointIds: string[] = [e0.a];
  let at = e0.b;
  const used = new Set<string>([e0.id]);

  while (used.size < el.length) {
    const e = el.find((ed) => !used.has(ed.id) && (ed.a === at || ed.b === at));
    if (!e) return { ok: false, error: 'Selected edges are not one connected loop.' };
    const other = e.a === at ? e.b : e.a;
    used.add(e.id);
    if (used.size < el.length) {
      if (other === pointIds[0]) {
        return { ok: false, error: 'Loop closes before every edge is used—select only one closed ring.' };
      }
      pointIds.push(other);
      at = other;
    } else {
      if (other !== pointIds[0]) {
        return { ok: false, error: 'The last edge does not return to the start of the loop.' };
      }
    }
  }
  return { ok: true, pointIds };
}

function findEdgeIdAtEvent(e: MouseEvent): string | null {
  const stack = document.elementsFromPoint(e.clientX, e.clientY);
  for (const item of stack) {
    if (!(item instanceof Element) || !svgEl.contains(item)) continue;
    if (item.localName === 'line' && item.classList.contains('ev2-edge-hit')) {
      const id = item.getAttribute('data-ev2-edge-id');
      if (id) return id;
    }
  }
  return null;
}

function setBordersError(msg: string | null): void {
  bordersError = msg;
  const el = document.getElementById('ev2-borders-error');
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

function renderTerritoryList(): void {
  const ul = document.getElementById('ev2-territory-list') as HTMLUListElement | null;
  if (!ul) return;
  ul.replaceChildren();
  for (const t of territories) {
    const li = document.createElement('li');
    const top = document.createElement('div');
    top.style.display = 'flex';
    top.style.alignItems = 'center';
    top.style.gap = '6px';
    const selBtn = document.createElement('button');
    selBtn.type = 'button';
    selBtn.className = 'ev2-territory-list-select' + (t.id === selectedTerritoryId ? ' active' : '');
    selBtn.textContent = t.id;
    selBtn.dataset.territoryId = t.id;
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'ev2-danger';
    delBtn.textContent = '×';
    delBtn.title = 'Delete';
    delBtn.style.flex = '0 0 28px';
    delBtn.dataset.territoryDelete = t.id;
    top.appendChild(selBtn);
    top.appendChild(delBtn);
    li.appendChild(top);
    ul.appendChild(li);
  }
}

function renderCpList(): void {
  const ul = document.getElementById('ev2-cp-list') as HTMLUListElement | null;
  if (!ul) return;

  // Remove items for deleted CPs
  const cpIds = new Set(controlPoints.map(cp => cp.id));
  for (const li of [...ul.children] as HTMLElement[]) {
    if (li.dataset.cpId && !cpIds.has(li.dataset.cpId)) li.remove();
  }

  // Add items for new CPs (skip existing)
  const existing = new Set([...ul.querySelectorAll<HTMLElement>('li[data-cp-id]')].map(li => li.dataset.cpId!));
  for (const cp of controlPoints) {
    if (existing.has(cp.id)) continue;
    const li = document.createElement('li');
    li.dataset.cpId = cp.id;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = cp.name;
    input.className = 'ev2-cp-name-input';
    input.dataset.cpId = cp.id;
    input.placeholder = 'Name…';

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'ev2-cp-del-btn';
    delBtn.textContent = '×';
    delBtn.title = 'Delete';
    delBtn.dataset.cpDelete = cp.id;

    li.appendChild(input);
    li.appendChild(delBtn);
    ul.appendChild(li);
  }
}

function renderNoteList(): void {
  const ul = document.getElementById('ev2-notes-list') as HTMLUListElement | null;
  if (!ul) return;

  const noteIds = new Set(notes.map(n => n.id));
  for (const li of [...ul.children] as HTMLElement[]) {
    if (li.dataset.noteId && !noteIds.has(li.dataset.noteId)) li.remove();
  }

  const existing = new Set([...ul.querySelectorAll<HTMLElement>('li[data-note-id]')].map(li => li.dataset.noteId!));
  for (const note of notes) {
    if (existing.has(note.id)) {
      // Update text input value if it differs (e.g. after import)
      const input = ul.querySelector<HTMLInputElement>(`li[data-note-id="${note.id}"] .ev2-note-text-input`);
      if (input && input.value !== note.text) input.value = note.text;
      // Update active align button
      ul.querySelectorAll<HTMLElement>(`li[data-note-id="${note.id}"] .ev2-note-align-btn`).forEach(b => {
        b.classList.toggle('active', b.dataset.align === note.align);
      });
      // Update max-width input
      const mwInput = ul.querySelector<HTMLInputElement>(`li[data-note-id="${note.id}"] .ev2-note-maxwidth-input`);
      if (mwInput) {
        const v = note.maxWidth ? String(note.maxWidth) : '';
        if (mwInput.value !== v) mwInput.value = v;
      }
      continue;
    }

    const li = document.createElement('li');
    li.dataset.noteId = note.id;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = note.text;
    input.className = 'ev2-note-text-input';
    input.dataset.noteId = note.id;
    input.placeholder = 'Note text…';

    const controls = document.createElement('div');
    controls.className = 'ev2-note-list-controls';

    for (const align of ['left', 'center', 'right'] as const) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ev2-note-align-btn' + (note.align === align ? ' active' : '');
      btn.dataset.align = align;
      btn.dataset.noteId = note.id;
      btn.textContent = align === 'left' ? 'L' : align === 'center' ? 'C' : 'R';
      btn.title = align.charAt(0).toUpperCase() + align.slice(1);
      controls.appendChild(btn);
    }

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'ev2-note-del-btn';
    delBtn.textContent = '×';
    delBtn.title = 'Delete';
    delBtn.dataset.noteDelete = note.id;

    controls.appendChild(delBtn);

    const mwRow = document.createElement('div');
    mwRow.className = 'ev2-note-maxwidth-row';
    const mwLabel = document.createElement('label');
    mwLabel.className = 'ev2-note-maxwidth-label';
    mwLabel.textContent = 'max-w';
    const mwInput = document.createElement('input');
    mwInput.type = 'number';
    mwInput.min = '10';
    mwInput.step = '10';
    mwInput.value = note.maxWidth ? String(note.maxWidth) : '';
    mwInput.className = 'ev2-note-maxwidth-input';
    mwInput.dataset.noteId = note.id;
    mwInput.placeholder = '—';
    mwRow.appendChild(mwLabel);
    mwRow.appendChild(mwInput);

    li.appendChild(input);
    li.appendChild(controls);
    li.appendChild(mwRow);
    ul.appendChild(li);
  }
}

function renderSectorList(): void {
  const ul = document.getElementById('ev2-sector-list') as HTMLUListElement | null;
  if (!ul) return;
  ul.replaceChildren();
  for (const s of sectors) {
    const li = document.createElement('li');
    li.dataset.sectorId = s.id;
    li.className = 'ev2-sector-item';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = s.name;
    nameInput.className = 'ev2-cp-name-input';
    nameInput.dataset.sectorId = s.id;
    nameInput.placeholder = 'Sector name…';

    const countBadge = document.createElement('span');
    countBadge.className = 'ev2-sector-count-badge';
    countBadge.textContent = `${s.territoryIds.length}`;

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'ev2-sector-edit-btn';
    editBtn.textContent = 'EDIT';
    editBtn.dataset.sectorEdit = s.id;

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'ev2-cp-del-btn';
    delBtn.textContent = '×';
    delBtn.title = 'Delete sector';
    delBtn.dataset.sectorDelete = s.id;

    li.appendChild(nameInput);
    li.appendChild(countBadge);
    li.appendChild(editBtn);
    li.appendChild(delBtn);
    ul.appendChild(li);
  }

  // Update selection count display
  const selEl = document.getElementById('ev2-sectors-selection');
  if (selEl) {
    const n = selectedSectorTerritoryIds.size;
    selEl.textContent = `${n} territor${n === 1 ? 'y' : 'ies'} selected`;
  }

  // Update cancel button visibility
  const cancelBtn = document.getElementById('ev2-sectors-cancel-btn') as HTMLButtonElement | null;
  if (cancelBtn) cancelBtn.classList.toggle('hidden', !editingSectorId);
}

function updateBordersPanel(): void {
  const n = selectedEdgeIds.size;
  const countEl = document.getElementById('ev2-borders-selection');
  if (countEl) countEl.textContent = `${n} edge${n === 1 ? '' : 's'} selected`;
  const rep = document.getElementById('ev2-borders-replace-btn') as HTMLButtonElement | null;
  if (rep) rep.disabled = !selectedTerritoryId;
  setBordersError(bordersError);
  renderTerritoryList();
  renderCpList();
  renderNoteList();
  renderSectorList();
}

function territoryCentroid(t: Territory): { x: number; y: number } {
  const tPts = territoryPoints(t);
  const x = tPts.reduce((s, p) => s + p.x, 0) / tPts.length;
  const y = tPts.reduce((s, p) => s + p.y, 0) / tPts.length;
  return { x, y };
}

function saveTerritoryFromSelection(replace: boolean): void {
  const r = cycleFromSelectedEdges(selectedEdgeIds);
  if (!r.ok) {
    setBordersError(r.error);
    return;
  }
  if (replace) {
    if (!selectedTerritoryId) {
      setBordersError('Select a territory in the list first.');
      return;
    }
    const t = territories.find((x) => x.id === selectedTerritoryId);
    if (!t) {
      setBordersError('Selected territory not found.');
      return;
    }
    t.pointIds = r.pointIds;
    setBordersError(null);
    selectedEdgeIds = new Set();
  } else {
    if (territories.some((t) => samePointSetAsTerritory(t, r.pointIds))) {
      setBordersError('A territory with this exact border already exists.');
      return;
    }
    territories.push({ id: newTerritoryId(), pointIds: r.pointIds, state: 'neutral' });
    setBordersError(null);
    selectedEdgeIds = new Set();
  }
  render();
}

function handleBordersClick(e: MouseEvent): void {
  const edgeId = findEdgeIdAtEvent(e);
  if (!edgeId) return;
  if (selectedEdgeIds.has(edgeId)) selectedEdgeIds.delete(edgeId);
  else selectedEdgeIds.add(edgeId);
  setBordersError(null);
  render();
}

// ── Resize ────────────────────────────────────────────────────────────────────

function updateViewBox(): void {
  const w = canvasAreaEl.clientWidth;
  const h = canvasAreaEl.clientHeight;
  svgEl.setAttribute('viewBox', `${panX} ${panY} ${w / zoom} ${h / zoom}`);
}

function resizeSvg(): void {
  const w = canvasAreaEl.clientWidth;
  const h = canvasAreaEl.clientHeight;
  svgEl.setAttribute('width', String(w));
  svgEl.setAttribute('height', String(h));
  updateViewBox();
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


/**
 * Builds an SVG path string for the territory border at `inset` pixels inward
 * from the polygon boundary. Adjacent non-suppressed offset edges are joined with
 * a miter (line intersection); if the miter is too extreme (concave vertex), a
 * bevel (two points) is used instead. Suppressed edges create natural gaps.
 */
function buildInsetBorderPath(
  t: Territory,
  edgeIndex: Map<string, Territory[]>,
  inset: number,
): string {
  const tPts = territoryPoints(t);
  const n = tPts.length;
  if (n < 3) return '';

  // Signed area (SVG y-down): positive = CW → right normal is inward
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = tPts[i]!, b = tPts[(i + 1) % n]!;
    area += a.x * b.y - b.x * a.y;
  }
  const cw = area > 0 ? 1 : -1;

  const edgePairs = polygonEdgePairs(t);
  const suppressed = edgePairs.map(([a, b]) => shouldSuppressBorderOnEdge(t, [a, b], edgeIndex));

  // Offset each edge inward by `inset` pixels
  type OE = { ax: number; ay: number; bx: number; by: number };
  const off: OE[] = edgePairs.map(([aId, bId]) => {
    const pa = ptById(aId)!, pb = ptById(bId)!;
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.5) return { ax: pa.x, ay: pa.y, bx: pb.x, by: pb.y };
    const nx = cw * dy / len, ny = cw * -dx / len;
    return { ax: pa.x + nx * inset, ay: pa.y + ny * inset,
             bx: pb.x + nx * inset, by: pb.y + ny * inset };
  });

  // Miter join: intersection of the two infinite offset lines.
  // Returns null when parallel or when the parameter is outside a reasonable range
  // (extreme concave miter) — caller falls back to bevel.
  function miterJoin(i: number, j: number): { x: number; y: number } | null {
    const o1 = off[i]!, o2 = off[j]!;
    const dx1 = o1.bx - o1.ax, dy1 = o1.by - o1.ay;
    const dx2 = o2.bx - o2.ax, dy2 = o2.by - o2.ay;
    const denom = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(denom) < 0.001) return null;
    const param = ((o2.ax - o1.ax) * dy2 - (o2.ay - o1.ay) * dx2) / denom;
    if (param < -2 || param > 3) return null; // too extreme → bevel
    return { x: o1.ax + param * dx1, y: o1.ay + param * dy1 };
  }

  // All edges non-suppressed → single closed polygon
  if (suppressed.every(s => !s)) {
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const jp = miterJoin(i, j);
      if (jp) {
        pts.push(jp);
      } else {
        pts.push({ x: off[i]!.bx, y: off[i]!.by });
        pts.push({ x: off[j]!.ax, y: off[j]!.ay });
      }
    }
    return 'M ' + pts.map(p => `${p.x},${p.y}`).join(' L ') + ' Z';
  }

  // Mixed suppression → open sub-paths, one per run of non-suppressed edges
  let pathD = '';
  for (let start = 0; start < n; start++) {
    if (suppressed[start] || !suppressed[(start - 1 + n) % n]) continue; // only run starts

    const pts: Array<{ x: number; y: number }> = [];
    pts.push({ x: off[start]!.ax, y: off[start]!.ay }); // open start (no join)

    let i = start;
    while (true) {
      const next = (i + 1) % n;
      if (suppressed[next] || next === start) {
        pts.push({ x: off[i]!.bx, y: off[i]!.by }); // open end
        break;
      }
      const jp = miterJoin(i, next);
      if (jp) {
        pts.push(jp);
      } else {
        pts.push({ x: off[i]!.bx, y: off[i]!.by });
        pts.push({ x: off[next]!.ax, y: off[next]!.ay });
      }
      i = next;
    }

    if (pts.length >= 2) pathD += 'M ' + pts.map(p => `${p.x},${p.y}`).join(' L ') + ' ';
  }
  return pathD;
}

// ── Shared-border helpers ─────────────────────────────────────────────────────

/** Returns ordered edge pairs [(p0,p1),(p1,p2),...,(pn,p0)] for a territory polygon. */
function polygonEdgePairs(t: Territory): Array<[string, string]> {
  return t.pointIds.map((id, i) => [id, t.pointIds[(i + 1) % t.pointIds.length]] as [string, string]);
}

function undirectedEdgeKey(aId: string, bId: string): string {
  return aId < bId ? `${aId}\0${bId}` : `${bId}\0${aId}`;
}

/** For each undirected map edge, which distinct territories use that segment (deduped by id). */
function buildEdgeTerritoryIndex(): Map<string, Territory[]> {
  const byId = new Map(territories.map((t) => [t.id, t] as [string, Territory]));
  const idSets = new Map<string, Set<string>>();
  for (const t of territories) {
    for (const [aId, bId] of polygonEdgePairs(t)) {
      if (aId === bId) continue;
      const k = undirectedEdgeKey(aId, bId);
      let set = idSets.get(k);
      if (!set) {
        set = new Set();
        idSets.set(k, set);
      }
      set.add(t.id);
    }
  }
  const out = new Map<string, Territory[]>();
  for (const [k, set] of idSets) {
    out.set(
      k,
      [...set].map((id) => byId.get(id)).filter((x): x is Territory => x !== undefined),
    );
  }
  return out;
}

/**
 * The other territory that shares the undirected edge, if any (planar: usually one).
 */
function neighborFromEdgeIndex(
  t: Territory,
  edge: [string, string],
  index: Map<string, Territory[]>,
): Territory | null {
  const k = undirectedEdgeKey(edge[0]!, edge[1]!);
  const list = index.get(k);
  if (!list) return null;
  return list.find((o) => o.id !== t.id) ?? null;
}

/** True if this side of the edge should not draw a stroke (shared with same-state neighbor). */
function shouldSuppressBorderOnEdge(
  t: Territory,
  edge: [string, string],
  edgeIndex: Map<string, Territory[]>,
): boolean {
  if (t.state === 'neutral') return false;
  const neighbor = neighborFromEdgeIndex(t, edge, edgeIndex);
  if (!neighbor) return false;
  return neighbor.state === t.state;
}

function render(): void {
  // Ensure defs element exists and is first
  let defsEl = svgEl.querySelector('defs') as SVGDefsElement | null;
  if (!defsEl) {
    defsEl = document.createElementNS(SVG_NS, 'defs') as SVGDefsElement;
    svgEl.prepend(defsEl);
  }
  // Rebuild defs clip paths and outer-border pattern
  defsEl.innerHTML = '';

  for (const t of territories) {
    const clipPath = document.createElementNS(SVG_NS, 'clipPath');
    clipPath.setAttribute('id', `ev2-clip-${t.id}`);
    const clipPoly = document.createElementNS(SVG_NS, 'polygon');
    clipPoly.setAttribute('points', territoryPointsAttr(t));
    clipPath.appendChild(clipPoly);
    defsEl.appendChild(clipPath);
  }

  // Pattern for outer border
  const outerPattern = document.createElementNS(SVG_NS, 'pattern');
  outerPattern.setAttribute('id', 'ev2-outer-border-pattern');
  outerPattern.setAttribute('patternUnits', 'userSpaceOnUse');
  outerPattern.setAttribute('width', '48');
  outerPattern.setAttribute('height', '48');
  const outerPatternImg = document.createElementNS(SVG_NS, 'image');
  outerPatternImg.setAttribute('href', 'images/misc/outside-border-pattern.png');
  outerPatternImg.setAttribute('width', '48');
  outerPatternImg.setAttribute('height', '48');
  outerPattern.appendChild(outerPatternImg);
  defsEl.appendChild(outerPattern);

  // Pattern for mountain territory fill
  const mountainPattern = document.createElementNS(SVG_NS, 'pattern');
  mountainPattern.setAttribute('id', 'ev2-mountain-pattern');
  mountainPattern.setAttribute('patternUnits', 'userSpaceOnUse');
  mountainPattern.setAttribute('width', '45');
  mountainPattern.setAttribute('height', '45');
  const mountainPatternImgEl = document.createElementNS(SVG_NS, 'image');
  mountainPatternImgEl.setAttribute('href', mountainPatternSrc);
  mountainPatternImgEl.setAttribute('width', '45');
  mountainPatternImgEl.setAttribute('height', '45');
  mountainPattern.appendChild(mountainPatternImgEl);
  defsEl.appendChild(mountainPattern);

  // ── Territory layer ──────────────────────────────────────────────────────
  const territoryLayer = svgEl.querySelector('#ev2-territory-layer') as SVGGElement;
  territoryLayer.innerHTML = '';
  territoryLayer.style.pointerEvents = mode === 'territory' ? 'auto' : 'none';

  const edgeIndex = buildEdgeTerritoryIndex();

  // ── Outer border layer ───────────────────────────────────────────────────
  // Build a unified perimeter path from all outer edges (touching only 1 territory).
  // Stroke it 144px wide (half inside, half outside) — the territory layer covers
  // the inner half, leaving 72px of pattern border visible around the map.
  const outerBorderLayer = svgEl.querySelector('#ev2-outer-border-layer') as SVGGElement;
  outerBorderLayer.innerHTML = '';
  outerBorderLayer.setAttribute('pointer-events', 'none');

  if (territories.length > 0) {
    // Collect outer edge segments as [pa, pb] pairs
    const outerSegments: Array<[Pt, Pt]> = [];
    for (const edge of edges) {
      const terrs = edgeIndex.get(undirectedEdgeKey(edge.a, edge.b));
      if (!terrs || terrs.length !== 1) continue;
      const pa = ptById(edge.a);
      const pb = ptById(edge.b);
      if (pa && pb) outerSegments.push([pa, pb]);
    }

    // Chain segments into continuous polylines
    if (outerSegments.length > 0) {
      // Build adjacency: point id → connected point ids in outer perimeter
      const adj = new Map<string, string[]>();
      for (const [pa, pb] of outerSegments) {
        if (!adj.has(pa.id)) adj.set(pa.id, []);
        if (!adj.has(pb.id)) adj.set(pb.id, []);
        adj.get(pa.id)!.push(pb.id);
        adj.get(pb.id)!.push(pa.id);
      }

      const visited = new Set<string>();
      const chains: Array<{ pts: Pt[]; closed: boolean }> = [];

      for (const [startPt] of outerSegments) {
        if (visited.has(startPt.id)) continue;
        const chain: Pt[] = [startPt];
        visited.add(startPt.id);
        let cur = startPt;
        let prevId: string | null = null;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const neighbors = adj.get(cur.id) ?? [];
          const next = neighbors.find(id => id !== prevId && !visited.has(id));
          if (next === undefined) break;
          visited.add(next);
          prevId = cur.id;
          cur = ptById(next)!;
          chain.push(cur);
        }
        // Detect closed loop: last point connects back to first
        const lastNeighbors = adj.get(chain[chain.length - 1]!.id) ?? [];
        const closed = lastNeighbors.includes(chain[0]!.id);
        chains.push({ pts: chain, closed });
      }

      // Build SVG path from all chains
      let d = '';
      for (const { pts: cpts, closed } of chains) {
        if (cpts.length < 2) continue;
        d += `M ${cpts[0]!.x},${cpts[0]!.y}`;
        for (let i = 1; i < cpts.length; i++) d += ` L ${cpts[i]!.x},${cpts[i]!.y}`;
        if (closed) d += ' Z';
      }

      if (d) {
        const perimPath = document.createElementNS(SVG_NS, 'path');
        perimPath.setAttribute('d', d);
        perimPath.setAttribute('fill', 'none');
        perimPath.setAttribute('stroke', 'url(#ev2-outer-border-pattern)');
        perimPath.setAttribute('stroke-width', '144');
        perimPath.setAttribute('stroke-linecap', 'butt');
        perimPath.setAttribute('stroke-linejoin', 'round');
        outerBorderLayer.appendChild(perimPath);
      }
    }
  }

  for (const t of territories) {
    const pts_str = territoryPointsAttr(t);

    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('data-ev2-territory-id', t.id);
    if (mode === 'borders' && selectedTerritoryId === t.id) {
      group.classList.add('ev2-territory-selected');
    }
    if (mode === 'sectors' && selectedSectorTerritoryIds.has(t.id)) {
      group.classList.add('ev2-territory-sector-selected');
    }

    // Filled polygon
    const fill = document.createElementNS(SVG_NS, 'polygon');
    fill.setAttribute('class', `ev2-territory-fill ev2-state-${t.state}`);
    fill.setAttribute('points', pts_str);
    group.appendChild(fill);

    // Inset border rendered as a compositing group so opacity never compounds at
    // sub-path endpoints. The glow layer uses butt caps (no end-cap blobs);
    // the main line uses round caps for clean termination.
    if (t.state !== 'neutral' && t.state !== 'mountain') {
      const borderPathD = buildInsetBorderPath(t, edgeIndex, -10);
      if (borderPathD) {
        const borderGroup = document.createElementNS(SVG_NS, 'g');
        borderGroup.setAttribute('class', `ev2-territory-border ev2-border-${t.state}`);
        borderGroup.setAttribute('pointer-events', 'none');

        const glowEl = document.createElementNS(SVG_NS, 'path');
        glowEl.setAttribute('d', borderPathD);
        glowEl.setAttribute('class', 'ev2-border-glow');
        borderGroup.appendChild(glowEl);

        const lineEl = document.createElementNS(SVG_NS, 'path');
        lineEl.setAttribute('d', borderPathD);
        lineEl.setAttribute('class', 'ev2-border-line');
        borderGroup.appendChild(lineEl);

        group.appendChild(borderGroup);
      }
    }

    territoryLayer.appendChild(group);
  }

  // ── Control point layer ──────────────────────────────────────────────────
  const cpLayer = svgEl.querySelector('#ev2-cp-layer') as SVGGElement;
  cpLayer.innerHTML = '';
  cpLayer.setAttribute('pointer-events', 'none');
  for (const cp of controlPoints) {
    const t = territories.find((x) => x.id === cp.territoryId);
    if (!t) continue;
    const c = territoryCentroid(t);

    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('data-cp-id', cp.id);

    // Placeholder rect — sized after text is in DOM
    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('class', 'ev2-cp-label-bg');
    bg.setAttribute('rx', '0');
    g.appendChild(bg);

    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('class', 'ev2-cp-label');
    label.setAttribute('x', String(c.x));
    label.setAttribute('y', String(c.y - 14));
    label.textContent = cp.name;
    g.appendChild(label);

    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('class', 'ev2-cp-dot');
    dot.setAttribute('cx', String(c.x));
    dot.setAttribute('cy', String(c.y));
    dot.setAttribute('r', '4');
    g.appendChild(dot);

    cpLayer.appendChild(g);

    // Size the background rect to the rendered text bounds + padding
    try {
      const pad = 4;
      const bb = label.getBBox();
      bg.setAttribute('x', String(bb.x - pad));
      bg.setAttribute('y', String(bb.y - pad));
      bg.setAttribute('width', String(bb.width + pad * 2));
      bg.setAttribute('height', String(bb.height + pad * 2));
    } catch (_) { /* getBBox unavailable when SVG is hidden */ }
  }

  // ── Note layer ───────────────────────────────────────────────────────────
  const noteLayer = svgEl.querySelector('#ev2-note-layer') as SVGGElement;
  noteLayer.innerHTML = '';
  noteLayer.setAttribute('pointer-events', 'none');
  for (const note of notes) {
    const anchorMap = { left: 'start', center: 'middle', right: 'end' } as const;
    const anchor = anchorMap[note.align];

    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('data-note-id', note.id);

    if (note.maxWidth) {
      const mw = note.maxWidth;
      const foX = note.align === 'center' ? note.x - mw / 2
                : note.align === 'right'  ? note.x - mw
                : note.x;
      const fo = document.createElementNS(SVG_NS, 'foreignObject');
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
      const textEl = document.createElementNS(SVG_NS, 'text');
      textEl.setAttribute('class', 'ev2-note-text');
      textEl.setAttribute('x', String(note.x));
      textEl.setAttribute('y', String(note.y - 8));
      textEl.setAttribute('text-anchor', anchor);
      textEl.textContent = note.text || ' ';
      g.appendChild(textEl);
    }

    if (mode !== 'view') {
      const handle = document.createElementNS(SVG_NS, 'circle');
      handle.setAttribute('class', 'ev2-note-handle');
      handle.setAttribute('cx', String(note.x));
      handle.setAttribute('cy', String(note.y));
      handle.setAttribute('r', '5');
      g.appendChild(handle);
    }

    noteLayer.appendChild(g);
  }

  // ── Edge layer ───────────────────────────────────────────────────────────
  const edgeLayer = svgEl.querySelector('#ev2-edge-layer') as SVGGElement;
  edgeLayer.innerHTML = '';

  // All glow lines go into one compositing group so their opacity is applied
  // once to the full composite — overlapping strokes at vertices stay uniform.
  const glowGroup = document.createElementNS(SVG_NS, 'g');
  glowGroup.setAttribute('class', 'ev2-edge-glow-group');
  glowGroup.setAttribute('pointer-events', 'none');
  edgeLayer.appendChild(glowGroup);

  for (const edge of edges) {
    const pa = ptById(edge.a);
    const pb = ptById(edge.b);
    if (!pa || !pb) continue;

    const glow = document.createElementNS(SVG_NS, 'line');
    glow.setAttribute('class', 'ev2-edge-glow');
    glow.setAttribute('x1', String(pa.x));
    glow.setAttribute('y1', String(pa.y));
    glow.setAttribute('x2', String(pb.x));
    glow.setAttribute('y2', String(pb.y));
    glowGroup.appendChild(glow);

    if (mode === 'borders') {
      const hit = document.createElementNS(SVG_NS, 'line');
      hit.setAttribute('class', 'ev2-edge-hit');
      hit.setAttribute('data-ev2-edge-id', edge.id);
      hit.setAttribute('x1', String(pa.x));
      hit.setAttribute('y1', String(pa.y));
      hit.setAttribute('x2', String(pb.x));
      hit.setAttribute('y2', String(pb.y));
      hit.setAttribute('stroke', 'rgba(0,0,0,0.01)');
      hit.setAttribute('stroke-width', '22');
      hit.setAttribute('stroke-linecap', 'round');
      hit.setAttribute('pointer-events', 'stroke');
      edgeLayer.appendChild(hit);
    }

    const line = document.createElementNS(SVG_NS, 'line');
    const edgeTerritories = edgeIndex.get(undirectedEdgeKey(edge.a, edge.b));
    const isOuterEdge = edgeTerritories !== undefined && edgeTerritories.length === 1;
    let cls = isOuterEdge ? 'ev2-edge ev2-edge-outer' : 'ev2-edge';
    if (mode === 'borders' && selectedEdgeIds.has(edge.id)) cls += ' ev2-edge-selected';
    line.setAttribute('class', cls);
    if (mode === 'borders') line.setAttribute('data-ev2-edge-id', edge.id);
    line.setAttribute('x1', String(pa.x));
    line.setAttribute('y1', String(pa.y));
    line.setAttribute('x2', String(pb.x));
    line.setAttribute('y2', String(pb.y));
    line.setAttribute('pointer-events', 'none');
    edgeLayer.appendChild(line);
  }

  // ── Sector border layer ──────────────────────────────────────────────────
  const sectorBorderLayer = svgEl.querySelector('#ev2-sector-border-layer') as SVGGElement;
  sectorBorderLayer.innerHTML = '';
  sectorBorderLayer.setAttribute('pointer-events', 'none');

  if (sectors.length > 0) {
    const territoryToSector = new Map<string, string>();
    for (const s of sectors) {
      for (const tid of s.territoryIds) {
        territoryToSector.set(tid, s.id);
      }
    }
    for (const edge of edges) {
      const k = undirectedEdgeKey(edge.a, edge.b);
      const terrs = edgeIndex.get(k);
      if (!terrs || terrs.length !== 2) continue;
      const sA = territoryToSector.get(terrs[0]!.id);
      const sB = territoryToSector.get(terrs[1]!.id);
      if (!sA || !sB || sA === sB) continue;
      const pa = ptById(edge.a);
      const pb = ptById(edge.b);
      if (!pa || !pb) continue;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('class', 'ev2-sector-border');
      line.setAttribute('x1', String(pa.x));
      line.setAttribute('y1', String(pa.y));
      line.setAttribute('x2', String(pb.x));
      line.setAttribute('y2', String(pb.y));
      sectorBorderLayer.appendChild(line);
    }
  }

  // ── Point layer ──────────────────────────────────────────────────────────
  const pointLayer = svgEl.querySelector('#ev2-point-layer') as SVGGElement;
  pointLayer.innerHTML = '';
  pointLayer.style.pointerEvents = mode === 'territory' || mode === 'borders' ? 'none' : 'auto';
  edgeLayer.style.pointerEvents = mode === 'territory' ? 'none' : 'auto';

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

  updateBordersPanel();

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

function setMode(newMode: 'edit' | 'borders' | 'territory' | 'sectors' | 'view'): void {
  if (newMode !== 'sectors') {
    selectedSectorTerritoryIds = new Set();
    editingSectorId = null;
  }
  mode = newMode;
  isRemovingDot = false;
  isNoteTool = false;
  currentPath = [];

  btnEdit.classList.toggle('active', mode === 'edit');
  btnBorders.classList.toggle('active', mode === 'borders');
  btnTerritory.classList.toggle('active', mode === 'territory');
  btnSectors.classList.toggle('active', mode === 'sectors');
  btnView.classList.toggle('active', mode === 'view');

  panelEdit.classList.toggle('hidden', mode !== 'edit');
  panelBorders.classList.toggle('hidden', mode !== 'borders');
  panelTerritory.classList.toggle('hidden', mode !== 'territory');
  panelSectors.classList.toggle('hidden', mode !== 'sectors');

  // Reset sub-tool button visuals
  if (removeDotBtn) removeDotBtn.classList.remove('active');
  if (noteToolBtn) noteToolBtn.classList.remove('active');

  if (mode === 'edit') svgEl.style.cursor = 'crosshair';
  else svgEl.style.cursor = 'default';

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

  if (snap) {
    const snapId = snap.id;

    if (currentPath.length > 0) {
      const lastId = currentPath[currentPath.length - 1];

      if (snapId !== lastId) {
        addEdge(lastId, snapId);

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
    }
    currentPath.push(newPt.id);
  }

  render();
}

function handleNoteClick(e: MouseEvent): void {
  const { x, y } = svgCoords(e);
  notes.push({ id: newNoteId(), x, y, text: 'Note', align: 'center' });
  render();
}

// ── Territory mode click handling ─────────────────────────────────────────────

function applyTerritoryTool(t: Territory): void {
  if (territoryTool === 'controlpoint') {
    const existing = controlPoints.find((cp) => cp.territoryId === t.id);
    if (existing) {
      controlPoints = controlPoints.filter((cp) => cp.id !== existing.id);
    } else {
      controlPoints.push({ id: newCpId(), territoryId: t.id, name: t.id.toUpperCase() });
    }
  } else {
    t.state = t.state === territoryTool ? 'neutral' : territoryTool;
  }
  render();
}

/**
 * Nudges in SVG user space: ray tests on long edges and pixel-thin hit targets
 * often sit exactly on a boundary; wiggle the probe until exactly one (or a clear) face wins.
 */
/** Large nudges would push out of very small 4-vertex (and similar) cells; try tiny first. */
const PIP_NUDGE_PAIRS: Array<{ dx: number; dy: number }> = (() => {
  const a = 0.01, b = 0.1, c = 0.5, d = 1.5, e = 3;
  return [
    { dx: 0, dy: 0 },
    { dx: a, dy: 0 }, { dx: -a, dy: 0 }, { dx: 0, dy: a }, { dx: 0, dy: -a },
    { dx: b, dy: 0 }, { dx: -b, dy: 0 }, { dx: 0, dy: b }, { dx: 0, dy: -b },
    { dx: c, dy: 0 }, { dx: -c, dy: 0 }, { dx: 0, dy: c }, { dx: 0, dy: -c },
    { dx: d, dy: 0 }, { dx: -d, dy: 0 }, { dx: 0, dy: d }, { dx: 0, dy: -d },
    { dx: d, dy: d }, { dx: -d, dy: -d }, { dx: d, dy: -d }, { dx: -d, dy: d },
    { dx: e, dy: 0 }, { dx: -e, dy: 0 },
  ];
})();

/**
 * Picks a single territory from SVG coords. With overlapping / self-intersecting
 * loops, many territories can be “inside” for one (x,y); the smallest-area rule
 * does not match paint order or the browser’s own hit test, so we use the same
 * rule as the painter: last in `territories` is drawn on top and wins the click.
 */
function pickTerritoryAt(svgX: number, svgY: number): Territory | null {
  for (const { dx, dy } of PIP_NUDGE_PAIRS) {
    const x = svgX + dx;
    const y = svgY + dy;
    const inside: Territory[] = [];
    for (const t of territories) {
      if (pointInPolygon(x, y, territoryPoints(t))) inside.push(t);
    }
    if (inside.length === 0) continue;

    if (inside.length === 1) return inside[0]!;

    let best = inside[0]!;
    let bestIdx = territories.indexOf(best);
    for (let i = 1; i < inside.length; i++) {
      const cand = inside[i]!;
      const idx = territories.indexOf(cand);
      if (idx > bestIdx) {
        best = cand;
        bestIdx = idx;
      }
    }
    return best;
  }
  return null;
}

/**
 * Topmost *filled* territory polygon (not border strokes) — matches what the user sees.
 * Ignores thick inner border lines, which can sit over another face’s fill.
 */
function territoryIdFromTopFillPolygonAt(e: MouseEvent): string | null {
  const stack = document.elementsFromPoint(e.clientX, e.clientY);
  for (const item of stack) {
    if (!(item instanceof Element) || !svgEl.contains(item)) continue;
    if (item.localName !== 'polygon' || !item.classList.contains('ev2-territory-fill')) continue;
    const g = item.parentElement;
    if (g && g.hasAttribute('data-ev2-territory-id')) {
      return g.getAttribute('data-ev2-territory-id')!;
    }
  }
  return null;
}

function handleTerritoryClick(e: MouseEvent): void {
  const fromFill = territoryIdFromTopFillPolygonAt(e);
  if (fromFill) {
    const t = territories.find((x) => x.id === fromFill);
    if (t) { applyTerritoryTool(t); return; }
  }
  const { x, y } = svgCoords(e);
  const t = pickTerritoryAt(x, y);
  if (t) applyTerritoryTool(t);
}

// ── Sectors mode ──────────────────────────────────────────────────────────────

function handleSectorsClick(e: MouseEvent): void {
  const fromFill = territoryIdFromTopFillPolygonAt(e);
  let t: Territory | null = null;
  if (fromFill) {
    t = territories.find((x) => x.id === fromFill) ?? null;
  }
  if (!t) {
    const { x, y } = svgCoords(e);
    t = pickTerritoryAt(x, y);
  }
  if (!t) return;
  if (selectedSectorTerritoryIds.has(t.id)) {
    selectedSectorTerritoryIds.delete(t.id);
  } else {
    selectedSectorTerritoryIds.add(t.id);
  }
  render();
}

function saveSector(): void {
  const ids = [...selectedSectorTerritoryIds];
  if (ids.length === 0) return;
  if (editingSectorId) {
    const existing = sectors.find((s) => s.id === editingSectorId);
    if (existing) existing.territoryIds = ids;
    editingSectorId = null;
  } else {
    sectors.push({ id: newSectorId(), name: `Sector ${sectors.length + 1}`, territoryIds: ids });
  }
  selectedSectorTerritoryIds = new Set();
  render();
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
  controlPoints = [];
  notes = [];
  sectors = [];
  currentPath = [];
  hoveredPoint = null;
  _ptCounter = 0;
  _edgeCounter = 0;
  _territoryCounter = 0;
  _cpCounter = 0;
  _noteCounter = 0;
  _sectorCounter = 0;
  selectedEdgeIds = new Set();
  selectedTerritoryId = null;
  bordersError = null;
  render();
}

// ── Export / Import ───────────────────────────────────────────────────────────

function exportState(): void {
  const raw: TerritoryMapDef = {
    version: 2,
    pts,
    edges,
    territories,
    controlPoints,
    notes,
    sectors,
  };
  const data = sanitizeTerritoryMapDef(raw);
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
  const loaded: TerritoryMapDef = {
    version: data.version,
    pts: data.pts,
    edges: data.edges,
    territories: data.territories,
    controlPoints: Array.isArray(data.controlPoints) ? data.controlPoints : [],
    notes: Array.isArray(data.notes) ? data.notes : [],
    sectors: Array.isArray(data.sectors) ? data.sectors : [],
    adjacencyBlockPairs: Array.isArray(data.adjacencyBlockPairs) ? data.adjacencyBlockPairs : undefined,
  };
  const sanitized = sanitizeTerritoryMapDef(loaded);
  pts = sanitized.pts as Pt[];
  edges = sanitized.edges as Edge[];
  territories = sanitized.territories as Territory[];
  controlPoints = sanitized.controlPoints as ControlPoint[];
  notes = (sanitized.notes ?? []) as Note[];
  sectors = (sanitized.sectors ?? []) as Sector[];
  currentPath = [];
  hoveredPoint = null;
  selectedEdgeIds = new Set();
  selectedTerritoryId = null;
  selectedSectorTerritoryIds = new Set();
  editingSectorId = null;
  bordersError = null;

  // Restore counters from max IDs so new IDs don't collide
  const maxNum = (arr: Array<{ id: string }>, prefix: string) =>
    arr.reduce((m, x) => Math.max(m, parseInt(x.id.slice(prefix.length)) || 0), 0);
  _ptCounter        = maxNum(pts, 'p');
  _edgeCounter      = maxNum(edges, 'e');
  _territoryCounter = maxNum(territories, 't');
  _cpCounter        = maxNum(controlPoints, 'cp');
  _noteCounter      = maxNum(notes, 'note');
  _sectorCounter    = maxNum(sectors, 'sec');
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

export function initMapEditor(onBack: () => void): void {
  _onBack = onBack;

  if (_initialized) return;
  _initialized = true;

  (document.getElementById('ev2-swatch-mountain-img') as HTMLImageElement | null)?.setAttribute('src', mountainPatternSrc);

  overlayEl      = document.getElementById('map-editor-overlay') as HTMLElement;
  svgEl          = document.getElementById('ev2-svg') as unknown as SVGSVGElement;
  canvasAreaEl   = document.getElementById('ev2-canvas-area') as HTMLElement;
  btnEdit        = document.getElementById('ev2-btn-edit') as HTMLButtonElement;
  btnBorders     = document.getElementById('ev2-btn-borders') as HTMLButtonElement;
  btnTerritory   = document.getElementById('ev2-btn-territory') as HTMLButtonElement;
  btnView        = document.getElementById('ev2-btn-view') as HTMLButtonElement;
  removeDotBtn   = document.getElementById('ev2-remove-dot-btn') as HTMLButtonElement;
  noteToolBtn    = document.getElementById('ev2-note-tool-btn') as HTMLButtonElement;
  panelEdit      = document.getElementById('ev2-panel-edit') as HTMLElement;
  panelBorders   = document.getElementById('ev2-panel-borders') as HTMLElement;
  panelTerritory = document.getElementById('ev2-panel-territory') as HTMLElement;
  btnSectors     = document.getElementById('ev2-btn-sectors') as HTMLButtonElement;
  panelSectors   = document.getElementById('ev2-panel-sectors') as HTMLElement;

  // Create SVG layers
  for (const id of ['ev2-outer-border-layer', 'ev2-territory-layer', 'ev2-edge-layer', 'ev2-sector-border-layer', 'ev2-cp-layer', 'ev2-note-layer', 'ev2-point-layer', 'ev2-preview-layer']) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('id', id);
    svgEl.appendChild(g);
  }

  // SVG mouse events
  svgEl.addEventListener('mousedown', (e: MouseEvent) => {
    if (overlayEl.classList.contains('hidden')) return;
    // Middle-click or space+left-click → pan
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      isPanning = true;
      panStartClientX = e.clientX;
      panStartClientY = e.clientY;
      panStartPanX = panX;
      panStartPanY = panY;
      svgEl.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
    if (mode === 'view' || mode === 'borders' || mode === 'sectors') return;
    if (isRemovingDot) return;                  // remove-dot uses click, not drag
    const { x, y } = svgCoords(e);
    const snapNote = findSnapNote(x, y);
    if (snapNote) {
      dragNoteId = snapNote.id;
      hasDragged = false;
      e.preventDefault();
      return;
    }
    const snap = findSnapPoint(x, y);
    if (snap) {
      dragPointId = snap.id;
      hasDragged = false;
      e.preventDefault();                       // prevent text selection while dragging
    }
  });

  svgEl.addEventListener('mousemove', (e: MouseEvent) => {
    if (overlayEl.classList.contains('hidden')) return;

    if (isPanning) {
      const dx = e.clientX - panStartClientX;
      const dy = e.clientY - panStartClientY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) hasPanned = true;
      panX = panStartPanX - dx / zoom;
      panY = panStartPanY - dy / zoom;
      updateViewBox();
      render();
      return;
    }

    const { x, y } = svgCoords(e);
    cursorPos = { x, y };

    if (dragNoteId) {
      const note = notes.find(n => n.id === dragNoteId);
      if (note) { note.x = x; note.y = y; hasDragged = true; }
      svgEl.style.cursor = 'grabbing';
      render();
      return;
    }

    if (dragPointId) {
      const pt = pts.find((p) => p.id === dragPointId);
      if (pt) { pt.x = x; pt.y = y; hasDragged = true; }
      svgEl.style.cursor = 'grabbing';
      render();
      return;
    }

    if (mode === 'borders') {
      hoveredPoint = null;
      svgEl.style.cursor = 'default';
      render();
      return;
    }

    const snap = findSnapPoint(x, y);
    hoveredPoint = snap ? snap.id : null;
    const snapNote = !snap ? findSnapNote(x, y) : null;
    if ((snap || snapNote) && mode !== 'view') svgEl.style.cursor = 'grab';
    else svgEl.style.cursor = mode === 'edit' && isRemovingDot ? 'cell'
                             : mode === 'edit' ? 'crosshair'
                             : 'default';
    render();
  });

  window.addEventListener('mouseup', () => {
    if (isPanning) {
      isPanning = false;
      svgEl.style.cursor = spaceDown ? 'grab'
                         : mode === 'edit' && isRemovingDot ? 'cell'
                         : mode === 'edit' ? 'crosshair'
                         : 'default';
    }
    if (dragNoteId) {
      dragNoteId = null;
      svgEl.style.cursor = mode === 'edit' && isRemovingDot ? 'cell'
                         : mode === 'edit' ? 'crosshair'
                         : 'default';
    }
    if (dragPointId) {
      dragPointId = null;
      svgEl.style.cursor = mode === 'edit' && isRemovingDot ? 'cell'
                         : mode === 'edit' ? 'crosshair'
                         : 'default';
    }
  });

  svgEl.addEventListener('click', (e: MouseEvent) => {
    if (overlayEl.classList.contains('hidden')) return;
    if (hasPanned) { hasPanned = false; return; }     // was a pan, not a tap
    if (hasDragged) { hasDragged = false; return; }  // was a drag, not a tap
    if (mode === 'edit') {
      if (isNoteTool) handleNoteClick(e);
      else handleEditClick(e);
    } else if (mode === 'borders') {
      handleBordersClick(e);
    } else if (mode === 'territory') {
      handleTerritoryClick(e);
    } else if (mode === 'sectors') {
      handleSectorsClick(e);
    }
  });

  // Keyboard
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (overlayEl.classList.contains('hidden')) return;
    if (e.key === ' ' && !spaceDown) {
      spaceDown = true;
      if (!isPanning) svgEl.style.cursor = 'grab';
      e.preventDefault();
    }
    if (e.key === 'Escape') {
      if (mode === 'borders') {
        selectedEdgeIds = new Set();
        bordersError = null;
        render();
      } else {
        currentPath = [];
        render();
      }
    }
    // Reset view: Home or 0
    if (e.key === 'Home' || (e.key === '0' && !e.ctrlKey && !e.metaKey)) {
      panX = 0; panY = 0; zoom = 1;
      updateViewBox();
      render();
    }
  });

  window.addEventListener('keyup', (e: KeyboardEvent) => {
    if (overlayEl.classList.contains('hidden')) return;
    if (e.key === ' ') {
      spaceDown = false;
      if (!isPanning) {
        svgEl.style.cursor = mode === 'edit' && isRemovingDot ? 'cell'
                           : mode === 'edit' ? 'crosshair'
                           : 'default';
      }
    }
  });

  // Wheel pan
  svgEl.addEventListener('wheel', (e: WheelEvent) => {
    if (overlayEl.classList.contains('hidden')) return;
    e.preventDefault();
    panX += e.deltaX / zoom;
    panY += e.deltaY / zoom;
    updateViewBox();
    render();
  }, { passive: false });

  // Mode buttons
  btnEdit.addEventListener('click', () => setMode('edit'));
  btnBorders.addEventListener('click', () => setMode('borders'));
  btnTerritory.addEventListener('click', () => setMode('territory'));
  btnSectors.addEventListener('click', () => setMode('sectors'));
  btnView.addEventListener('click', () => setMode('view'));

  // Sectors panel
  (document.getElementById('ev2-sectors-save-btn') as HTMLButtonElement)
    .addEventListener('click', () => saveSector());
  (document.getElementById('ev2-sectors-clear-btn') as HTMLButtonElement)
    .addEventListener('click', () => {
      selectedSectorTerritoryIds = new Set();
      editingSectorId = null;
      render();
    });
  (document.getElementById('ev2-sectors-cancel-btn') as HTMLButtonElement)
    .addEventListener('click', () => {
      editingSectorId = null;
      selectedSectorTerritoryIds = new Set();
      render();
    });
  document.getElementById('ev2-sector-list')?.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b) return;
    if (b.dataset.sectorDelete) {
      sectors = sectors.filter((s) => s.id !== b.dataset.sectorDelete);
      if (editingSectorId === b.dataset.sectorDelete) {
        editingSectorId = null;
        selectedSectorTerritoryIds = new Set();
      }
      render();
      return;
    }
    if (b.dataset.sectorEdit) {
      const s = sectors.find((x) => x.id === b.dataset.sectorEdit);
      if (s) {
        editingSectorId = s.id;
        selectedSectorTerritoryIds = new Set(s.territoryIds);
        render();
      }
    }
  });
  document.getElementById('ev2-sector-list')?.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset.sectorId) return;
    const s = sectors.find((x) => x.id === input.dataset.sectorId);
    if (s) s.name = input.value;
  });

  (document.getElementById('ev2-borders-autodetect-btn') as HTMLButtonElement)
    .addEventListener('click', () => {
      const { added, skipped } = autoDetectTerritories();
      if (added === 0 && skipped === 0) {
        setBordersError('No closed regions found. Draw a connected graph with enclosed areas first.');
      } else if (added === 0) {
        setBordersError(`All ${skipped} detected region${skipped === 1 ? '' : 's'} already exist as territories.`);
      } else {
        setBordersError(null);
        const msg = `Added ${added} territory${added === 1 ? '' : 'ies'}` +
                    (skipped ? ` (${skipped} already existed).` : '.');
        // Show a transient success message by briefly setting a non-error notice
        const el = document.getElementById('ev2-borders-error')!;
        el.textContent = msg;
        el.classList.remove('hidden');
        el.style.color = '#16a34a';
        setTimeout(() => {
          el.style.color = '';
          el.classList.add('hidden');
          el.textContent = '';
        }, 2500);
      }
    });

  (document.getElementById('ev2-borders-clear-btn') as HTMLButtonElement)
    .addEventListener('click', () => {
      selectedEdgeIds = new Set();
      bordersError = null;
      render();
    });
  (document.getElementById('ev2-borders-save-btn') as HTMLButtonElement)
    .addEventListener('click', () => {
      saveTerritoryFromSelection(false);
    });
  (document.getElementById('ev2-borders-replace-btn') as HTMLButtonElement)
    .addEventListener('click', () => {
      saveTerritoryFromSelection(true);
    });
  document.getElementById('ev2-territory-list')?.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b) return;
    e.preventDefault();
    if (b.dataset.territoryDelete) {
      const id = b.dataset.territoryDelete;
      territories = territories.filter((t) => t.id !== id);
      if (selectedTerritoryId === id) selectedTerritoryId = null;
      bordersError = null;
      render();
      return;
    }
    if (b.dataset.territoryId) {
      selectedTerritoryId = b.dataset.territoryId;
      bordersError = null;
      render();
    }
  });

  // Territory tool selector
  document.getElementById('ev2-territory-tool-selector')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-tool]') as HTMLElement | null;
    if (!btn) return;
    const tool = btn.dataset.tool as TerritoryTool;
    territoryTool = tool;
    document.querySelectorAll('#ev2-territory-tool-selector .ev2-tool-btn').forEach((b) => {
      b.classList.toggle('active', (b as HTMLElement).dataset.tool === tool);
    });
  });

  // CP list — delete button
  document.getElementById('ev2-cp-list')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-cp-delete]') as HTMLElement | null;
    if (!btn) return;
    const id = btn.dataset.cpDelete!;
    controlPoints = controlPoints.filter((cp) => cp.id !== id);
    render();
  });

  // CP list — name input (live update, update SVG label without full re-render)
  document.getElementById('ev2-cp-list')?.addEventListener('input', (e) => {
    const input = (e.target as HTMLElement) as HTMLInputElement;
    if (!input.dataset.cpId) return;
    const cp = controlPoints.find((c) => c.id === input.dataset.cpId);
    if (!cp) return;
    cp.name = input.value;
    const label = svgEl.querySelector<SVGTextElement>(`[data-cp-id="${cp.id}"] text`);
    if (label) label.textContent = cp.name;
  });

  // Remove-dot toggle (within edit mode)
  removeDotBtn.addEventListener('click', () => {
    isRemovingDot = !isRemovingDot;
    if (isRemovingDot) { isNoteTool = false; noteToolBtn.classList.remove('active'); }
    removeDotBtn.classList.toggle('active', isRemovingDot);
    svgEl.style.cursor = isRemovingDot ? 'cell' : 'crosshair';
    render();
  });

  // Note tool toggle (within edit mode)
  noteToolBtn.addEventListener('click', () => {
    isNoteTool = !isNoteTool;
    if (isNoteTool) { isRemovingDot = false; removeDotBtn.classList.remove('active'); }
    noteToolBtn.classList.toggle('active', isNoteTool);
    svgEl.style.cursor = 'crosshair';
    render();
  });

  // Notes list — delete button
  document.getElementById('ev2-notes-list')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-note-delete]') as HTMLElement | null;
    if (btn) {
      const id = btn.dataset.noteDelete!;
      notes = notes.filter(n => n.id !== id);
      render();
      return;
    }
    const alignBtn = (e.target as HTMLElement).closest('[data-align]') as HTMLElement | null;
    if (alignBtn && alignBtn.dataset.noteId) {
      const note = notes.find(n => n.id === alignBtn.dataset.noteId);
      if (note) {
        note.align = alignBtn.dataset.align as Note['align'];
        render();
      }
    }
  });

  // Notes list — text / maxWidth input (live update)
  document.getElementById('ev2-notes-list')?.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset.noteId) return;
    const note = notes.find(n => n.id === input.dataset.noteId);
    if (!note) return;
    if (input.classList.contains('ev2-note-maxwidth-input')) {
      const v = parseInt(input.value, 10);
      note.maxWidth = !input.value || isNaN(v) || v <= 0 ? undefined : v;
      render();
    } else {
      note.text = input.value;
      // Quick DOM update without full render
      const textEl = svgEl.querySelector<SVGTextElement>(`[data-note-id="${note.id}"] text`);
      if (textEl) { textEl.textContent = note.text || ' '; return; }
      const foDiv = svgEl.querySelector<HTMLElement>(`[data-note-id="${note.id}"] div`);
      if (foDiv) foDiv.textContent = note.text || ' ';
    }
  });

  const undoBtn = document.getElementById('ev2-undo-btn') as HTMLButtonElement;
  undoBtn.addEventListener('click', () => undo());

  const clearBtn = document.getElementById('ev2-clear-btn') as HTMLButtonElement;
  clearBtn.addEventListener('click', () => clearAll());

  const backBtn = document.getElementById('ev2-back-btn') as HTMLButtonElement;
  backBtn.addEventListener('click', () => {
    hideMapEditor();
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

export function showMapEditor(): void {
  overlayEl.classList.remove('hidden');

  // Reset state
  pts = [];
  edges = [];
  territories = [];
  controlPoints = [];
  notes = [];
  sectors = [];
  currentPath = [];
  hoveredPoint = null;
  cursorPos = { x: 0, y: 0 };
  _ptCounter = 0;
  _edgeCounter = 0;
  _territoryCounter = 0;
  _cpCounter = 0;
  _noteCounter = 0;
  _sectorCounter = 0;
  isNoteTool = false;
  dragNoteId = null;
  territoryTool = 'allied';
  panX = 0; panY = 0; zoom = 1;
  isPanning = false; hasPanned = false; spaceDown = false;
  selectedEdgeIds = new Set();
  selectedTerritoryId = null;
  selectedSectorTerritoryIds = new Set();
  editingSectorId = null;
  bordersError = null;

  // Reset mode to edit
  mode = 'edit';
  isRemovingDot = false;
  btnEdit.classList.add('active');
  btnBorders.classList.remove('active');
  btnTerritory.classList.remove('active');
  btnSectors.classList.remove('active');
  btnView.classList.remove('active');
  removeDotBtn.classList.remove('active');
  noteToolBtn.classList.remove('active');
  panelEdit.classList.remove('hidden');
  panelBorders.classList.add('hidden');
  panelTerritory.classList.add('hidden');
  panelSectors.classList.add('hidden');
  svgEl.style.cursor = 'crosshair';

  // Reset territory tool selector to 'allied'
  document.querySelectorAll('#ev2-territory-tool-selector .ev2-tool-btn').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.tool === 'allied');
  });

  resizeSvg();
  render();
}

export function hideMapEditor(): void {
  overlayEl.classList.add('hidden');
}
