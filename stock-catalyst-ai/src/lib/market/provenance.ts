/**
 * Data provenance and status labelling.
 *
 * Every value shown in the UI carries one of these labels. The labelling rules
 * live here so that adapters, the cache, and CSV upload cannot disagree.
 */

import type { DataProvenance, DataStatus } from './types.ts';
import { isStale, nowIso, secondsBetween } from '../utils/dates.ts';

export interface ProvenanceInput {
  source: string;
  status: DataStatus;
  asOf?: string | null;
  retrievedAt?: string;
  delaySeconds?: number | null;
  staleAfterSeconds?: number;
  note?: string | null;
  nowTime?: number;
}

export function makeProvenance(input: ProvenanceInput): DataProvenance {
  const retrievedAt = input.retrievedAt ?? nowIso();
  const asOf = input.asOf ?? null;
  const staleAfterSeconds = input.staleAfterSeconds ?? 900;
  const nowTime = input.nowTime ?? Date.now();
  const delaySeconds =
    input.delaySeconds ?? (asOf === null ? null : secondsBetween(asOf, new Date(nowTime).toISOString()));

  return {
    source: input.source,
    status: input.status,
    retrievedAt,
    asOf,
    delaySeconds,
    stale: isStale(asOf ?? retrievedAt, staleAfterSeconds, nowTime),
    note: input.note ?? null,
  };
}

export function unavailableProvenance(source: string, note: string): DataProvenance {
  return {
    source,
    status: 'unavailable',
    retrievedAt: nowIso(),
    asOf: null,
    delaySeconds: null,
    stale: true,
    note,
  };
}

/** Rewrites provenance for a cache hit without losing the original timestamps. */
export function asCached(original: DataProvenance, staleAfterSeconds: number, nowTime = Date.now()): DataProvenance {
  const ageSeconds = secondsBetween(original.retrievedAt, new Date(nowTime).toISOString());
  return {
    ...original,
    status: 'cached',
    stale: isStale(original.asOf ?? original.retrievedAt, staleAfterSeconds, nowTime),
    note: [original.note, `served from cache${ageSeconds === null ? '' : ` (age ${ageSeconds}s)`}`]
      .filter(Boolean)
      .join('; '),
  };
}

export const STATUS_LABELS: Record<DataStatus, string> = {
  live: 'LIVE',
  delayed: 'DELAYED',
  cached: 'CACHED',
  uploaded: 'UPLOADED',
  demo: 'DEMO',
  unavailable: 'UNAVAILABLE',
};

export const STATUS_DESCRIPTIONS: Record<DataStatus, string> = {
  live: 'Real-time or same-session data from the configured provider.',
  delayed: 'Provider reports a delay; see the as-of timestamp.',
  cached: 'Served from the local cache to respect provider rate limits.',
  uploaded: 'Loaded from a CSV file you supplied.',
  demo: 'Offline demonstration data. Synthetic - not real market data.',
  unavailable: 'Could not be retrieved from any configured source. No value is shown or estimated.',
};

export function statusLabel(status: DataStatus): string {
  return STATUS_LABELS[status] ?? 'UNKNOWN';
}

export function statusDescription(status: DataStatus): string {
  return STATUS_DESCRIPTIONS[status] ?? 'Unknown data status.';
}

const STATUS_SEVERITY: Record<DataStatus, number> = {
  live: 0,
  delayed: 1,
  cached: 2,
  uploaded: 3,
  demo: 4,
  unavailable: 5,
};

/** The least trustworthy status in a set - used for the panel-level badge. */
export function worstStatus(provenances: ReadonlyArray<DataProvenance | null>): DataStatus {
  let worst: DataStatus = 'live';
  let seen = false;
  for (const provenance of provenances) {
    if (provenance === null) continue;
    seen = true;
    if (STATUS_SEVERITY[provenance.status] > STATUS_SEVERITY[worst]) worst = provenance.status;
  }
  return seen ? worst : 'unavailable';
}

export function anyStale(provenances: ReadonlyArray<DataProvenance | null>): boolean {
  return provenances.some((provenance) => provenance?.stale === true);
}

/** Human-readable summary used in reports and exports. */
export function describeProvenance(provenance: DataProvenance | null): string {
  if (provenance === null) return 'No source available.';
  const parts = [
    `source: ${provenance.source}`,
    `status: ${statusLabel(provenance.status)}`,
    `as of: ${provenance.asOf ?? 'unknown'}`,
    `retrieved: ${provenance.retrievedAt}`,
  ];
  if (provenance.delaySeconds !== null) parts.push(`delay: ${provenance.delaySeconds}s`);
  if (provenance.stale) parts.push('STALE');
  if (provenance.note) parts.push(`note: ${provenance.note}`);
  return parts.join(' | ');
}