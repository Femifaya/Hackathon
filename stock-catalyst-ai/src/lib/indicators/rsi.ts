/**
 * Relative Strength Index using Wilder's smoothing.
 *
 * Indexing: with period P the first RSI appears at index P, because P price
 * changes require P+1 closes. Earlier entries are null - never zero-filled.
 */

import type { Series, SeriesResult } from './types.ts';
import { lastFiniteIndex } from './math.ts';

export const RSI_OVERBOUGHT = 70;
export const RSI_OVERSOLD = 30;

export interface RsiDetail {
  values: Series;
  averageGain: Series;
  averageLoss: Series;
}

export function rsiDetail(values: readonly number[], period = 14): RsiDetail {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError('rsi period must be a positive integer');
  }
  const out: Series = new Array(values.length).fill(null);
  const gains: Series = new Array(values.length).fill(null);
  const losses: Series = new Array(values.length).fill(null);
  if (values.length <= period) return { values: out, averageGain: gains, averageLoss: losses };

  let gainSum = 0;
  let lossSum = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    if (change > 0) gainSum += change;
    else lossSum -= change;
  }
  let averageGain = gainSum / period;
  let averageLoss = lossSum / period;
  gains[period] = averageGain;
  losses[period] = averageLoss;
  out[period] = toRsi(averageGain, averageLoss);

  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
    gains[index] = averageGain;
    losses[index] = averageLoss;
    out[index] = toRsi(averageGain, averageLoss);
  }

  return { values: out, averageGain: gains, averageLoss: losses };
}

function toRsi(averageGain: number, averageLoss: number): number {
  if (averageLoss === 0) {
    // No downside in the window: RSI is pinned, or flat if there was no move at all.
    return averageGain === 0 ? 50 : 100;
  }
  const rs = averageGain / averageLoss;
  return 100 - 100 / (1 + rs);
}

export function rsi(values: readonly number[], period = 14): Series {
  return rsiDetail(values, period).values;
}

export function rsiResult(values: readonly number[], period = 14): SeriesResult {
  const series = rsi(values, period);
  const index = lastFiniteIndex(series);
  return {
    period,
    values: series,
    latest: index === null ? null : (series[index] as number),
    latestIndex: index,
  };
}

export type RsiState = 'overbought' | 'oversold' | 'neutral' | 'insufficient_data';

export function rsiState(latest: number | null): RsiState {
  if (latest === null || !Number.isFinite(latest)) return 'insufficient_data';
  if (latest >= RSI_OVERBOUGHT) return 'overbought';
  if (latest <= RSI_OVERSOLD) return 'oversold';
  return 'neutral';
}

/** Divergence between price and RSI over the lookback window (simple sign test). */
export function rsiDivergence(
  prices: readonly number[],
  rsiValues: ReadonlyArray<Series[number]>,
  lookback = 20,
): 'bullish' | 'bearish' | 'none' | 'insufficient_data' {
  const start = Math.max(0, rsiValues.length - lookback);
  const points: Array<{ index: number; rsi: number }> = [];
  for (let index = start; index < rsiValues.length; index += 1) {
    const value = rsiValues[index];
    if (typeof value === 'number' && Number.isFinite(value)) points.push({ index, rsi: value });
  }
  if (points.length < 2) return 'insufficient_data';

  const first = points[0];
  const last = points[points.length - 1];
  const priceFirst = prices[first.index];
  const priceLast = prices[last.index];
  if (priceFirst === undefined || priceLast === undefined) return 'insufficient_data';

  if (priceLast < priceFirst && last.rsi > first.rsi) return 'bullish';
  if (priceLast > priceFirst && last.rsi < first.rsi) return 'bearish';
  return 'none';
}
