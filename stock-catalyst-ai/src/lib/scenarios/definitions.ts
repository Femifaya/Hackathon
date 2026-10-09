/**
 * Scenario definitions. Each one states its assumptions explicitly and derives its
 * effect with a disclosed formula. Nothing here is learned, fitted, or predicted.
 */

import type { ScenarioId } from './types.ts';

export interface ScenarioDefinition {
  id: ScenarioId;
  label: string;
  category: 'company' | 'market' | 'macro' | 'volatility';
  description: string;
  /** Assumed shock, in percent, applied before sensitivity multipliers. */
  assumedShockPercent: number;
  assumptions: string[];
  formula: string;
}

export const SCENARIO_DEFINITIONS: readonly ScenarioDefinition[] = [
  {
    id: 'earnings_miss',
    label: 'Earnings miss',
    category: 'company',
    description: 'Reported earnings come in below consensus at the next scheduled release.',
    assumedShockPercent: -8,
    assumptions: [
      'Reported EPS is 8% below consensus',
      'Guidance is unchanged',
      'The market reprices the miss within one to three sessions',
    ],
    formula: 'move = epsSurprise(-8%) x earningsPassThrough(1.5 if trailing P/E > 30 else 1.0), clipped to +/-4 x ATR%',
  },
  {
    id: 'guidance_reduction',
    label: 'Guidance reduction',
    category: 'company',
    description: 'Management lowers forward guidance even if the reported quarter is in line.',
    assumedShockPercent: -6,
    assumptions: [
      'Forward EPS guidance is reduced by 6%',
      'The valuation multiple contracts by 10% on lower forward earnings',
      'No offsetting buyback or product announcement',
    ],
    formula: 'move = guidanceShock(-6%) x 1.0 + multipleContraction(-10%) x 0.5, clipped to +/-5 x ATR%',
  },
  {
    id: 'broad_market_decline',
    label: 'Broad market decline',
    category: 'market',
    description: 'The broad US equity index falls sharply over a short period.',
    assumedShockPercent: -7,
    assumptions: ['Reference index falls 7%', 'The name keeps its retrieved beta', 'No idiosyncratic company news'],
    formula: 'move = indexShock(-7%) x beta(retrieved, default 1.0 when unavailable)',
  },
  {
    id: 'rate_increase',
    label: 'Interest rate increase',
    category: 'macro',
    description: 'Policy rates rise more than the market has priced, raising discount rates.',
    assumedShockPercent: -4,
    assumptions: [
      'The policy rate path is revised 50bp higher',
      'Higher-multiple names de-rate more than lower-multiple names',
      'Growth expectations are otherwise unchanged',
    ],
    formula: 'move = rateShock(-4%) x multipleSensitivity(1.5 if trailing P/E > 30, 1.2 if > 20, else 1.0)',
  },
  {
    id: 'volatility_spike',
    label: 'Volatility spike',
    category: 'volatility',
    description: 'Realised volatility expands without a change in the direction of the trend.',
    assumedShockPercent: 0,
    assumptions: ['Daily range expands to 2.5 x its current ATR%', 'Direction of travel is unchanged', 'Position sizing, not direction, is the affected decision'],
    formula: 'atrPercentAfter = ATR% x 2.5; move is reported as unavailable because the scenario is direction-neutral',
  },
  {
    id: 'sector_rotation',
    label: 'Sector rotation',
    category: 'market',
    description: 'Capital rotates out of this sector into another without a company-specific event.',
    assumedShockPercent: -5,
    assumptions: ['The sector falls 5% relative to the broad index', 'The name keeps its retrieved beta to the sector', 'Fundamentals are unchanged'],
    formula: 'move = sectorShock(-5%) x beta(retrieved, default 1.0 when unavailable)',
  },
  {
    id: 'company_specific_negative',
    label: 'Company specific negative event',
    category: 'company',
    description: 'An unmodelled negative event such as a regulatory action, key-person departure, or product setback.',
    assumedShockPercent: -12,
    assumptions: [
      'An unanticipated negative disclosure occurs',
      'The severity is assumed to be comparable to a large single-day gap',
      'Liquidity remains sufficient to exit at the assumed level',
    ],
    formula: 'move = eventShock(-12%), clipped to +/-6 x ATR% only when ATR% is available',
  },
];

export const SCENARIO_IDS: readonly ScenarioId[] = SCENARIO_DEFINITIONS.map((definition) => definition.id);

export function findDefinition(id: string): ScenarioDefinition | null {
  return SCENARIO_DEFINITIONS.find((definition) => definition.id === id) ?? null;
}

export function isScenarioId(value: unknown): value is ScenarioId {
  return typeof value === 'string' && (SCENARIO_IDS as readonly string[]).includes(value);
}