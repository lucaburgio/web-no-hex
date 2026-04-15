import config, { BOARD_HEX_DIM_MAX, BOARD_HEX_DIM_MIN } from './gameconfig';
import { hexPoints } from './hex';
import { SCENARIOS } from './scenarios';
import type { RiverHex } from './types';
import { generateRiver, getOutwardSides, riverMaxHexesFromBoardWidth, riverSegmentUrl, SIDE_DELTA } from './rivers';

const EDITOR_HEX_SIZE = 34;

// ── Sector helpers (breakthrough mode) ───────────────────────────────────────

const SECTOR_COLORS: [number, number, number][] = [
  [60,  100, 220],
  [220, 150,  30],
  [ 40, 170,  80],
  [190,  60,  90],
  [130,  50, 210],
  [ 30, 160, 160],
];

function sectorTint(idx: number): string {
  const [r, g, b] = SECTOR_COLORS[idx % SECTOR_COLORS.length];
  return `rgba(${r},${g},${b},0.09)`;
}

function sectorLabelColor(idx: number): string {
  const [r, g, b] = SECTOR_COLORS[idx % SECTOR_COLORS.length];
  return `rgba(${r},${g},${b},0.65)`;
}

/** Returns the starting row index for each sector (sorted north-to-south, sector 0 = topmost). */
function computeSectorStarts(rows: number, numSectors: number): number[] {
  return Array.from({ length: numSectors }, (_, k) => Math.floor(k * rows / numSectors));
}

/** Returns which sector index (0 = topmost) a given row belongs to. */
function getHexSector(row: number, sectorStarts: number[]): number {
  let sector = 0;
  for (let i = 1; i < sectorStarts.length; i++) {
    if (row >= sectorStarts[i]) sector = i;
  }
  return sector;
}

type EditorGameMode = 'domination' | 'conquest' | 'breakthrough';
type EditorTool = string; // 'normal' | 'mountain' | 'controlPoint' | 'player:TYPE' | 'ai:TYPE'

interface EditorState {
  cols: number;
  rows: number;
  /** StoryDef `id`; preserved when loading a full story object and emitted on copy. */
  id: string;
  title: string;
  description: string;
  gameMode: EditorGameMode;
  scenario: string;
  unitPackage: string;
  unitPackagePlayer2: string;
  mountains: Set<string>;
  /** Conquest-mode objective hexes (separate from breakthrough CPs). */
  conquestControlPoints: Set<string>;
  breakthroughControlPoints: Set<string>;
  playerStart: Map<number, string>; // col -> unitTypeId
  aiStart: Map<number, string>;     // col -> unitTypeId
  /** All river hexes across all generated rivers. */
  rivers: RiverHex[];
  activeTool: EditorTool;
}

function mkState(): EditorState {
  return {
    cols: 8, rows: 8,
    id: 'my-map',
    title: 'My Map',
    description: 'Description.',
    gameMode: 'domination',
    scenario: '',
    unitPackage: '',
    unitPackagePlayer2: '',
    mountains: new Set(),
    conquestControlPoints: new Set(),
    breakthroughControlPoints: new Set(),
    playerStart: new Map(),
    aiStart: new Map(),
    rivers: [],
    activeTool: 'normal',
  };
}

let edState = mkState();
let onBackCb: () => void = () => {};

// DOM refs (set in initMapEditor)
let overlayEl: HTMLDivElement;
let svgEl: SVGSVGElement;
let colsInput: HTMLInputElement;
let rowsInput: HTMLInputElement;
let gameModeSelect: HTMLSelectElement;
let scenarioSelect: HTMLSelectElement;
let unitPackageSelect: HTMLSelectElement;
let unitPackagePlayer2Select: HTMLSelectElement;
let toolbarEl: HTMLDivElement;
let exportBtn: HTMLButtonElement;
let loadModalOverlay: HTMLDivElement;
let loadTextarea: HTMLTextAreaElement;
let loadErrorEl: HTMLDivElement;

export function initMapEditor(onBack: () => void): void {
  onBackCb = onBack;

  overlayEl        = document.getElementById('map-editor-overlay') as HTMLDivElement;
  svgEl            = document.getElementById('map-editor-board') as unknown as SVGSVGElement;
  colsInput        = document.getElementById('me-cols') as HTMLInputElement;
  rowsInput        = document.getElementById('me-rows') as HTMLInputElement;
  gameModeSelect   = document.getElementById('me-game-mode') as HTMLSelectElement;
  scenarioSelect   = document.getElementById('me-scenario') as HTMLSelectElement;
  unitPackageSelect        = document.getElementById('me-unit-package') as HTMLSelectElement;
  unitPackagePlayer2Select = document.getElementById('me-unit-package-player2') as HTMLSelectElement;
  toolbarEl        = document.getElementById('map-editor-toolbar') as HTMLDivElement;
  exportBtn        = document.getElementById('me-export-btn') as HTMLButtonElement;

  // Populate scenario select
  SCENARIOS.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.title;
    scenarioSelect.appendChild(opt);
  });

  scenarioSelect.addEventListener('change', () => {
    edState.scenario = scenarioSelect.value;
  });

  // Populate unit package selects
  const pkgs = [...new Set(
    config.unitTypes.map(u => u.package).filter((p): p is string => Boolean(p))
  )];
  pkgs.forEach(pkg => {
    const opt = document.createElement('option');
    opt.value = pkg;
    opt.textContent = pkg;
    unitPackageSelect.appendChild(opt);
    const opt2 = document.createElement('option');
    opt2.value = pkg;
    opt2.textContent = pkg;
    unitPackagePlayer2Select.appendChild(opt2);
  });

  colsInput.addEventListener('input', () => {
    const v = Math.max(BOARD_HEX_DIM_MIN, Math.min(BOARD_HEX_DIM_MAX, parseInt(colsInput.value, 10) || 8));
    edState.cols = v;
    cleanOOB();
    renderBoard();
  });

  rowsInput.addEventListener('input', () => {
    const v = Math.max(BOARD_HEX_DIM_MIN, Math.min(BOARD_HEX_DIM_MAX, parseInt(rowsInput.value, 10) || 8));
    edState.rows = v;
    cleanOOB();
    renderBoard();
  });

  gameModeSelect.addEventListener('change', () => {
    edState.gameMode = gameModeSelect.value as EditorGameMode;
    if (edState.gameMode === 'domination' && edState.activeTool === 'controlPoint') {
      edState.activeTool = 'normal';
    }
    refreshToolbar();
    renderBoard();
  });

  unitPackageSelect.addEventListener('change', () => {
    edState.unitPackage = unitPackageSelect.value;
    edState.playerStart.clear();
    if (edState.activeTool.startsWith('player:')) edState.activeTool = 'normal';
    refreshToolbar();
    renderBoard();
  });

  unitPackagePlayer2Select.addEventListener('change', () => {
    edState.unitPackagePlayer2 = unitPackagePlayer2Select.value;
    edState.aiStart.clear();
    if (edState.activeTool.startsWith('ai:')) edState.activeTool = 'normal';
    refreshToolbar();
    renderBoard();
  });

  loadModalOverlay = document.getElementById('me-load-modal-overlay') as HTMLDivElement;
  loadTextarea     = document.getElementById('me-load-textarea') as HTMLTextAreaElement;
  loadErrorEl      = document.getElementById('me-load-error') as HTMLDivElement;

  document.getElementById('me-back-btn')!.addEventListener('click', () => onBackCb());
  document.getElementById('me-load-btn')!.addEventListener('click', () => {
    loadTextarea.value = '';
    loadErrorEl.classList.add('hidden');
    loadErrorEl.textContent = '';
    loadModalOverlay.classList.remove('hidden');
    loadTextarea.focus();
  });
  document.getElementById('me-load-cancel-btn')!.addEventListener('click', () => {
    loadModalOverlay.classList.add('hidden');
  });
  document.getElementById('me-load-confirm-btn')!.addEventListener('click', () => {
    const err = applyLoadedCode(loadTextarea.value);
    if (err) {
      loadErrorEl.textContent = err;
      loadErrorEl.classList.remove('hidden');
    } else {
      loadModalOverlay.classList.add('hidden');
    }
  });
  exportBtn.addEventListener('click', exportToClipboard);

  // SVG drag-paint interaction
  let painting = false;
  svgEl.addEventListener('mousedown', (e) => { painting = true; applyTool(e); });
  svgEl.addEventListener('mousemove', (e) => { if (painting) applyTool(e); });
  window.addEventListener('mouseup', () => { painting = false; });
}

// ── State management ──────────────────────────────────────────────────────────

function cleanOOB(): void {
  const { cols, rows } = edState;
  for (const k of [...edState.mountains]) {
    const [c, r] = k.split(',').map(Number);
    if (c >= cols || r >= rows) edState.mountains.delete(k);
  }
  for (const k of [...edState.conquestControlPoints]) {
    const [c, r] = k.split(',').map(Number);
    if (c >= cols || r >= rows) edState.conquestControlPoints.delete(k);
  }
  for (const k of [...edState.breakthroughControlPoints]) {
    const [c, r] = k.split(',').map(Number);
    if (c >= cols || r >= rows) edState.breakthroughControlPoints.delete(k);
  }
  edState.rivers = edState.rivers.filter(rh => rh.col < cols && rh.row < rows);
  for (const c of [...edState.playerStart.keys()]) if (c >= cols) edState.playerStart.delete(c);
  for (const c of [...edState.aiStart.keys()]) if (c >= cols) edState.aiStart.delete(c);
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function refreshToolbar(): void {
  toolbarEl.innerHTML = '';

  const { outer: tg, btns: tgBtns } = mkGroup('TERRAIN');
  tgBtns.appendChild(mkToolBtn('normal', 'NORMAL'));
  tgBtns.appendChild(mkToolBtn('mountain', 'MOUNTAIN'));
  tgBtns.appendChild(mkToolBtn('river', 'RIVER'));
  if (edState.gameMode === 'conquest' || edState.gameMode === 'breakthrough') {
    tgBtns.appendChild(mkToolBtn('controlPoint', 'CTRL PT'));
  }
  toolbarEl.appendChild(tg);

  const pkg1 = edState.unitPackage;
  if (pkg1) {
    const units1 = config.unitTypes.filter(u => u.package === pkg1);
    if (units1.length > 0) {
      const { outer: pg, btns: pgBtns } = mkGroup('PLAYER START');
      units1.forEach(ut => pgBtns.appendChild(mkToolBtn(`player:${ut.id}`, ut.name, ut.icon)));
      toolbarEl.appendChild(pg);
    }
  }

  const pkg2 = edState.unitPackagePlayer2 || edState.unitPackage;
  if (pkg2) {
    const units2 = config.unitTypes.filter(u => u.package === pkg2);
    if (units2.length > 0) {
      const { outer: ag, btns: agBtns } = mkGroup('AI START');
      units2.forEach(ut => agBtns.appendChild(mkToolBtn(`ai:${ut.id}`, ut.name, ut.icon)));
      toolbarEl.appendChild(ag);
    }
  }

  updateActive();
}

function mkGroup(label: string): { outer: HTMLDivElement; btns: HTMLDivElement } {
  const outer = document.createElement('div');
  outer.className = 'me-tool-group';
  const lbl = document.createElement('div');
  lbl.className = 'me-tool-group-label';
  lbl.textContent = label;
  outer.appendChild(lbl);
  const btns = document.createElement('div');
  btns.className = 'me-tool-group-btns';
  outer.appendChild(btns);
  return { outer, btns };
}

function mkToolBtn(tool: string, label: string, icon?: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'me-tool-btn';
  btn.dataset.tool = tool;

  if (icon) {
    const img = document.createElement('img');
    img.src = icon;
    img.className = 'me-tool-btn-icon';
    img.alt = '';
    btn.appendChild(img);
  }

  const span = document.createElement('span');
  span.textContent = label;
  btn.appendChild(span);

  btn.addEventListener('click', () => {
    edState.activeTool = tool;
    updateActive();
    renderBoard();
  });

  return btn;
}

function updateActive(): void {
  toolbarEl.querySelectorAll<HTMLButtonElement>('.me-tool-btn').forEach(btn => {
    btn.classList.toggle('me-tool-active', btn.dataset.tool === edState.activeTool);
  });
}

// ── Canvas rendering ──────────────────────────────────────────────────────────

function hexToPixelLocal(col: number, row: number): { x: number; y: number } {
  const s = EDITOR_HEX_SIZE;
  return {
    x: s * Math.sqrt(3) * (col + (Math.abs(row) % 2 === 1 ? 0.5 : 0)),
    y: s * 1.5 * row,
  };
}

function renderBoard(): void {
  const { cols, rows } = edState;
  const s = EDITOR_HEX_SIZE;
  const hexW = s * Math.sqrt(3);
  const margin = s * 0.8;
  const totalW = cols * hexW + hexW * 0.5;
  const totalH = (rows - 1) * s * 1.5 + s * 2;

  // Sector overlay — only in Breakthrough edit layer when BT CPs exist
  const showSectors = edState.gameMode === 'breakthrough' && edState.breakthroughControlPoints.size > 0;
  const numSectors  = showSectors ? edState.breakthroughControlPoints.size + 1 : 0;
  const sectorStarts = showSectors ? computeSectorStarts(rows, numSectors) : [];

  // Extra left margin to accommodate sector labels
  const leftMargin = showSectors ? s * 2.8 : margin;

  svgEl.setAttribute('width', String(Math.ceil(totalW + leftMargin + margin)));
  svgEl.setAttribute('height', String(Math.ceil(totalH + 2 * margin)));
  svgEl.setAttribute('viewBox', `${-leftMargin} ${-margin} ${totalW + leftMargin + margin} ${totalH + 2 * margin}`);
  svgEl.innerHTML = '';

  // Build river lookup and clip-path defs
  const riverByKey = new Map<string, RiverHex>();
  for (const rh of edState.rivers) riverByKey.set(`${rh.col},${rh.row}`, rh);

  const hlRiver = edState.activeTool === 'river';
  const hlPlayer = edState.activeTool.startsWith('player:');
  const hlAi = edState.activeTool.startsWith('ai:');

  if (riverByKey.size > 0) {
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    for (const rh of edState.rivers) {
      const { x, y } = hexToPixelLocal(rh.col, rh.row);
      const clip = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
      clip.setAttribute('id', `me-riv-clip-${rh.col}-${rh.row}`);
      clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
      const cp = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      cp.setAttribute('points', hexPoints(x, y, s));
      clip.appendChild(cp);
      defs.appendChild(clip);
    }
    svgEl.appendChild(defs);
  }

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const key = `${col},${row}`;
      const { x, y } = hexToPixelLocal(col, row);

      const isMtn       = edState.mountains.has(key);
      const isCP =
        (edState.gameMode === 'conquest' && edState.conquestControlPoints.has(key))
        || (edState.gameMode === 'breakthrough' && edState.breakthroughControlPoints.has(key));
      const isPS        = row === rows - 1 && edState.playerStart.has(col);
      const isAS        = row === 0 && edState.aiStart.has(col);
      const isPlayerRow = row === rows - 1;
      const isAiRow     = row === 0;

      let fill = 'var(--color-hex-neutral)';
      if      (isMtn) fill = '#7a6e6b';
      else if (isCP)  fill = '#c9b87a';
      else if (isPS)  fill = 'var(--color-hex-player)';
      else if (isAS)  fill = 'var(--color-hex-ai)';

      const isRiver      = riverByKey.has(key);
      const isBorderHex  = col === 0 || col === cols - 1 || row === 0 || row === rows - 1;
      const isRiverStart = hlRiver && isBorderHex && !isMtn && getOutwardSides(col, row, cols, rows).length > 0;

      let stroke = 'var(--color-hex-stroke)';
      let strokeW = '1';
      if      (hlPlayer && isPlayerRow) { stroke = 'var(--color-unit-selected)'; strokeW = '2.5'; }
      else if (hlAi && isAiRow)         { stroke = 'var(--color-ai)';            strokeW = '2.5'; }
      else if (isRiverStart)            { stroke = 'rgba(80,160,220,0.8)';       strokeW = '2.5'; }
      else if (isPlayerRow)             { stroke = 'rgba(0,0,0,0.35)';           strokeW = '1.5'; }
      else if (isAiRow)                 { stroke = 'rgba(100,100,100,0.45)';     strokeW = '1.5'; }

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.dataset.col = String(col);
      g.dataset.row = String(row);
      g.style.cursor = 'pointer';

      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('points', hexPoints(x, y, s));
      poly.setAttribute('fill', fill);
      poly.setAttribute('stroke', stroke);
      poly.setAttribute('stroke-width', strokeW);
      g.appendChild(poly);

      // River texture overlay (clipped to hex shape)
      if (isRiver) {
        const rh = riverByKey.get(key)!;
        const url = riverSegmentUrl(rh.segment);
        if (url) {
          const iw = s * Math.sqrt(3);
          const ih = s * 2;
          const clipped = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          clipped.setAttribute('clip-path', `url(#me-riv-clip-${col}-${row})`);
          clipped.style.pointerEvents = 'none';
          const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
          img.setAttribute('href', url);
          img.setAttribute('x', String(x - iw / 2));
          img.setAttribute('y', String(y - ih / 2));
          img.setAttribute('width', String(iw));
          img.setAttribute('height', String(ih));
          img.style.pointerEvents = 'none';
          clipped.appendChild(img);
          g.appendChild(clipped);
        }
      }

      // Sector tint overlay (drawn on top of base fill, below labels)
      if (showSectors) {
        const sector = getHexSector(row, sectorStarts);
        const tint = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        tint.setAttribute('points', hexPoints(x, y, s));
        tint.setAttribute('fill', sectorTint(sector));
        tint.style.pointerEvents = 'none';
        g.appendChild(tint);
      }

      if (isMtn) {
        addTxt(g, x, y, '▲', s * 0.42, '#fff');
      }

      if (isCP) {
        const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        ring.setAttribute('cx', String(x));
        ring.setAttribute('cy', String(y));
        ring.setAttribute('r', String(s * 0.27));
        ring.setAttribute('fill', 'none');
        ring.setAttribute('stroke', 'rgba(0,0,0,0.55)');
        ring.setAttribute('stroke-width', '2');
        ring.style.pointerEvents = 'none';
        g.appendChild(ring);
      }

      if (isPS) {
        const uid = edState.playerStart.get(col)!;
        const ut = config.unitTypes.find(u => u.id === uid && u.package === edState.unitPackage);
        addTxt(g, x, y, (ut?.name ?? uid).slice(0, 3).toUpperCase(), s * 0.32, 'var(--color-dark)');
      } else if (isPlayerRow && !isMtn) {
        addTxt(g, x, y, 'P', s * 0.28, 'rgba(0,0,0,0.18)');
      }

      if (isAS) {
        const uid = edState.aiStart.get(col)!;
        const ut = config.unitTypes.find(u => u.id === uid && u.package === edState.unitPackage);
        addTxt(g, x, y, (ut?.name ?? uid).slice(0, 3).toUpperCase(), s * 0.32, 'var(--color-dark)');
      } else if (isAiRow && !isMtn) {
        addTxt(g, x, y, 'A', s * 0.28, 'rgba(0,0,0,0.18)');
      }

      svgEl.appendChild(g);
    }
  }

  if (showSectors) {
    renderSectorOverlay(rows, cols, sectorStarts, numSectors, s, leftMargin);
  }
}

function renderSectorOverlay(
  rows: number, cols: number,
  sectorStarts: number[], numSectors: number,
  hexSize: number, leftMargin: number,
): void {
  const hexW = hexSize * Math.sqrt(3);

  // Dashed boundary lines between sectors
  for (let k = 1; k < numSectors; k++) {
    const bRow = sectorStarts[k];
    const lineY = (hexToPixelLocal(0, bRow - 1).y + hexToPixelLocal(0, bRow).y) / 2;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(-hexW * 0.5));
    line.setAttribute('y1', String(lineY));
    line.setAttribute('x2', String(cols * hexW + hexW * 0.5));
    line.setAttribute('y2', String(lineY));
    line.setAttribute('stroke', 'rgba(0,0,0,0.22)');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-dasharray', '5 4');
    line.style.pointerEvents = 'none';
    svgEl.appendChild(line);
  }

  // Sector labels in the expanded left margin
  for (let k = 0; k < numSectors; k++) {
    const startRow = sectorStarts[k];
    const endRow   = k < numSectors - 1 ? sectorStarts[k + 1] - 1 : rows - 1;
    const midY     = (hexToPixelLocal(0, startRow).y + hexToPixelLocal(0, endRow).y) / 2;
    const labelX   = -(leftMargin * 0.55);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String(labelX));
    label.setAttribute('y', String(midY));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dominant-baseline', 'central');
    label.setAttribute('fill', sectorLabelColor(k));
    label.setAttribute('font-size', String(hexSize * 0.3));
    label.setAttribute('font-family', 'Disket Mono, monospace');
    label.setAttribute('font-weight', 'bold');
    label.textContent = `S${k + 1}`;
    label.style.pointerEvents = 'none';
    svgEl.appendChild(label);
  }
}

function addTxt(
  g: SVGGElement, x: number, y: number,
  content: string, fontSize: number, fill: string
): void {
  const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  t.setAttribute('x', String(x));
  t.setAttribute('y', String(y));
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('dominant-baseline', 'central');
  t.setAttribute('fill', fill);
  t.setAttribute('font-size', String(fontSize));
  t.setAttribute('font-family', 'Disket Mono, monospace');
  t.setAttribute('font-weight', 'bold');
  t.textContent = content;
  t.style.pointerEvents = 'none';
  t.style.userSelect = 'none';
  g.appendChild(t);
}

// ── Tool application ──────────────────────────────────────────────────────────

function applyTool(e: MouseEvent): void {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const g = el?.closest('[data-col]') as SVGGElement | null;
  if (!g || !svgEl.contains(g)) return;

  const col = parseInt(g.dataset.col!, 10);
  const row = parseInt(g.dataset.row!, 10);
  const key = `${col},${row}`;
  const { rows, activeTool } = edState;

  if (activeTool === 'normal') {
    edState.mountains.delete(key);
    edState.conquestControlPoints.delete(key);
    edState.breakthroughControlPoints.delete(key);
    // Remove any river that passes through this hex
    edState.rivers = edState.rivers.filter(rh => !(rh.col === col && rh.row === row));
    if (row === rows - 1) edState.playerStart.delete(col);
    if (row === 0) edState.aiStart.delete(col);
  } else if (activeTool === 'mountain') {
    edState.mountains.add(key);
    edState.conquestControlPoints.delete(key);
    edState.breakthroughControlPoints.delete(key);
    if (row === rows - 1) edState.playerStart.delete(col);
    if (row === 0) edState.aiStart.delete(col);
  } else if (activeTool === 'river') {
    applyRiverTool(col, row);
    return; // renderBoard called inside
  } else if (activeTool === 'controlPoint') {
    if (edState.gameMode === 'conquest') {
      edState.conquestControlPoints.add(key);
    } else if (edState.gameMode === 'breakthrough') {
      edState.breakthroughControlPoints.add(key);
    }
    edState.mountains.delete(key);
  } else if (activeTool.startsWith('player:')) {
    if (row !== rows - 1) return;
    edState.playerStart.set(col, activeTool.slice('player:'.length));
    edState.mountains.delete(key);
    edState.conquestControlPoints.delete(key);
    edState.breakthroughControlPoints.delete(key);
  } else if (activeTool.startsWith('ai:')) {
    if (row !== 0) return;
    edState.aiStart.set(col, activeTool.slice('ai:'.length));
    edState.mountains.delete(key);
    edState.conquestControlPoints.delete(key);
    edState.breakthroughControlPoints.delete(key);
  }

  renderBoard();
}

/**
 * River tool click handler.
 * - Clicking a border hex with an outward side generates a new river from there.
 * - Clicking any hex that is already part of a river removes that entire river chain.
 */
function applyRiverTool(col: number, row: number): void {
  const { cols, rows } = edState;

  // If the clicked hex is part of an existing river, remove that river
  const existingIdx = edState.rivers.findIndex(rh => rh.col === col && rh.row === row);
  if (existingIdx !== -1) {
    // Identify which river chain owns this hex by walking from the clicked hex
    // outward: the chain is a contiguous run sharing the same entry→exit path.
    // Simplest approach: remove ALL river hexes with the same connected segment.
    const toRemove = new Set<string>();
    // Walk forwards (follow exits) and backwards (follow entries) from this hex
    const riverMap = new Map<string, RiverHex>();
    for (const rh of edState.rivers) riverMap.set(`${rh.col},${rh.row}`, rh);

    const queue: string[] = [`${col},${row}`];
    while (queue.length > 0) {
      const k = queue.pop()!;
      if (toRemove.has(k)) continue;
      toRemove.add(k);
      const rh = riverMap.get(k);
      if (!rh) continue;
      // Follow exit → next hex forward
      const parity = Math.abs(rh.row) % 2 === 0 ? 'even' : 'odd';
      const [fdc, fdr] = SIDE_DELTA[parity][rh.exitSide];
      const fnk = `${rh.col + fdc},${rh.row + fdr}`;
      if (riverMap.has(fnk)) queue.push(fnk);
      // Walk backwards: find any hex whose exit leads to k
      for (const [nk, nrh] of riverMap) {
        if (toRemove.has(nk)) continue;
        const np = Math.abs(nrh.row) % 2 === 0 ? 'even' : 'odd';
        const [ndc, ndr] = SIDE_DELTA[np][nrh.exitSide];
        if (`${nrh.col + ndc},${nrh.row + ndr}` === k) queue.push(nk);
      }
    }
    edState.rivers = edState.rivers.filter(rh => !toRemove.has(`${rh.col},${rh.row}`));
    renderBoard();
    return;
  }

  // Only border hexes with outward sides can start a river
  const outwardSides = getOutwardSides(col, row, cols, rows);
  if (outwardSides.length === 0) return;

  // Generate a river from each outward side and pick the one that goes farthest
  // (prefer longer rivers; if tied, pick a random one)
  const candidates = outwardSides.map(side =>
    generateRiver({
      startCol: col,
      startRow: row,
      entrySide: side,
      cols,
      rows,
      maxSteps: riverMaxHexesFromBoardWidth(cols, config.riverMaxLengthBoardWidthMult),
    }),
  );
  candidates.sort((a, b) => b.length - a.length);
  const best = candidates[0];
  if (!best || best.length === 0) return;

  // Append the new river hexes (skip any col,row already occupied by another river)
  const occupiedByRiver = new Set(edState.rivers.map(rh => `${rh.col},${rh.row}`));
  const newHexes = best.filter(rh => !occupiedByRiver.has(`${rh.col},${rh.row}`));
  edState.rivers.push(...newHexes);
  renderBoard();
}

// ── Load ──────────────────────────────────────────────────────────────────────

/** Parse pasted code and populate editor state. Returns an error string or null on success. */
function applyLoadedCode(raw: string): string | null {
  const code = raw.trim().replace(/,\s*$/, ''); // strip trailing comma
  if (!code) return 'Nothing to load.';

  let parsed: Record<string, unknown>;
  try {
    // eslint-disable-next-line no-new-func
    parsed = new Function('return (' + code + ')')() as Record<string, unknown>;
  } catch (err) {
    return 'Parse error: ' + (err as Error).message;
  }

  if (!parsed || typeof parsed !== 'object') return 'Not a valid object.';

  // Full story: `{ id, map: { … } }`. Bare map: only `StoryMapDef` keys (no wrapper).
  const isWrapped = Boolean(parsed.map && typeof parsed.map === 'object');
  const mapDef = (isWrapped ? parsed.map : parsed) as Record<string, unknown>;

  const cols = Number(mapDef.cols);
  const rows = Number(mapDef.rows);
  if (!Number.isInteger(cols) || cols < BOARD_HEX_DIM_MIN || cols > BOARD_HEX_DIM_MAX) {
    return `Invalid cols (must be ${BOARD_HEX_DIM_MIN}–${BOARD_HEX_DIM_MAX}).`;
  }
  if (!Number.isInteger(rows) || rows < BOARD_HEX_DIM_MIN || rows > BOARD_HEX_DIM_MAX) {
    return `Invalid rows (must be ${BOARD_HEX_DIM_MIN}–${BOARD_HEX_DIM_MAX}).`;
  }

  const mountains = new Set<string>(
    Array.isArray(mapDef.mountains) ? mapDef.mountains.map(String) : []
  );
  let conquestControlPoints = new Set<string>(
    Array.isArray(mapDef.conquestControlPoints) ? mapDef.conquestControlPoints.map(String) : []
  );
  let breakthroughControlPoints = new Set<string>(
    Array.isArray(mapDef.breakthroughControlPoints) ? mapDef.breakthroughControlPoints.map(String) : []
  );
  const legacyCp = Array.isArray(mapDef.controlPoints) ? mapDef.controlPoints.map(String) : [];
  if (conquestControlPoints.size === 0 && breakthroughControlPoints.size === 0 && legacyCp.length > 0) {
    const gm = (isWrapped && typeof parsed.gameMode === 'string' ? parsed.gameMode : 'domination') as EditorGameMode;
    if (gm === 'conquest') conquestControlPoints = new Set(legacyCp);
    else if (gm === 'breakthrough') breakthroughControlPoints = new Set(legacyCp);
  }

  const playerStart = new Map<number, string>();
  if (Array.isArray(mapDef.playerStart)) {
    for (const pos of mapDef.playerStart as Array<{ col?: unknown; unitTypeId?: unknown }>) {
      if (pos && typeof pos.col === 'number') {
        playerStart.set(pos.col, typeof pos.unitTypeId === 'string' ? pos.unitTypeId : 'infantry');
      }
    }
  }
  const aiStart = new Map<number, string>();
  if (Array.isArray(mapDef.aiStart)) {
    for (const pos of mapDef.aiStart as Array<{ col?: unknown; unitTypeId?: unknown }>) {
      if (pos && typeof pos.col === 'number') {
        aiStart.set(pos.col, typeof pos.unitTypeId === 'string' ? pos.unitTypeId : 'infantry');
      }
    }
  }

  const rivers: RiverHex[] = [];
  if (Array.isArray(mapDef.rivers)) {
    for (const rh of mapDef.rivers as Array<Record<string, unknown>>) {
      if (
        typeof rh.col === 'number' && typeof rh.row === 'number' &&
        typeof rh.segment === 'string' &&
        typeof rh.entrySide === 'string' && typeof rh.exitSide === 'string'
      ) {
        rivers.push({
          col: rh.col, row: rh.row,
          segment: rh.segment,
          entrySide: rh.entrySide as RiverHex['entrySide'],
          exitSide: rh.exitSide as RiverHex['exitSide'],
        });
      }
    }
  }

  // Commit to state
  edState.cols = cols;
  edState.rows = rows;
  edState.mountains = mountains;
  edState.conquestControlPoints = conquestControlPoints;
  edState.breakthroughControlPoints = breakthroughControlPoints;
  edState.playerStart = playerStart;
  edState.aiStart = aiStart;
  edState.rivers = rivers;

  if (isWrapped) {
    edState.id = typeof parsed.id === 'string' ? parsed.id : 'my-map';
    edState.title = typeof parsed.title === 'string' ? parsed.title : 'My Map';
    edState.description = typeof parsed.description === 'string' ? parsed.description : 'Description.';
    edState.gameMode = (typeof parsed.gameMode === 'string' ? parsed.gameMode : 'domination') as EditorGameMode;
    gameModeSelect.value = edState.gameMode;
    edState.scenario = typeof parsed.scenario === 'string' ? parsed.scenario : '';
    scenarioSelect.value = edState.scenario;
    edState.unitPackage = typeof parsed.unitPackage === 'string' ? parsed.unitPackage : '';
    unitPackageSelect.value = edState.unitPackage;
    edState.unitPackagePlayer2 = typeof parsed.unitPackagePlayer2 === 'string' ? parsed.unitPackagePlayer2 : '';
    unitPackagePlayer2Select.value = edState.unitPackagePlayer2;
  } else {
    edState.id = 'my-map';
    edState.title = 'My Map';
    edState.description = 'Description.';
    edState.gameMode = 'domination';
    gameModeSelect.value = 'domination';
    edState.scenario = '';
    scenarioSelect.value = '';
    edState.unitPackage = '';
    unitPackageSelect.value = '';
    edState.unitPackagePlayer2 = '';
    unitPackagePlayer2Select.value = '';
  }

  colsInput.value = String(cols);
  rowsInput.value = String(rows);

  edState.activeTool = 'normal';
  refreshToolbar();
  renderBoard();
  return null;
}

// ── Export ────────────────────────────────────────────────────────────────────

/** Escape for single-quoted JS string literals in generated map code. */
function escapeJsStringLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function exportToClipboard(): void {
  const {
    cols, rows, id, title, description, scenario, mountains,
    conquestControlPoints, breakthroughControlPoints,
    playerStart, aiStart, unitPackage, unitPackagePlayer2, rivers,
  } = edState;
  const i = '  ';
  const q = escapeJsStringLiteral;

  const mStr = [...mountains].sort().map(m => `'${m}'`).join(', ');

  const pStr = [...playerStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([col, uid]) =>
      uid === 'infantry' ? `{ col: ${col} }` : `{ col: ${col}, unitTypeId: '${uid}' }`
    ).join(', ');

  const aStr = [...aiStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([col, uid]) =>
      uid === 'infantry' ? `{ col: ${col} }` : `{ col: ${col}, unitTypeId: '${uid}' }`
    ).join(', ');

  const cqStr = [...conquestControlPoints].sort().map(c => `'${c}'`).join(', ');
  const btStr = [...breakthroughControlPoints].sort().map(c => `'${c}'`).join(', ');

  let code = `{\n`;
  code += `${i}id: '${q(id)}',\n`;
  code += `${i}title: '${q(title)}',\n`;
  code += `${i}description: '${q(description)}',\n`;
  if (scenario) code += `${i}scenario: '${q(scenario)}',\n`;
  if (unitPackage) code += `${i}unitPackage: '${q(unitPackage)}',\n`;
  if (unitPackagePlayer2 && unitPackagePlayer2 !== unitPackage) {
    code += `${i}unitPackagePlayer2: '${q(unitPackagePlayer2)}',\n`;
  }
  code += `${i}gameMode: 'domination',\n`;
  code += `${i}map: {\n`;
  code += `${i}${i}cols: ${cols},\n`;
  code += `${i}${i}rows: ${rows},\n`;
  code += `${i}${i}mountains: [${mStr}],\n`;
  code += `${i}${i}playerStart: [${pStr}],\n`;
  code += `${i}${i}aiStart: [${aStr}],\n`;
  if (conquestControlPoints.size > 0) {
    code += `${i}${i}conquestControlPoints: [${cqStr}],\n`;
  }
  if (breakthroughControlPoints.size > 0) {
    code += `${i}${i}breakthroughControlPoints: [${btStr}],\n`;
  }
  if (rivers.length > 0) {
    const rvStr = rivers
      .map(rh => `{ col: ${rh.col}, row: ${rh.row}, segment: '${rh.segment}', entrySide: '${rh.entrySide}', exitSide: '${rh.exitSide}' }`)
      .join(`,\n${i}${i}  `);
    code += `${i}${i}rivers: [\n${i}${i}  ${rvStr},\n${i}${i}],\n`;
  }
  code += `${i}},\n`;
  code += `${i}productionPointsPerTurn: 20,\n`;
  code += `}`;

  const flash = () => {
    const orig = exportBtn.textContent;
    exportBtn.textContent = 'COPIED!';
    setTimeout(() => { exportBtn.textContent = orig; }, 1500);
  };

  navigator.clipboard.writeText(code).then(flash).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = code;
    Object.assign(ta.style, { position: 'fixed', opacity: '0', top: '0', left: '0' });
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); flash(); } catch { /* ignore */ }
    document.body.removeChild(ta);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export function showMapEditor(): void {
  edState = mkState();
  colsInput.value = '8';
  rowsInput.value = '8';
  gameModeSelect.value = 'domination';
  scenarioSelect.value = '';
  unitPackageSelect.value = '';
  unitPackagePlayer2Select.value = '';
  refreshToolbar();
  renderBoard();
  overlayEl.classList.remove('hidden');
}

export function hideMapEditor(): void {
  overlayEl.classList.add('hidden');
}
