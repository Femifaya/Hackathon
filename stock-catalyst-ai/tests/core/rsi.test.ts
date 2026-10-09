import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { rsi, rsiResult, rsiState, rsiDivergence, RSI_OVERBOUGHT, RSI_OVERSOLD } from '../../src/lib/indicators/rsi.ts';
import { closes, rampSeries } from './helpers.ts';

describe('rsi (Wilder)', () => {
  it('matches a hand-computed reference for period 3', () => {
    const values = rsi([10, 11, 12, 11, 13], 3);
    assert.deepEqual(values.slice(0, 3), [null, null, null]);
    assert.ok(Math.abs((values[3] as number) - 200 / 3) < 1e-9); // 66.6667
    assert.ok(Math.abs((values[4] as number) - 250 / 3) < 1e-9); // 83.3333
  });

  it('returns 100 for a strictly rising series (no losses in window)', () => {
    const values = rsi(closes(rampSeries(40, 100, 1)), 14);
    const finite = values.filter((value): value is number => value !== null);
    assert.ok(finite.length > 0);
    assert.ok(finite.every((value) => value === 100));
  });

  it('returns 0 for a strictly falling series', () => {
    const values = rsi(closes(rampSeries(40, 200, -1)), 14);
    const finite = values.filter((value): value is number => value !== null);
    assert.ok(finite.length > 0);
    assert.ok(finite.every((value) => value === 0));
  });

  it('returns 50 for a perfectly flat series (no gains, no losses)', () => {
    const values = rsi(new Array(30).fill(100), 14);
    const finite = values.filter((value): value is number => value !== null);
    assert.ok(finite.every((value) => value === 50));
  });

  it('never leaves the 0..100 range', () => {
    const values = rsi(closes(rampSeries(120, 100, 0.3)), 14);
    for (const value of values) {
      if (value === null) continue;
      assert.ok(value >= 0 && value <= 100, `out of range: ${value}`);
    }
  });

  it('produces nulls, not zeros, when history is too short', () => {
    const values = rsi([100, 101, 102], 14);
    assert.deepEqual(values, [null, null, null]);
    const result = rsiResult([100, 101, 102], 14);
    assert.equal(result.latest, null);
    assert.equal(result.latestIndex, null);
  });

  it('exposes the first value at index = period', () => {
    const result = rsiResult(closes(rampSeries(30, 100, 1)), 14);
    assert.equal(result.latestIndex, 29);
    assert.equal(result.latest, 100);
  });

  it('rejects an invalid period', () => {
    assert.throws(() => rsi([1, 2, 3], 0), RangeError);
  });

  it('maps thresholds to overbought/oversold/neutral', () => {
    assert.equal(rsiState(75), 'overbought');
    assert.equal(rsiState(RSI_OVERBOUGHT), 'overbought');
    assert.equal(rsiState(25), 'oversold');
    assert.equal(rsiState(RSI_OVERSOLD), 'oversold');
    assert.equal(rsiState(55), 'neutral');
    assert.equal(rsiState(null), 'insufficient_data');
  });

  it('detects bullish and bearish divergence', () => {
    const prices = [10, 9, 8, 7];
    const rising = [null, 40, 45, 50];
    assert.equal(rsiDivergence(prices, rising, 4), 'bullish');

    const upPrices = [7, 8, 9, 10];
    const falling = [null, 60, 55, 50];
    assert.equal(rsiDivergence(upPrices, falling, 4), 'bearish');

    assert.equal(rsiDivergence(upPrices, [null, 50, 55, 60], 4), 'none');
    assert.equal(rsiDivergence(upPrices, [null, null, null, 50], 4), 'insufficient_data');
  });
});