/**
 * Deterministic session timestamps for the demo provider.
 * Weekends are skipped so the series resembles a trading calendar without
 * depending on a holiday table. Times are anchored to UTC midnight.
 */

import { startOfUtcDay } from '../utils/dates.ts';

export function demoSessionTimes(count: number, endTime = Date.now()): string[] {
  const safeCount = Math.max(1, Math.min(2000, Math.floor(count)));
  const times: string[] = [];
  let cursor = startOfUtcDay(endTime);
  while (times.length < safeCount) {
    const day = new Date(cursor).getUTCDay();
    if (day !== 0 && day !== 6) {
      times.unshift(new Date(cursor).toISOString());
    }
    cursor -= 86_400_000;
  }
  return times;
}

export function dayTimeFrom(startMs: number, index: number): string {
  return demoSessionTimes(index + 1, startMs + index * 86_400_000)[index] ?? new Date(startMs).toISOString();
}