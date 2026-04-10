import config from './gameconfig';
import type { GameState, StoryProgress } from './types';

const STORY_PROGRESS_KEY = 'web-strategic-story-progress';
const STORY_SAVE_KEY = 'web-strategic-story-save';
const LAST_SESSION_KEY = 'web-strategic-last-session';

export type LastSessionType = 'vsAI' | 'story';

const DEFAULT_PROGRESS: StoryProgress = {
  reachedIndex: 0,
  completedIds: [],
  activeStoryId: null,
  completedTurns: {},
};

export function loadStoryProgress(): StoryProgress {
  try {
    const saved = localStorage.getItem(STORY_PROGRESS_KEY);
    if (!saved) return { ...DEFAULT_PROGRESS };
    const p = JSON.parse(saved) as Partial<StoryProgress>;
    return {
      reachedIndex: p.reachedIndex ?? 0,
      completedIds: p.completedIds ?? [],
      activeStoryId: p.activeStoryId ?? null,
      completedTurns: p.completedTurns ?? {},
    };
  } catch {
    return { ...DEFAULT_PROGRESS };
  }
}

export function saveStoryProgress(progress: StoryProgress): void {
  try {
    localStorage.setItem(STORY_PROGRESS_KEY, JSON.stringify(progress));
  } catch (e) {
    console.error('Failed to save story progress:', e);
  }
}

export function saveStoryGameState(state: GameState): void {
  if (state.winner !== null) {
    clearStoryGameState();
    return;
  }
  try {
    localStorage.setItem(STORY_SAVE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save story game state:', e);
  }
}

export function loadStoryGameState(): GameState | null {
  try {
    const saved = localStorage.getItem(STORY_SAVE_KEY);
    if (!saved) return null;
    const state = JSON.parse(saved) as GameState;

    if (!state.mountainHexes) state.mountainHexes = [];
    if (state.gameMode == null) state.gameMode = 'domination';
    if (!state.controlPointHexes) state.controlPointHexes = [];
    if (!state.sectorHexes) state.sectorHexes = [];
    if (!state.sectorOwners) state.sectorOwners = [];
    if (!state.sectorControlPointHex) state.sectorControlPointHex = [];
    if (!state.breakthroughCpOccupation) state.breakthroughCpOccupation = [];
    if (!state.sectorIndexByHex) state.sectorIndexByHex = {};
    if (state.gameMode !== 'conquest') {
      state.conquestPoints = null;
    } else if (state.conquestPoints == null) {
      state.conquestPoints = {
        1: config.conquestPointsPlayer,
        2: config.conquestPointsAi,
      };
    }

    for (const unit of state.units) {
      if (unit.unitTypeId == null) unit.unitTypeId = 'infantry';
      if (unit.attackedThisTurn == null) unit.attackedThisTurn = false;
      const ut = config.unitTypes.find(u => u.id === unit.unitTypeId) ?? config.unitTypes[0];
      if (unit.movement == null) unit.movement = ut.movement;
      if (unit.maxHp == null) unit.maxHp = ut.maxHp;
      if (unit.strength == null) unit.strength = ut.strength;
      unit.hp = Math.min(unit.hp ?? unit.maxHp, unit.maxHp);
    }

    return state;
  } catch (e) {
    console.error('Failed to load story game state:', e);
    return null;
  }
}

export function hasStoryGameState(): boolean {
  try {
    return localStorage.getItem(STORY_SAVE_KEY) !== null;
  } catch {
    return false;
  }
}

export function clearStoryGameState(): void {
  try {
    localStorage.removeItem(STORY_SAVE_KEY);
  } catch (e) {
    console.error('Failed to clear story game state:', e);
  }
}

export function setLastSessionType(type: LastSessionType): void {
  try {
    localStorage.setItem(LAST_SESSION_KEY, type);
  } catch {}
}

export function getLastSessionType(): LastSessionType | null {
  try {
    const v = localStorage.getItem(LAST_SESSION_KEY);
    if (v === 'vsAI' || v === 'story') return v;
    return null;
  } catch {
    return null;
  }
}
