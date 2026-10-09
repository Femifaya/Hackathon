/** MACD (12/26/9 by default) with an SMA-seeded signal line. */

import type { MacdResult, Series } from './types.ts';
import { ema, emaOfSeries } from './ema.ts';
import { isFiniteNumber, lastFiniteIndex } from './math.ts';

export interface MacdOptions {
  fast?: number;
  slow?: number;
  signal?: number;
}

export function macd(values: readonly number[], options: MacdOptions = {}): MacdResult {
  const fast = options.fast ?? 12;
  const slow = options.slow ?? 26;
  const signalPeriod = options.signal ?? 9;
  if (fast >= slow) {
    throw new RangeError('macd fast period must be smaller than the slow period');
  }

  const fastSeries = ema(values, fast);
  const slowSeries = ema(values, slow);
  const macdLine: Series = new Array(values.length).fill(null);
  for (let index = 0; index < values.length; index += 1) {
    const f = fastSeries[index];
    const s = slowSeries[index];
    if (isFiniteNumber(f) && isFiniteNumber(s)) macdLine[index] = f - s;
  }

  const signalLine = emaOfSeries(macdLine, signalPeriod);
  const histogram: Series = new Array(values.length).fill(null);
  for (let index = 0; index < values.length; index += 1) {
    const m = macdLine[index];
    const s = signalLine[index];
    if (isFiniteNumber(m) && isFiniteNumber(s)) histogram[index] = m - s;
  }

  return {
    fast,
    slow,
    signalPeriod,
    macd: macdLine,
    signal: signalLine,
    histogram,
    latest: macdLatest(macdLine, signalLine, histogram),
  };
}

function macdLatest(
  macdLine: ReadonlyArray<Series[number]>,
  signalLine: ReadonlyArray<Series[number]>,
  histogram: ReadonlyArray<Series[number]>,
): MacdResult['latest'] {
  const index = lastFiniteIndex(histogram);
  if (index === null) {
    return { macd: null, signal: null, histogram: null, state: 'neutral' };
  }
  const currentHistogram = histogram[index] as number;
  const currentMacd = macdLine[index];
  const currentSignal = signalLine[index];

  let previousHistogram: number | null = null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const value = histogram[cursor];
    if (isFiniteNumber(value)) {
      previousHistogram = value;
      break;
    }
  }

  let state: MacdResult['latest']['state'] = 'neutral';
  if (previousHistogram !== null) {
    if (previousHistogram <= 0 && currentHistogram > 0) state = 'bullish_cross';
    else if (previousHistogram >= 0 && currentHistogram < 0) state = 'bearish_cross';
    else state = currentHistogram > 0 ? 'bullish' : currentHistogram < 0 ? 'bearish' : 'neutral';
  } else {
    state = currentHistogram > 0 ? 'bullish' : currentHistogram < 0 ? 'bearish' : 'neutral';
  }

  return {
    macd: isFiniteNumber(currentMacd) ? currentMacd : null,
    signal: isFiniteNumber(currentSignal) ? currentSignal : null,
    histogram: currentHistogram,
    state,
  };
}
