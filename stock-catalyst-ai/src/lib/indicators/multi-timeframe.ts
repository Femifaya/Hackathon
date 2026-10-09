/**
 * Multi-timeframe trend alignment. Weekly and monthly series are derived from the
 * daily series by aggregation, so a provider only has to supply daily candles.
 */

import type { MultiTimeframeResult, Timeframe, TimeframeTrend, TrendResult } from './types.ts';
import type { Candle } from '../market/types.ts';
import { resampleCandles } from '../market/candles.ts';
import { classifyTrend } from './trend.ts';

export const MIN_BARS_PER_FRAME: Record<Timeframe, number> = {
  daily: 20,
  weekly: 20,
  monthly: 12,
};

const FRAME_WEIGHT: Record<Timeframe, number> = {
  daily: 1,
  weekly: 1.5,
  monthly: 2,
};

function frameFor(timeframe: Timeframe, candles: readonly Candle[]): TimeframeTrend {
  const series =
    timeframe === 'daily'
      ? [...candles]
      : resampleCandles(candles, timeframe === 'weekly' ? 'weekly' : 'monthly');

  const minimum = MIN_BARS_PER_FRAME[timeframe];
  if (series.length < minimum) {
    return {
      timeframe,
      bars: series.length,
      trend: null,
      note: `insufficient ${timeframe} bars (${series.length} of ${minimum} required)`,
    };
  }

  const trend = classifyTrend(series);
  return {
    timeframe,
    bars: series.length,
    trend,
    note: trend ? null : 'trend could not be classified',
  };
}

export function multiTimeframeTrend(candles: readonly Candle[]): MultiTimeframeResult {
  const frames: TimeframeTrend[] = [
    frameFor('daily', candles),
    frameFor('weekly', candles),
    frameFor('monthly', candles),
  ];

  const usable = frames.filter((frame): frame is TimeframeTrend & { trend: TrendResult } => frame.trend !== null);

  if (usable.length === 0) {
    return {
      frames,
      alignment: 'insufficient_data',
      score: 0,
      note: 'no timeframe had enough history to classify a trend',
    };
  }

  let weighted = 0;
  let totalWeight = 0;
  for (const frame of usable) {
    const weight = FRAME_WEIGHT[frame.timeframe];
    const signal = frame.trend.direction === 'up' ? 1 : frame.trend.direction === 'down' ? -1 : 0;
    weighted += signal * weight * (0.5 + 0.5 * frame.trend.strength);
    totalWeight += weight;
  }
  const score = totalWeight === 0 ? 0 : Math.max(-1, Math.min(1, weighted / totalWeight));

  const directions = usable.map((frame) => frame.trend.direction);
  const allUp = directions.length > 0 && directions.every((direction) => direction === 'up');
  const allDown = directions.length > 0 && directions.every((direction) => direction === 'down');

  let alignment: MultiTimeframeResult['alignment'] = 'mixed';
  if (allUp) alignment = 'aligned_bullish';
  else if (allDown) alignment = 'aligned_bearish';

  const missing = frames.filter((frame) => frame.trend === null).map((frame) => frame.timeframe);
  const note = [
    `${usable.length} of ${frames.length} timeframes classified`,
    alignment === 'mixed' ? 'timeframes disagree' : `timeframes agree (${alignment.replace('_', ' ')})`,
    missing.length > 0 ? `unavailable: ${missing.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('; ');

  return { frames, alignment, score, note };
}