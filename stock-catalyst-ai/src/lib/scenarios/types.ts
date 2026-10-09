/** Types for the assumption-driven scenario engine. */

export type ScenarioId =
  | 'earnings_miss'
  | 'guidance_reduction'
  | 'broad_market_decline'
  | 'rate_increase'
  | 'volatility_spike'
  | 'sector_rotation'
  | 'company_specific_negative';

export type EffectDirection = 'positive' | 'negative' | 'neutral';

export interface ScenarioInputs {
  symbol: string;
  lastClose: number | null;
  atrPercent: number | null;
  beta: number | null;
  peTrailing: number | null;
  peForward: number | null;
  revenueGrowthYoY: number | null;
  nextEarningsDate: string | null;
  distanceToSupportPercent: number | null;
  distanceToResistancePercent: number | null;
  rsi: number | null;
  trendDirection: 'up' | 'down' | 'sideways' | null;
  /** Data gaps are disclosed in the result instead of being filled with guesses. */
  missingInputs: string[];
}

export interface ScenarioAssumption {
  label: string;
  value: string;
  source: 'user' | 'scenario_default' | 'derived_from_data';
}

export interface ScenarioEffect {
  metric: string;
  value: number | null;
  unit: 'percent' | 'price' | 'multiple' | 'count' | 'label';
  direction: EffectDirection;
  howDerived: string;
}

export interface ScenarioResult {
  id: ScenarioId;
  label: string;
  category: string;
  description: string;
  assumptions: ScenarioAssumption[];
  effects: ScenarioEffect[];
  estimatedMovePercent: number | null;
  estimatedPriceLow: number | null;
  estimatedPriceHigh: number | null;
  breachesNearestSupport: boolean | null;
  missingInputs: string[];
  /** Always present: scenario output is an illustration, not a forecast. */
  disclosure: string;
  formula: string;
}

export const SCENARIO_DISCLOSURE =
  'Scenario results are assumption-driven illustrations of sensitivity, not predictions or forecasts. Every number below is derived from the stated assumptions applied to retrieved data; if an input was unavailable the effect is reported as unavailable rather than estimated.';