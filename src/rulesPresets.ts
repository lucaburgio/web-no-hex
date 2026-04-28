import { DEFAULT_TERRITORY_ECONOMY } from './gameconfig';
import type { GameConfig } from './types';

/** Select value for manual economy / combat / healing tuning. */
export const RULES_PRESET_CUSTOM = 'custom' as const;

export type RulesPresetValues = Pick<
  GameConfig,
  | 'productionPointsPerTurn'
  | 'productionPointsPerTurnAi'
  | 'territoryQuota'
  | 'pointsPerQuota'
  | 'productionTurns'
  | 'productionSafeDistance'
  | 'flankingBonus'
  | 'maxFlankingUnits'
  | 'zoneOfControl'
  | 'limitArtillery'
  | 'fogOfWar'
  | 'healOwnTerritory'
  | 'conquestPointsPlayer'
  | 'conquestPointsAi'
  | 'breakthroughAttackerStartingPP'
  | 'breakthroughEnemySectorStrengthMult'
  | 'breakthroughSectorCaptureBonusPP'
>;

export type RulesPreset = { id: string; label: string; description: string } & RulesPresetValues;

/** Shown under the Rules select when [Custom] is active. */
export const RULES_PRESET_CUSTOM_DESCRIPTION =
  'Set custom rules for your game.';

const FLANKING_EPS = 1e-5;
const FRAC_EPS = 1e-5;

function rulesValuesMatchConfig(cfg: GameConfig, p: RulesPresetValues): boolean {
  return (
    cfg.productionPointsPerTurn === p.productionPointsPerTurn &&
    cfg.productionPointsPerTurnAi === p.productionPointsPerTurnAi &&
    cfg.territoryQuota === p.territoryQuota &&
    cfg.pointsPerQuota === p.pointsPerQuota &&
    cfg.productionTurns === p.productionTurns &&
    cfg.productionSafeDistance === p.productionSafeDistance &&
    Math.abs(cfg.flankingBonus - p.flankingBonus) < FLANKING_EPS &&
    cfg.maxFlankingUnits === p.maxFlankingUnits &&
    cfg.zoneOfControl === p.zoneOfControl &&
    cfg.limitArtillery === p.limitArtillery &&
    cfg.fogOfWar === p.fogOfWar &&
    cfg.healOwnTerritory === p.healOwnTerritory &&
    cfg.conquestPointsPlayer === p.conquestPointsPlayer &&
    cfg.conquestPointsAi === p.conquestPointsAi &&
    cfg.breakthroughAttackerStartingPP === p.breakthroughAttackerStartingPP &&
    Math.abs(cfg.breakthroughEnemySectorStrengthMult - p.breakthroughEnemySectorStrengthMult) < FRAC_EPS &&
    cfg.breakthroughSectorCaptureBonusPP === p.breakthroughSectorCaptureBonusPP
  );
}

export const RULES_PRESETS: RulesPreset[] = [
  {
    id: 'standard',
    label: 'Standard',
    description:
      'The standard ruleset of the game. A good earning base for Production points, but earnings by territory are limited. Battles are challenging till the end.',
    productionPointsPerTurn: 20,
    productionPointsPerTurnAi: 20,
    territoryQuota: DEFAULT_TERRITORY_ECONOMY.territoryQuota,
    pointsPerQuota: DEFAULT_TERRITORY_ECONOMY.pointsPerQuota,
    productionTurns: 2,
    productionSafeDistance: 2,
    flankingBonus: 0.15,
    maxFlankingUnits: 2,
    zoneOfControl: true,
    limitArtillery: false,
    fogOfWar: false,
    healOwnTerritory: 2,
    conquestPointsPlayer: 40,
    conquestPointsAi: 40,
    breakthroughAttackerStartingPP: 120,
    breakthroughEnemySectorStrengthMult: 0.5,
    breakthroughSectorCaptureBonusPP: 120,
  },
  {
    id: 'blitz',
    label: 'Blitz',
    description:
      'Low earning base, but each hex contributes to the production points earnings. Owning territory is crucial and even a small progress through enemy lines could quickly end the battle.',
    productionPointsPerTurn: 6,
    productionPointsPerTurnAi: 6,
    territoryQuota: 1,
    pointsPerQuota: 1,
    productionTurns: 2,
    productionSafeDistance: 2,
    flankingBonus: 0.15,
    maxFlankingUnits: 2,
    zoneOfControl: true,
    limitArtillery: false,
    fogOfWar: false,
    healOwnTerritory: 2,
    conquestPointsPlayer: 40,
    conquestPointsAi: 40,
    breakthroughAttackerStartingPP: 40,
    breakthroughEnemySectorStrengthMult: 0.5,
    breakthroughSectorCaptureBonusPP: 40,
  },
];

export function getRulesPresetById(id: string): RulesPreset | undefined {
  return RULES_PRESETS.find(p => p.id === id);
}

export function getRulesPresetDescriptionForSelectValue(id: string): string {
  if (id === RULES_PRESET_CUSTOM) return RULES_PRESET_CUSTOM_DESCRIPTION;
  return getRulesPresetById(id)?.description ?? '';
}

export function findMatchingRulesPresetId(cfg: GameConfig): string | typeof RULES_PRESET_CUSTOM {
  for (const p of RULES_PRESETS) {
    if (rulesValuesMatchConfig(cfg, p)) return p.id;
  }
  return RULES_PRESET_CUSTOM;
}
