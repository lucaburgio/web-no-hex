import type { StoryDef } from './types';

export const STORIES: StoryDef[] = [
{
  id: 'tutorial-01',
  scenario: 'tutorial',
  title: 'Introduction',
  description: 'Description.',
  unitPackage: 'us-ww2',
  unitPackagePlayer2: 'de-ww2',
  gameMode: 'domination',
  map: 'kuki-island',

  productionPointsPerTurnAi: 0,
},
{
  id: 'tutorial-02',
  scenario: 'tutorial',
  title: 'Learn — Attack on Breakthrough',
  description: 'Description.',
  unitPackage: 'us-ww2',
  unitPackagePlayer2: 'jp-ww2',
  gameMode: 'breakthrough',
  breakthroughPlayer1Role: 'attacker',
  map: 'kuki-island',

  productionPointsPerTurnAi: 10,
  startingUnitsAttacker: 1,
  startingUnitsDefender: 3,
},
{
  id: 'tutorial-03',
  scenario: 'tutorial',
  title: 'Learn — Defend on Breakthrough',
  description: 'Description.',
  unitPackage: 'jp-ww2',
  unitPackagePlayer2: 'us-ww2',
  gameMode: 'breakthrough',
  breakthroughPlayer1Role: 'defender',
  map: 'kuki-island',

  productionPointsPerTurnAi: 20,
  startingUnitsAttacker: 1,
  startingUnitsDefender: 3,
  breakthroughAttackerStartingPP: 60,
},
];

export function getStoryById(id: string): StoryDef | undefined {
  return STORIES.find(s => s.id === id);
}
