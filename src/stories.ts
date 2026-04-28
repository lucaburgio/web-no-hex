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
  map: 'tutorial',

  productionPointsPerTurnAi: 4,
},
{
  id: 'ww2de-01',
  scenario: 'ww2us',
  title: 'Castellet',
  description: 'Description.',
  unitPackage: 'de-ww2',
  unitPackagePlayer2: 'us-ww2',
  gameMode: 'breakthrough',
  breakthroughPlayer1Role: 'attacker',
  map: 'castellet',

  productionPointsPerTurnAi: 20,
  startingUnitsAttacker: 1,
  startingUnitsDefender: 3,
},
];

export function getStoryById(id: string): StoryDef | undefined {
  return STORIES.find(s => s.id === id);
}
