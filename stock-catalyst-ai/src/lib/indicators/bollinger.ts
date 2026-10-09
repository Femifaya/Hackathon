/** Bollinger Bands: SMA middle band with population standard-deviation envelopes. */

import type { BollingerResult, Series } from './types.ts';
import { sma } from './sma.ts';
import { isFiniteNumber, populationStdDev } from './math.ts';

export interface BollingerOptions {
  period?: number;
  multiplier?: number;
}

export function bollinger(values: readonly number[], options: BollingerOptions = {}): BollingerResult {
  const period = options.period ?? 20;
  const multiplier = options.multiplier ?? 2;
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError('bollinger period must be a positive integer');
  }
  if (!(multiplier > 0)) {
    throw new RangeError('bollinger multiplier must be positive');
  }

  const middle = sma(values, period);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);
  const bandwidth: Series = new Array(values.length).fill(null);
  const percentB: Series = new Array(values.length).fill(null);

  for (let index = period - 1; index < values.length; index += 1) {
    const mid = middle[index];
    if (!isFiniteNumber(mid)) continue;
    const deviation = populationStdDev(values.slice(index - period + 1, index + 1));
    if (deviation === null) continue;
    const up = mid + multiplier * deviation;
    const low = mid - multiplier * deviation;
    upper[index] = up;
    lower[index] = low;
    bandwidth[index] = mid === 0 ? null : (up - low) / mid;
    percentB[index] = up === low ? null : (values[index] - low) / (up - low);
  }

  return {
    period,
    multiplier,
    middle,
    upper,
    lower,
    bandwidth,
    percentB,
    latest: bollingerLatest(values, middle, upper, lower, bandwidth, percentB),
  };
}

function bollingerLatest(
  values: readonly number[],
  middle: ReadonlyArray<Series[number]>,
  upper: ReadonlyArray<Series[number]>,
  lower: ReadonlyArray<Series[number]>,
  bandwidth: ReadonlyArray<Series[number]>,
  percentB: ReadonlyArray<Series[number]>,
): BollingerResult['latest'] {
  const lastIndex = values.length - 1;
  const mid = middle[lastIndex];
  const up = upper[lastIndex];
  const low = lower[lastIndex];
  const bw = bandwidth[lastIndex];
  const pb = percentB[lastIndex];
  const close = values[lastIndex];

  let position: BollingerResult['latest']['position'] = 'unknown';
  if (isFiniteNumber(up) && isFiniteNumber(low) && isFiniteNumber(mid) && isFiniteNumber(close)) {
    if (close > up) position = 'above_upper';
    else if (close < low) position = 'below_lower';
    else position = close >= mid ? 'upper_half' : 'lower_half';
  }

  return {
    middle: isFiniteNumber(mid) ? mid : null,
    upper: isFiniteNumber(up) ? up : null,
    lower: isFiniteNumber(low) ? low : null,
    bandwidth: isFiniteNumber(bw) ? bw : null,
    percentB: isFiniteNumber(pb) ? pb : null,
    position,
  };
}
