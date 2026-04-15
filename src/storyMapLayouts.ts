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
