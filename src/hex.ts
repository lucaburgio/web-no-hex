// Hex grid math using offset coordinates (odd-r offset, pointy-top)
// col = q offset, row = r

import config from './gameconfig';

export const HEX_SIZE: number = config.hexSize;

/** Radius multiplier for terrain fill polygons only — slight overlap hides sub-pixel seams between adjacent SVG fills (WKWebView). */
export const HEX_FILL_RADIUS_MULT = 1.0025;

// Pixel position for a hex at (col, row) — pointy-top, odd-r offset
export function hexToPixel(col: number, row: number): { x: number; y: number } {
  const x = HEX_SIZE * Math.sqrt(3) * (col + (Math.abs(row) % 2 === 1 ? 0.5 : 0));
  const y = HEX_SIZE * 1.5 * row;
  return { x, y };
}

// The 6 neighbor directions for odd and even rows (pointy-top, odd-r offset).
// Odd rows are shifted right by +0.5, so their diagonal neighbors are at col and col+1.
// Even rows' diagonal neighbors are at col-1 and col.
const NEIGHBOR_DIRS: { even: [number, number][]; odd: [number, number][] } = {
  even: [
    [ 1,  0], [-1,  0],   // right, left
    [ 0, -1], [-1, -1],   // lower-right, lower-left (row above)
    [ 0,  1], [-1,  1],   // upper-right, upper-left (row below)
  ],
  odd: [
    [ 1,  0], [-1,  0],   // right, left
    [ 1, -1], [ 0, -1],   // lower-right, lower-left (row above)
    [ 1,  1], [ 0,  1],   // upper-right, upper-left (row below)
  ],
};

export function getNeighbors(col: number, row: number, cols: number, rows: number): [number, number][] {
  const dirs = row % 2 === 0 ? NEIGHBOR_DIRS.even : NEIGHBOR_DIRS.odd;
  return dirs
    .map(([dc, dr]): [number, number] => [col + dc, row + dr])
    .filter(([c, r]) => c >= 0 && r >= 0 && c < cols && r < rows);
}

// Hex path for SVG polygon points
export function hexPoints(cx: number, cy: number, size: number = HEX_SIZE): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30); // pointy-top
    pts.push(`${cx + size * Math.cos(angle)},${cy + size * Math.sin(angle)}`);
  }
  return pts.join(' ');
}

/** Hex outline for `#hex-layer` terrain fills; slightly larger than {@link hexPoints} so neighbors overlap. */
export function hexFillPoints(cx: number, cy: number): string {
  return hexPoints(cx, cy, HEX_SIZE * HEX_FILL_RADIUS_MULT);
}

// Simple BFS distance between two hex cells (offset coords)
export function hexDistance(c1: number, r1: number, c2: number, r2: number, cols: number, rows: number): number {
  if (c1 === c2 && r1 === r2) return 0;
  const visited = new Set<string>();
  let frontier: [number, number][] = [[c1, r1]];
  let dist = 0;
  while (frontier.length > 0) {
    dist++;
    const next: [number, number][] = [];
    for (const [c, r] of frontier) {
      for (const [nc, nr] of getNeighbors(c, r, cols, rows)) {
        const key = `${nc},${nr}`;
        if (nc === c2 && nr === r2) return dist;
        if (!visited.has(key)) {
          visited.add(key);
          next.push([nc, nr]);
        }
      }
    }
    frontier = next;
  }
  return Infinity;
}
