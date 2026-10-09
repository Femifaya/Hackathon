import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildScenarioInputs, runAllScenarios, runScenario } from '../../src/lib/scenarios/engine.ts';
import { SCENARIO_DEFINITIONS, SCENARIO_IDS, findDefinition, isScenarioId } from '../../src/lib/scenarios/definitions.ts';
import { SCENARIO_DISCLOSURE } from '../../src/lib/scenarios/types.ts';
import type { ScenarioInputs } from '../../src/lib/scenarios/types.ts';

function inputs(overrides: Partial<ScenarioInputs> = {}): ScenarioInputs {
  return buildScenarioInputs({
    symbol: 'NVDA',
    lastClose: 150,
    atrPercent: 2.5,
    rsi: 58,
    trendDirection: 'up',
    distanceToSupportPercent: -5,
    distanceToResistancePercent: 6,
    beta: 1.4,
    peTrailing: 42,
    peForward: 33,
    revenueGrowthYoY: 18,
    nextEarningsDate: '2026-11-04T21:00:00.000Z',
    ...overrides,
  });
}

describe('scenario definitions', () => {
  it('exposes the seven required scenarios', () => {
    assert.deepEqual([...SCENARIO_IDS], [
      'earnings_miss',
      'guidance_reduction',
      'broad_market_decline',
      'rate_increase',
      'volatility_spike',
      'sector_rotation',
      'company_specific_negative',
    ]);
    assert.equal(SCENARIO_DEFINITIONS.length, 7);
  });

  it('documents assumptions and a formula for every scenario', () => {
    for (const definition of SCENARIO_DEFINITIONS) {
      assert.ok(definition.assumptions.length >= 2, `${definition.id} needs assumptions`);
      assert.ok(definition.formula.length > 10, `${definition.id} needs a disclosed formula`);
      assert.equal(isScenarioId(definition.id), true);
      assert.equal(findDefinition(definition.id)?.id, definition.id);
    }
    assert.equal(findDefinition('not_a_scenario'), null);
    assert.equal(isScenarioId('drop table'), false);
  });
});

describe('scenario engine math', () => {
  it('applies a higher earnings sensitivity to a high multiple name', () => {
    const result = runScenario('earnings_miss', { inputs: inputs({ atrPercent: 10 }) });
    assert.equal(result.estimatedMovePercent, -12); // -8 x 1.5
    assert.match(result.formula, /1.5x sensitivity/);
  });

  it('uses a neutral sensitivity when the multiple is modest', () => {
    const result = runScenario('earnings_miss', { inputs: inputs({ peTrailing: 15, atrPercent: 10 }) });
    assert.equal(result.estimatedMovePercent, -8);
  });

  it('clips an outsized estimate to the observed daily range', () => {
    const result = runScenario('earnings_miss', { inputs: inputs({ atrPercent: 1 }) });
    assert.equal(result.estimatedMovePercent, -4); // clipped to 4 x ATR%
    assert.match(result.formula, /clipped to 4 x ATR%/);
  });

  it('combines the guidance and multiple components', () => {
    const result = runScenario('guidance_reduction', { inputs: inputs({ atrPercent: 10 }) });
    assert.equal(result.estimatedMovePercent, -11); // -6 + (-10 x 0.5)
    assert.ok(result.effects.some((effect) => effect.metric === 'Assumed forward multiple change' && effect.value === -10));
  });

  it('scales market and sector shocks by beta', () => {
    assert.equal(runScenario('broad_market_decline', { inputs: inputs() }).estimatedMovePercent, -9.8); // -7 x 1.4
    assert.equal(runScenario('sector_rotation', { inputs: inputs() }).estimatedMovePercent, -7); // -5 x 1.4
    assert.equal(runScenario('broad_market_decline', { inputs: inputs({ beta: null }) }).estimatedMovePercent, -7);
  });

  it('records a default beta as an assumption and as a missing input', () => {
    const result = runScenario('broad_market_decline', { inputs: inputs({ beta: null }) });
    assert.ok(result.missingInputs.includes('beta'));
    assert.ok(result.assumptions.some((assumption) => assumption.label.includes('default') && assumption.source === 'scenario_default'));
  });

  it('scales a rate shock by valuation sensitivity', () => {
    assert.equal(runScenario('rate_increase', { inputs: inputs({ peTrailing: 42 }) }).estimatedMovePercent, -6);
    assert.equal(runScenario('rate_increase', { inputs: inputs({ peTrailing: 25 }) }).estimatedMovePercent, -4.8);
    assert.equal(runScenario('rate_increase', { inputs: inputs({ peTrailing: 12 }) }).estimatedMovePercent, -4);
  });

  it('reports a volatility spike as direction-neutral with no move estimate', () => {
    const result = runScenario('volatility_spike', { inputs: inputs({ atrPercent: 2 }) });
    assert.equal(result.estimatedMovePercent, null);
    assert.equal(result.estimatedPriceLow, null);
    const atrEffect = result.effects.find((effect) => effect.metric === 'ATR(14) after the spike');
    assert.equal(atrEffect?.value, 5); // 2 x 2.5
  });

  it('never estimates a value when the input is unavailable', () => {
    const result = runScenario('volatility_spike', { inputs: inputs({ atrPercent: null }) });
    const atrEffect = result.effects.find((effect) => effect.metric === 'ATR(14) after the spike');
    assert.equal(atrEffect?.value, null);
    assert.match(atrEffect?.howDerived ?? '', /unavailable/);
    assert.ok(result.missingInputs.includes('atrPercent'));
  });

  it('clips a company specific event to six daily ranges', () => {
    assert.equal(runScenario('company_specific_negative', { inputs: inputs({ atrPercent: 1 }) }).estimatedMovePercent, -6);
    assert.equal(runScenario('company_specific_negative', { inputs: inputs({ atrPercent: 5 }) }).estimatedMovePercent, -12);
  });

  it('derives a price band from the last close and ATR', () => {
    const result = runScenario('broad_market_decline', { inputs: inputs({ lastClose: 100, atrPercent: 3 }) });
    assert.equal(result.estimatedMovePercent, -9.8);
    // Move to 90.2, then +/- one ATR (3.0) band.
    assert.equal(result.estimatedPriceLow, 87.2);
    assert.equal(result.estimatedPriceHigh, 93.2);
  });

  it('reports no price band when the last close is unavailable', () => {
    const result = runScenario('broad_market_decline', { inputs: inputs({ lastClose: null }) });
    assert.equal(result.estimatedPriceLow, null);
    assert.equal(result.estimatedPriceHigh, null);
    assert.ok(result.missingInputs.includes('lastClose'));
    assert.equal(result.estimatedMovePercent, -9.8);
  });

  it('detects when the assumed move reaches the nearest support', () => {
    const breached = runScenario('broad_market_decline', { inputs: inputs({ distanceToSupportPercent: -5 }) });
    assert.equal(breached.breachesNearestSupport, true);
    const held = runScenario('broad_market_decline', { inputs: inputs({ distanceToSupportPercent: -20 }) });
    assert.equal(held.breachesNearestSupport, false);
    const unknown = runScenario('broad_market_decline', { inputs: inputs({ distanceToSupportPercent: null }) });
    assert.equal(unknown.breachesNearestSupport, null);
  });

  it('accepts a user override of the assumed shock and labels it as user supplied', () => {
    const result = runScenario('broad_market_decline', { inputs: inputs({ beta: 1 }), overrideShockPercent: -15 });
    assert.equal(result.estimatedMovePercent, -15);
    const userAssumption = result.assumptions.find((assumption) => assumption.source === 'user');
    assert.match(userAssumption?.label ?? '', /overridden to -15%/);
  });

  it('handles an unknown scenario id without throwing', () => {
    const result = runScenario('alien_invasion' as never, { inputs: inputs() });
    assert.equal(result.label, 'Unknown scenario');
    assert.equal(result.estimatedMovePercent, null);
    assert.deepEqual(result.missingInputs, ['scenario definition']);
  });

  it('is deterministic for identical inputs', () => {
    const a = runAllScenarios({ inputs: inputs() });
    const b = runAllScenarios({ inputs: inputs() });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
});

describe('scenario guardrails', () => {
  const results = runAllScenarios({ inputs: inputs() });

  it('runs every defined scenario', () => {
    assert.equal(results.length, 7);
    assert.deepEqual(results.map((result) => result.id), [...SCENARIO_IDS]);
  });

  it('attaches the not-a-prediction disclosure to every result', () => {
    for (const result of results) {
      assert.equal(result.disclosure, SCENARIO_DISCLOSURE);
      assert.match(result.disclosure, /not predictions or forecasts/);
    }
  });

  it('explains how every effect was derived', () => {
    for (const result of results) {
      assert.ok(result.effects.length >= 1);
      for (const effect of result.effects) {
        assert.ok(effect.howDerived.length > 10, `${result.id}: missing derivation`);
        assert.ok(['percent', 'price', 'multiple', 'count', 'label'].includes(effect.unit));
      }
    }
  });

  it('lists assumptions with their origin', () => {
    for (const result of results) {
      assert.ok(result.assumptions.length >= 2);
      for (const assumption of result.assumptions) {
        assert.ok(['user', 'scenario_default', 'derived_from_data'].includes(assumption.source));
      }
    }
  });
});