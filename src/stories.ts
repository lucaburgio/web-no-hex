import type { StoryDef } from './types';

export const STORIES: StoryDef[] = [
  {
    id: 'first-contact',
    title: 'First Contact',
    description: 'Lead your infantry across a narrow front. Learn the basics — move, conquer, and push the enemy back to their lines.',
    unitPackage: 'infantry',
    gameMode: 'domination',
    map: {
      cols: 6,
      rows: 4,
      mountains: ['2,1', '3,1', '3,2'],
      playerStart: [{ col: 1 }, { col: 4 }],
      aiStart: [{ col: 1 }, { col: 4 }],
    },
    productionPointsPerTurn: 20,
  },
  {
    id: 'steel-fist',
    title: 'Steel Fist',
    description: 'Command an armored spearhead through contested terrain. Tanks break enemy lines; artillery softens positions from a distance.',
    unitPackage: 'armored',
    gameMode: 'domination',
    map: {
      cols: 8,
      rows: 6,
      mountains: ['1,2', '2,2', '5,3', '6,3', '3,1', '4,4'],
      playerStart: [{ col: 2, unitTypeId: 'tank' }, { col: 5, unitTypeId: 'tank' }],
      aiStart: [{ col: 2, unitTypeId: 'tank' }, { col: 5, unitTypeId: 'tank' }],
    },
    productionPointsPerTurn: 40,
  },
  {
    id: 'contested-grounds',
    title: 'Contested Grounds',
    description: 'Fight for control of strategic positions. All unit types at your disposal — use combined arms to dominate the control points.',
    gameMode: 'conquest',
    map: {
      cols: 8,
      rows: 8,
      mountains: ['1,2', '6,2', '2,4', '5,4', '1,6', '6,6'],
      playerStart: [{ col: 1 }, { col: 4 }, { col: 6 }],
      aiStart: [{ col: 1 }, { col: 4 }, { col: 6 }],
      controlPoints: ['3,2', '5,2', '3,5', '5,5'],
    },
    conquestPointsPlayer: 14,
    conquestPointsAi: 14,
    productionPointsPerTurn: 20,
  },
];

export function getStoryById(id: string): StoryDef | undefined {
  return STORIES.find(s => s.id === id);
}
