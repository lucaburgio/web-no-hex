import type { ScenarioDef } from './types';
import trainingIcon from '../public/icons/scenarios/training.svg';
import usWw2Icon from '../public/icons/scenarios/us-ww2.svg';
import deWw2Icon from '../public/icons/scenarios/de-ww2.svg';
import ruWw2Icon from '../public/icons/scenarios/ru-ww2.svg';
import usvietnamIcon from '../public/icons/scenarios/us-vietnam.svg';
import trainingImg from '../public/images/scenarios/training.png';
import usww2Img from '../public/images/scenarios/us-ww2.png';
import ruww2Img from '../public/images/scenarios/ru-ww2.png';
import deww2Img from '../public/images/scenarios/de-ww2.png';
import usvietImg from '../public/images/scenarios/us-vietnam.png';

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
    id: 'ww2us',
    icon: usWw2Icon,
    title: 'OUR SOLDIERS FRONTIER',
    image: usww2Img,
    miniTitle: 'SECOND WORLD WAR - United States',
    description: 'The largest conflict in human history. Command Allied forces across a series of tactical engagements on the Western and Eastern fronts.',
  },
  {
    id: 'ww2de',
    icon: deWw2Icon,
    title: 'THE BLITZ DOCTRINE',
    image: deww2Img,
    miniTitle: 'SECOND WORLD WAR - Germany',
    description: 'The largest conflict in human history. Command Axis forces across a series of tactical engagements on the Western and Eastern fronts.',
  },
  {
    id: 'ww2ru',
    icon: ruWw2Icon,
    title: 'WINTER STORM',
    image: ruww2Img,
    miniTitle: 'SECOND WORLD WAR - URSS',
    description: 'The largest conflict in human history. Command Russian forces across a series of tactical engagements on the Eastern front.',
  }
];

export function getScenarioById(id: string): ScenarioDef | undefined {
  return SCENARIOS.find(s => s.id === id);
}
