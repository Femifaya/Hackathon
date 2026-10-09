/**
 * CSV upload fallback for historical OHLCV.
 *
 * Why it exists: free tiers go down, symbols get delisted, and users often have a
 * broker export. Uploaded data is always labelled UPLOADED and never mixed with
 * provider data inside one indicator calculation.
 */

import type { Candle } from './types.ts';
import { validateCandles } from './candles.ts';

export interface CsvOptions {
  maxRows: number;
  maxBytes: number;
  delimiter?: string;
}

export interface RejectedCsvRow {
  line: number;
  reason: string;
}

export interface CsvOhlcvResult {
  candles: Candle[];
  rejected: RejectedCsvRow[];
  warnings: string[];
  delimiter: string;
  headers: string[];
  rowCount: number;
}

const HEADER_ALIASES: Record<string, string[]> = {
  time: ['date', 'time', 'timestamp', 'datetime', 'tradetime'],
  open: ['open', 'o', 'openprice'],
  high: ['high', 'h', 'highprice'],
  low: ['low', 'l', 'lowprice'],
  close: ['close', 'c', 'closeprice', 'adjclose', 'adjustedclose', 'adjclosing'],
  volume: ['volume', 'vol', 'v', 'sharevolume'],
};

function normalizeHeader(value: string): string {
  return value.replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function detectDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/, 1)[0] ?? '';
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/** RFC-4180-ish tokenizer: handles quoted fields, embedded delimiters, and CRLF. */
export function tokenizeCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const normalized = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (inQuotes) {
      if (char === '"') {
        if (normalized[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (char === '\r') {
      continue;
    }
    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((cell) => cell.trim() !== ''));
}

/** Accepts the date shapes that broker and vendor exports actually use. */
export function parseCsvDate(value: string): string | null {
  const text = value.trim().replace(/^\uFEFF/, '');
  if (text === '') return null;

  const iso = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
  if (iso.test(text)) {
    const parsed = Date.parse(text.includes('T') || text.includes(' ') ? text : `${text}T00:00:00Z`);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  const slash = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    const year = Number(slash[3]);
    // US exports are month-first; a value above 12 in the first slot cannot be a month.
    const month = first <= 12 ? first : second;
    const day = first <= 12 ? second : first;
    const parsed = Date.UTC(year, month - 1, day);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  const ymd = text.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
  if (ymd) {
    const parsed = Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  const fallback = Date.parse(text);
  return Number.isFinite(fallback) ? new Date(fallback).toISOString() : null;
}

function resolveColumns(headers: readonly string[]): Record<string, number> {
  const columns: Record<string, number> = {};
  const normalized = headers.map(normalizeHeader);
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      const index = normalized.indexOf(alias);
      if (index >= 0) {
        columns[field] = index;
        break;
      }
    }
  }
  return columns;
}

export function parseOhlcvCsv(text: string, options: CsvOptions): CsvOhlcvResult {
  const warnings: string[] = [];
  const rejected: RejectedCsvRow[] = [];

  if (typeof text !== 'string' || text.trim() === '') {
    return { candles: [], rejected, warnings: ['file was empty'], delimiter: ',', headers: [], rowCount: 0 };
  }
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > options.maxBytes) {
    return {
      candles: [],
      rejected,
      warnings: [`file is ${byteLength} bytes, above the ${options.maxBytes} byte limit`],
      delimiter: ',',
      headers: [],
      rowCount: 0,
    };
  }

  const delimiter = options.delimiter ?? detectDelimiter(text);
  const rows = tokenizeCsv(text, delimiter);
  if (rows.length < 2) {
    return { candles: [], rejected, warnings: ['file has no data rows'], delimiter, headers: rows[0] ?? [], rowCount: 0 };
  }

  const headers = rows[0];
  const columns = resolveColumns(headers);
  const required = ['time', 'open', 'high', 'low', 'close'] as const;
  const missing = required.filter((field) => columns[field] === undefined);
  if (missing.length > 0) {
    return {
      candles: [],
      rejected,
      warnings: [`missing required column(s): ${missing.join(', ')}`],
      delimiter,
      headers,
      rowCount: 0,
    };
  }
  if (columns.volume === undefined) {
    warnings.push('no volume column found; volume-based indicators will report insufficient data');
  }

  const dataRows = rows.slice(1);
  if (dataRows.length > options.maxRows) {
    warnings.push(`file has ${dataRows.length} rows; only the last ${options.maxRows} were used`);
  }
  const scoped = dataRows.slice(Math.max(0, dataRows.length - options.maxRows));

  const candidates: unknown[] = [];
  const candidateLines: number[] = [];
  const firstSkipped = dataRows.length - scoped.length;
  scoped.forEach((row, offset) => {
    const lineNumber = firstSkipped + offset + 2;
    const cell = (field: string): string => {
      const index = columns[field];
      if (index === undefined) return '';
      return (row[index] ?? '').trim();
    };
    const rawTime = cell('time');
    const time = parseCsvDate(rawTime);
    if (time === null) {
      rejected.push({ line: lineNumber, reason: `unparsable date "${rawTime}"` });
      return;
    }
    const numeric = (field: string): number | null => {
      const raw = cell(field);
      if (raw === '') return null;
      const parsed = Number(raw.replace(/[$,\s]/g, ''));
      return Number.isFinite(parsed) ? parsed : null;
    };
    const open = numeric('open');
    const high = numeric('high');
    const low = numeric('low');
    const close = numeric('close');
    if (open === null || high === null || low === null || close === null) {
      rejected.push({ line: lineNumber, reason: 'non-numeric or missing OHLC value' });
      return;
    }
    candidates.push({ time, open, high, low, close, volume: numeric('volume') });
    candidateLines.push(lineNumber);
  });

  const validated = validateCandles(candidates);
  for (const entry of validated.rejected) {
    rejected.push({ line: candidateLines[entry.index] ?? entry.index + 2, reason: entry.reason });
  }
  warnings.push(...validated.warnings);

  return {
    candles: validated.candles,
    rejected,
    warnings,
    delimiter,
    headers,
    rowCount: scoped.length,
  };
}

/** Extension/MIME guard used by the upload route before reading any bytes. */
export function isAllowedCsvUpload(filename: string | null, contentType: string | null): boolean {
  const name = (filename ?? '').toLowerCase();
  const type = (contentType ?? '').toLowerCase();
  const nameOk = name.endsWith('.csv') || name.endsWith('.txt');
  const typeOk =
    type === '' ||
    type === 'text/csv' ||
    type === 'text/plain' ||
    type === 'application/vnd.ms-excel' ||
    type === 'application/csv';
  return nameOk && typeOk;
}