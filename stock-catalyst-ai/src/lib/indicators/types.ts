/** Shared shapes for the technical-analysis layer. */

import type { AdjustmentKind, CandleInterval } from '../market/types.ts';

export type Series = Array<number | null>;

export type TrendDirection = 'up' | 'down' | 'sideways';

export interface SeriesResult {
  period: number;
  values: Series;
  latest: number | null;
  latestIndex: number | null;
}

export interface MacdResult {
  fast: number;
  slow: number;
  signalPeriod: number;
  macd: Series;
  signal: Series;
  histogram: Series;
  latest: {
    macd: number | null;
    signal: number | null;
    histogram: number | null;
    state: 'bullish_cross' | 'bearish_cross' | 'bullish' | 'bearish' | 'neutral';
  };
}

export interface BollingerResult {
  period: number;
  multiplier: number;
  middle: Series;
  upper: Series;
  lower: Series;
  bandwidth: Series;
  percentB: Series;
  latest: {
    middle: number | null;
    upper: number | null;
    lower: number | null;
    bandwidth: number | null;
    percentB: number | null;
    position: 'above_upper' | 'upper_half' | 'lower_half' | 'below_lower' | 'unknown';
  };
}

export interface VolumeTrendResult {
  period: number;
  average: Series;
  ratio: Series;
  latestAverage: number | null;
  latestRatio: number | null;
  direction: 'rising' | 'falling' | 'flat' | 'insufficient_data';
  slopePercentPerBar: number | null;
  complete: boolean;
}

export interface PriceLevel {
  price: number;
  kind: 'support' | 'resistance';
  touches: number;
  firstTime: string;
  lastTime: string;
  strength: number;
}

export interface LevelsResult {
  method: string;
  tolerancePercent: number;
  supports: PriceLevel[];
  resistances: PriceLevel[];
  nearestSupport: PriceLevel | null;
  nearestResistance: PriceLevel | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
}

export interface TrendResult {
  direction: TrendDirection;
  /** 0..1 composite of slope, moving-average alignment, and structure. */
  strength: number;
  slopePercentPerBar: number | null;
  closeVsSma20Percent: number | null;
  sma20VsSma50Percent: number | null;
  higherHighs: boolean | null;
  higherLows: boolean | null;
  barsUsed: number;
  reason: string;
}

export type Timeframe = 'daily' | 'weekly' | 'monthly';

export interface TimeframeTrend {
  timeframe: Timeframe;
  bars: number;
  trend: TrendResult | null;
  note: string | null;
}

export interface MultiTimeframeResult {
  frames: TimeframeTrend[];
  alignment: 'aligned_bullish' | 'aligned_bearish' | 'mixed' | 'insufficient_data';
  /** -1 (fully bearish) .. +1 (fully bullish). */
  score: number;
  note: string;
}

export interface IndicatorSnapshot {
  symbol: string;
  interval: CandleInterval;
  adjustment: AdjustmentKind;
  computedAt: string;
  barsUsed: number;
  firstTime: string | null;
  lastTime: string | null;
  lastClose: number | null;
  sma20: SeriesResult | null;
  sma50: SeriesResult | null;
  ema20: SeriesResult | null;
  ema50: SeriesResult | null;
  rsi14: SeriesResult | null;
  rsiState: 'overbought' | 'oversold' | 'neutral' | 'insufficient_data';
  macd: MacdResult | null;
  atr14: SeriesResult | null;
  atrPercent: number | null;
  bollinger: BollingerResult | null;
  volume: VolumeTrendResult | null;
  levels: LevelsResult | null;
  trend: TrendResult | null;
  multiTimeframe: MultiTimeframeResult | null;
  /** Indicator ids that could not be computed because history is too short. */
  insufficientData: string[];
  warnings: string[];
}

export const MIN_BARS: Record<string, number> = {
  sma20: 20,
  sma50: 50,
  ema20: 20,
  ema50: 50,
  rsi14: 15,
  macd: 34,
  atr14: 15,
  bollinger: 20,
  volume: 20,
  levels: 10,
  trend: 20,
};