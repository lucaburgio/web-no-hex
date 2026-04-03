import type { GameState } from './types';

const STORAGE_KEY = 'web-strategic-save';

export function saveGameState(state: GameState): void {
  if (state.winner !== null) {
    clearGameState();
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error('Failed to save game state:', error);
  }
}

export function loadGameState(): GameState | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return null;
    return JSON.parse(saved) as GameState;
  } catch (error) {
    console.error('Failed to load game state:', error);
    return null;
  }
}

export function hasSaveGame(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function clearGameState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear game state:', error);
  }
}
