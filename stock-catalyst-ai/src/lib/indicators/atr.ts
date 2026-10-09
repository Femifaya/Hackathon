/** True Range and Average True Range (Wilder smoothing). */

import type { Series, SeriesResult } from './types.ts';
import type { Candle } from '../market/types.ts';
import { lastFinite, lastFiniteIndex } from './math.ts';

export function trueRange(candles: readonly Candle[]): number[] {
  const out: number[] = [];
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (index === 0) {
      out.push(candle.high - candle.low);
      continue;
    }
    const previousClose = candles[index - 1].close;
    out.push(
      Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previousClose),
        Math.abs(candle.low - previousClose),
      ),
    );
  }
  return out;
}

export function atr(candles: readonly Candle[], period = 14): Series {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError('atr period must be a positive integer');
  }
  const ranges = trueRange(candles);
  const out: Series = new Array(ranges.length).fill(null);
  if (ranges.length < period) return out;

  let sum = 0;
  for (let index = 0; index < period; index += 1) sum += ranges[index];
  let previous = sum / period;
  out[period - 1] = previous;

  for (let index = period; index < ranges.length; index += 1) {
    previous = (previous * (period - 1) + ranges[index]) / period;
    out[index] = previous;
  }
  return out;
}

export function atrResult(candles: readonly Candle[], period = 14): SeriesResult {
  const series = atr(candles, period);
  const index = lastFiniteIndex(series);
  return {
    period,
    values: series,
    latest: index === null ? null : (series[index] as number),
    latestIndex: index,
  };
}

/** ATR as a percentage of the matching close. Useful across price scales. */
export function atrPercentSeries(candles: readonly Candle[], period = 14): Series {
  const series = atr(candles, period);
  return series.map((value, index) => {
    const close = candles[index]?.close;
    if (value === null || close === undefined || close === 0) return null;
    return (value / close) * 100;
  });
}

export function atrPercent(candles: readonly Candle[], period = 14): number | null {
  return lastFinite(atrPercentSeries(candles, period));
}

export type VolatilityRegime = 'low' | 'normal' | 'elevated' | 'high' | 'insufficient_data';

/** Regime bands are relative to ATR%, a common convention for single-name equities. */
export function volatilityRegime(atrPercentValue: number | null): VolatilityRegime {
  if (atrPercentValue === null || !Number.isFinite(atrPercentValue)) return 'insufficient_data';
  if (atrPercentValue < 1.5) return 'low';
  if (atrPercentValue < 3) return 'normal';
  if (atrPercentValue < 5) return 'elevated';
  return 'high';
}