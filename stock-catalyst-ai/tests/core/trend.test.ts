import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyTrend } from '../../src/lib/indicators/trend.ts';
import { multiTimeframeTrend } from '../../src/lib/indicators/multi-timeframe.ts';
import { flatSeries, rampSeries, waveSeries } from './helpers.ts';

describe('classifyTrend', () => {
  it('classifies a steady ramp as up with a documented reason', () => {
    const trend = classifyTrend(rampSeries(80, 100, 1));
    assert.ok(trend !== null);
    assert.equal(trend.direction, 'up');
    assert.ok(trend.slopePercentPerBar !== null && trend.slopePercentPerBar > 0);
    assert.ok(trend.closeVsSma20Percent !== null && trend.closeVsSma20Percent > 0);
    assert.ok(trend.strength > 0.5 && trend.strength <= 1);
    assert.match(trend.reason, /slope/);
  });

  it('classifies a steady decline as down', () => {
    const trend = classifyTrend(rampSeries(80, 200, -1));
    assert.ok(trend !== null);
    assert.equal(trend.direction, 'down');
    assert.ok((trend.slopePercentPerBar as number) < 0);
    assert.ok((trend.closeVsSma20Percent as number) < 0);
  });

  it('classifies a flat series as sideways with low strength', () => {
    const trend = classifyTrend(flatSeries(80, 100));
    assert.ok(trend !== null);
    assert.equal(trend.direction, 'sideways');
    assert.ok(trend.strength <= 0.35);
  });

  it('returns null instead of guessing when history is below the fast period', () => {
    assert.equal(classifyTrend(rampSeries(19, 100, 1)), null);
    assert.equal(classifyTrend([]), null);
  });

  it('reports SMA50 as unavailable rather than inventing it on short history', () => {
    const trend = classifyTrend(rampSeries(30, 100, 1));
    assert.ok(trend !== null);
    assert.equal(trend.sma20VsSma50Percent, null);
    assert.match(trend.reason, /SMA50 unavailable/);
  });

  it('detects higher highs and higher lows in a rising wave', () => {
    const trend = classifyTrend(waveSeries(160, 100, 4, 0.2));
    assert.ok(trend !== null);
    assert.ok(trend.higherHighs === true || trend.higherHighs === null);
    assert.ok(trend.higherLows === true || trend.higherLows === null);
  });
});

describe('multiTimeframeTrend', () => {
  it('aligns daily and weekly on a long ramp and flags a short monthly series', () => {
    const result = multiTimeframeTrend(rampSeries(300, 100, 0.5));
    const daily = result.frames.find((frame) => frame.timeframe === 'daily');
    const weekly = result.frames.find((frame) => frame.timeframe === 'weekly');
    const monthly = result.frames.find((frame) => frame.timeframe === 'monthly');
    assert.equal(daily?.trend?.direction, 'up');
    assert.equal(weekly?.trend?.direction, 'up');
    assert.equal(monthly?.trend, null);
    assert.match(monthly?.note ?? '', /insufficient monthly bars/);
    assert.equal(result.alignment, 'aligned_bullish');
    assert.ok(result.score > 0.5);
  });

  it('aligns all three timeframes given enough history', () => {
    const result = multiTimeframeTrend(rampSeries(600, 100, 0.3));
    assert.equal(result.frames.filter((frame) => frame.trend !== null).length, 3);
    assert.equal(result.alignment, 'aligned_bullish');
    assert.ok(result.score > 0);
  });

  it('reports aligned_bearish on a long decline', () => {
    const result = multiTimeframeTrend(rampSeries(600, 400, -0.3));
    assert.equal(result.alignment, 'aligned_bearish');
    assert.ok(result.score < 0);
  });

  it('reports mixed when timeframes disagree', () => {
    const rising = rampSeries(400, 100, 0.4);
    const falling = rampSeries(120, rising[rising.length - 1].close, -0.9).slice(1);
    const result = multiTimeframeTrend([...rising, ...falling]);
    assert.equal(result.alignment, 'mixed');
    assert.match(result.note, /disagree/);
  });

  it('returns insufficient_data with no history', () => {
    const result = multiTimeframeTrend([]);
    assert.equal(result.alignment, 'insufficient_data');
    assert.equal(result.score, 0);
    assert.match(result.note, /no timeframe/);
  });

  it('keeps the score within -1..1', () => {
    for (const candles of [rampSeries(600, 100, 2), rampSeries(600, 900, -2), waveSeries(600)]) {
      const score = multiTimeframeTrend(candles).score;
      assert.ok(score >= -1 && score <= 1, `score out of range: ${score}`);
    }
  });
});