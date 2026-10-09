/** Exponential moving average, SMA-seeded (the standard convention). */

import type { Series, SeriesResult } from './types.ts';
import { lastFinite, lastFiniteIndex, mean } from './math.ts';

export function emaAlpha(period: number): number {
  return 2 / (period + 1);
}

export function ema(values: readonly number[], period: number): Series {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError('ema period must be a positive integer');
  }
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const seed = mean(values.slice(0, period));
  if (seed === null) return out;
  out[period - 1] = seed;
  const alpha = emaAlpha(period);
  for (let index = period; index < values.length; index += 1) {
    const previous = out[index - 1];
    if (previous === null) continue;
    out[index] = alpha * values[index] + (1 - alpha) * previous;
  }
  return out;
}

export function emaResult(values: readonly number[], period: number): SeriesResult {
  const series = ema(values, period);
  const index = lastFiniteIndex(series);
  return {
    period,
    values: series,
    latest: index === null ? null : (series[index] as number),
    latestIndex: index,
  };
}

/**
 * EMA over a sparse series (used for the MACD signal line, whose input starts
 * later than the price series). Nulls are skipped, not treated as zeros.
 */
export function emaOfSeries(series: ReadonlyArray<Series[number]>, period: number): Series {
  const out: Series = new Array(series.length).fill(null);
  const present: number[] = [];
  const positions: number[] = [];
  const alpha = emaAlpha(period);
  let previous: number | null = null;
  for (let index = 0; index < series.length; index += 1) {
    const value = series[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    present.push(value);
    positions.push(index);
    if (present.length < period) continue;
    if (previous === null) {
      previous = mean(present.slice(0, period)) ?? null;
    } else {
      previous = alpha * value + (1 - alpha) * previous;
    }
    if (previous !== null) out[index] = previous;
  }
  return out;
}

export function emaLatest(values: readonly number[], period: number): number | null {
  return lastFinite(ema(values, period));
}
