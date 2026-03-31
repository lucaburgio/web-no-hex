// Hex grid math using offset coordinates (odd-r offset, pointy-top)
// col = q offset, row = r

export const HEX_SIZE = 22; // radius in px

// Pixel position for a hex at (col, row) — pointy-top, odd-r offset
export function hexToPixel(col, row) {
  const x = HEX_SIZE * Math.sqrt(3) * (col + (row % 2 === 1 ? 0.5 : 0));
  const y = HEX_SIZE * 1.5 * row;
  return { x, y };
}

// The 6 neighbor directions for odd and even rows (pointy-top, offset coords)
const NEIGHBOR_DIRS = {
  even: [
    [1, 0], [-1, 0],
    [0, -1], [1, -1],
    [0, 1], [1, 1],
  ],
  odd: [
    [1, 0], [-1, 0],
    [-1, -1], [0, -1],
    [-1, 1], [0, 1],
  ],
};

export function getNeighbors(col, row, cols, rows) {
  const dirs = row % 2 === 0 ? NEIGHBOR_DIRS.even : NEIGHBOR_DIRS.odd;
  return dirs
    .map(([dc, dr]) => [col + dc, row + dr])
    .filter(([c, r]) => c >= 0 && r >= 0 && c < cols && r < rows);
}

// Hex path for SVG polygon points
export function hexPoints(cx, cy) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30); // pointy-top
    pts.push(`${cx + HEX_SIZE * Math.cos(angle)},${cy + HEX_SIZE * Math.sin(angle)}`);
  }
  return pts.join(' ');
}

// Simple BFS distance between two hex cells (offset coords)
export function hexDistance(c1, r1, c2, r2, cols, rows) {
  if (c1 === c2 && r1 === r2) return 0;
  const visited = new Set();
  let frontier = [[c1, r1]];
  let dist = 0;
  while (frontier.length > 0) {
    dist++;
    const next = [];
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
