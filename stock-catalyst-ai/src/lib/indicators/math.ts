/** Small numeric helpers shared by every indicator. */

import type { Series } from './types.ts';

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Population standard deviation (the convention used by Bollinger Bands). */
export function populationStdDev(values: readonly number[]): number | null {
  const average = mean(values);
  if (average === null) return null;
  let total = 0;
  for (const value of values) total += (value - average) ** 2;
  return Math.sqrt(total / values.length);
}

export function lastFiniteIndex(values: ReadonlyArray<Series[number]>): number | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (isFiniteNumber(value)) return index;
  }
  return null;
}

export function lastFinite(values: ReadonlyArray<Series[number]>): number | null {
  const index = lastFiniteIndex(values);
  return index === null ? null : (values[index] as number);
}

/** Ordinary least-squares slope of y over x = 0..n-1. */
export function linearSlope(values: readonly number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const meanX = (n - 1) / 2;
  const meanY = mean(values);
  if (meanY === null) return null;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = index - meanX;
    numerator += dx * (values[index] - meanY);
    denominator += dx * dx;
  }
  if (denominator === 0) return null;
  return numerator / denominator;
}

export function percentChange(from: number | null | undefined, to: number | null | undefined): number | null {
  if (!isFiniteNumber(from) || !isFiniteNumber(to) || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

export function roundTo(value: number | null, digits = 6): number | null {
  if (!isFiniteNumber(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function countFinite(values: ReadonlyArray<Series[number]>): number {
  let count = 0;
  for (const value of values) if (isFiniteNumber(value)) count += 1;
  return count;
}
