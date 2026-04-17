import { riverHexesFromPaintedKeys } from './rivers';
import type { StoryMapDef } from './types';

/**
 * Conquest objective hexes for this map. Prefers {@link StoryMapDef.conquestControlPoints},
 * then legacy {@link StoryMapDef.controlPoints}.
 */
export function getConquestControlPointsForMap(map: StoryMapDef): string[] {
  if (map.conquestControlPoints?.length) return [...map.conquestControlPoints];
  if (map.controlPoints?.length) return [...map.controlPoints];
  return [];
}

/**
 * Breakthrough sector CP hexes. Prefers {@link StoryMapDef.breakthroughControlPoints},
 * then legacy {@link StoryMapDef.controlPoints}.
 */
export function getBreakthroughControlPointsForMap(map: StoryMapDef): string[] {
  if (map.breakthroughControlPoints?.length) return [...map.breakthroughControlPoints];
  if (map.controlPoints?.length) return [...map.controlPoints];
  return [];
}

/**
 * Custom match preset list: map must define both conquest and breakthrough layouts explicitly
 * (mountains/rivers are shared; domination needs no extra keys).
 */
export function storyMapHasFullCustomMatchSupport(map: StoryMapDef): boolean {
  return (map.conquestControlPoints?.length ?? 0) >= 1
    && (map.breakthroughControlPoints?.length ?? 0) >= 1;
}

/**
 * Mirror both grid axes: `col' = cols - 1 - col`, `row' = rows - 1 - row` on every hex key.
 * Used for Breakthrough when the attacker is AI (player 1 defends): authored maps assume a
 * south attacker, so mirroring aligns terrain, sectors, and CPs with the north-attacker layout.
 */
export function mirrorStoryMapY(map: StoryMapDef, cols: number, rows: number): StoryMapDef {
  const mirrorKey = (key: string): string => {
    const [c, r] = key.split(',').map(Number);
    return `${cols - 1 - c},${rows - 1 - r}`;
  };

  let rivers: ReturnType<typeof riverHexesFromPaintedKeys> | undefined;
  if (map.rivers && map.rivers.length > 0) {
    const keySet = new Set<string>();
    for (const rh of map.rivers) {
      keySet.add(`${rh.col},${rh.row}`);
    }
    const mirrored = new Set<string>();
    for (const k of keySet) {
      mirrored.add(mirrorKey(k));
    }
    rivers = riverHexesFromPaintedKeys(mirrored, map.cols, map.rows);
  }

  const out: StoryMapDef = {
    cols: map.cols,
    rows: map.rows,
    mountains: map.mountains.map(mirrorKey),
    playerStart: map.playerStart,
    aiStart: map.aiStart,
  };
  if (map.breakthroughControlPoints?.length) {
    out.breakthroughControlPoints = map.breakthroughControlPoints.map(mirrorKey);
  }
  if (map.conquestControlPoints?.length) {
    out.conquestControlPoints = map.conquestControlPoints.map(mirrorKey);
  }
  if (map.controlPoints?.length) {
    out.controlPoints = map.controlPoints.map(mirrorKey);
  }
  if (rivers?.length) {
    out.rivers = rivers;
  }
  return out;
}
