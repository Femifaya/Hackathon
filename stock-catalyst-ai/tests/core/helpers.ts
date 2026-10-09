/** Deterministic fixture builders shared by the core test suites. */

import type { Candle, CandleSeries } from '../../src/lib/market/types.ts';

export function dayTime(index: number, startMs = Date.UTC(2024, 0, 2)): string {
  return new Date(startMs + index * 86_400_000).toISOString();
}

export function candle(index: number, close: number, options: Partial<Candle> = {}): Candle {
  const open = options.open ?? close;
  const high = options.high ?? Math.max(open, close);
  const low = options.low ?? Math.min(open, close);
  return {
    time: options.time ?? dayTime(index),
    open,
    high,
    low,
    close,
    volume: options.volume === undefined ? 1_000_000 : options.volume,
  };
}

/** Linear ramp: closes start at `start` and step by `step` each bar. */
export function rampSeries(count: number, start = 100, step = 1): Candle[] {
  const out: Candle[] = [];
  for (let index = 0; index < count; index += 1) {
    out.push(candle(index, start + index * step));
  }
  return out;
}

/** Flat series with tiny noise, used to assert "sideways" classification. */
export function flatSeries(count: number, level = 100): Candle[] {
  const out: Candle[] = [];
  for (let index = 0; index < count; index += 1) {
    const close = level + (index % 2 === 0 ? 0.01 : -0.01);
    out.push(candle(index, close, { high: close + 0.05, low: close - 0.05 }));
  }
  return out;
}

/**
 * Sine wave around a rising baseline: produces real pivot highs/lows for the
 * support-resistance and structure tests.
 */
export function waveSeries(count: number, baseline = 100, amplitude = 5, drift = 0.05): Candle[] {
  const out: Candle[] = [];
  for (let index = 0; index < count; index += 1) {
    const close = baseline + drift * index + amplitude * Math.sin(index / 3);
    const high = close + 0.6;
    const low = close - 0.6;
    out.push(candle(index, close, { open: close - 0.1, high, low, volume: 1_000_000 + index * 1000 }));
  }
  return out;
}

export function series(candles: Candle[], symbol = 'TEST', adjustment: CandleSeries['adjustment'] = 'full'): CandleSeries {
  return { symbol, interval: '1d', adjustment, candles };
}

export function closes(candles: readonly Candle[]): number[] {
  return candles.map((item) => item.close);
}

export function approx(actual: number | null, expected: number, tolerance = 1e-6): boolean {
  return actual !== null && Math.abs(actual - expected) <= tolerance;
}