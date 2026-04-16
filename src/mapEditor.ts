import config, { BOARD_HEX_DIM_MAX, BOARD_HEX_DIM_MIN } from './gameconfig';
import { hexPoints } from './hex';
import { SCENARIOS } from './scenarios';
import { riverHexesFromPaintedKeys, riverSegmentUrl } from './rivers';
import type { RiverHex } from './types';

const EDITOR_HEX_SIZE = 34;

/** Defaults for new map editor sessions and resets when loading raw map JSON (no story wrapper). */
const DEFAULT_MAP_EDITOR_SCENARIO = 'tutorial';
const DEFAULT_MAP_EDITOR_UNIT_PACKAGE_P1 = 'standard';

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

/**
 * Breakthrough editor: control-point rows sorted north → south (increasing r).
 * Sectors are horizontal bands; game sector 0 is south (attacker starting sector, no CP).
 */
function breakthroughCpRowsNorthToSouth(cpKeys: Iterable<string>): number[] {
  const rows = [...cpKeys].map(k => Number(k.split(',')[1])).filter(Number.isFinite);
  return [...new Set(rows)].sort((a, b) => a - b);
}

/**
 * Game sector index for a row: 0 = south (attacker home band), K = north when there are K CPs.
 */
function breakthroughEditorGameSectorForRow(row: number, cpRowsNorthToSouth: number[]): number {
  const r = cpRowsNorthToSouth;
  const K = r.length;
  if (K === 0) return 0;
  if (row > r[K - 1]!) return 0;
  if (row <= r[0]!) return K;
  for (let j = 1; j < K; j++) {
    if (row <= r[j]! && row > r[j - 1]!) return K - j;
  }
  return K;
}

/** Inclusive row span per game sector index (same indexing as {@link breakthroughEditorGameSectorForRow}). */
function breakthroughSectorRowSpans(cpRowsNorthToSouth: number[], rows: number): { lo: number; hi: number }[] {
  const r = cpRowsNorthToSouth;
  const K = r.length;
  const out: { lo: number; hi: number }[] = [];
  out[K] = { lo: 0, hi: r[0]! };
  for (let j = 1; j < K; j++) {
    out[K - j] = { lo: r[j - 1]! + 1, hi: r[j]! };
  }
  out[0] = { lo: r[K - 1]! + 1, hi: rows - 1 };
  return out;
}

const ATTACKER_START_SECTOR_LABEL = 'Attacker starting sector';

function breakthroughSectorCanvasLabel(gameSector: number): string {
  return gameSector === 0 ? ATTACKER_START_SECTOR_LABEL : `S${gameSector + 1}`;
}

/** Y positions for dashed lines between row bands (matches {@link breakthroughSectorRowSpans}). */
function breakthroughSectorBoundaryYs(cpRowsNorthToSouth: number[], rows: number, rowToY: (row: number) => number): number[] {
  const r = cpRowsNorthToSouth;
  const ys: number[] = [];
  for (let i = 0; i < r.length; i++) {
    if (r[i]! < rows - 1) {
      ys.push((rowToY(r[i]!) + rowToY(r[i]! + 1)) / 2);
    }
  }
  return ys;
}

function dedupeBreakthroughCpOnePerRow(set: Set<string>): void {
  const seen = new Set<number>();
  for (const k of [...set]) {
    const r = Number(k.split(',')[1]);
    if (!Number.isFinite(r) || seen.has(r)) set.delete(k);
    else seen.add(r);
  }
}

let placementHintTimeoutId = 0;
function showPlacementHint(clientX: number, clientY: number, message: string): void {
  tooltipEl.textContent = message;
  tooltipEl.style.left = `${clientX + 12}px`;
  tooltipEl.style.top = `${clientY - 28}px`;
  tooltipEl.classList.add('me-unit-tooltip-visible');
  window.clearTimeout(placementHintTimeoutId);
  placementHintTimeoutId = window.setTimeout(() => {
    tooltipEl.classList.remove('me-unit-tooltip-visible');
  }, 2600);
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
  /** Painted river terrain (`"col,row"` keys), like {@link EditorState.mountains}. */
  riverHexKeys: Set<string>;
  /**
   * Last {@link riverHexesFromPaintedKeys} result from “Generate river” (random segment picks).
   * Cleared when painted river hexes no longer match {@link riverPreviewKeysSig}.
   */
  riverPreviewHexes: RiverHex[] | null;
  /** Sorted `riverHexKeys` signature when {@link riverPreviewHexes} was produced. */
  riverPreviewKeysSig: string | null;
  activeTool: EditorTool;
}

function mkState(): EditorState {
  return {
    cols: 8, rows: 8,
    id: 'my-map',
    title: 'My Map',
    description: 'Description.',
    gameMode: 'domination',
    scenario: DEFAULT_MAP_EDITOR_SCENARIO,
    unitPackage: DEFAULT_MAP_EDITOR_UNIT_PACKAGE_P1,
    unitPackagePlayer2: '',
    mountains: new Set(),
    conquestControlPoints: new Set(),
    breakthroughControlPoints: new Set(),
    playerStart: new Map(),
    aiStart: new Map(),
    riverHexKeys: new Set(),
    riverPreviewHexes: null,
    riverPreviewKeysSig: null,
    activeTool: 'normal',
  };
}

let edState = mkState();
let onBackCb: () => void = () => {};

// DOM refs (set in initMapEditor)
let overlayEl: HTMLDivElement;
let svgEl: SVGSVGElement;
let tooltipEl: HTMLDivElement;
let colsInput: HTMLInputElement;
let rowsInput: HTMLInputElement;
let gameModeSelect: HTMLSelectElement;
let scenarioSelect: HTMLSelectElement;
let unitPackageSelect: HTMLSelectElement;
let unitPackagePlayer2Select: HTMLSelectElement;
let toolbarEl: HTMLDivElement;
let exportBtn: HTMLButtonElement;
let generateRiverBtn: HTMLButtonElement;
let loadModalOverlay: HTMLDivElement;
let loadTextarea: HTMLTextAreaElement;
let loadErrorEl: HTMLDivElement;

export function initMapEditor(onBack: () => void): void {
  onBackCb = onBack;

  overlayEl        = document.getElementById('map-editor-overlay') as HTMLDivElement;
  svgEl            = document.getElementById('map-editor-board') as unknown as SVGSVGElement;

  // Tooltip element for unit hover
  tooltipEl = document.getElementById('me-unit-tooltip') as HTMLDivElement;
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'me-unit-tooltip';
    tooltipEl.className = 'me-unit-tooltip';
    document.body.appendChild(tooltipEl);
  }
  colsInput        = document.getElementById('me-cols') as HTMLInputElement;
  rowsInput        = document.getElementById('me-rows') as HTMLInputElement;
  gameModeSelect   = document.getElementById('me-game-mode') as HTMLSelectElement;
  scenarioSelect   = document.getElementById('me-scenario') as HTMLSelectElement;
  unitPackageSelect        = document.getElementById('me-unit-package') as HTMLSelectElement;
  unitPackagePlayer2Select = document.getElementById('me-unit-package-player2') as HTMLSelectElement;
  toolbarEl        = document.getElementById('map-editor-toolbar') as HTMLDivElement;
  exportBtn        = document.getElementById('me-export-btn') as HTMLButtonElement;
  generateRiverBtn = document.getElementById('me-generate-river-btn') as HTMLButtonElement;

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

  function clampDimensionInput(el: HTMLInputElement): number {
    const raw = parseFloat(el.value);
    const min = el.min === '' ? -Infinity : Number(el.min);
    const max = el.max === '' ? Infinity : Number(el.max);
    const fallback = Number.isFinite(min) ? min : BOARD_HEX_DIM_MIN;
    const parsed = Number.isFinite(raw) ? raw : fallback;
    const clamped = Math.max(min, Math.min(max, parsed));
    if (String(clamped) !== el.value) el.value = String(clamped);
    return clamped;
  }

  /** While typing, only cap above max (same as custom match numeric fields); min commits on blur. */
  function onMapDimensionInput(which: 'cols' | 'rows'): void {
    const el = which === 'cols' ? colsInput : rowsInput;
    if (el.max !== '') {
      const v = parseFloat(el.value);
      const max = Number(el.max);
      if (Number.isFinite(v) && Number.isFinite(max) && v > max) {
        el.value = String(max);
      }
    }
    const t = el.value.trim();
    if (t === '') return;
    const raw = parseInt(t, 10);
    if (!Number.isFinite(raw)) return;
    if (raw < BOARD_HEX_DIM_MIN) return;
    const clamped = Math.max(BOARD_HEX_DIM_MIN, Math.min(BOARD_HEX_DIM_MAX, raw));
    if (which === 'cols') edState.cols = clamped;
    else edState.rows = clamped;
    cleanOOB();
    renderBoard();
  }

  function commitMapDimension(which: 'cols' | 'rows'): void {
    const el = which === 'cols' ? colsInput : rowsInput;
    const w = clampDimensionInput(el);
    if (which === 'cols') edState.cols = w;
    else edState.rows = w;
    cleanOOB();
    renderBoard();
  }

  colsInput.addEventListener('input', () => { onMapDimensionInput('cols'); });
  colsInput.addEventListener('blur', () => { commitMapDimension('cols'); });
  colsInput.addEventListener('change', () => { commitMapDimension('cols'); });

  rowsInput.addEventListener('input', () => { onMapDimensionInput('rows'); });
  rowsInput.addEventListener('blur', () => { commitMapDimension('rows'); });
  rowsInput.addEventListener('change', () => { commitMapDimension('rows'); });

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

  generateRiverBtn.addEventListener('click', () => {
    const { cols, rows, riverHexKeys } = edState;
    if (riverHexKeys.size === 0) return;
    const seed = (Math.random() * 0xFFFFFFFF) >>> 0;
    edState.riverPreviewHexes = riverHexesFromPaintedKeys(riverHexKeys, cols, rows, seed);
    edState.riverPreviewKeysSig = riverKeysSignature(riverHexKeys);
    renderBoard();
  });

  // SVG drag-paint interaction
  let painting = false;
  svgEl.addEventListener('mousedown', (e) => { painting = true; applyTool(e); });
  svgEl.addEventListener('mousemove', (e) => {
    if (painting) applyTool(e);
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const g = el?.closest('[data-unit-name]') as SVGGElement | null;
    if (g && svgEl.contains(g)) {
      tooltipEl.textContent = g.dataset.unitName!;
      tooltipEl.style.left = `${e.clientX + 12}px`;
      tooltipEl.style.top  = `${e.clientY - 28}px`;
      tooltipEl.classList.add('me-unit-tooltip-visible');
    } else {
      tooltipEl.classList.remove('me-unit-tooltip-visible');
    }
  });
  svgEl.addEventListener('mouseleave', () => {
    tooltipEl.classList.remove('me-unit-tooltip-visible');
  });
  window.addEventListener('mouseup', () => { painting = false; });
}

/** Keeps custom settings dropdown labels in sync after programmatic value changes. */
function syncMapEditorSelectWidgets(): void {
  for (const el of [scenarioSelect, gameModeSelect, unitPackageSelect, unitPackagePlayer2Select]) {
    el.dispatchEvent(new Event('settings-select-sync'));
  }
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
  dedupeBreakthroughCpOnePerRow(edState.breakthroughControlPoints);
  edState.riverHexKeys = new Set(
    [...edState.riverHexKeys].filter(k => {
      const [c, r] = k.split(',').map(Number);
      return c >= 0 && r >= 0 && c < cols && r < rows;
    }),
  );
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

function riverKeysSignature(keys: Set<string>): string {
  return [...keys].sort().join('|');
}

/** Clipped river art on the editor board (matches in-game river rendering at {@link EDITOR_HEX_SIZE}). */
function appendRiverPreviewLayer(hexes: RiverHex[]): void {
  const s = EDITOR_HEX_SIZE;
  const clipPrefix = 'me-riv-clip';
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  for (const rh of hexes) {
    const { x, y } = hexToPixelLocal(rh.col, rh.row);
    const clip = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
    clip.setAttribute('id', `${clipPrefix}-${rh.col}-${rh.row}`);
    clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
    const clipPoly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    clipPoly.setAttribute('points', hexPoints(x, y, s));
    clip.appendChild(clipPoly);
    defs.appendChild(clip);
  }
  svgEl.appendChild(defs);

  const iw = s * Math.sqrt(3);
  const ih = s * 2;
  const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  layer.setAttribute('pointer-events', 'none');
  for (const rh of hexes) {
    const url = riverSegmentUrl(rh.segment);
    if (!url) continue;
    const { x, y } = hexToPixelLocal(rh.col, rh.row);
    const clipped = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    clipped.setAttribute('clip-path', `url(#${clipPrefix}-${rh.col}-${rh.row})`);
    const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
    img.setAttribute('href', url);
    img.setAttribute('x', String(x - iw / 2));
    img.setAttribute('y', String(y - ih / 2));
    img.setAttribute('width', String(iw));
    img.setAttribute('height', String(ih));
    img.setAttribute('pointer-events', 'none');
    clipped.appendChild(img);
    layer.appendChild(clipped);
  }
  svgEl.appendChild(layer);
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
  const keySig = riverKeysSignature(edState.riverHexKeys);
  if (
    edState.riverPreviewHexes !== null
    && edState.riverPreviewKeysSig !== keySig
  ) {
    edState.riverPreviewHexes = null;
    edState.riverPreviewKeysSig = null;
  }

  const { cols, rows } = edState;
  const s = EDITOR_HEX_SIZE;
  const hexW = s * Math.sqrt(3);
  const margin = s * 0.8;
  const totalW = cols * hexW + hexW * 0.5;
  const totalH = (rows - 1) * s * 1.5 + s * 2;

  // Sector overlay — only in Breakthrough edit layer when BT CPs exist
  const showSectors = edState.gameMode === 'breakthrough' && edState.breakthroughControlPoints.size > 0;
  const numSectors  = showSectors ? edState.breakthroughControlPoints.size + 1 : 0;
  const btCpRowsNorthToSouth = showSectors ? breakthroughCpRowsNorthToSouth(edState.breakthroughControlPoints) : [];
  const btSectorSpans = showSectors ? breakthroughSectorRowSpans(btCpRowsNorthToSouth, rows) : [];

  // Extra left margin to accommodate sector labels
  const leftMargin = showSectors ? s * 2.8 : margin;

  svgEl.setAttribute('width', String(Math.ceil(totalW + leftMargin + margin)));
  svgEl.setAttribute('height', String(Math.ceil(totalH + 2 * margin)));
  svgEl.setAttribute('viewBox', `${-leftMargin} ${-margin} ${totalW + leftMargin + margin} ${totalH + 2 * margin}`);
  svgEl.innerHTML = '';

  const hlRiver = edState.activeTool === 'river';
  const hlPlayer = edState.activeTool.startsWith('player:');
  const hlAi = edState.activeTool.startsWith('ai:');

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

      const isRiver = edState.riverHexKeys.has(key);

      let fill = 'var(--color-hex-neutral)';
      if      (isMtn) fill = '#7a6e6b';
      else if (isRiver) fill = 'rgba(55, 130, 220, 0.92)';
      else if (isCP)  fill = '#c9b87a';
      else if (isPS)  fill = 'var(--color-hex-player)';
      else if (isAS)  fill = 'var(--color-hex-ai)';

      let stroke = 'var(--color-hex-stroke)';
      let strokeW = '1';
      if      (hlPlayer && isPlayerRow) { stroke = 'var(--color-unit-selected)'; strokeW = '2.5'; }
      else if (hlAi && isAiRow)         { stroke = 'var(--color-ai)';            strokeW = '2.5'; }
      else if (hlRiver && isRiver)      { stroke = 'rgba(40, 90, 160, 0.95)';    strokeW = '2.5'; }
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

      // Sector tint overlay (drawn on top of base fill, below labels)
      if (showSectors) {
        const sector = breakthroughEditorGameSectorForRow(row, btCpRowsNorthToSouth);
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
        if (ut?.icon) {
          addUnitIcon(g, x, y, ut.icon, ut.name, s);
        } else {
          addTxt(g, x, y, (ut?.name ?? uid).slice(0, 3).toUpperCase(), s * 0.32, 'var(--color-dark)');
        }
        g.dataset.unitName = ut?.name ?? uid;
      } else if (isPlayerRow && !isMtn) {
        addTxt(g, x, y, 'P', s * 0.28, 'rgba(0,0,0,0.18)');
      }

      if (isAS) {
        const uid = edState.aiStart.get(col)!;
        const pkg2 = edState.unitPackagePlayer2 || edState.unitPackage;
        const ut = config.unitTypes.find(u => u.id === uid && u.package === pkg2);
        if (ut?.icon) {
          addUnitIcon(g, x, y, ut.icon, ut.name, s);
        } else {
          addTxt(g, x, y, (ut?.name ?? uid).slice(0, 3).toUpperCase(), s * 0.32, 'var(--color-dark)');
        }
        g.dataset.unitName = ut?.name ?? uid;
      } else if (isAiRow && !isMtn) {
        addTxt(g, x, y, 'A', s * 0.28, 'rgba(0,0,0,0.18)');
      }

      svgEl.appendChild(g);
    }
  }

  if (showSectors) {
    renderSectorOverlay(rows, cols, btCpRowsNorthToSouth, btSectorSpans, numSectors, s, leftMargin);
  }

  if (edState.riverPreviewHexes !== null && edState.riverPreviewHexes.length > 0) {
    appendRiverPreviewLayer(edState.riverPreviewHexes);
  }

  generateRiverBtn.disabled = edState.riverHexKeys.size === 0;
}

function renderSectorOverlay(
  rows: number, cols: number,
  cpRowsNorthToSouth: number[],
  sectorSpans: { lo: number; hi: number }[],
  numSectors: number,
  hexSize: number, leftMargin: number,
): void {
  const hexW = hexSize * Math.sqrt(3);
  const rowY = (r: number) => hexToPixelLocal(0, r).y;

  // Dashed boundary lines between row bands (one line per CP row band edge)
  for (const lineY of breakthroughSectorBoundaryYs(cpRowsNorthToSouth, rows, rowY)) {
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

  // Sector labels in the expanded left margin (north → south on screen: game sector K … 0)
  for (let gameSector = numSectors - 1; gameSector >= 0; gameSector--) {
    const span = sectorSpans[gameSector]!;
    if (span.lo > span.hi) continue;
    const midY = (rowY(span.lo) + rowY(span.hi)) / 2;
    const labelX = -(leftMargin * 0.55);
    const labelText = breakthroughSectorCanvasLabel(gameSector);
    const fs = labelText === ATTACKER_START_SECTOR_LABEL ? hexSize * 0.2 : hexSize * 0.3;

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String(labelX));
    label.setAttribute('y', String(midY));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dominant-baseline', 'central');
    label.setAttribute('fill', sectorLabelColor(gameSector));
    label.setAttribute('font-size', String(fs));
    label.setAttribute('font-family', 'Disket Mono, monospace');
    label.setAttribute('font-weight', 'bold');
    if (labelText === ATTACKER_START_SECTOR_LABEL) {
      const t1 = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      t1.setAttribute('x', String(labelX));
      t1.setAttribute('dy', '-0.55em');
      t1.textContent = 'Attacker starting';
      const t2 = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      t2.setAttribute('x', String(labelX));
      t2.setAttribute('dy', '1.1em');
      t2.textContent = 'sector';
      label.appendChild(t1);
      label.appendChild(t2);
    } else {
      label.textContent = labelText;
    }
    label.style.pointerEvents = 'none';
    svgEl.appendChild(label);
  }
}

function addUnitIcon(
  g: SVGGElement, x: number, y: number,
  icon: string, _name: string, hexSize: number,
): void {
  const size = hexSize * 0.72;
  const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
  img.setAttribute('href', icon);
  img.setAttribute('x', String(x - size / 2));
  img.setAttribute('y', String(y - size / 2));
  img.setAttribute('width', String(size));
  img.setAttribute('height', String(size));
  img.setAttribute('pointer-events', 'none');
  g.appendChild(img);
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
    edState.riverHexKeys.delete(key);
    if (row === rows - 1) edState.playerStart.delete(col);
    if (row === 0) edState.aiStart.delete(col);
  } else if (activeTool === 'mountain') {
    edState.mountains.add(key);
    edState.riverHexKeys.delete(key);
    edState.conquestControlPoints.delete(key);
    edState.breakthroughControlPoints.delete(key);
    if (row === rows - 1) edState.playerStart.delete(col);
    if (row === 0) edState.aiStart.delete(col);
  } else if (activeTool === 'river') {
    if (edState.mountains.has(key)) return;
    edState.riverHexKeys.add(key);
    edState.conquestControlPoints.delete(key);
    edState.breakthroughControlPoints.delete(key);
    if (row === rows - 1) edState.playerStart.delete(col);
    if (row === 0) edState.aiStart.delete(col);
  } else if (activeTool === 'controlPoint') {
    if (edState.gameMode === 'conquest') {
      edState.conquestControlPoints.add(key);
    } else if (edState.gameMode === 'breakthrough') {
      const rowTaken = [...edState.breakthroughControlPoints].some(
        other => other !== key && Number(other.split(',')[1]) === row,
      );
      if (rowTaken) {
        showPlacementHint(
          e.clientX,
          e.clientY,
          'Only one breakthrough control point per row — sectors are horizontal bands.',
        );
        return;
      }
      edState.breakthroughControlPoints.add(key);
    }
    edState.mountains.delete(key);
    edState.riverHexKeys.delete(key);
  } else if (activeTool.startsWith('player:')) {
    if (row !== rows - 1) return;
    edState.playerStart.set(col, activeTool.slice('player:'.length));
    edState.mountains.delete(key);
    edState.riverHexKeys.delete(key);
    edState.conquestControlPoints.delete(key);
    edState.breakthroughControlPoints.delete(key);
  } else if (activeTool.startsWith('ai:')) {
    if (row !== 0) return;
    edState.aiStart.set(col, activeTool.slice('ai:'.length));
    edState.mountains.delete(key);
    edState.riverHexKeys.delete(key);
    edState.conquestControlPoints.delete(key);
    edState.breakthroughControlPoints.delete(key);
  }

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

  const riverHexKeys = new Set<string>();
  if (Array.isArray(mapDef.rivers)) {
    for (const rh of mapDef.rivers as Array<Record<string, unknown>>) {
      if (typeof rh.col === 'number' && typeof rh.row === 'number') {
        riverHexKeys.add(`${rh.col},${rh.row}`);
      }
    }
  }

  // Commit to state
  edState.cols = cols;
  edState.rows = rows;
  edState.mountains = mountains;
  edState.conquestControlPoints = conquestControlPoints;
  edState.breakthroughControlPoints = breakthroughControlPoints;
  dedupeBreakthroughCpOnePerRow(edState.breakthroughControlPoints);
  edState.playerStart = playerStart;
  edState.aiStart = aiStart;
  edState.riverHexKeys = riverHexKeys;

  if (isWrapped) {
    edState.id = typeof parsed.id === 'string' ? parsed.id : 'my-map';
    edState.title = typeof parsed.title === 'string' ? parsed.title : 'My Map';
    edState.description = typeof parsed.description === 'string' ? parsed.description : 'Description.';
    edState.gameMode = (typeof parsed.gameMode === 'string' ? parsed.gameMode : 'domination') as EditorGameMode;
    gameModeSelect.value = edState.gameMode;
    edState.scenario = typeof parsed.scenario === 'string' ? parsed.scenario : DEFAULT_MAP_EDITOR_SCENARIO;
    scenarioSelect.value = edState.scenario;
    edState.unitPackage = typeof parsed.unitPackage === 'string' ? parsed.unitPackage : DEFAULT_MAP_EDITOR_UNIT_PACKAGE_P1;
    unitPackageSelect.value = edState.unitPackage;
    edState.unitPackagePlayer2 = typeof parsed.unitPackagePlayer2 === 'string' ? parsed.unitPackagePlayer2 : '';
    unitPackagePlayer2Select.value = edState.unitPackagePlayer2;
  } else {
    edState.id = 'my-map';
    edState.title = 'My Map';
    edState.description = 'Description.';
    edState.gameMode = 'domination';
    gameModeSelect.value = 'domination';
    edState.scenario = DEFAULT_MAP_EDITOR_SCENARIO;
    scenarioSelect.value = DEFAULT_MAP_EDITOR_SCENARIO;
    edState.unitPackage = DEFAULT_MAP_EDITOR_UNIT_PACKAGE_P1;
    unitPackageSelect.value = DEFAULT_MAP_EDITOR_UNIT_PACKAGE_P1;
    edState.unitPackagePlayer2 = '';
    unitPackagePlayer2Select.value = '';
  }

  colsInput.value = String(cols);
  rowsInput.value = String(rows);

  edState.activeTool = 'normal';
  refreshToolbar();
  renderBoard();
  syncMapEditorSelectWidgets();
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
    playerStart, aiStart, unitPackage, unitPackagePlayer2, riverHexKeys,
    riverPreviewHexes, riverPreviewKeysSig,
  } = edState;
  const expSig = riverKeysSignature(riverHexKeys);
  const rivers =
    riverPreviewHexes !== null && riverPreviewKeysSig === expSig
      ? riverPreviewHexes
      : riverHexesFromPaintedKeys(riverHexKeys, cols, rows);
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
  scenarioSelect.value = edState.scenario;
  unitPackageSelect.value = edState.unitPackage;
  unitPackagePlayer2Select.value = edState.unitPackagePlayer2;
  refreshToolbar();
  renderBoard();
  syncMapEditorSelectWidgets();
  overlayEl.classList.remove('hidden');
}

export function hideMapEditor(): void {
  overlayEl.classList.add('hidden');
}
