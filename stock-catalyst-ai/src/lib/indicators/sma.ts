/** Simple moving average. */

import type { Series, SeriesResult } from './types.ts';
import { isFiniteNumber, lastFinite, lastFiniteIndex, linearSlope, mean, percentChange } from './math.ts';

export function sma(values: readonly number[], period: number): Series {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError('sma period must be a positive integer');
  }
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= period) sum -= values[index - period];
    if (index >= period - 1) out[index] = sum / period;
  }
  return out;
}

export function smaResult(values: readonly number[], period: number): SeriesResult {
  const series = sma(values, period);
  const index = lastFiniteIndex(series);
  return {
    period,
    values: series,
    latest: index === null ? null : (series[index] as number),
    latestIndex: index,
  };
}

/** Slope of the SMA over `bars` samples, expressed as percent per bar. */
export function smaSlopePercentPerBar(values: readonly number[], period: number, bars = 5): number | null {
  const series = sma(values, period);
  const window: number[] = [];
  for (let index = series.length - 1; index >= 0 && window.length < bars; index -= 1) {
    const value = series[index];
    if (!isFiniteNumber(value)) break;
    window.unshift(value);
  }
  if (window.length < 2) return null;
  const slope = linearSlope(window);
  const reference = mean(window);
  if (slope === null || reference === null || reference === 0) return null;
  return (slope / reference) * 100;
}

export function smaCrossState(fast: ReadonlyArray<number | null>, slow: ReadonlyArray<number | null>): 'above' | 'below' | 'cross_up' | 'cross_down' | 'unknown' {
  const fastLatest = lastFinite(fast);
  const slowLatest = lastFinite(slow);
  if (!isFiniteNumber(fastLatest) || !isFiniteNumber(slowLatest)) return 'unknown';
  let fastPrev: number | null = null;
  let slowPrev: number | null = null;
  for (let index = fast.length - 2; index >= 0; index -= 1) {
    const f = fast[index];
    const s = slow[index];
    if (isFiniteNumber(f) && isFiniteNumber(s)) {
      fastPrev = f;
      slowPrev = s;
      break;
    }
  }
  if (fastPrev !== null && slowPrev !== null) {
    if (fastPrev <= slowPrev && fastLatest > slowLatest) return 'cross_up';
    if (fastPrev >= slowPrev && fastLatest < slowLatest) return 'cross_down';
  }
  return fastLatest > slowLatest ? 'above' : fastLatest < slowLatest ? 'below' : 'unknown';
}

export function distanceFromSmaPercent(values: readonly number[], period: number): number | null {
  const latestValue = values.length > 0 ? values[values.length - 1] : null;
  return percentChange(lastFinite(sma(values, period)), latestValue);
}
