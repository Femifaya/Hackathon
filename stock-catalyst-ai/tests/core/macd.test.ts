import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { macd } from '../../src/lib/indicators/macd.ts';
import { closes, rampSeries } from './helpers.ts';

describe('macd', () => {
  it('matches a hand-computed reference for fast=2 slow=3 signal=2', () => {
    const result = macd([1, 2, 3, 4, 5], { fast: 2, slow: 3, signal: 2 });
    assert.deepEqual(result.macd.slice(0, 2), [null, null]);
    for (const index of [2, 3, 4]) {
      assert.ok(Math.abs((result.macd[index] as number) - 0.5) < 1e-9);
    }
    assert.equal(result.signal[2], null);
    assert.ok(Math.abs((result.signal[3] as number) - 0.5) < 1e-9);
    assert.ok(Math.abs((result.histogram[4] as number) - 0) < 1e-9);
    assert.equal(result.latest.state, 'neutral');
  });

  it('rejects a fast period that is not smaller than the slow period', () => {
    assert.throws(() => macd([1, 2, 3], { fast: 26, slow: 12 }), RangeError);
  });

  it('returns all nulls when history is below the slow period', () => {
    const result = macd([1, 2, 3], { fast: 12, slow: 26, signal: 9 });
    assert.ok(result.macd.every((value) => value === null));
    assert.ok(result.signal.every((value) => value === null));
    assert.equal(result.latest.macd, null);
    assert.equal(result.latest.state, 'neutral');
  });

  it('turns positive after a downtrend reverses sharply upward', () => {
    const declining = closes(rampSeries(45, 150, -1));
    const recovering = closes(rampSeries(15, declining[declining.length - 1] as number, 3)).slice(1);
    const result = macd([...declining, ...recovering]);
    assert.ok(result.latest.histogram !== null);
    assert.ok(
      result.latest.state === 'bullish_cross' || result.latest.state === 'bullish',
      `expected bullish state, got ${result.latest.state}`,
    );
  });

  it('turns negative after an uptrend reverses sharply downward', () => {
    const rising = closes(rampSeries(45, 100, 1));
    const falling = closes(rampSeries(15, rising[rising.length - 1] as number, -3)).slice(1);
    const result = macd([...rising, ...falling]);
    assert.ok(result.latest.histogram !== null);
    assert.ok(
      result.latest.state === 'bearish_cross' || result.latest.state === 'bearish',
      `expected bearish state, got ${result.latest.state}`,
    );
  });

  it('uses the documented defaults', () => {
    const result = macd(closes(rampSeries(80, 100, 0.5)));
    assert.equal(result.fast, 12);
    assert.equal(result.slow, 26);
    assert.equal(result.signalPeriod, 9);
    assert.ok(result.latest.macd !== null);
  });
});