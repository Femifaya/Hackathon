import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { atr, atrPercent, atrResult, trueRange, volatilityRegime } from '../../src/lib/indicators/atr.ts';
import { bollinger } from '../../src/lib/indicators/bollinger.ts';
import { candle } from './helpers.ts';
import type { Candle } from '../../src/lib/market/types.ts';

const gapCandles: Candle[] = [
  candle(0, 10, { high: 11, low: 9 }),
  candle(1, 11, { high: 12, low: 10 }),
  candle(2, 14, { high: 15, low: 11 }),
  candle(3, 13, { high: 14.5, low: 12 }),
];

describe('true range and ATR', () => {
  it('uses high-low for the first bar and gap-aware ranges afterwards', () => {
    const ranges = trueRange(gapCandles);
    assert.deepEqual(ranges, [2, 2, 4, 2.5]);
  });

  it('seeds with a simple average then applies Wilder smoothing', () => {
    const values = atr(gapCandles, 3);
    assert.deepEqual(values.slice(0, 2), [null, null]);
    assert.ok(Math.abs((values[2] as number) - 8 / 3) < 1e-9);
    assert.ok(Math.abs((values[3] as number) - 47 / 18) < 1e-9);
  });

  it('returns nulls when history is shorter than the period', () => {
    assert.deepEqual(atr(gapCandles, 14), [null, null, null, null]);
    assert.equal(atrResult(gapCandles, 14).latest, null);
  });

  it('rejects an invalid period', () => {
    assert.throws(() => atr(gapCandles, 0), RangeError);
  });

  it('expresses ATR as a percentage of the close', () => {
    const value = atrPercent(gapCandles, 3);
    assert.ok(value !== null);
    // ATR 47/18 = 2.6111 on a close of 13 -> 20.09%
    assert.ok(Math.abs((value as number) - (47 / 18 / 13) * 100) < 1e-9);
  });

  it('classifies volatility regimes with documented bands', () => {
    assert.equal(volatilityRegime(1.0), 'low');
    assert.equal(volatilityRegime(2.0), 'normal');
    assert.equal(volatilityRegime(4.0), 'elevated');
    assert.equal(volatilityRegime(7.0), 'high');
    assert.equal(volatilityRegime(null), 'insufficient_data');
  });
});

describe('bollinger bands', () => {
  it('matches a hand-computed reference for period 5, multiplier 2', () => {
    const result = bollinger([1, 2, 3, 4, 5], { period: 5, multiplier: 2 });
    assert.equal(result.latest.middle, 3);
    assert.ok(Math.abs((result.latest.upper as number) - (3 + 2 * Math.SQRT2)) < 1e-9);
    assert.ok(Math.abs((result.latest.lower as number) - (3 - 2 * Math.SQRT2)) < 1e-9);
    assert.ok(Math.abs((result.latest.bandwidth as number) - (4 * Math.SQRT2) / 3) < 1e-9);
    assert.ok(Math.abs((result.latest.percentB as number) - (5 - (3 - 2 * Math.SQRT2)) / (4 * Math.SQRT2)) < 1e-9);
    assert.equal(result.latest.position, 'upper_half');
  });

  it('collapses the bands to zero width on a flat series', () => {
    const result = bollinger(new Array(25).fill(50), { period: 20, multiplier: 2 });
    assert.equal(result.latest.upper, 50);
    assert.equal(result.latest.lower, 50);
    assert.equal(result.latest.bandwidth, 0);
    assert.equal(result.latest.percentB, null);
    assert.equal(result.latest.position, 'upper_half');
  });

  it('flags a close beyond the upper band', () => {
    const values = new Array(24).fill(100);
    values.push(140);
    const result = bollinger(values, { period: 20, multiplier: 2 });
    assert.equal(result.latest.position, 'above_upper');
  });

  it('flags a close beyond the lower band', () => {
    const values = new Array(24).fill(100);
    values.push(60);
    const result = bollinger(values, { period: 20, multiplier: 2 });
    assert.equal(result.latest.position, 'below_lower');
  });

  it('returns nulls before the window fills and validates its options', () => {
    const result = bollinger([1, 2, 3], { period: 20 });
    assert.ok(result.middle.every((value) => value === null));
    assert.equal(result.latest.position, 'unknown');
    assert.throws(() => bollinger([1, 2, 3], { period: 0 }), RangeError);
    assert.throws(() => bollinger([1, 2, 3], { period: 5, multiplier: 0 }), RangeError);
  });
});