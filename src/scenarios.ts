import type { ScenarioDef } from './types';
import trainingIcon from '../public/icons/scenarios/training.svg';
import usWw2Icon from '../public/icons/scenarios/us-ww2.svg';
import trainingImg from '../public/images/scenarios/training.png';
import usww2Img from '../public/images/scenarios/us-ww2.png';

export const SCENARIOS: ScenarioDef[] = [
  {
    id: 'tutorial',
    icon: trainingIcon,
    title: 'BASIC TRAINING',
    image: trainingImg,
    miniTitle: 'TUTORIAL',
    description: 'Learn the fundamentals of hex-grid combat. Master infantry movement, tank breakthroughs, and artillery fire before heading to the front.',
  },
  {
    id: 'ww2',
    icon: usWw2Icon,
    title: 'OUR SOLDIERS FRONTIER',
    image: usww2Img,
    miniTitle: 'SECOND WORLD WAR',
    description: 'The largest conflict in human history. Command Allied or Axis forces across a series of tactical engagements on the Western and Eastern fronts.',
  },
];

export function getScenarioById(id: string): ScenarioDef | undefined {
  return SCENARIOS.find(s => s.id === id);
}
