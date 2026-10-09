/**
 * Single entry point for technical analysis.
 *
 * Every indicator is a pure, causal function of validated OHLCV data. Nothing here
 * calls a network, a model, or a database, and nothing here produces an opinion:
 * outputs are labelled CALCULATION wherever they are rendered.
 */

import type { CandleSeries } from '../market/types.ts';
import type { IndicatorSnapshot } from './types.ts';
import { MIN_BARS } from './types.ts';
import { closesOf, hasCompleteVolume, volumesOf } from '../market/candles.ts';
import { smaResult } from './sma.ts';
import { emaResult } from './ema.ts';
import { rsiResult, rsiState } from './rsi.ts';
import { macd } from './macd.ts';
import { atrPercent, atrResult, volatilityRegime } from './atr.ts';
import { bollinger } from './bollinger.ts';
import { volumeTrend } from './volume.ts';
import { supportResistance } from './support-resistance.ts';
import { classifyTrend } from './trend.ts';
import { multiTimeframeTrend } from './multi-timeframe.ts';

export * from './types.ts';
export { sma, smaResult, smaCrossState, smaSlopePercentPerBar, distanceFromSmaPercent } from './sma.ts';
export { ema, emaResult, emaOfSeries, emaAlpha, emaLatest } from './ema.ts';
export { rsi, rsiResult, rsiDetail, rsiState, rsiDivergence, RSI_OVERBOUGHT, RSI_OVERSOLD } from './rsi.ts';
export { macd } from './macd.ts';
export { atr, atrResult, atrPercent, atrPercentSeries, trueRange, volatilityRegime } from './atr.ts';
export { bollinger } from './bollinger.ts';
export { averageVolume, volumeTrend, volumeSignal } from './volume.ts';
export { findPivots, supportResistance, distanceToLevelPercent } from './support-resistance.ts';
export { classifyTrend, SLOPE_UP_THRESHOLD, SLOPE_DOWN_THRESHOLD } from './trend.ts';
export { multiTimeframeTrend, MIN_BARS_PER_FRAME } from './multi-timeframe.ts';
export { linearSlope, populationStdDev, mean, percentChange, roundTo } from './math.ts';

export interface SnapshotOptions {
  nowTime?: number;
  extraWarnings?: string[];
}

export function computeIndicatorSnapshot(
  symbol: string,
  series: CandleSeries,
  options: SnapshotOptions = {},
): IndicatorSnapshot {
  const candles = series.candles;
  const closes = closesOf(candles);
  const bars = candles.length;
  const warnings = [...(options.extraWarnings ?? [])];
  const insufficientData: string[] = [];

  const requireBars = (id: string, needed: number): boolean => {
    if (bars >= needed) return true;
    insufficientData.push(id);
    return false;
  };

  const sma20 = requireBars('sma20', MIN_BARS.sma20) ? smaResult(closes, 20) : null;
  const sma50 = requireBars('sma50', MIN_BARS.sma50) ? smaResult(closes, 50) : null;
  const ema20 = requireBars('ema20', MIN_BARS.ema20) ? emaResult(closes, 20) : null;
  const ema50 = requireBars('ema50', MIN_BARS.ema50) ? emaResult(closes, 50) : null;
  const rsi14 = requireBars('rsi14', MIN_BARS.rsi14) ? rsiResult(closes, 14) : null;
  const macdResult = requireBars('macd', MIN_BARS.macd) ? macd(closes) : null;
  const atr14 = requireBars('atr14', MIN_BARS.atr14) ? atrResult(candles, 14) : null;
  const bollingerResult = requireBars('bollinger', MIN_BARS.bollinger) ? bollinger(closes, { period: 20, multiplier: 2 }) : null;

  const volumeComplete = hasCompleteVolume(candles);
  const volume = requireBars('volume', MIN_BARS.volume)
    ? volumeTrend(volumesOf(candles), 20, volumeComplete)
    : null;
  if (!volumeComplete && bars > 0) {
    warnings.push('volume is incomplete in this series; volume-based signals are marked insufficient_data');
  }

  const levels = requireBars('levels', MIN_BARS.levels)
    ? supportResistance(candles, { window: 2, tolerancePercent: 1 })
    : null;
  const trend = requireBars('trend', MIN_BARS.trend) ? classifyTrend(candles) : null;
  const multiTimeframe = bars >= MIN_BARS.trend ? multiTimeframeTrend(candles) : null;

  if (series.adjustment === 'unknown') {
    warnings.push('corporate-action adjustment of this series is unknown; indicator values may be distorted');
  } else if (series.adjustment === 'none') {
    warnings.push('prices are unadjusted; splits and dividends will distort moving averages');
  }
  if (bars < MIN_BARS.sma50) {
    warnings.push(`history has ${bars} bars; 50-period indicators need at least ${MIN_BARS.sma50}`);
  }

  const atrPct = atr14 ? atrPercent(candles, 14) : null;
  const regime = volatilityRegime(atrPct);
  if (regime === 'high' || regime === 'elevated') {
    warnings.push(`ATR(14) is ${atrPct === null ? 'n/a' : `${atrPct.toFixed(2)}%`} of price (${regime} volatility)`);
  }

  const lastClose = bars > 0 ? candles[bars - 1].close : null;

  return {
    symbol,
    interval: series.interval,
    adjustment: series.adjustment,
    computedAt: new Date(options.nowTime ?? Date.now()).toISOString(),
    barsUsed: bars,
    firstTime: bars > 0 ? candles[0].time : null,
    lastTime: bars > 0 ? candles[bars - 1].time : null,
    lastClose,
    sma20,
    sma50,
    ema20,
    ema50,
    rsi14,
    rsiState: rsiState(rsi14 ? rsi14.latest : null),
    macd: macdResult,
    atr14,
    atrPercent: atrPct,
    bollinger: bollingerResult,
    volume,
    levels,
    trend,
    multiTimeframe,
    insufficientData,
    warnings,
  };
}
