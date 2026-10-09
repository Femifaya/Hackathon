/**
 * Scenario engine.
 *
 * Deterministic and transparent: the same inputs and the same scenario always
 * produce the same numbers, and every number carries a `howDerived` string. When an
 * input is missing the effect is reported as unavailable - it is never imputed.
 */

import type { ScenarioAssumption, ScenarioEffect, ScenarioId, ScenarioInputs, ScenarioResult } from './types.ts';
import { SCENARIO_DISCLOSURE } from './types.ts';
import { SCENARIO_DEFINITIONS, findDefinition } from './definitions.ts';
import { round } from '../utils/format.ts';

export const DEFAULT_BETA = 1;
const HIGH_MULTIPLE_PE = 30;
const MID_MULTIPLE_PE = 20;

export interface ScenarioRequest {
  inputs: ScenarioInputs;
  /** Optional user override of the assumed shock, in percent. */
  overrideShockPercent?: number | null;
}

function multipleSensitivity(peTrailing: number | null): { factor: number; note: string } {
  if (peTrailing === null) return { factor: 1, note: 'trailing P/E unavailable, so a neutral sensitivity of 1.0 is used' };
  if (peTrailing > HIGH_MULTIPLE_PE) return { factor: 1.5, note: `trailing P/E ${round(peTrailing, 1)} is above ${HIGH_MULTIPLE_PE}, so a 1.5x sensitivity is applied` };
  if (peTrailing > MID_MULTIPLE_PE) return { factor: 1.2, note: `trailing P/E ${round(peTrailing, 1)} is above ${MID_MULTIPLE_PE}, so a 1.2x sensitivity is applied` };
  return { factor: 1, note: `trailing P/E ${round(peTrailing, 1)} is at or below ${MID_MULTIPLE_PE}, so a 1.0x sensitivity is applied` };
}

function clipToAtr(move: number, atrPercent: number | null, multiple: number): { value: number; clipped: boolean } {
  if (atrPercent === null || atrPercent <= 0) return { value: move, clipped: false };
  const limit = atrPercent * multiple;
  if (Math.abs(move) <= limit) return { value: move, clipped: false };
  return { value: Math.sign(move) * limit, clipped: true };
}

function assumptionsFor(id: ScenarioId, inputs: ScenarioInputs, definitionShock: number, overrideShock: number | null): ScenarioAssumption[] {
  const base = findDefinition(id);
  const list: ScenarioAssumption[] = (base?.assumptions ?? []).map((label) => ({
    label,
    value: label,
    source: 'scenario_default' as const,
  }));

  if (overrideShock !== null) {
    list.push({
      label: `Assumed shock overridden to ${overrideShock}% (default ${definitionShock}%)`,
      value: `${overrideShock}%`,
      source: 'user',
    });
  }
  list.push({
    label: `Beta used: ${inputs.beta === null ? `${DEFAULT_BETA} (default, retrieved beta unavailable)` : round(inputs.beta, 2)}`,
    value: String(inputs.beta ?? DEFAULT_BETA),
    source: inputs.beta === null ? 'scenario_default' : 'derived_from_data',
  });
  list.push({
    label: `ATR(14) used: ${inputs.atrPercent === null ? 'unavailable' : `${round(inputs.atrPercent, 2)}% of price`}`,
    value: inputs.atrPercent === null ? 'unavailable' : `${round(inputs.atrPercent, 2)}%`,
    source: inputs.atrPercent === null ? 'scenario_default' : 'derived_from_data',
  });
  return list;
}

export function runScenario(id: ScenarioId, request: ScenarioRequest): ScenarioResult {
  const definition = findDefinition(id);
  const { inputs } = request;
  const overrideShock = request.overrideShockPercent ?? null;

  if (definition === null) {
    return {
      id,
      label: 'Unknown scenario',
      category: 'company',
      description: 'This scenario id is not supported.',
      assumptions: [],
      effects: [],
      estimatedMovePercent: null,
      estimatedPriceLow: null,
      estimatedPriceHigh: null,
      breachesNearestSupport: null,
      missingInputs: ['scenario definition'],
      disclosure: SCENARIO_DISCLOSURE,
      formula: 'n/a',
    };
  }

  const shock = overrideShock ?? definition.assumedShockPercent;
  const effects: ScenarioEffect[] = [];
  const missing = [...inputs.missingInputs];
  let move: number | null = null;
  let howDerived = definition.formula;

  const beta = inputs.beta ?? DEFAULT_BETA;
  if (inputs.beta === null && !missing.includes('beta')) missing.push('beta');
  if (inputs.atrPercent === null && !missing.includes('atrPercent')) missing.push('atrPercent');
  if (inputs.lastClose === null && !missing.includes('lastClose')) missing.push('lastClose');

  switch (id) {
    case 'earnings_miss': {
      const sensitivity = multipleSensitivity(inputs.peTrailing);
      const raw = shock * sensitivity.factor;
      const clipped = clipToAtr(raw, inputs.atrPercent, 4);
      move = round(clipped.value, 2);
      howDerived = `${definition.formula}; ${sensitivity.note}${clipped.clipped ? '; clipped to 4 x ATR% because the raw estimate exceeded the observed daily range' : ''}`;
      effects.push({
        metric: 'Estimated single-event price move',
        value: move,
        unit: 'percent',
        direction: move < 0 ? 'negative' : move > 0 ? 'positive' : 'neutral',
        howDerived,
      });
      break;
    }
    case 'guidance_reduction': {
      const guidancePart = shock;
      const multiplePart = -10 * 0.5;
      const raw = guidancePart + multiplePart;
      const clipped = clipToAtr(raw, inputs.atrPercent, 5);
      move = round(clipped.value, 2);
      howDerived = `${definition.formula}; guidance component ${round(guidancePart, 2)}% plus multiple component ${round(multiplePart, 2)}%${clipped.clipped ? '; clipped to 5 x ATR%' : ''}`;
      effects.push({
        metric: 'Estimated combined price move',
        value: move,
        unit: 'percent',
        direction: move < 0 ? 'negative' : move > 0 ? 'positive' : 'neutral',
        howDerived,
      });
      effects.push({
        metric: 'Assumed forward multiple change',
        value: -10,
        unit: 'percent',
        direction: 'negative',
        howDerived: 'scenario default assumption, not derived from retrieved data',
      });
      break;
    }
    case 'broad_market_decline':
    case 'sector_rotation': {
      move = round(shock * beta, 2);
      howDerived = `${definition.formula}; shock ${shock}% x beta ${round(beta, 2)}`;
      effects.push({
        metric: id === 'broad_market_decline' ? 'Estimated move from an index shock' : 'Estimated move from a sector shock',
        value: move,
        unit: 'percent',
        direction: move < 0 ? 'negative' : move > 0 ? 'positive' : 'neutral',
        howDerived,
      });
      break;
    }
    case 'rate_increase': {
      const sensitivity = multipleSensitivity(inputs.peTrailing);
      move = round(shock * sensitivity.factor, 2);
      howDerived = `${definition.formula}; ${sensitivity.note}`;
      effects.push({ metric: 'Estimated move from a rate shock', value: move, unit: 'percent', direction: move < 0 ? 'negative' : move > 0 ? 'positive' : 'neutral', howDerived });
      break;
    }
    case 'volatility_spike': {
      move = null;
      howDerived = definition.formula;
      effects.push({
        metric: 'ATR(14) after the spike',
        value: inputs.atrPercent === null ? null : round(inputs.atrPercent * 2.5, 2),
        unit: 'percent',
        direction: inputs.atrPercent === null ? 'neutral' : 'negative',
        howDerived: inputs.atrPercent === null ? 'ATR% unavailable, so no value is estimated' : 'current ATR% x 2.5 (scenario assumption)',
      });
      effects.push({
        metric: 'Suggested risk-per-trade adjustment',
        value: null,
        unit: 'label',
        direction: 'negative',
        howDerived: 'Position size, not direction, is the affected decision: a wider ATR means the same dollar risk requires fewer shares',
      });
      if (inputs.atrPercent === null) missing.push('atrPercent (already listed)');
      break;
    }
    case 'company_specific_negative': {
      const clipped = clipToAtr(shock, inputs.atrPercent, 6);
      move = round(clipped.value, 2);
      howDerived = `${definition.formula}${clipped.clipped ? '; clipped to 6 x ATR%' : ''}`;
      effects.push({
        metric: 'Estimated gap move',
        value: move,
        unit: 'percent',
        direction: move < 0 ? 'negative' : move > 0 ? 'positive' : 'neutral',
        howDerived,
      });
      break;
    }
  }

  const low = inputs.lastClose === null || move === null ? null : round(inputs.lastClose * (1 + move / 100), 2);
  const band = inputs.atrPercent === null || inputs.lastClose === null ? null : round(inputs.lastClose * (inputs.atrPercent / 100), 2);
  const high = low === null || band === null ? null : round(low + band, 2);
  const lowBound = low === null || band === null ? null : round(low - band, 2);

  let breaches: boolean | null = null;
  if (move !== null && inputs.distanceToSupportPercent !== null) {
    breaches = move <= inputs.distanceToSupportPercent;
    effects.push({
      metric: 'Would the assumed move reach the nearest support cluster',
      value: breaches ? 1 : 0,
      unit: 'count',
      direction: breaches ? 'negative' : 'neutral',
      howDerived: `assumed move ${move}% compared with the distance to the nearest support cluster ${round(inputs.distanceToSupportPercent, 2)}%`,
    });
  } else {
    effects.push({
      metric: 'Would the assumed move reach the nearest support cluster',
      value: null,
      unit: 'count',
      direction: 'neutral',
      howDerived: 'nearest support distance unavailable, so no comparison is made',
    });
  }

  return {
    id,
    label: definition.label,
    category: definition.category,
    description: definition.description,
    assumptions: assumptionsFor(id, inputs, definition.assumedShockPercent, overrideShock),
    effects,
    estimatedMovePercent: move,
    estimatedPriceLow: lowBound,
    estimatedPriceHigh: high,
    breachesNearestSupport: breaches,
    missingInputs: [...new Set(missing)],
    disclosure: SCENARIO_DISCLOSURE,
    formula: howDerived,
  };
}

export function runAllScenarios(request: ScenarioRequest): ScenarioResult[] {
  return SCENARIO_DEFINITIONS.map((definition) => runScenario(definition.id, request));
}

/** Inputs derived from an indicator snapshot plus optional fundamentals. */
export function buildScenarioInputs(params: {
  symbol: string;
  lastClose: number | null;
  atrPercent: number | null;
  rsi: number | null;
  trendDirection: 'up' | 'down' | 'sideways' | null;
  distanceToSupportPercent: number | null;
  distanceToResistancePercent: number | null;
  beta: number | null;
  peTrailing: number | null;
  peForward: number | null;
  revenueGrowthYoY: number | null;
  nextEarningsDate: string | null;
}): ScenarioInputs {
  const missing: string[] = [];
  const track = (label: string, value: unknown) => {
    if (value === null || value === undefined) missing.push(label);
  };
  track('lastClose', params.lastClose);
  track('atrPercent', params.atrPercent);
  track('beta', params.beta);
  track('peTrailing', params.peTrailing);
  track('peForward', params.peForward);
  track('revenueGrowthYoY', params.revenueGrowthYoY);
  track('nextEarningsDate', params.nextEarningsDate);
  track('distanceToSupportPercent', params.distanceToSupportPercent);
  track('distanceToResistancePercent', params.distanceToResistancePercent);

  return { ...params, missingInputs: missing };
}