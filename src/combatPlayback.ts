import type { Unit } from './types';

/**
 * Which board snapshot to draw for the AI damage-float beat, and which unit ids to skip
 * so two casualties never stack on one hex (mutual kill uses the resolved board).
 */
export function aiDamageFloatDrawParams(
  unitsBefore: Unit[],
  unitsAfter: Unit[],
  afterStrike: boolean,
): { pick: 'after' | 'before'; hiddenUnitIds: Set<number> } {
  if (afterStrike) {
    return { pick: 'after', hiddenUnitIds: new Set() };
  }
  const dead = unitsBefore.filter(u => !unitsAfter.some(ua => ua.id === u.id));
  if (dead.length >= 2) {
    return { pick: 'after', hiddenUnitIds: new Set() };
  }
  return { pick: 'before', hiddenUnitIds: new Set(dead.map(u => u.id)) };
}
