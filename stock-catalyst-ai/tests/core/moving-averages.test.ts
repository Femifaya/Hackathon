import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { sma, smaResult, smaCrossState, smaSlopePercentPerBar, distanceFromSmaPercent } from '../../src/lib/indicators/sma.ts';
import { ema, emaResult, emaAlpha, emaOfSeries } from '../../src/lib/indicators/ema.ts';
import { rampSeries, closes } from './helpers.ts';

describe('sma', () => {
  it('returns nulls until the window fills, then the exact average', () => {
    assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  });

  it('returns all nulls when history is shorter than the period', () => {
    assert.deepEqual(sma([1, 2], 5), [null, null]);
  });

  it('rejects a non-positive or fractional period', () => {
    assert.throws(() => sma([1, 2, 3], 0), RangeError);
    assert.throws(() => sma([1, 2, 3], 2.5), RangeError);
  });

  it('is causal: appending a bar never changes earlier values', () => {
    const short = sma([10, 11, 12, 13], 3);
    const long = sma([10, 11, 12, 13, 14], 3);
    assert.deepEqual(long.slice(0, 4), short);
  });

  it('exposes the latest value and its index', () => {
    const result = smaResult([1, 2, 3, 4, 5], 3);
    assert.equal(result.latest, 4);
    assert.equal(result.latestIndex, 4);
    assert.equal(result.period, 3);
  });

  it('reports latest as null for an empty series', () => {
    const result = smaResult([], 3);
    assert.equal(result.latest, null);
    assert.equal(result.latestIndex, null);
  });

  it('computes a positive slope for a rising ramp', () => {
    const slope = smaSlopePercentPerBar(closes(rampSeries(60, 100, 1)), 20, 5);
    assert.ok(slope !== null && slope > 0, `expected positive slope, got ${slope}`);
  });

  it('measures distance from the moving average in percent', () => {
    const distance = distanceFromSmaPercent([10, 10, 10, 20], 3);
    assert.ok(distance !== null);
    // SMA3 at the last bar is (10+10+20)/3 = 13.333; close 20 is +50%.
    assert.ok(Math.abs((distance as number) - 50) < 0.001, `got ${distance}`);
  });
});

describe('ema', () => {
  it('seeds with the SMA and applies the smoothing factor', () => {
    // period 3 -> alpha 0.5, seed at index 2 = mean(1,2,3) = 2
    assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  });

  it('uses alpha = 2 / (period + 1)', () => {
    assert.equal(emaAlpha(9), 0.2);
    assert.equal(emaAlpha(19), 0.1);
  });

  it('returns all nulls below the minimum length', () => {
    assert.deepEqual(ema([1, 2], 10), [null, null]);
  });

  it('rejects an invalid period', () => {
    assert.throws(() => ema([1, 2, 3], 0), RangeError);
  });

  it('reacts faster than the SMA on an accelerating series', () => {
    // A pure linear ramp gives EMA and SMA the same steady-state lag, so this
    // uses exponential growth where the EMA must sit closer to the last close.
    const values: number[] = [];
    for (let index = 0; index < 60; index += 1) values.push(100 * Math.pow(1.02, index));
    const emaLatestValue = emaResult(values, 20).latest;
    const smaLatestValue = smaResult(values, 20).latest;
    const lastClose = values[values.length - 1];
    assert.ok(emaLatestValue !== null && smaLatestValue !== null);
    assert.ok((emaLatestValue as number) > (smaLatestValue as number), 'EMA should lead SMA when accelerating');
    assert.ok(lastClose - (emaLatestValue as number) < lastClose - (smaLatestValue as number));
  });

  it('skips nulls instead of treating them as zero when smoothing a sparse series', () => {
    const sparse = [null, null, 10, 12, 14, null, 16];
    const result = emaOfSeries(sparse, 2);
    assert.equal(result[0], null);
    assert.equal(result[1], null);
    assert.equal(result[2], null);
    assert.equal(result[3], 11); // mean(10, 12)
    assert.equal(result[4], 13); // 2/3*14 + 1/3*11
    assert.equal(result[5], null);
    // alpha = 2/3 -> 2/3*16 + 1/3*13 = 15
    assert.ok(Math.abs((result[6] as number) - 15) < 1e-9);
  });
});

describe('moving-average cross state', () => {
  it('detects an upward cross', () => {
    const fast = [null, 9, 9, 11];
    const slow = [null, 10, 10, 10];
    assert.equal(smaCrossState(fast, slow), 'cross_up');
  });

  it('detects a downward cross', () => {
    const fast = [null, 11, 11, 9];
    const slow = [null, 10, 10, 10];
    assert.equal(smaCrossState(fast, slow), 'cross_down');
  });

  it('reports above/below without a cross', () => {
    assert.equal(smaCrossState([null, 12, 12, 12], [null, 10, 10, 10]), 'above');
    assert.equal(smaCrossState([null, 8, 8, 8], [null, 10, 10, 10]), 'below');
  });

  it('returns unknown when either series has no finite value', () => {
    assert.equal(smaCrossState([null, null], [null, null]), 'unknown');
  });
});