import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  candleCoverage,
  closesOf,
  hasCompleteVolume,
  intervalToBucket,
  resampleCandles,
  validateCandles,
  volumesOf,
} from '../../src/lib/market/candles.ts';
import { candle, dayTime, rampSeries } from './helpers.ts';

const valid = { time: '2024-01-02T00:00:00.000Z', open: 10, high: 11, low: 9, close: 10.5, volume: 100 };

describe('validateCandles', () => {
  it('accepts a well-formed row', () => {
    const result = validateCandles([valid]);
    assert.equal(result.candles.length, 1);
    assert.equal(result.rejected.length, 0);
    assert.deepEqual(result.candles[0], { ...valid, volume: 100 });
  });

  it('coerces numeric strings, which CSV and some JSON providers emit', () => {
    const result = validateCandles([{ ...valid, open: '10', high: '11', low: '9', close: '10.5', volume: '100' }]);
    assert.equal(result.candles.length, 1);
    assert.equal(result.candles[0].open, 10);
    assert.equal(result.candles[0].volume, 100);
  });

  it('treats a blank or negative volume as missing, never as zero', () => {
    const blank = validateCandles([{ ...valid, volume: '' }]);
    assert.equal(blank.candles[0].volume, null);
    const negative = validateCandles([{ ...valid, volume: -5 }]);
    assert.equal(negative.candles[0].volume, null);
  });

  it('rejects rows it cannot trust, with a reason', () => {
    const rows = [
      null,
      42,
      { ...valid, time: 'not-a-date' },
      { ...valid, open: -5 },
      { ...valid, close: 0 },
      { ...valid, high: 8, low: 9 },
      { ...valid, open: 12, high: 11 },
      { ...valid, open: 8, low: 9 },
    ];
    const result = validateCandles(rows);
    assert.equal(result.candles.length, 0);
    assert.equal(result.rejected.length, rows.length);
    assert.deepEqual(
      result.rejected.map((row) => row.reason),
      [
        'not an object',
        'not an object',
        'missing or unparsable time',
        'missing or non-positive OHLC value',
        'missing or non-positive OHLC value',
        'high below low',
        'high/low do not contain open/close',
        'high/low do not contain open/close',
      ],
    );
  });

  it('rejects a non-array payload instead of throwing', () => {
    const result = validateCandles('nope' as unknown as unknown[]);
    assert.deepEqual(result.candles, []);
    assert.deepEqual(result.warnings, ['payload was not an array']);
  });

  it('removes duplicate timestamps keeping the latest value', () => {
    const result = validateCandles([valid, { ...valid, close: 11, high: 11.5 }]);
    assert.equal(result.candles.length, 1);
    assert.equal(result.candles[0].close, 11);
    assert.equal(result.duplicatesRemoved, 1);
    assert.match(result.warnings.join(' '), /duplicate timestamp/);
  });

  it('sorts unordered input and warns about it', () => {
    const later = { ...valid, time: '2024-01-03T00:00:00.000Z' };
    const result = validateCandles([later, valid]);
    assert.equal(result.candles[0].time, '2024-01-02T00:00:00.000Z');
    assert.equal(result.candles[1].time, '2024-01-03T00:00:00.000Z');
    assert.match(result.warnings.join(' '), /not in ascending time order/);
  });
});

describe('resampleCandles', () => {
  const tenDays = rampSeries(10, 100, 1).map((item, index) => ({ ...item, time: dayTime(index) }));

  it('returns the same series for a daily bucket', () => {
    assert.deepEqual(resampleCandles(tenDays, 'daily'), tenDays);
  });

  it('aggregates into Monday-anchored weekly buckets', () => {
    const weekly = resampleCandles(tenDays, 'weekly');
    assert.equal(weekly.length, 2);
    assert.equal(weekly[0].open, tenDays[0].open);
    assert.equal(weekly[0].close, tenDays[5].close);
    assert.equal(weekly[0].high, Math.max(...tenDays.slice(0, 6).map((item) => item.high)));
    assert.equal(weekly[0].low, Math.min(...tenDays.slice(0, 6).map((item) => item.low)));
    assert.equal(weekly[0].volume, 6_000_000);
    assert.equal(weekly[1].volume, 4_000_000);
  });

  it('aggregates into monthly buckets', () => {
    const forty = rampSeries(40, 100, 1).map((item, index) => ({ ...item, time: dayTime(index) }));
    const monthly = resampleCandles(forty, 'monthly');
    assert.equal(monthly.length, 2);
    assert.equal(monthly[0].time, '2024-01-02T00:00:00.000Z');
    assert.equal(monthly[1].close, forty[39].close);
  });

  it('keeps volume null when every bar in the bucket lacks it', () => {
    const noVolume = tenDays.map((item) => ({ ...item, volume: null }));
    const weekly = resampleCandles(noVolume, 'weekly');
    assert.equal(weekly[0].volume, null);
    assert.equal(hasCompleteVolume(noVolume), false);
  });

  it('maps intervals to buckets', () => {
    assert.equal(intervalToBucket('1d'), 'daily');
    assert.equal(intervalToBucket('1wk'), 'weekly');
    assert.equal(intervalToBucket('1mo'), 'monthly');
  });
});

describe('candleCoverage', () => {
  it('reports an empty series without inventing dates', () => {
    assert.deepEqual(candleCoverage([]), {
      count: 0,
      firstTime: null,
      lastTime: null,
      spanDays: null,
      largestGapDays: null,
      missingVolumeBars: 0,
    });
  });

  it('measures span, largest gap, and missing volume', () => {
    const candles = rampSeries(10, 100, 1).map((item, index) => ({ ...item, time: dayTime(index) }));
    candles[9] = { ...candles[9], time: dayTime(20), volume: null };
    const coverage = candleCoverage(candles);
    assert.equal(coverage.count, 10);
    assert.equal(coverage.spanDays, 20);
    assert.equal(coverage.largestGapDays, 12);
    assert.equal(coverage.missingVolumeBars, 1);
  });

  it('exposes close and volume projections', () => {
    const candles = [candle(0, 10, { volume: 5 }), candle(1, 12, { volume: null })];
    assert.deepEqual(closesOf(candles), [10, 12]);
    assert.deepEqual(volumesOf(candles), [5, 0]);
    assert.equal(hasCompleteVolume(candles), false);
  });
});