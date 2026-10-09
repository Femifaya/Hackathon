import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectDelimiter, isAllowedCsvUpload, parseCsvDate, parseOhlcvCsv, tokenizeCsv } from '../../src/lib/market/csv.ts';
import { isSafePathSegment, isValidSymbol, normalizeSymbol, toStooqSymbol } from '../../src/lib/market/symbols.ts';
import { normalizeEarnings, normalizeFinancials, normalizeMacroEvents, normalizeNews, normalizeQuote } from '../../src/lib/market/validators.ts';
import { asCached, describeProvenance, makeProvenance, statusLabel, worstStatus } from '../../src/lib/market/provenance.ts';

const CSV_OPTIONS = { maxRows: 1000, maxBytes: 1_000_000 };

describe('csv tokenizer', () => {
  it('detects the delimiter from the header line', () => {
    assert.equal(detectDelimiter('Date,Open,High\n'), ',');
    assert.equal(detectDelimiter('Date;Open;High\n'), ';');
    assert.equal(detectDelimiter('Date\tOpen\tHigh\n'), '\t');
  });

  it('handles quoted fields containing delimiters, quotes, and newlines', () => {
    const rows = tokenizeCsv('a,"b,c","say ""hi""","line1\nline2"\n1,2,3,4\n', ',');
    assert.deepEqual(rows[0], ['a', 'b,c', 'say "hi"', 'line1\nline2']);
    assert.deepEqual(rows[1], ['1', '2', '3', '4']);
  });

  it('strips a UTF-8 BOM and ignores blank lines', () => {
    const rows = tokenizeCsv('\uFEFFDate,Close\n\n2024-01-02,10\n\n', ',');
    assert.equal(rows.length, 2);
    assert.equal(rows[0][0], 'Date');
  });
});

describe('csv date parsing', () => {
  it('accepts the shapes vendor exports use', () => {
    assert.equal(parseCsvDate('2024-01-02'), '2024-01-02T00:00:00.000Z');
    assert.equal(parseCsvDate('2024-01-02T15:30:00Z'), '2024-01-02T15:30:00.000Z');
    assert.equal(parseCsvDate('01/02/2024'), '2024-01-02T00:00:00.000Z');
    assert.equal(parseCsvDate('2024/01/02'), '2024-01-02T00:00:00.000Z');
    assert.equal(parseCsvDate('2024.01.02'), '2024-01-02T00:00:00.000Z');
  });

  it('disambiguates a day above 12 in the first slot', () => {
    assert.equal(parseCsvDate('25/12/2024'), '2024-12-25T00:00:00.000Z');
  });

  it('rejects unparsable dates instead of guessing', () => {
    assert.equal(parseCsvDate('not-a-date'), null);
    assert.equal(parseCsvDate(''), null);
  });
});

describe('parseOhlcvCsv', () => {
  const header = 'Date,Open,High,Low,Close,Volume\n';

  it('parses a vendor export and coerces formatted numbers', () => {
    const text = `${header}2024-01-02,"$10.00",11.50,9.75,"$10.75","1,200"\n2024-01-03,10.75,11,10.5,10.9,1300\n`;
    const result = parseOhlcvCsv(text, CSV_OPTIONS);
    assert.equal(result.candles.length, 2);
    assert.equal(result.candles[0].open, 10);
    assert.equal(result.candles[0].close, 10.75);
    assert.equal(result.candles[0].volume, 1200);
    assert.deepEqual(result.rejected, []);
  });

  it('accepts Yahoo-style Adj.Close headers', () => {
    const text = 'Date,Open,High,Low,Close,Adj.Close,Volume\n2024-01-02,10,11,9,10,9.5,100\n';
    const result = parseOhlcvCsv(text, CSV_OPTIONS);
    assert.equal(result.candles.length, 1);
    assert.equal(result.candles[0].close, 10);
  });

  it('reports per-row rejections with line numbers and keeps valid rows', () => {
    const text = `${header}2024-01-02,10,11,9,10.5,100\nbaddate,1,2,3,4,5\n2024-01-04,x,2,3,4,5\n2024-01-05,10,9,11,10,100\n`;
    const result = parseOhlcvCsv(text, CSV_OPTIONS);
    assert.equal(result.candles.length, 1);
    assert.deepEqual(
      result.rejected.map((row) => row.reason),
      ['unparsable date "baddate"', 'non-numeric or missing OHLC value', 'high below low'],
    );
    assert.deepEqual(result.rejected.map((row) => row.line), [3, 4, 5]);
  });

  it('fails closed when a required column is absent', () => {
    const result = parseOhlcvCsv('Date,Open,High,Low\n2024-01-02,1,2,3\n', CSV_OPTIONS);
    assert.equal(result.candles.length, 0);
    assert.match(result.warnings.join(' '), /missing required column\(s\): close/);
  });

  it('warns when volume is missing so volume indicators report insufficient data', () => {
    const result = parseOhlcvCsv('Date,Open,High,Low,Close\n2024-01-02,10,11,9,10.5\n', CSV_OPTIONS);
    assert.equal(result.candles.length, 1);
    assert.equal(result.candles[0].volume, null);
    assert.match(result.warnings.join(' '), /no volume column/);
  });

  it('enforces the row cap and keeps the most recent rows', () => {
    let text = header;
    for (let index = 0; index < 50; index += 1) {
      text += `${new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10)},10,11,9,10,100\n`;
    }
    const result = parseOhlcvCsv(text, { maxRows: 10, maxBytes: 1_000_000 });
    assert.equal(result.candles.length, 10);
    // The most recent rows are kept, so the window ends on 2024-02-19.
    assert.equal(result.candles[0].time, '2024-02-10T00:00:00.000Z');
    assert.equal(result.candles[9].time, '2024-02-19T00:00:00.000Z');
    assert.match(result.warnings.join(' '), /only the last 10 were used/);
  });

  it('refuses a file above the byte limit before parsing', () => {
    const result = parseOhlcvCsv(`${header}2024-01-02,1,2,3,4,5\n`, { maxRows: 10, maxBytes: 20 });
    assert.equal(result.candles.length, 0);
    assert.match(result.warnings.join(' '), /above the 20 byte limit/);
  });

  it('handles empty input without throwing', () => {
    assert.deepEqual(parseOhlcvCsv('', CSV_OPTIONS).candles, []);
    assert.match(parseOhlcvCsv('Date,Open,High,Low,Close\n', CSV_OPTIONS).warnings.join(' '), /no data rows/);
  });

  it('gates uploads by filename and content type', () => {
    assert.equal(isAllowedCsvUpload('prices.csv', 'text/csv'), true);
    assert.equal(isAllowedCsvUpload('prices.txt', 'text/plain'), true);
    assert.equal(isAllowedCsvUpload('prices.exe', 'application/octet-stream'), false);
    assert.equal(isAllowedCsvUpload('prices.csv', 'text/html'), false);
    assert.equal(isAllowedCsvUpload(null, null), false);
  });
});

describe('symbol handling', () => {
  it('normalises and validates ticker symbols', () => {
    assert.equal(normalizeSymbol(' nvda '), 'NVDA');
    assert.equal(normalizeSymbol('BRK.B'), 'BRK.B');
    assert.equal(normalizeSymbol('BF-B'), 'BF-B');
    assert.equal(isValidSymbol('NVDA'), true);
  });

  it('rejects anything that could reach a URL', () => {
    for (const bad of ['', '   ', 'A'.repeat(11), 'NV DA', 'nvda/../etc', 'https://evil.com', 'NVDA?', '1NVDA', null, 42, {}]) {
      assert.equal(normalizeSymbol(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  it('maps to the stooq convention and rejects unsafe path segments', () => {
    assert.equal(toStooqSymbol('NVDA'), 'nvda.us');
    assert.equal(isSafePathSegment('a-b.c_1'), true);
    assert.equal(isSafePathSegment('../etc'), false);
    assert.equal(isSafePathSegment('a'.repeat(33)), false);
  });
});

describe('payload validators', () => {
  it('accepts a complete quote and coerces formatted numbers', () => {
    const result = normalizeQuote({ price: '$1,234.50', changePercent: '2.5%', volume: '1000' }, 'TEST');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.price, 1234.5);
      assert.equal(result.value.changePercent, 2.5);
      assert.equal(result.value.volume, 1000);
      assert.equal(result.value.symbol, 'TEST');
    }
  });

  it('rejects a quote with neither price nor previous close', () => {
    const result = normalizeQuote({ open: 10 }, 'TEST');
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.path === 'quote.price'));
  });

  it('rejects a non-object payload', () => {
    assert.equal(normalizeQuote(null, 'TEST').ok, false);
    assert.equal(normalizeQuote([1, 2], 'TEST').ok, false);
  });

  it('rejects an inverted high/low quote', () => {
    assert.equal(normalizeQuote({ price: 10, high: 5, low: 20 }, 'TEST').ok, false);
  });

  it('turns absent optional fields into null rather than a default', () => {
    const result = normalizeQuote({ price: 10 }, 'TEST');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.marketCap, null);
      assert.equal(result.value.exchange, null);
      assert.equal(result.value.isMarketOpen, null);
    }
  });

  it('rejects out-of-range numbers', () => {
    const result = normalizeQuote({ price: -5 }, 'TEST');
    assert.equal(result.ok, false);
  });

  it('requires a headline and a date for news, and reports the offending index', () => {
    const result = normalizeNews(
      [
        { headline: 'Good', publishedAt: '2025-01-02T00:00:00Z' },
        { headline: '', publishedAt: '2025-01-02T00:00:00Z' },
        { headline: 'No date' },
        'not-an-object',
      ],
      'TEST',
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.length, 1);
      assert.equal(result.value[0].sentiment, 'unknown');
      assert.equal(result.value[0].source, 'unknown');
    }
    assert.ok(result.issues.some((issue) => issue.path === 'news[1].headline'));
    assert.ok(result.issues.some((issue) => issue.path === 'news[2].publishedAt'));
  });

  it('drops earnings rows without a usable date', () => {
    const result = normalizeEarnings([{ date: 'nope' }, { date: '2025-02-04', epsEstimate: '1.5' }], 'TEST');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.length, 1);
      assert.equal(result.value[0].epsEstimate, 1.5);
      assert.equal(result.value[0].status, 'estimated');
      assert.equal(result.value[0].timeOfDay, 'unknown');
    }
  });

  it('rejects an earnings payload where no row survives', () => {
    assert.equal(normalizeEarnings([{ date: 'nope' }], 'TEST').ok, false);
    assert.equal(normalizeEarnings('nope', 'TEST').ok, false);
  });

  it('normalises financial statements and valuation ratios', () => {
    const result = normalizeFinancials(
      {
        statements: [{ period: 'QUARTERLY', asOf: '2025-06-30', revenue: '9,500,000,000', eps: 1.42 }],
        ratios: { peTrailing: '31.4', beta: '1.35', fiftyTwoWeekHigh: '198.5' },
      },
      'TEST',
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.statements[0].revenue, 9_500_000_000);
      assert.equal(result.value.statements[0].period, 'quarterly');
      assert.equal(result.value.ratios.peTrailing, 31.4);
      assert.equal(result.value.ratios.priceToBook, null);
    }
  });

  it('falls back to a safe enum value and records the issue', () => {
    const result = normalizeMacroEvents([{ name: 'CPI', scheduledAt: '2025-01-15T13:30:00Z', importance: 'critical' }]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value[0].importance, 'medium');
      assert.equal(result.value[0].region, 'US');
    }
    assert.ok(result.issues.some((issue) => issue.message.includes('critical')));
  });

  it('caps the number of rows normalised from an oversized payload', () => {
    const many = Array.from({ length: 200 }, (_, index) => ({ headline: `h${index}`, publishedAt: '2025-01-02T00:00:00Z' }));
    const result = normalizeNews(many, 'TEST');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.length, 40);
  });
});

describe('provenance labelling', () => {
  const now = Date.UTC(2025, 5, 15, 12, 0, 0);

  it('derives delay and staleness from the as-of timestamp', () => {
    const fresh = makeProvenance({ source: 'stooq', status: 'live', asOf: '2025-06-15T11:59:00.000Z', staleAfterSeconds: 900, nowTime: now });
    assert.equal(fresh.stale, false);
    assert.equal(fresh.delaySeconds, 60);

    const old = makeProvenance({ source: 'stooq', status: 'live', asOf: '2025-06-15T10:00:00.000Z', staleAfterSeconds: 900, nowTime: now });
    assert.equal(old.stale, true);
  });

  it('treats a missing as-of as stale rather than fresh', () => {
    const unknown = makeProvenance({ source: 'x', status: 'live', asOf: null, staleAfterSeconds: 900, nowTime: now });
    assert.equal(unknown.delaySeconds, null);
  });

  it('relabels a cache hit and keeps the original timestamps', () => {
    const original = makeProvenance({ source: 'finnhub', status: 'delayed', asOf: '2025-06-15T11:59:00.000Z', retrievedAt: '2025-06-15T11:59:30.000Z', staleAfterSeconds: 900, nowTime: now });
    const cached = asCached(original, 900, now);
    assert.equal(cached.status, 'cached');
    assert.equal(cached.asOf, original.asOf);
    assert.equal(cached.retrievedAt, original.retrievedAt);
    assert.match(cached.note ?? '', /served from cache \(age 30s\)/);
  });

  it('reports the least trustworthy status across a panel', () => {
    const live = makeProvenance({ source: 'a', status: 'live', nowTime: now });
    const demo = makeProvenance({ source: 'b', status: 'demo', nowTime: now });
    const cached = makeProvenance({ source: 'c', status: 'cached', nowTime: now });
    assert.equal(worstStatus([live, cached]), 'cached');
    assert.equal(worstStatus([live, demo, cached]), 'demo');
    assert.equal(worstStatus([null, null]), 'unavailable');
    assert.equal(worstStatus([]), 'unavailable');
  });

  it('labels every status and describes it in exports', () => {
    assert.equal(statusLabel('uploaded'), 'UPLOADED');
    const provenance = makeProvenance({ source: 'csv-upload', status: 'uploaded', asOf: '2025-06-15T00:00:00.000Z', note: 'user file', nowTime: now });
    const text = describeProvenance(provenance);
    assert.match(text, /source: csv-upload/);
    assert.match(text, /status: UPLOADED/);
    assert.match(text, /note: user file/);
    assert.equal(describeProvenance(null), 'No source available.');
  });
});