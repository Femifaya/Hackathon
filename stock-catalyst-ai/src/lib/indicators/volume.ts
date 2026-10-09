/** Volume trend: current volume versus its rolling average, plus slope. */

import type { Series, VolumeTrendResult } from './types.ts';
import { isFiniteNumber, lastFinite, linearSlope, mean } from './math.ts';

/**
 * Slope thresholds, in percent of the window's mean volume per bar. A +2%/bar
 * slope across a 20-bar window is roughly a 40% expansion, which is the point
 * where volume starts to carry information about participation.
 */
export const VOLUME_SLOPE_RISING = 2;
export const VOLUME_SLOPE_FALLING = -2;

export function averageVolume(volumes: readonly number[], period = 20): Series {
  const out: Series = new Array(volumes.length).fill(null);
  if (volumes.length < period || period < 1) return out;
  let sum = 0;
  for (let index = 0; index < volumes.length; index += 1) {
    sum += volumes[index];
    if (index >= period) sum -= volumes[index - period];
    if (index >= period - 1) out[index] = sum / period;
  }
  return out;
}

export function volumeTrend(volumes: readonly number[], period = 20, complete = true): VolumeTrendResult {
  const average = averageVolume(volumes, period);
  const ratio: Series = average.map((value, index) => {
    if (!isFiniteNumber(value) || value === 0) return null;
    return volumes[index] / value;
  });

  const latestAverage = lastFinite(average);
  const latestRatio = lastFinite(ratio);

  const tail: number[] = [];
  for (let index = volumes.length - 1; index >= 0 && tail.length < period; index -= 1) {
    tail.unshift(volumes[index]);
  }
  const slope = tail.length >= 3 ? linearSlope(tail) : null;
  const reference = mean(tail);
  const slopePercentPerBar =
    slope !== null && reference !== null && reference > 0 ? (slope / reference) * 100 : null;

  // A trend claim requires a full average window AND complete volume data.
  // Anything less is reported as insufficient rather than inferred from a
  // partial window.
  let direction: VolumeTrendResult['direction'] = 'insufficient_data';
  if (complete && latestAverage !== null && slopePercentPerBar !== null) {
    if (slopePercentPerBar > VOLUME_SLOPE_RISING) direction = 'rising';
    else if (slopePercentPerBar < VOLUME_SLOPE_FALLING) direction = 'falling';
    else direction = 'flat';
  }

  return {
    period,
    average,
    ratio,
    latestAverage,
    latestRatio,
    direction,
    slopePercentPerBar,
    complete,
  };
}

export type VolumeSignal = 'expanding' | 'contracting' | 'normal' | 'insufficient_data';

export function volumeSignal(latestRatio: number | null, complete: boolean): VolumeSignal {
  if (!complete || latestRatio === null || !Number.isFinite(latestRatio)) return 'insufficient_data';
  if (latestRatio >= 1.5) return 'expanding';
  if (latestRatio <= 0.7) return 'contracting';
  return 'normal';
}