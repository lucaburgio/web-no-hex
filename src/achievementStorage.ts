import type { GameMode, WinReason } from './types';

const ACHIEVEMENT_STATS_KEY = 'web-strategic-achievement-stats';

export interface AchievementStats {
  /** Best turn count among all vs-AI victories (lower is better). */
  bestWinTurnsVsAi: number | null;
  totalWinsVsAi: number;
  wonDomination: boolean;
  wonConquest: boolean;
  wonBreakthrough: boolean;
  /** Won at least once by eliminating the opponent’s forces (or equivalent). */
  wonByAnnihilation: boolean;
}

const DEFAULT_STATS: AchievementStats = {
  bestWinTurnsVsAi: null,
  totalWinsVsAi: 0,
  wonDomination: false,
  wonConquest: false,
  wonBreakthrough: false,
  wonByAnnihilation: false,
};

export function loadAchievementStats(): AchievementStats {
  try {
    const raw = localStorage.getItem(ACHIEVEMENT_STATS_KEY);
    if (!raw) return { ...DEFAULT_STATS };
    const p = JSON.parse(raw) as Partial<AchievementStats>;
    return {
      bestWinTurnsVsAi:
        p.bestWinTurnsVsAi === undefined || p.bestWinTurnsVsAi === null
          ? null
          : Number(p.bestWinTurnsVsAi),
      totalWinsVsAi: Math.max(0, Number(p.totalWinsVsAi) || 0),
      wonDomination: Boolean(p.wonDomination),
      wonConquest: Boolean(p.wonConquest),
      wonBreakthrough: Boolean(p.wonBreakthrough),
      wonByAnnihilation: Boolean(p.wonByAnnihilation),
    };
  } catch {
    return { ...DEFAULT_STATS };
  }
}

export function saveAchievementStats(stats: AchievementStats): void {
  try {
    localStorage.setItem(ACHIEVEMENT_STATS_KEY, JSON.stringify(stats));
  } catch (e) {
    console.error('Failed to save achievement stats:', e);
  }
}

function isAnnihilationStyleWin(reason: WinReason | undefined): boolean {
  if (reason == null) return false;
  return (
    reason === 'dom_annihilation' ||
    reason === 'cq_elimination' ||
    reason === 'bt_attacker_wiped'
  );
}

/**
 * Call when the local player wins any vs-AI match (skirmish or story).
 */
export function recordVsAiVictory(
  turns: number,
  mode: GameMode,
  winReason: WinReason | undefined,
): void {
  const s = loadAchievementStats();
  s.totalWinsVsAi += 1;
  if (s.bestWinTurnsVsAi === null || turns < s.bestWinTurnsVsAi) {
    s.bestWinTurnsVsAi = turns;
  }
  if (mode === 'domination') s.wonDomination = true;
  if (mode === 'conquest') s.wonConquest = true;
  if (mode === 'breakthrough') s.wonBreakthrough = true;
  if (isAnnihilationStyleWin(winReason)) s.wonByAnnihilation = true;
  saveAchievementStats(s);
}
