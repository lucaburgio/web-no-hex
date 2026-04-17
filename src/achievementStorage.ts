import type { GameMode, WinReason } from './types';

const ACHIEVEMENT_STATS_KEY = 'web-strategic-achievement-stats';

const WIN_REASON_KEYS: readonly WinReason[] = [
  'dom_breakthrough',
  'dom_annihilation',
  'cq_elimination',
  'cq_both_eliminated',
  'cq_cp_depleted',
  'cq_both_cp_depleted',
  'bt_attacker_wiped',
  'bt_all_sectors',
];

export interface AchievementStats {
  /** Best turn count among all vs-AI victories (lower is better). */
  bestWinTurnsVsAi: number | null;
  /** Longest vs-AI victory by turn count (higher is more turns). */
  longestWinTurnsVsAi: number | null;
  totalWinsVsAi: number;
  wonDomination: boolean;
  wonConquest: boolean;
  wonBreakthrough: boolean;
  /** Won at least once by eliminating the opponent’s forces (or equivalent). */
  wonByAnnihilation: boolean;
  /** Which {@link WinReason} values the player has won with at least once (vs AI). */
  winReasonWon: Partial<Record<WinReason, boolean>>;
}

const DEFAULT_STATS: AchievementStats = {
  bestWinTurnsVsAi: null,
  longestWinTurnsVsAi: null,
  totalWinsVsAi: 0,
  wonDomination: false,
  wonConquest: false,
  wonBreakthrough: false,
  wonByAnnihilation: false,
  winReasonWon: {},
};

export function loadAchievementStats(): AchievementStats {
  try {
    const raw = localStorage.getItem(ACHIEVEMENT_STATS_KEY);
    if (!raw) return { ...DEFAULT_STATS };
    const p = JSON.parse(raw) as Partial<AchievementStats>;
    const wrRaw = p.winReasonWon;
    const winReasonWon: Partial<Record<WinReason, boolean>> = {};
    if (wrRaw && typeof wrRaw === 'object') {
      for (const key of WIN_REASON_KEYS) {
        if (wrRaw[key]) winReasonWon[key] = true;
      }
    }
    return {
      bestWinTurnsVsAi:
        p.bestWinTurnsVsAi === undefined || p.bestWinTurnsVsAi === null
          ? null
          : Number(p.bestWinTurnsVsAi),
      longestWinTurnsVsAi:
        p.longestWinTurnsVsAi === undefined || p.longestWinTurnsVsAi === null
          ? null
          : Number(p.longestWinTurnsVsAi),
      totalWinsVsAi: Math.max(0, Number(p.totalWinsVsAi) || 0),
      wonDomination: Boolean(p.wonDomination),
      wonConquest: Boolean(p.wonConquest),
      wonBreakthrough: Boolean(p.wonBreakthrough),
      wonByAnnihilation: Boolean(p.wonByAnnihilation),
      winReasonWon,
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
  if (s.longestWinTurnsVsAi === null || turns > s.longestWinTurnsVsAi) {
    s.longestWinTurnsVsAi = turns;
  }
  if (mode === 'domination') s.wonDomination = true;
  if (mode === 'conquest') s.wonConquest = true;
  if (mode === 'breakthrough') s.wonBreakthrough = true;
  if (isAnnihilationStyleWin(winReason)) s.wonByAnnihilation = true;
  if (winReason != null && WIN_REASON_KEYS.includes(winReason)) {
    s.winReasonWon = { ...s.winReasonWon, [winReason]: true };
  }
  saveAchievementStats(s);
}
