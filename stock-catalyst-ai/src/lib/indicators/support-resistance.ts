/**
 * Support and resistance from fractal pivots, clustered into price zones.
 *
 * Method (disclosed in the UI and in exports):
 *   1. A pivot high at bar i is a high strictly greater than the `window` bars on
 *      each side; pivot lows are symmetric.
 *   2. Pivots are clustered when their prices are within `tolerancePercent`.
 *   3. A cluster's price is the touch-weighted mean, its strength combines touch
 *      count and recency.
 *   4. Clusters below the last close are supports, above are resistances.
 *
 * This is a heuristic, not a forecast. It is reported as a CALCULATION, never as
 * an AI interpretation.
 */

import type { LevelsResult, PriceLevel } from './types.ts';
import type { Candle } from '../market/types.ts';
import { isFiniteNumber } from './math.ts';

export interface PivotPoint {
  index: number;
  time: string;
  price: number;
  kind: 'high' | 'low';
}

export interface LevelsOptions {
  window?: number;
  tolerancePercent?: number;
  maxLevels?: number;
  lookbackBars?: number;
}

export function findPivots(candles: readonly Candle[], window = 2): PivotPoint[] {
  if (window < 1) throw new RangeError('pivot window must be at least 1');
  const pivots: PivotPoint[] = [];
  for (let index = window; index < candles.length - window; index += 1) {
    const high = candles[index].high;
    const low = candles[index].low;
    let isPivotHigh = true;
    let isPivotLow = true;
    for (let offset = 1; offset <= window; offset += 1) {
      if (candles[index - offset].high >= high || candles[index + offset].high >= high) {
        isPivotHigh = false;
      }
      if (candles[index - offset].low <= low || candles[index + offset].low <= low) {
        isPivotLow = false;
      }
    }
    if (isPivotHigh) pivots.push({ index, time: candles[index].time, price: high, kind: 'high' });
    if (isPivotLow) pivots.push({ index, time: candles[index].time, price: low, kind: 'low' });
  }
  return pivots;
}

interface Cluster {
  prices: number[];
  times: string[];
  indices: number[];
}

function clusterPivots(pivots: readonly PivotPoint[], tolerancePercent: number): Cluster[] {
  const clusters: Cluster[] = [];
  for (const pivot of pivots) {
    const tolerance = pivot.price * (tolerancePercent / 100);
    const match = clusters.find((cluster) => {
      const representative = cluster.prices.reduce((sum, value) => sum + value, 0) / cluster.prices.length;
      return Math.abs(representative - pivot.price) <= tolerance;
    });
    if (match) {
      match.prices.push(pivot.price);
      match.times.push(pivot.time);
      match.indices.push(pivot.index);
    } else {
      clusters.push({ prices: [pivot.price], times: [pivot.time], indices: [pivot.index] });
    }
  }
  return clusters;
}

export function supportResistance(candles: readonly Candle[], options: LevelsOptions = {}): LevelsResult {
  const window = options.window ?? 2;
  const tolerancePercent = options.tolerancePercent ?? 1.0;
  const maxLevels = options.maxLevels ?? 4;
  const lookbackBars = options.lookbackBars ?? 252;

  const scope = candles.slice(Math.max(0, candles.length - lookbackBars));
  const method = `fractal pivots (window ${window}) clustered at +/-${tolerancePercent}%, last ${scope.length} bars`;

  if (scope.length < 5) {
    return {
      method,
      tolerancePercent,
      supports: [],
      resistances: [],
      nearestSupport: null,
      nearestResistance: null,
      fiftyTwoWeekHigh: scope.length > 0 ? Math.max(...scope.map((candle) => candle.high)) : null,
      fiftyTwoWeekLow: scope.length > 0 ? Math.min(...scope.map((candle) => candle.low)) : null,
    };
  }

  const offset = candles.length - scope.length;
  const pivots = findPivots(scope, window);
  const lastIndex = scope.length - 1;

  const toLevel = (cluster: Cluster, kind: PriceLevel['kind']): PriceLevel => {
    const price = cluster.prices.reduce((sum, value) => sum + value, 0) / cluster.prices.length;
    const touches = cluster.prices.length;
    const mostRecentIndex = Math.max(...cluster.indices);
    // Recency decay: a level touched recently matters more than an old one.
    const recency = Math.max(0, 1 - (lastIndex - mostRecentIndex) / Math.max(1, scope.length));
    return {
      price,
      kind,
      touches,
      firstTime: cluster.times.reduce((a, b) => (a < b ? a : b)),
      lastTime: cluster.times.reduce((a, b) => (a > b ? a : b)),
      strength: Math.min(1, 0.25 * touches + 0.5 * recency + (mostRecentIndex + offset > 0 ? 0.05 : 0)),
    };
  };

  const highs = clusterPivots(
    pivots.filter((pivot) => pivot.kind === 'high'),
    tolerancePercent,
  ).map((cluster) => toLevel(cluster, 'resistance'));
  const lows = clusterPivots(
    pivots.filter((pivot) => pivot.kind === 'low'),
    tolerancePercent,
  ).map((cluster) => toLevel(cluster, 'support'));

  const lastClose = scope[lastIndex].close;
  const rank = (a: PriceLevel, b: PriceLevel) => b.strength - a.strength || b.touches - a.touches;

  const resistances = highs
    .filter((level) => level.price > lastClose * (1 + tolerancePercent / 200))
    .sort((a, b) => a.price - b.price)
    .slice(0, maxLevels);
  const supports = lows
    .filter((level) => level.price < lastClose * (1 - tolerancePercent / 200))
    .sort((a, b) => b.price - a.price)
    .slice(0, maxLevels);

  const nearestResistance = [...resistances].sort(rank)[0] ?? null;
  const nearestSupport = [...supports].sort(rank)[0] ?? null;

  return {
    method,
    tolerancePercent,
    supports,
    resistances,
    nearestSupport,
    nearestResistance,
    fiftyTwoWeekHigh: Math.max(...scope.map((candle) => candle.high)),
    fiftyTwoWeekLow: Math.min(...scope.map((candle) => candle.low)),
  };
}

export function distanceToLevelPercent(close: number | null, level: PriceLevel | null): number | null {
  if (!isFiniteNumber(close) || level === null || close === 0) return null;
  return ((level.price - close) / close) * 100;
}