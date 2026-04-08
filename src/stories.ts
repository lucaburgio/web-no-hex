import type { StoryDef } from './types';

export const STORIES: StoryDef[] = [
  {
    id: 'my-map',
    title: 'My Map',
    description: 'Description.',
    unitPackage: 'standard',
    gameMode: 'domination',
    map: {
      cols: 4,
      rows: 8,
      mountains: ['0,2', '0,3', '0,4', '1,4', '3,1', '3,4', '3,5'],
      playerStart: [{ col: 0, unitTypeId: 'artillery' }, { col: 3, unitTypeId: 'artillery' }],
      aiStart: [{ col: 0, unitTypeId: 'tank' }, { col: 1, unitTypeId: 'tank' }, { col: 2, unitTypeId: 'tank' }, { col: 3, unitTypeId: 'tank' }],
    },
    productionPointsPerTurn: 20,
  },
  {
    id: 'my-map-3',
    title: 'My Map breakthrough',
    description: 'Description.',
    unitPackage: 'us-ww2',
    gameMode: 'breakthrough',
    map: {
      cols: 8,
      rows: 8,
      mountains: [],
      playerStart: [{ col: 3 }, { col: 4 }],
      aiStart: [{ col: 2, unitTypeId: 'tank' }, { col: 4, unitTypeId: 'tank' }, { col: 5, unitTypeId: 'tank' }],
      controlPoints: ['3,1', '5,3'],
    },
    productionPointsPerTurn: 20,
  },
  {
    id: 'my-map-2',
    title: 'My Map',
    description: 'Description.',
    unitPackage: 'standard',
    gameMode: 'breakthrough',
    map: {
      cols: 8,
      rows: 14,
      mountains: ['0,7', '1,6', '2,6', '2,7', '4,2', '4,3', '5,10', '5,3', '6,2', '7,10'],
      playerStart: [{ col: 2, unitTypeId: 'tank' }, { col: 3, unitTypeId: 'tank' }, { col: 4, unitTypeId: 'tank' }, { col: 5, unitTypeId: 'tank' }, { col: 6, unitTypeId: 'tank' }],
      aiStart: [{ col: 2 }, { col: 3 }],
      controlPoints: ['1,7', '5,2', '6,10'],
    },
    productionPointsPerTurn: 20,
  },
  {
    id: 'first-contact',
    title: 'First Contact',
    description: 'Lead your infantry across a narrow front. Learn the basics — move, conquer, and push the enemy back to their lines.',
    unitPackage: 'us-ww2',
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
    unitPackage: 'us-ww2',
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
    unitPackage: 'us-ww2',
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
