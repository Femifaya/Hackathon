import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeIndicatorSnapshot } from '../../src/lib/indicators/index.ts';
import { candle, dayTime, rampSeries, series } from './helpers.ts';

describe('computeIndicatorSnapshot', () => {
  const longRamp = series(rampSeries(300, 100, 0.5).map((item, index) => ({ ...item, time: dayTime(index) })));
  const snapshot = computeIndicatorSnapshot('TEST', longRamp, { nowTime: Date.UTC(2025, 0, 1) });

  it('computes every indicator when history is sufficient', () => {
    assert.deepEqual(snapshot.insufficientData, []);
    assert.ok(snapshot.sma20?.latest !== null);
    assert.ok(snapshot.sma50?.latest !== null);
    assert.ok(snapshot.ema20?.latest !== null);
    assert.ok(snapshot.ema50?.latest !== null);
    assert.ok(snapshot.rsi14?.latest !== null);
    assert.ok(snapshot.macd?.latest.macd !== null);
    assert.ok(snapshot.atr14?.latest !== null);
    assert.ok(snapshot.bollinger?.latest.middle !== null);
    assert.ok(snapshot.volume !== null);
    assert.ok(snapshot.levels !== null);
    assert.ok(snapshot.trend !== null);
    assert.ok(snapshot.multiTimeframe !== null);
  });

  it('records provenance of the calculation itself', () => {
    assert.equal(snapshot.symbol, 'TEST');
    assert.equal(snapshot.interval, '1d');
    assert.equal(snapshot.adjustment, 'full');
    assert.equal(snapshot.computedAt, '2025-01-01T00:00:00.000Z');
    assert.equal(snapshot.barsUsed, 300);
    assert.equal(snapshot.firstTime, dayTime(0));
    assert.equal(snapshot.lastTime, dayTime(299));
    assert.equal(snapshot.lastClose, rampSeries(300, 100, 0.5)[299].close);
  });

  it('describes the ramp as an overbought uptrend aligned across timeframes', () => {
    assert.equal(snapshot.rsiState, 'overbought');
    assert.equal(snapshot.trend?.direction, 'up');
    assert.equal(snapshot.multiTimeframe?.alignment, 'aligned_bullish');
    assert.ok((snapshot.atr14?.latest as number) > 0.4 && (snapshot.atr14?.latest as number) < 0.6);
  });

  it('lists exactly which indicators lack data on a short history', () => {
    const short = computeIndicatorSnapshot('SHORT', series(rampSeries(30, 100, 1)));
    assert.ok(short.insufficientData.includes('sma50'));
    assert.ok(short.insufficientData.includes('ema50'));
    assert.ok(short.insufficientData.includes('macd'));
    assert.ok(!short.insufficientData.includes('sma20'));
    assert.ok(!short.insufficientData.includes('rsi14'));
    assert.equal(short.sma50, null);
    assert.equal(short.macd, null);
    assert.match(short.warnings.join(' '), /50-period indicators need at least 50/);
  });

  it('survives an empty series without throwing or fabricating values', () => {
    const empty = computeIndicatorSnapshot('EMPTY', series([]));
    assert.equal(empty.barsUsed, 0);
    assert.equal(empty.lastClose, null);
    assert.equal(empty.sma20, null);
    assert.equal(empty.levels, null);
    assert.equal(empty.multiTimeframe, null);
    assert.ok(empty.insufficientData.length >= 10);
  });

  it('warns when the adjustment method is unknown', () => {
    const unknown = computeIndicatorSnapshot('ADJ', series(rampSeries(60, 100, 1), 'TEST', 'unknown'));
    assert.match(unknown.warnings.join(' '), /adjustment of this series is unknown/);
    const none = computeIndicatorSnapshot('ADJ', series(rampSeries(60, 100, 1), 'TEST', 'none'));
    assert.match(none.warnings.join(' '), /unadjusted/);
  });

  it('flags incomplete volume instead of computing a volume signal', () => {
    const partial = rampSeries(60, 100, 1).map((item, index) =>
      index % 3 === 0 ? { ...item, time: dayTime(index), volume: null } : { ...item, time: dayTime(index) },
    );
    const result = computeIndicatorSnapshot('VOL', series(partial));
    assert.equal(result.volume?.complete, false);
    assert.equal(result.volume?.direction, 'insufficient_data');
    assert.match(result.warnings.join(' '), /volume is incomplete/);
  });

  it('carries caller-supplied warnings through to the report layer', () => {
    const result = computeIndicatorSnapshot('WARN', series(rampSeries(60, 100, 1)), {
      extraWarnings: ['provider reported a 15-minute delay'],
    });
    assert.ok(result.warnings.includes('provider reported a 15-minute delay'));
  });

  it('handles single-bar candles without division by zero', () => {
    const single = computeIndicatorSnapshot('ONE', series([candle(0, 100)]));
    assert.equal(single.barsUsed, 1);
    assert.equal(single.lastClose, 100);
    assert.equal(single.atrPercent, null);
  });
});