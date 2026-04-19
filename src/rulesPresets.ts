import { DEFAULT_TERRITORY_ECONOMY } from './gameconfig';
import type { GameConfig } from './types';

/** Select value for manual economy / combat / healing tuning. */
export const RULES_PRESET_CUSTOM = 'custom' as const;

export type RulesPresetValues = Pick<
  GameConfig,
  | 'mountainPct'
  | 'enableRivers'
  | 'riverMaxLengthBoardWidthMult'
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
  'Terrain, economy, combat, healing, and Breakthrough balance use the values in the sections below.';

const FLANKING_EPS = 1e-5;
const FRAC_EPS = 1e-5;

function rulesValuesMatchConfig(cfg: GameConfig, p: RulesPresetValues): boolean {
  return (
    Math.abs(cfg.mountainPct - p.mountainPct) < FRAC_EPS &&
    cfg.enableRivers === p.enableRivers &&
    Math.abs(cfg.riverMaxLengthBoardWidthMult - p.riverMaxLengthBoardWidthMult) < FRAC_EPS &&
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
      'Default pacing: moderate mountains and rivers, baseline income and territory bonuses, standard flanking and healing. Artillery is not limited by adjacency. Breakthrough uses default attacker PP, sector capture bonus, and defender malus in captured sectors.',
    mountainPct: 0.12,
    enableRivers: true,
    riverMaxLengthBoardWidthMult: 1.5,
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
    healOwnTerritory: 2,
    conquestPointsPlayer: 40,
    conquestPointsAi: 40,
    breakthroughAttackerStartingPP: 120,
    breakthroughEnemySectorStrengthMult: 0.5,
    breakthroughSectorCaptureBonusPP: 120,
  },
  {
    id: 'high_tempo',
    label: 'High tempo',
    description:
      'Faster rounds: lighter terrain, higher production and territory payouts, quicker production hexes, stronger flanks, and limit artillery until adjacent threats are cleared. Slower healing. Breakthrough: more attacker PP, slightly harsher defender malus, and a larger per-sector PP bonus.',
    mountainPct: 0.08,
    enableRivers: true,
    riverMaxLengthBoardWidthMult: 1.2,
    productionPointsPerTurn: 28,
    productionPointsPerTurnAi: 28,
    territoryQuota: 6,
    pointsPerQuota: 4,
    productionTurns: 1,
    productionSafeDistance: 2,
    flankingBonus: 0.2,
    maxFlankingUnits: 3,
    zoneOfControl: true,
    limitArtillery: true,
    healOwnTerritory: 1,
    conquestPointsPlayer: 40,
    conquestPointsAi: 40,
    breakthroughAttackerStartingPP: 150,
    breakthroughEnemySectorStrengthMult: 0.45,
    breakthroughSectorCaptureBonusPP: 140,
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
