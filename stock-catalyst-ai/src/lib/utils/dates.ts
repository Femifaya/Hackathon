/**
 * Date helpers. All instants are UTC ISO-8601 strings so that server, database,
 * client, and exported reports agree byte-for-byte.
 */

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && (ISO_RE.test(value) || DATE_RE.test(value)) && !Number.isNaN(Date.parse(value));
}

export function toIso(date: Date | number | string): string | null {
  const time = typeof date === 'string' ? Date.parse(date) : typeof date === 'number' ? date : date.getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function secondsBetween(fromIso: string | null | undefined, toIso: string | null | undefined): number | null {
  const from = parseIso(fromIso);
  const to = parseIso(toIso);
  if (from === null || to === null) return null;
  return Math.round((to - from) / 1000);
}

export function addDays(dateIso: string, days: number): string | null {
  const time = parseIso(dateIso);
  if (time === null) return null;
  return new Date(time + days * 86_400_000).toISOString();
}

export function startOfUtcDay(time: number): number {
  const date = new Date(time);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

/** Monday-based week start, used to resample daily candles to weekly. */
export function startOfUtcWeek(time: number): number {
  const date = new Date(startOfUtcDay(time));
  const day = date.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  return date.getTime() + diff * 86_400_000;
}

export function isWeekend(time: number): boolean {
  const day = new Date(time).getUTCDay();
  return day === 0 || day === 6;
}

export type ResampleBucket = 'daily' | 'weekly' | 'monthly';

export function bucketKey(time: number, bucket: ResampleBucket): string {
  const date = new Date(time);
  if (bucket === 'monthly') {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  if (bucket === 'weekly') {
    return new Date(startOfUtcWeek(time)).toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

/** US equity regular session close, 20:00 UTC in EST / 20:00-21:00 with DST. */
export function lastExpectedSessionEnd(referenceIso: string | null | undefined): string | null {
  const reference = referenceIso ? parseIso(referenceIso) : Date.now();
  if (reference === null) return null;
  let cursor = startOfUtcDay(reference);
  // Step back over weekends; assume 21:00 UTC close (conservative for EST/EDT).
  while (isWeekend(cursor)) {
    cursor -= 86_400_000;
  }
  return new Date(cursor + 21 * 3_600_000).toISOString();
}

/**
 * True when the newest data point is older than the tolerance window. Drives the
 * STALE badge; never used to silently substitute a value.
 */
export function isStale(asOfIso: string | null | undefined, staleAfterSeconds: number, nowTime: number = Date.now()): boolean {
  const asOf = parseIso(asOfIso);
  if (asOf === null) return true;
  return nowTime - asOf > staleAfterSeconds * 1000;
}

export function formatTimestampUtc(iso: string | null | undefined): string {
  const time = parseIso(iso);
  if (time === null) return 'timestamp unavailable';
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(time)) + ' UTC';
}

export function formatRelative(fromIso: string | null | undefined, nowTime: number = Date.now()): string {
  const seconds = secondsBetween(fromIso, new Date(nowTime).toISOString());
  if (seconds === null) return 'unknown age';
  const absolute = Math.abs(seconds);
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [1, 'second'],
    [60, 'minute'],
    [3600, 'hour'],
    [86_400, 'day'],
    [604_800, 'week'],
    [2_629_800, 'month'],
    [31_557_600, 'year'],
  ];
  const formatter = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
  let divisor = 1;
  let unit: Intl.RelativeTimeFormatUnit = 'second';
  // Pick the largest unit that still fits the elapsed span.
  for (const [size, name] of units) {
    if (absolute >= size) {
      divisor = size;
      unit = name;
    }
  }
  return formatter.format(-Math.round(seconds / divisor), unit);
}