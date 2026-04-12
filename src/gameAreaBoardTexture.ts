/**
 * Repeating texture behind the board, masked so it fades with distance from the board's
 * axis-aligned bounding box (Tier B). Mask is regenerated on resize via ResizeObserver.
 */

import bgLinesTexture from '../public/images/misc/bg-lines.png';

const DEBOUNCE_MS = 48;

/** Euclidean distance from (px, py) to the nearest point on the closed rectangle [L,R]×[T,B]. */
function distanceToRect(px: number, py: number, L: number, T: number, R: number, B: number): number {
  const cx = Math.min(Math.max(px, L), R);
  const cy = Math.min(Math.max(py, T), B);
  return Math.hypot(px - cx, py - cy);
}

function readFadePx(gameArea: HTMLElement): number {
  const raw = getComputedStyle(gameArea).getPropertyValue('--game-area-board-texture-fade').trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 280;
}

export function initGameAreaBoardTexture(gameArea: HTMLElement, board: HTMLElement): () => void {
  const found = document.getElementById('game-area-bg-texture');
  if (!found) return () => {};
  const texEl: HTMLElement = found;

  texEl.style.backgroundImage = `url(${JSON.stringify(bgLinesTexture)})`;
  texEl.style.backgroundRepeat = 'repeat';
  texEl.style.backgroundPosition = '0 0';

  const canvas = document.createElement('canvas');
  const ctxRaw = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctxRaw) return () => {};
  const ctx = ctxRaw;

  let blobUrl: string | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let gen = 0;

  function revokeBlob(): void {
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = null;
    }
  }

  function updateMask(): void {
    const ar = gameArea.getBoundingClientRect();
    const br = board.getBoundingClientRect();
    const myGen = ++gen;

    if (ar.width < 1 || ar.height < 1 || br.width < 2 || br.height < 2) {
      revokeBlob();
      texEl.style.maskImage = 'none';
      (texEl.style as CSSStyleDeclaration & { WebkitMaskImage?: string }).webkitMaskImage = 'none';
      texEl.style.opacity = '0';
      return;
    }

    texEl.style.opacity = '1';

    const L = br.left - ar.left;
    const T = br.top - ar.top;
    const R = br.right - ar.left;
    const B = br.bottom - ar.top;

    const w = Math.max(1, Math.round(ar.width));
    const h = Math.max(1, Math.round(ar.height));
    canvas.width = w;
    canvas.height = h;

    const fade = readFadePx(gameArea);
    const imgData = ctx.createImageData(w, h);
    const data = imgData.data;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        let a: number;
        // Full texture under the board so neutral hexes can stay transparent and show stripes.
        if (px >= L && px <= R && py >= T && py <= B) {
          a = 1;
        } else {
          const dist = distanceToRect(px, py, L, T, R, B);
          a = Math.max(0, Math.min(1, 1 - dist / fade));
        }
        const o = (y * w + x) * 4;
        data[o] = 255;
        data[o + 1] = 255;
        data[o + 2] = 255;
        data[o + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(imgData, 0, 0);

    canvas.toBlob((blob) => {
      if (myGen !== gen || !blob) return;
      revokeBlob();
      blobUrl = URL.createObjectURL(blob);
      const u = `url("${blobUrl}")`;
      texEl.style.maskImage = u;
      (texEl.style as CSSStyleDeclaration & { WebkitMaskImage?: string }).webkitMaskImage = u;
      texEl.style.maskSize = '100% 100%';
      texEl.style.maskRepeat = 'no-repeat';
      texEl.style.maskPosition = '0 0';
      texEl.style.maskMode = 'alpha';
    });
  }

  function schedule(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      updateMask();
    }, DEBOUNCE_MS);
  }

  const roGame = new ResizeObserver(schedule);
  const roBoard = new ResizeObserver(schedule);
  roGame.observe(gameArea);
  roBoard.observe(board);
  window.addEventListener('resize', schedule);
  schedule();

  return () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    roGame.disconnect();
    roBoard.disconnect();
    window.removeEventListener('resize', schedule);
    revokeBlob();
    gen++;
  };
}
