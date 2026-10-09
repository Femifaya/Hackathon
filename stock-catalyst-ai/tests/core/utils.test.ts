import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  addDays,
  bucketKey,
  formatRelative,
  formatTimestampUtc,
  isIsoTimestamp,
  isStale,
  lastExpectedSessionEnd,
  nowIso,
  parseIso,
  secondsBetween,
  startOfUtcWeek,
  toIso,
} from '../../src/lib/utils/dates.ts';
import {
  clamp,
  formatBytes,
  formatCompact,
  formatNumber,
  formatPercent,
  formatPrice,
  formatRatioAsPercent,
  labelFor,
  round,
  titleCase,
  truncate,
} from '../../src/lib/utils/format.ts';
import { createId, isPrefixedId } from '../../src/lib/utils/id.ts';
import { redactSecrets } from '../../src/lib/utils/logger.ts';
import { err, firstOk, isErr, isOk, mapResult, ok, unwrapOr } from '../../src/lib/utils/result.ts';

const NOW = Date.UTC(2025, 5, 15, 12, 0, 0);

describe('dates', () => {
  it('validates ISO timestamps and rejects anything else', () => {
    assert.equal(isIsoTimestamp('2025-06-15T12:00:00.000Z'), true);
    assert.equal(isIsoTimestamp('2025-06-15'), true);
    assert.equal(isIsoTimestamp('15 June 2025'), false);
    assert.equal(isIsoTimestamp(null), false);
    assert.equal(isIsoTimestamp(123), false);
  });

  it('round-trips instants', () => {
    assert.equal(toIso('2025-06-15T12:00:00Z'), '2025-06-15T12:00:00.000Z');
    assert.equal(toIso(NOW), '2025-06-15T12:00:00.000Z');
    assert.equal(toIso('garbage'), null);
    assert.equal(parseIso(null), null);
    assert.ok(isIsoTimestamp(nowIso()));
  });

  it('measures elapsed seconds and staleness', () => {
    const asOf = '2025-06-15T11:00:00.000Z';
    assert.equal(secondsBetween(asOf, '2025-06-15T12:00:00.000Z'), 3600);
    assert.equal(isStale(asOf, 900, NOW), true);
    assert.equal(isStale('2025-06-15T11:59:00.000Z', 900, NOW), false);
    assert.equal(isStale(null, 900, NOW), true);
  });

  it('anchors weekly buckets to Monday', () => {
    // 2025-06-15 is a Sunday.
    assert.equal(startOfUtcWeek(Date.UTC(2025, 5, 15)), Date.UTC(2025, 5, 9));
    assert.equal(bucketKey(Date.UTC(2025, 5, 15), 'weekly'), '2025-06-09');
    assert.equal(bucketKey(Date.UTC(2025, 5, 15), 'monthly'), '2025-06');
    assert.equal(bucketKey(Date.UTC(2025, 5, 15), 'daily'), '2025-06-15');
  });

  it('adds days and finds the last expected session end', () => {
    assert.equal(addDays('2025-06-15T00:00:00.000Z', 1), '2025-06-16T00:00:00.000Z');
    assert.equal(addDays('garbage', 1), null);
    // Sunday 2025-06-15 -> steps back to Friday 2025-06-13 21:00 UTC.
    assert.equal(lastExpectedSessionEnd('2025-06-15T09:00:00.000Z'), '2025-06-13T21:00:00.000Z');
  });

  it('formats timestamps defensively', () => {
    assert.equal(formatTimestampUtc(null), 'timestamp unavailable');
    assert.match(formatTimestampUtc('2025-06-15T12:00:00.000Z'), /Jun 15, 2025/);
    assert.match(formatTimestampUtc('2025-06-15T12:00:00.000Z'), /UTC$/);
    assert.equal(formatRelative('2025-06-15T11:00:00.000Z', NOW), '1 hour ago');
    assert.equal(formatRelative('2025-06-15T11:59:30.000Z', NOW), '30 seconds ago');
    assert.equal(formatRelative('2025-06-14T12:00:00.000Z', NOW), 'yesterday');
    assert.equal(formatRelative('2025-06-15T13:00:00.000Z', NOW), 'in 1 hour');
    assert.equal(formatRelative(null, NOW), 'unknown age');
  });
});

describe('formatting', () => {
  it('renders n/a for every non-finite value instead of NaN', () => {
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(formatNumber(value), 'n/a');
      assert.equal(formatPrice(value), 'n/a');
      assert.equal(formatPercent(value), 'n/a');
      assert.equal(formatCompact(value), 'n/a');
      assert.equal(formatBytes(value), 'n/a');
    }
  });

  it('formats money, percent, and compact values', () => {
    assert.equal(formatPrice(1234.5), '$1,234.50');
    assert.equal(formatPrice(0.1234), '$0.1234');
    assert.equal(formatPercent(3.14159), '+3.14%');
    assert.equal(formatPercent(-2), '-2.00%');
    assert.equal(formatRatioAsPercent(0.031), '+3.10%');
    assert.equal(formatCompact(1_500_000), '1.5M');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(512), '512 B');
  });

  it('truncates, clamps, rounds, and labels safely', () => {
    assert.equal(truncate('abcdefgh', 5), 'abcd…');
    assert.equal(truncate('abc', 5), 'abc');
    assert.equal(clamp(5, 0, 1), 1);
    assert.equal(round(1.23456, 2), 1.23);
    assert.equal(titleCase('earnings_MISS'), 'Earnings Miss');
    assert.equal(labelFor('rate_limited'), 'Rate Limited');
    assert.equal(labelFor('   '), 'Unknown');
  });
});

describe('ids', () => {
  it('creates prefixed ids and validates them', () => {
    const id = createId('rpt', () => 0.5, NOW);
    assert.ok(id.startsWith('rpt_'));
    assert.equal(isPrefixedId(id, 'rpt'), true);
    assert.equal(isPrefixedId(id, 'wtc'), false);
    assert.equal(isPrefixedId('rpt_' + 'a'.repeat(120), 'rpt'), false);
    assert.equal(isPrefixedId(42, 'rpt'), false);
  });

  it('produces unique ids with the default entropy source', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createId('rpt')));
    assert.equal(ids.size, 200);
  });
});

describe('logger redaction', () => {
  it('redacts credential-shaped keys and values', () => {
    const redacted = redactSecrets({
      apiKey: 'super-secret-value',
      authorization: 'Bearer abc',
      nested: { providerToken: 'xyz', safe: 'keep me' },
      list: ['sk-abcdefghij1234567890'],
      count: 3,
    }) as Record<string, unknown>;
    assert.equal(redacted.apiKey, '[REDACTED]');
    assert.equal(redacted.authorization, '[REDACTED]');
    assert.deepEqual(redacted.nested, { providerToken: '[REDACTED]', safe: 'keep me' });
    assert.deepEqual(redacted.list, ['[REDACTED]']);
    assert.equal(redacted.count, 3);
  });
});

describe('result helpers', () => {
  it('discriminates success from failure', () => {
    const success = ok(1);
    const failure = err('boom');
    assert.equal(isOk(success), true);
    assert.equal(isErr(failure), true);
    assert.equal(unwrapOr(failure, 9), 9);
    assert.deepEqual(mapResult(success, (value) => value + 1), ok(2));
    assert.deepEqual(mapResult(failure, (value: number) => value + 1), failure);
  });

  it('picks the first success or the last error', () => {
    assert.deepEqual(firstOk([err('a'), ok(2), ok(3)]), ok(2));
    assert.deepEqual(firstOk([err('a'), err('b')]), err('b'));
    assert.equal(firstOk([]), null);
  });
});