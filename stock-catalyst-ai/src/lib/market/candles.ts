/**
 * Candle hygiene. Everything downstream (indicators, scenarios, AI evidence)
 * consumes the output of `validateCandles`, so a malformed upstream payload can
 * never reach a calculation.
 */

import type { Candle, CandleInterval } from './types.ts';
import { bucketKey, parseIso } from '../utils/dates.ts';
import type { ResampleBucket } from '../utils/dates.ts';

export interface RejectedCandle {
  index: number;
  time: string | null;
  reason: string;
}

export interface CandleValidationResult {
  candles: Candle[];
  rejected: RejectedCandle[];
  warnings: string[];
  duplicatesRemoved: number;
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function coerceVolume(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'string' ? Number(value) : value;
  return finiteNonNegative(numeric) ? numeric : null;
}

function coercePrice(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'string' ? Number(value) : value;
  return finitePositive(numeric) ? numeric : null;
}

/**
 * Validates, normalises, de-duplicates, and sorts candles ascending by time.
 * Invalid rows are rejected with a reason; they are never silently repaired.
 */
export function validateCandles(input: readonly unknown[]): CandleValidationResult {
  const rejected: RejectedCandle[] = [];
  const warnings: string[] = [];
  const accepted: Candle[] = [];

  if (!Array.isArray(input)) {
    return { candles: [], rejected, warnings: ['payload was not an array'], duplicatesRemoved: 0 };
  }

  for (let index = 0; index < input.length; index += 1) {
    const raw = input[index] as Record<string, unknown> | null;
    const rawTime = typeof raw?.time === 'string' ? raw.time : null;
    if (!raw || typeof raw !== 'object') {
      rejected.push({ index, time: rawTime, reason: 'not an object' });
      continue;
    }
    const time = parseIso(rawTime ?? (typeof raw.date === 'string' ? raw.date : null));
    if (time === null) {
      rejected.push({ index, time: rawTime, reason: 'missing or unparsable time' });
      continue;
    }
    const open = coercePrice(raw.open);
    const high = coercePrice(raw.high);
    const low = coercePrice(raw.low);
    const close = coercePrice(raw.close);
    if (open === null || high === null || low === null || close === null) {
      rejected.push({ index, time: rawTime, reason: 'missing or non-positive OHLC value' });
      continue;
    }
    if (high < low) {
      rejected.push({ index, time: rawTime, reason: 'high below low' });
      continue;
    }
    if (high < Math.max(open, close) || low > Math.min(open, close)) {
      rejected.push({ index, time: rawTime, reason: 'high/low do not contain open/close' });
      continue;
    }
    accepted.push({
      time: new Date(time).toISOString(),
      open,
      high,
      low,
      close,
      volume: coerceVolume(raw.volume),
    });
  }

  const byTime = new Map<string, Candle>();
  let duplicatesRemoved = 0;
  for (const candle of accepted) {
    if (byTime.has(candle.time)) duplicatesRemoved += 1;
    // Last write wins: providers return the most recent correction last.
    byTime.set(candle.time, candle);
  }

  const candles = [...byTime.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const unsorted = accepted.some(
    (candle, index) => index > 0 && Date.parse(candle.time) < Date.parse(accepted[index - 1].time),
  );
  if (unsorted) warnings.push('input candles were not in ascending time order; sorted before use');
  if (duplicatesRemoved > 0) {
    warnings.push(`${duplicatesRemoved} duplicate timestamp(s) removed; latest value kept`);
  }
  if (rejected.length > 0) {
    warnings.push(`${rejected.length} row(s) rejected during validation`);
  }

  return { candles, rejected, warnings, duplicatesRemoved };
}

export interface CandleCoverage {
  count: number;
  firstTime: string | null;
  lastTime: string | null;
  spanDays: number | null;
  largestGapDays: number | null;
  missingVolumeBars: number;
}

export function candleCoverage(candles: readonly Candle[]): CandleCoverage {
  if (candles.length === 0) {
    return {
      count: 0,
      firstTime: null,
      lastTime: null,
      spanDays: null,
      largestGapDays: null,
      missingVolumeBars: 0,
    };
  }
  const first = candles[0];
  const last = candles[candles.length - 1];
  const firstTime = Date.parse(first.time);
  const lastTime = Date.parse(last.time);
  let largestGap = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const gap = Date.parse(candles[index].time) - Date.parse(candles[index - 1].time);
    if (gap > largestGap) largestGap = gap;
  }
  return {
    count: candles.length,
    firstTime: first.time,
    lastTime: last.time,
    spanDays: Math.round((lastTime - firstTime) / 86_400_000),
    largestGapDays: Math.round(largestGap / 86_400_000),
    missingVolumeBars: candles.filter((candle) => candle.volume === null).length,
  };
}

export function intervalToBucket(interval: CandleInterval): ResampleBucket {
  if (interval === '1wk') return 'weekly';
  if (interval === '1mo') return 'monthly';
  return 'daily';
}

/**
 * Aggregates a daily series into a coarser bucket. Volume sums; a bucket whose
 * members all lack volume yields `null` rather than a fabricated zero.
 */
export function resampleCandles(candles: readonly Candle[], bucket: ResampleBucket): Candle[] {
  if (bucket === 'daily') return [...candles];
  const groups = new Map<string, Candle[]>();
  for (const candle of candles) {
    const time = Date.parse(candle.time);
    if (!Number.isFinite(time)) continue;
    const key = bucketKey(time, bucket);
    const existing = groups.get(key);
    if (existing) existing.push(candle);
    else groups.set(key, [candle]);
  }

  const out: Candle[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const volumes = sorted.map((candle) => candle.volume).filter((value): value is number => value !== null);
    out.push({
      time: sorted[0].time,
      open: sorted[0].open,
      high: Math.max(...sorted.map((candle) => candle.high)),
      low: Math.min(...sorted.map((candle) => candle.low)),
      close: sorted[sorted.length - 1].close,
      volume: volumes.length > 0 ? volumes.reduce((sum, value) => sum + value, 0) : null,
    });
  }
  return out.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

export function closesOf(candles: readonly Candle[]): number[] {
  return candles.map((candle) => candle.close);
}

export function volumesOf(candles: readonly Candle[]): number[] {
  return candles.map((candle) => candle.volume ?? 0);
}

export function hasCompleteVolume(candles: readonly Candle[]): boolean {
  return candles.length > 0 && candles.every((candle) => candle.volume !== null);
}