import config from './gameconfig';
import { hexPoints } from './hex';

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
  gameMode: EditorGameMode;
  unitPackage: string;
  mountains: Set<string>;
  controlPoints: Set<string>;
  playerStart: Map<number, string>; // col -> unitTypeId
  aiStart: Map<number, string>;     // col -> unitTypeId
  activeTool: EditorTool;
}

function mkState(): EditorState {
  return {
    cols: 8, rows: 8,
    gameMode: 'domination',
    unitPackage: '',
    mountains: new Set(),
    controlPoints: new Set(),
    playerStart: new Map(),
    aiStart: new Map(),
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
let unitPackageSelect: HTMLSelectElement;
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
  unitPackageSelect = document.getElementById('me-unit-package') as HTMLSelectElement;
  toolbarEl        = document.getElementById('map-editor-toolbar') as HTMLDivElement;
  exportBtn        = document.getElementById('me-export-btn') as HTMLButtonElement;

  // Populate unit package select
  const pkgs = [...new Set(
    config.unitTypes.map(u => u.package).filter((p): p is string => Boolean(p))
  )];
  pkgs.forEach(pkg => {
    const opt = document.createElement('option');
    opt.value = pkg;
    opt.textContent = pkg;
    unitPackageSelect.appendChild(opt);
  });

  colsInput.addEventListener('input', () => {
    const v = Math.max(2, Math.min(24, parseInt(colsInput.value, 10) || 8));
    edState.cols = v;
    cleanOOB();
    renderBoard();
  });

  rowsInput.addEventListener('input', () => {
    const v = Math.max(2, Math.min(24, parseInt(rowsInput.value, 10) || 8));
    edState.rows = v;
    cleanOOB();
    renderBoard();
  });

  gameModeSelect.addEventListener('change', () => {
    edState.gameMode = gameModeSelect.value as EditorGameMode;
    if (edState.gameMode === 'domination') {
      edState.controlPoints.clear();
      if (edState.activeTool === 'controlPoint') edState.activeTool = 'normal';
    }
    refreshToolbar();
    renderBoard();
  });

  unitPackageSelect.addEventListener('change', () => {
    edState.unitPackage = unitPackageSelect.value;
    edState.playerStart.clear();
    edState.aiStart.clear();
    if (edState.activeTool.startsWith('player:') || edState.activeTool.startsWith('ai:')) {
      edState.activeTool = 'normal';
    }
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
  for (const k of [...edState.controlPoints]) {
    const [c, r] = k.split(',').map(Number);
    if (c >= cols || r >= rows) edState.controlPoints.delete(k);
  }
  for (const c of [...edState.playerStart.keys()]) if (c >= cols) edState.playerStart.delete(c);
  for (const c of [...edState.aiStart.keys()]) if (c >= cols) edState.aiStart.delete(c);
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function refreshToolbar(): void {
  toolbarEl.innerHTML = '';

  const { outer: tg, btns: tgBtns } = mkGroup('TERRAIN');
  tgBtns.appendChild(mkToolBtn('normal', 'NORMAL'));
  tgBtns.appendChild(mkToolBtn('mountain', 'MOUNTAIN'));
  if (edState.gameMode === 'conquest' || edState.gameMode === 'breakthrough') {
    tgBtns.appendChild(mkToolBtn('controlPoint', 'CTRL PT'));
  }
  toolbarEl.appendChild(tg);

  const pkg = edState.unitPackage;
  if (pkg) {
    const units = config.unitTypes.filter(u => u.package === pkg);
    if (units.length > 0) {
      const { outer: pg, btns: pgBtns } = mkGroup('PLAYER START');
      units.forEach(ut => pgBtns.appendChild(mkToolBtn(`player:${ut.id}`, ut.name, ut.icon)));
      toolbarEl.appendChild(pg);

      const { outer: ag, btns: agBtns } = mkGroup('AI START');
      units.forEach(ut => agBtns.appendChild(mkToolBtn(`ai:${ut.id}`, ut.name, ut.icon)));
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

  // Sector computation — breakthrough mode only, requires at least one CP
  const showSectors = edState.gameMode === 'breakthrough' && edState.controlPoints.size > 0;
  const numSectors  = showSectors ? edState.controlPoints.size + 1 : 0;
  const sectorStarts = showSectors ? computeSectorStarts(rows, numSectors) : [];

  // Extra left margin to accommodate sector labels
  const leftMargin = showSectors ? s * 2.8 : margin;

  svgEl.setAttribute('width', String(Math.ceil(totalW + leftMargin + margin)));
  svgEl.setAttribute('height', String(Math.ceil(totalH + 2 * margin)));
  svgEl.setAttribute('viewBox', `${-leftMargin} ${-margin} ${totalW + leftMargin + margin} ${totalH + 2 * margin}`);
  svgEl.innerHTML = '';

  const hlPlayer = edState.activeTool.startsWith('player:');
  const hlAi = edState.activeTool.startsWith('ai:');

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const key = `${col},${row}`;
      const { x, y } = hexToPixelLocal(col, row);

      const isMtn       = edState.mountains.has(key);
      const isCP        = edState.controlPoints.has(key);
      const isPS        = row === rows - 1 && edState.playerStart.has(col);
      const isAS        = row === 0 && edState.aiStart.has(col);
      const isPlayerRow = row === rows - 1;
      const isAiRow     = row === 0;

      let fill = 'var(--color-hex-neutral)';
      if      (isMtn) fill = '#7a6e6b';
      else if (isCP)  fill = '#c9b87a';
      else if (isPS)  fill = 'var(--color-hex-player)';
      else if (isAS)  fill = 'var(--color-hex-ai)';

      let stroke = 'var(--color-hex-stroke)';
      let strokeW = '1';
      if      (hlPlayer && isPlayerRow) { stroke = 'var(--color-unit-selected)'; strokeW = '2.5'; }
      else if (hlAi && isAiRow)         { stroke = 'var(--color-ai)';            strokeW = '2.5'; }
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
    edState.controlPoints.delete(key);
    if (row === rows - 1) edState.playerStart.delete(col);
    if (row === 0) edState.aiStart.delete(col);
  } else if (activeTool === 'mountain') {
    edState.mountains.add(key);
    edState.controlPoints.delete(key);
    if (row === rows - 1) edState.playerStart.delete(col);
    if (row === 0) edState.aiStart.delete(col);
  } else if (activeTool === 'controlPoint') {
    edState.controlPoints.add(key);
    edState.mountains.delete(key);
  } else if (activeTool.startsWith('player:')) {
    if (row !== rows - 1) return;
    edState.playerStart.set(col, activeTool.slice('player:'.length));
    edState.mountains.delete(key);
    edState.controlPoints.delete(key);
  } else if (activeTool.startsWith('ai:')) {
    if (row !== 0) return;
    edState.aiStart.set(col, activeTool.slice('ai:'.length));
    edState.mountains.delete(key);
    edState.controlPoints.delete(key);
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

  // Accept either a full StoryDef-like object or a bare StoryMapDef
  const mapDef = (parsed.map && typeof parsed.map === 'object'
    ? parsed.map
    : parsed) as Record<string, unknown>;

  const cols = Number(mapDef.cols);
  const rows = Number(mapDef.rows);
  if (!Number.isInteger(cols) || cols < 2 || cols > 24) return 'Invalid cols (must be 2–24).';
  if (!Number.isInteger(rows) || rows < 2 || rows > 24) return 'Invalid rows (must be 2–24).';

  const mountains = new Set<string>(
    Array.isArray(mapDef.mountains) ? mapDef.mountains.map(String) : []
  );
  const controlPoints = new Set<string>(
    Array.isArray(mapDef.controlPoints) ? mapDef.controlPoints.map(String) : []
  );

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

  // Commit to state
  edState.cols = cols;
  edState.rows = rows;
  edState.mountains = mountains;
  edState.controlPoints = controlPoints;
  edState.playerStart = playerStart;
  edState.aiStart = aiStart;

  if (typeof parsed.gameMode === 'string') {
    edState.gameMode = parsed.gameMode as EditorGameMode;
    gameModeSelect.value = edState.gameMode;
  }
  if (typeof parsed.unitPackage === 'string') {
    edState.unitPackage = parsed.unitPackage;
    unitPackageSelect.value = edState.unitPackage;
  }

  colsInput.value = String(cols);
  rowsInput.value = String(rows);

  edState.activeTool = 'normal';
  refreshToolbar();
  renderBoard();
  return null;
}

// ── Export ────────────────────────────────────────────────────────────────────

function exportToClipboard(): void {
  const { cols, rows, gameMode, mountains, controlPoints, playerStart, aiStart, unitPackage } = edState;
  const i = '  ';

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

  const cpStr = [...controlPoints].sort().map(c => `'${c}'`).join(', ');

  let code = `{\n`;
  code += `${i}id: 'my-map',\n`;
  code += `${i}title: 'My Map',\n`;
  code += `${i}description: 'Description.',\n`;
  if (unitPackage) code += `${i}unitPackage: '${unitPackage}',\n`;
  code += `${i}gameMode: '${gameMode}',\n`;
  code += `${i}map: {\n`;
  code += `${i}${i}cols: ${cols},\n`;
  code += `${i}${i}rows: ${rows},\n`;
  code += `${i}${i}mountains: [${mStr}],\n`;
  code += `${i}${i}playerStart: [${pStr}],\n`;
  code += `${i}${i}aiStart: [${aStr}],\n`;
  if ((gameMode === 'conquest' || gameMode === 'breakthrough') && controlPoints.size > 0) {
    code += `${i}${i}controlPoints: [${cpStr}],\n`;
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
  unitPackageSelect.value = '';
  refreshToolbar();
  renderBoard();
  overlayEl.classList.remove('hidden');
}

export function hideMapEditor(): void {
  overlayEl.classList.add('hidden');
}
