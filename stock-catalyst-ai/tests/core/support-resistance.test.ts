import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  distanceToLevelPercent,
  findPivots,
  supportResistance,
} from '../../src/lib/indicators/support-resistance.ts';
import { candle, waveSeries } from './helpers.ts';
import type { Candle } from '../../src/lib/market/types.ts';

const singlePeak: Candle[] = [10, 11, 12, 13, 12, 11, 10].map((high, index) =>
  candle(index, high - 0.5, { high, low: high - 1, open: high - 0.5 }),
);

describe('findPivots', () => {
  it('detects a fractal high with the configured window', () => {
    const pivots = findPivots(singlePeak, 2);
    const highs = pivots.filter((pivot) => pivot.kind === 'high');
    assert.equal(highs.length, 1);
    assert.equal(highs[0].index, 3);
    assert.equal(highs[0].price, 13);
  });

  it('detects a fractal low', () => {
    const trough: Candle[] = [13, 12, 11, 10, 11, 12, 13].map((low, index) =>
      candle(index, low + 0.5, { high: low + 1, low, open: low + 0.5 }),
    );
    const lows = findPivots(trough, 2).filter((pivot) => pivot.kind === 'low');
    assert.equal(lows.length, 1);
    assert.equal(lows[0].price, 10);
  });

  it('never marks the first or last window bars as pivots', () => {
    const pivots = findPivots(waveSeries(60), 2);
    assert.ok(pivots.every((pivot) => pivot.index >= 2 && pivot.index <= 57));
  });

  it('rejects a window smaller than one', () => {
    assert.throws(() => findPivots(singlePeak, 0), RangeError);
  });
});

describe('supportResistance', () => {
  const candles = waveSeries(200);
  const result = supportResistance(candles, { window: 2, tolerancePercent: 1 });
  const lastClose = candles[candles.length - 1].close;

  it('places every support below and every resistance above the last close', () => {
    assert.ok(result.supports.length > 0, 'expected at least one support');
    assert.ok(result.resistances.length > 0, 'expected at least one resistance');
    assert.ok(result.supports.every((level) => level.price < lastClose));
    assert.ok(result.resistances.every((level) => level.price > lastClose));
  });

  it('records touch counts, timestamps, and a bounded strength', () => {
    for (const level of [...result.supports, ...result.resistances]) {
      assert.ok(level.touches >= 1);
      assert.ok(level.strength > 0 && level.strength <= 1);
      assert.ok(Date.parse(level.firstTime) <= Date.parse(level.lastTime));
      assert.ok(['support', 'resistance'].includes(level.kind));
    }
  });

  it('caps the number of levels returned', () => {
    const capped = supportResistance(candles, { maxLevels: 2 });
    assert.ok(capped.supports.length <= 2);
    assert.ok(capped.resistances.length <= 2);
  });

  it('identifies the strongest nearby level', () => {
    assert.ok(result.nearestSupport !== null);
    assert.ok(result.nearestResistance !== null);
    const strongest = [...result.supports].sort((a, b) => b.strength - a.strength)[0];
    assert.equal(result.nearestSupport?.price, strongest?.price);
  });

  it('reports the 52-week range from the analysed window', () => {
    const highs = candles.map((item) => item.high);
    const lows = candles.map((item) => item.low);
    assert.equal(result.fiftyTwoWeekHigh, Math.max(...highs));
    assert.equal(result.fiftyTwoWeekLow, Math.min(...lows));
  });

  it('discloses its method rather than presenting levels as fact', () => {
    assert.match(result.method, /fractal pivots/);
    assert.equal(result.tolerancePercent, 1);
  });

  it('returns empty levels instead of guessing when history is too short', () => {
    const tiny = supportResistance(candles.slice(0, 4));
    assert.deepEqual(tiny.supports, []);
    assert.deepEqual(tiny.resistances, []);
    assert.equal(tiny.nearestSupport, null);
    assert.equal(tiny.nearestResistance, null);
    assert.ok(tiny.fiftyTwoWeekHigh !== null);
  });

  it('computes the distance to a level in percent', () => {
    const level = result.nearestResistance;
    assert.ok(level !== null);
    const distance = distanceToLevelPercent(lastClose, level);
    assert.ok(distance !== null && distance > 0);
    assert.equal(distanceToLevelPercent(null, level), null);
    assert.equal(distanceToLevelPercent(0, level), null);
  });
});