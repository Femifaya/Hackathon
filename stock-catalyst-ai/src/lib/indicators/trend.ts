/**
 * Trend classification from price structure and moving averages.
 * Thresholds are explicit constants so the same input always yields the same
 * label; this module contains no AI involvement.
 */

import type { TrendDirection, TrendResult } from './types.ts';
import type { Candle } from '../market/types.ts';
import { sma } from './sma.ts';
import { isFiniteNumber, lastFinite, linearSlope, mean } from './math.ts';
import { findPivots } from './support-resistance.ts';

export const SLOPE_UP_THRESHOLD = 0.1;
export const SLOPE_DOWN_THRESHOLD = -0.1;

export interface TrendOptions {
  slopeLookback?: number;
  fastPeriod?: number;
  slowPeriod?: number;
}

export function classifyTrend(candles: readonly Candle[], options: TrendOptions = {}): TrendResult | null {
  const slopeLookback = options.slopeLookback ?? 50;
  const fastPeriod = options.fastPeriod ?? 20;
  const slowPeriod = options.slowPeriod ?? 50;
  if (candles.length < fastPeriod) return null;

  const closes = candles.map((candle) => candle.close);
  const window = closes.slice(Math.max(0, closes.length - slopeLookback));
  const slope = linearSlope(window);
  const reference = mean(window);
  const slopePercentPerBar =
    slope !== null && reference !== null && reference !== 0 ? (slope / reference) * 100 : null;

  const fastLatest = lastFinite(sma(closes, fastPeriod));
  const slowLatest = lastFinite(sma(closes, slowPeriod));
  const close = closes[closes.length - 1];

  const closeVsSma20Percent =
    isFiniteNumber(fastLatest) && fastLatest !== 0 ? ((close - fastLatest) / fastLatest) * 100 : null;
  const sma20VsSma50Percent =
    isFiniteNumber(fastLatest) && isFiniteNumber(slowLatest) && slowLatest !== 0
      ? ((fastLatest - slowLatest) / slowLatest) * 100
      : null;

  const { higherHighs, higherLows } = pivotStructure(candles);

  let direction: TrendDirection = 'sideways';
  const reasons: string[] = [];

  if (slopePercentPerBar === null) {
    reasons.push('slope unavailable');
  } else if (
    slopePercentPerBar >= SLOPE_UP_THRESHOLD &&
    isFiniteNumber(fastLatest) &&
    close >= fastLatest &&
    (slowLatest === null || (isFiniteNumber(slowLatest) && fastLatest >= slowLatest))
  ) {
    direction = 'up';
    reasons.push(`slope +${slopePercentPerBar.toFixed(3)}%/bar`);
    reasons.push('close at or above SMA20');
    if (slowLatest === null) reasons.push('SMA50 unavailable (history too short)');
    else reasons.push('SMA20 at or above SMA50');
  } else if (
    slopePercentPerBar <= SLOPE_DOWN_THRESHOLD &&
    isFiniteNumber(fastLatest) &&
    close <= fastLatest &&
    (slowLatest === null || (isFiniteNumber(slowLatest) && fastLatest <= slowLatest))
  ) {
    direction = 'down';
    reasons.push(`slope ${slopePercentPerBar.toFixed(3)}%/bar`);
    reasons.push('close at or below SMA20');
    if (slowLatest === null) reasons.push('SMA50 unavailable (history too short)');
    else reasons.push('SMA20 at or below SMA50');
  } else {
    reasons.push('slope and moving-average alignment do not confirm a direction');
  }

  const strength = trendStrength(direction, slopePercentPerBar, sma20VsSma50Percent, higherHighs, higherLows);

  if (higherHighs !== null) reasons.push(higherHighs ? 'higher highs' : 'no higher highs');
  if (higherLows !== null) reasons.push(higherLows ? 'higher lows' : 'no higher lows');

  return {
    direction,
    strength,
    slopePercentPerBar,
    closeVsSma20Percent,
    sma20VsSma50Percent,
    higherHighs,
    higherLows,
    barsUsed: window.length,
    reason: reasons.join('; '),
  };
}

function trendStrength(
  direction: TrendDirection,
  slopePercentPerBar: number | null,
  sma20VsSma50Percent: number | null,
  higherHighs: boolean | null,
  higherLows: boolean | null,
): number {
  if (direction === 'sideways') {
    const flatness = slopePercentPerBar === null ? 0 : Math.max(0, 1 - Math.abs(slopePercentPerBar) / 0.1);
    return Math.min(0.35, 0.35 * flatness);
  }
  const slopeScore =
    slopePercentPerBar === null ? 0 : Math.min(1, Math.abs(slopePercentPerBar) / 0.5);
  const alignmentScore =
    sma20VsSma50Percent === null ? 0.5 : Math.min(1, Math.abs(sma20VsSma50Percent) / 5);
  const structureScore = structureScoreFor(direction, higherHighs, higherLows);
  const raw = 0.45 * slopeScore + 0.3 * alignmentScore + 0.25 * structureScore;
  return Math.max(0, Math.min(1, raw));
}

function structureScoreFor(
  direction: TrendDirection,
  higherHighs: boolean | null,
  higherLows: boolean | null,
): number {
  const votes: number[] = [];
  if (direction === 'up') {
    if (higherHighs !== null) votes.push(higherHighs ? 1 : 0);
    if (higherLows !== null) votes.push(higherLows ? 1 : 0);
  }
  if (direction === 'down') {
    if (higherHighs !== null) votes.push(higherHighs ? 0 : 1);
    if (higherLows !== null) votes.push(higherLows ? 0 : 1);
  }
  if (votes.length === 0) return 0.5;
  return votes.reduce((sum, value) => sum + value, 0) / votes.length;
}

function pivotStructure(candles: readonly Candle[]): { higherHighs: boolean | null; higherLows: boolean | null } {
  const scope = candles.slice(Math.max(0, candles.length - 120));
  const pivots = findPivots(scope, 2);
  const highs = pivots.filter((pivot) => pivot.kind === 'high').map((pivot) => pivot.price);
  const lows = pivots.filter((pivot) => pivot.kind === 'low').map((pivot) => pivot.price);

  const compareLastTwo = (values: number[]): boolean | null => {
    if (values.length < 2) return null;
    return values[values.length - 1] > values[values.length - 2];
  };

  return { higherHighs: compareLastTwo(highs), higherLows: compareLastTwo(lows) };
}