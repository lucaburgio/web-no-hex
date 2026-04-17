import type { AchievementStats } from './achievementStorage';
import type { StoryProgress } from './types';
import { STORIES } from './stories';
import { SCENARIOS } from './scenarios';
import modeImgDomination from '../public/images/modes/domination.png';
import modeImgConquest from '../public/images/modes/conquest.png';
import modeImgBreakthrough from '../public/images/modes/breakthrough.png';
import modeIconDomination from '../public/icons/modes/domination.svg';
import modeIconConquest from '../public/icons/modes/conquest.svg';
import modeIconBreakthrough from '../public/icons/modes/breakthrough.svg';
import starIcon from '../public/icons/star.svg';

export type AchievementCategory = 'scenarios' | 'speed' | 'modes' | 'milestones';

export type AchievementKind =
  | { type: 'scenario'; scenarioId: string }
  | { type: 'speed'; maxTurns: number }
  | { type: 'modes_all' }
  | { type: 'wins'; count: number }
  | { type: 'annihilation' };

export interface AchievementDefinition {
  id: string;
  title: string;
  description: string;
  image: string;
  icon: string;
  category: AchievementCategory;
  kind: AchievementKind;
}

export interface AchievementView extends AchievementDefinition {
  current: number;
  goal: number;
  completed: boolean;
  /** Extra line, e.g. best turn count for speed feats. */
  sublabel?: string;
}

function buildScenarioAchievements(): AchievementDefinition[] {
  return SCENARIOS.map(sc => {
    const missionCount = STORIES.filter(s => s.scenario === sc.id).length;
    return {
      id: `scenario-${sc.id}`,
      title: sc.title,
      description:
        missionCount > 0
          ? `Complete all ${missionCount} missions in this scenario.`
          : 'Complete every mission in this scenario.',
      image: sc.image,
      icon: sc.icon,
      category: 'scenarios',
      kind: { type: 'scenario', scenarioId: sc.id },
    };
  });
}

const STATIC_ACHIEVEMENTS: AchievementDefinition[] = [
  {
    id: 'speed-40',
    title: 'Forty-round campaign',
    description: 'Win a vs AI match in 40 turns or fewer.',
    image: modeImgDomination,
    icon: starIcon,
    category: 'speed',
    kind: { type: 'speed', maxTurns: 40 },
  },
  {
    id: 'speed-25',
    title: 'Twenty-five turn blitz',
    description: 'Win a vs AI match in 25 turns or fewer.',
    image: modeImgConquest,
    icon: starIcon,
    category: 'speed',
    kind: { type: 'speed', maxTurns: 25 },
  },
  {
    id: 'speed-15',
    title: 'Fifteen turn lightning strike',
    description: 'Win a vs AI match in 15 turns or fewer.',
    image: modeImgBreakthrough,
    icon: starIcon,
    category: 'speed',
    kind: { type: 'speed', maxTurns: 15 },
  },
  {
    id: 'modes-all',
    title: 'Well-rounded commander',
    description: 'Win at least one vs AI match in Domination, Conquest, and Breakthrough.',
    image: modeImgDomination,
    icon: modeIconDomination,
    category: 'modes',
    kind: { type: 'modes_all' },
  },
  {
    id: 'first-win',
    title: 'First victory',
    description: 'Win your first vs AI match.',
    image: modeImgConquest,
    icon: starIcon,
    category: 'milestones',
    kind: { type: 'wins', count: 1 },
  },
  {
    id: 'wins-10',
    title: 'Battle-hardened',
    description: 'Win 10 vs AI matches.',
    image: modeImgBreakthrough,
    icon: starIcon,
    category: 'milestones',
    kind: { type: 'wins', count: 10 },
  },
  {
    id: 'annihilation',
    title: 'Total elimination',
    description: 'Win a vs AI match by wiping out the opposing force (or routing a breakthrough attacker).',
    image: modeImgDomination,
    icon: starIcon,
    category: 'milestones',
    kind: { type: 'annihilation' },
  },
];

export function getAllAchievementDefinitions(): AchievementDefinition[] {
  return [...buildScenarioAchievements(), ...STATIC_ACHIEVEMENTS];
}

function modesCompleted(stats: AchievementStats): number {
  return (
    (stats.wonDomination ? 1 : 0) +
    (stats.wonConquest ? 1 : 0) +
    (stats.wonBreakthrough ? 1 : 0)
  );
}

function computeView(
  def: AchievementDefinition,
  storyProgress: StoryProgress,
  stats: AchievementStats,
): AchievementView {
  const k = def.kind;
  if (k.type === 'scenario') {
    const missions = STORIES.filter(s => s.scenario === k.scenarioId);
    const goal = missions.length;
    const current = missions.filter(s => storyProgress.completedIds.includes(s.id)).length;
    const completed = goal > 0 && current >= goal;
    return {
      ...def,
      current,
      goal,
      completed,
    };
  }
  if (k.type === 'speed') {
    const best = stats.bestWinTurnsVsAi;
    const done = best !== null && best <= k.maxTurns;
    let sublabel: string;
    if (done) {
      sublabel = `Met: won in ${best} turns (≤${k.maxTurns})`;
    } else if (best != null) {
      sublabel = `Best victory: ${best} turns — need ≤${k.maxTurns}`;
    } else {
      sublabel = `Win a vs AI match in ${k.maxTurns} turns or fewer`;
    }
    return {
      ...def,
      current: done ? 1 : 0,
      goal: 1,
      completed: done,
      sublabel,
    };
  }
  if (k.type === 'modes_all') {
    const m = modesCompleted(stats);
    return {
      ...def,
      current: m,
      goal: 3,
      completed: m >= 3,
    };
  }
  if (k.type === 'wins') {
    const c = stats.totalWinsVsAi;
    return {
      ...def,
      current: Math.min(c, k.count),
      goal: k.count,
      completed: c >= k.count,
    };
  }
  if (k.type === 'annihilation') {
    return {
      ...def,
      current: stats.wonByAnnihilation ? 1 : 0,
      goal: 1,
      completed: stats.wonByAnnihilation,
    };
  }
  return { ...def, current: 0, goal: 1, completed: false };
}

export function getAchievementViews(
  storyProgress: StoryProgress,
  stats: AchievementStats,
): AchievementView[] {
  return getAllAchievementDefinitions().map(d => computeView(d, storyProgress, stats));
}

/** Section order in the achievements overlay. */
export const ACHIEVEMENT_CATEGORY_ORDER: AchievementCategory[] = [
  'scenarios',
  'speed',
  'modes',
  'milestones',
];

export function categoryLabel(cat: AchievementCategory): string {
  switch (cat) {
    case 'scenarios':
      return 'Scenarios';
    case 'speed':
      return 'Speed';
    case 'modes':
      return 'Game modes';
    case 'milestones':
      return 'Milestones';
    default:
      return cat;
  }
}
