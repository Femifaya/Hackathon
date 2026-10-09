/**
 * Shared payload validation for every provider adapter.
 *
 * Adapters translate a provider's shape into a plain record; these functions
 * enforce the domain contract on that record. A payload that does not validate is
 * reported as `bad_payload` - it is never partially accepted and never padded with
 * invented defaults. Optional fields become `null`, which the UI renders as "n/a".
 */

import type {
  AnalystEstimates,
  CompanyProfile,
  EarningsEvent,
  FinancialStatement,
  Financials,
  MacroEvent,
  NewsItem,
  Quote,
  ValuationRatios,
} from './types.ts';
import { isIsoTimestamp } from '../utils/dates.ts';

export interface ValidationIssue {
  path: string;
  message: string;
  /** Fatal issues invalidate the whole payload; non-fatal ones null the field. */
  fatal?: boolean;
}

export type ParseResult<T> =
  | { ok: true; value: T; issues: ValidationIssue[] }
  | { ok: false; value: null; issues: ValidationIssue[] };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface FieldOptions {
  required?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
}

function findValue(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (key in source && source[key] !== undefined) return source[key];
  }
  return undefined;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

export function fieldNumber(
  source: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  issues: ValidationIssue[],
  options: FieldOptions = {},
): number | null {
  const raw = findValue(source, keys);
  if (isEmpty(raw)) {
    if (options.required) issues.push({ path, message: 'required numeric field is missing' });
    return null;
  }
  const parsed = typeof raw === 'number' ? raw : Number(String(raw).replace(/[$,%\s]/g, ''));
  if (!Number.isFinite(parsed)) {
    issues.push({ path, message: `value "${String(raw)}" is not a finite number` });
    return null;
  }
  if (options.min !== undefined && parsed < options.min) {
    issues.push({ path, message: `value ${parsed} is below the minimum ${options.min}` });
    return null;
  }
  if (options.max !== undefined && parsed > options.max) {
    issues.push({ path, message: `value ${parsed} exceeds the maximum ${options.max}` });
    return null;
  }
  return parsed;
}

export function fieldString(
  source: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  issues: ValidationIssue[],
  options: FieldOptions = {},
): string | null {
  const raw = findValue(source, keys);
  if (isEmpty(raw)) {
    if (options.required) issues.push({ path, message: 'required text field is missing' });
    return null;
  }
  const text = String(raw).trim();
  const maxLength = options.maxLength ?? 4000;
  if (text.length > maxLength) {
    issues.push({ path, message: `value exceeds ${maxLength} characters and was rejected` });
    return null;
  }
  return text;
}

export function fieldBoolean(
  source: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  issues: ValidationIssue[],
): boolean | null {
  const raw = findValue(source, keys);
  if (isEmpty(raw)) return null;
  if (typeof raw === 'boolean') return raw;
  const lowered = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'open'].includes(lowered)) return true;
  if (['false', '0', 'no', 'closed'].includes(lowered)) return false;
  issues.push({ path, message: `value "${String(raw)}" is not a boolean` });
  return null;
}

export function fieldIso(
  source: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  issues: ValidationIssue[],
  options: FieldOptions = {},
): string | null {
  const raw = fieldString(source, keys, path, issues, { ...options, maxLength: 64 });
  if (raw === null) return null;
  if (!isIsoTimestamp(raw) && !/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    issues.push({ path, message: `value "${raw}" is not an ISO-8601 date` });
    return null;
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    issues.push({ path, message: `value "${raw}" could not be parsed as a date` });
    return null;
  }
  return new Date(parsed).toISOString();
}

export function fieldEnum<T extends string>(
  source: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  issues: ValidationIssue[],
  allowed: readonly T[],
  fallback: T | null = null,
): T | null {
  const raw = findValue(source, keys);
  if (isEmpty(raw)) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  const match = allowed.find((value) => value === normalized);
  if (!match) {
    issues.push({ path, message: `value "${String(raw)}" is not one of ${allowed.join(', ')}` });
    return fallback;
  }
  return match;
}

function finish<T>(value: T, issues: ValidationIssue[], requiredFailed: boolean): ParseResult<T> {
  const fatal =
    requiredFailed ||
    issues.some((issue) => issue.fatal === true || issue.message.includes('required'));
  if (fatal) return { ok: false, value: null, issues };
  return { ok: true, value, issues };
}

export function normalizeQuote(raw: unknown, symbol: string): ParseResult<Quote> {
  if (!isRecord(raw)) return { ok: false, value: null, issues: [{ path: 'quote', message: 'payload is not an object' }] };
  const issues: ValidationIssue[] = [];
  const price = fieldNumber(raw, ['price', 'last', 'close', 'currentPrice'], 'quote.price', issues, { min: 0 });
  const value: Quote = {
    symbol,
    price,
    change: fieldNumber(raw, ['change', 'diff', 'changeAbsolute'], 'quote.change', issues),
    changePercent: fieldNumber(raw, ['changePercent', 'changePercentage', 'dp', 'percentChange'], 'quote.changePercent', issues),
    open: fieldNumber(raw, ['open', 'dayOpen'], 'quote.open', issues, { min: 0 }),
    high: fieldNumber(raw, ['high', 'dayHigh'], 'quote.high', issues, { min: 0 }),
    low: fieldNumber(raw, ['low', 'dayLow'], 'quote.low', issues, { min: 0 }),
    previousClose: fieldNumber(raw, ['previousClose', 'prevClose', 'pc'], 'quote.previousClose', issues, { min: 0 }),
    volume: fieldNumber(raw, ['volume', 'dayVolume', 'vol'], 'quote.volume', issues, { min: 0 }),
    marketCap: fieldNumber(raw, ['marketCap', 'marketCapitalization'], 'quote.marketCap', issues, { min: 0 }),
    isMarketOpen: fieldBoolean(raw, ['isMarketOpen', 'marketOpen', 'isOpen'], 'quote.isMarketOpen', issues),
    exchange: fieldString(raw, ['exchange', 'exchangeName'], 'quote.exchange', issues, { maxLength: 64 }),
    currency: fieldString(raw, ['currency'], 'quote.currency', issues, { maxLength: 8 }),
  };

  if (value.price === null && value.previousClose === null) {
    issues.push({ path: 'quote.price', message: 'required numeric field is missing' });
  }
  if (
    value.high !== null &&
    value.low !== null &&
    value.high < value.low
  ) {
    issues.push({ path: 'quote.high', message: 'high is below low', fatal: true });
  }
  return finish(value, issues, false);
}

export function normalizeProfile(raw: unknown, symbol: string): ParseResult<CompanyProfile> {
  if (!isRecord(raw)) return { ok: false, value: null, issues: [{ path: 'profile', message: 'payload is not an object' }] };
  const issues: ValidationIssue[] = [];
  const value: CompanyProfile = {
    symbol,
    name: fieldString(raw, ['name', 'companyName', 'Name'], 'profile.name', issues, { maxLength: 160 }),
    sector: fieldString(raw, ['sector', 'Sector'], 'profile.sector', issues, { maxLength: 120 }),
    industry: fieldString(raw, ['industry', 'Industry'], 'profile.industry', issues, { maxLength: 160 }),
    description: fieldString(raw, ['description', 'Description', 'longBusinessSummary'], 'profile.description', issues, { maxLength: 4000 }),
    exchange: fieldString(raw, ['exchange', 'Exchange'], 'profile.exchange', issues, { maxLength: 64 }),
    country: fieldString(raw, ['country', 'Country'], 'profile.country', issues, { maxLength: 64 }),
    employees: fieldNumber(raw, ['employees', 'fullTimeEmployees', 'FullTimeEmployees'], 'profile.employees', issues, { min: 0 }),
    website: fieldString(raw, ['website', 'Website'], 'profile.website', issues, { maxLength: 200 }),
    ipoDate: fieldIso(raw, ['ipoDate', 'ipo', 'IPODate'], 'profile.ipoDate', issues),
    marketCap: fieldNumber(raw, ['marketCap', 'MarketCapitalization'], 'profile.marketCap', issues, { min: 0 }),
  };
  return finish(value, issues, false);
}

export function normalizeStatement(raw: unknown, index: number): ParseResult<FinancialStatement> {
  if (!isRecord(raw)) {
    return { ok: false, value: null, issues: [{ path: `statements[${index}]`, message: 'not an object' }] };
  }
  const issues: ValidationIssue[] = [];
  const path = `statements[${index}]`;
  const value: FinancialStatement = {
    period: fieldEnum(raw, ['period', 'fiscalPeriod'], `${path}.period`, issues, ['quarterly', 'annual', 'ttm'] as const, 'quarterly') ?? 'quarterly',
    asOf: fieldIso(raw, ['asOf', 'date', 'endDate', 'fiscalDateEnding'], `${path}.asOf`, issues),
    revenue: fieldNumber(raw, ['revenue', 'totalRevenue'], `${path}.revenue`, issues),
    revenueGrowthYoY: fieldNumber(raw, ['revenueGrowthYoY', 'revenueGrowth'], `${path}.revenueGrowthYoY`, issues),
    grossMargin: fieldNumber(raw, ['grossMargin'], `${path}.grossMargin`, issues),
    operatingMargin: fieldNumber(raw, ['operatingMargin'], `${path}.operatingMargin`, issues),
    netMargin: fieldNumber(raw, ['netMargin', 'profitMargin'], `${path}.netMargin`, issues),
    eps: fieldNumber(raw, ['eps', 'dilutedEps', 'epsDiluted'], `${path}.eps`, issues),
    epsGrowthYoY: fieldNumber(raw, ['epsGrowthYoY', 'epsGrowth'], `${path}.epsGrowthYoY`, issues),
    freeCashFlow: fieldNumber(raw, ['freeCashFlow'], `${path}.freeCashFlow`, issues),
    totalDebt: fieldNumber(raw, ['totalDebt'], `${path}.totalDebt`, issues, { min: 0 }),
    totalCash: fieldNumber(raw, ['totalCash', 'cashAndCashEquivalents'], `${path}.totalCash`, issues, { min: 0 }),
    currentRatio: fieldNumber(raw, ['currentRatio'], `${path}.currentRatio`, issues),
    returnOnEquity: fieldNumber(raw, ['returnOnEquity', 'roe'], `${path}.returnOnEquity`, issues),
  };
  return finish(value, issues, false);
}

export function normalizeFinancials(raw: unknown, symbol: string): ParseResult<Financials> {
  if (!isRecord(raw)) return { ok: false, value: null, issues: [{ path: 'financials', message: 'payload is not an object' }] };
  const issues: ValidationIssue[] = [];
  const rawStatements = Array.isArray(raw.statements) ? raw.statements : [];
  const statements: FinancialStatement[] = [];
  rawStatements.slice(0, 16).forEach((entry, index) => {
    const parsed = normalizeStatement(entry, index);
    if (parsed.ok) statements.push(parsed.value);
    else issues.push(...parsed.issues);
  });

  const ratioSource = isRecord(raw.ratios) ? raw.ratios : raw;
  const ratios: ValuationRatios = {
    peTrailing: fieldNumber(ratioSource, ['peTrailing', 'peRatio', 'PERatio', 'trailingPE'], 'ratios.peTrailing', issues),
    peForward: fieldNumber(ratioSource, ['peForward', 'forwardPE'], 'ratios.peForward', issues),
    pegRatio: fieldNumber(ratioSource, ['pegRatio', 'PEGRatio'], 'ratios.pegRatio', issues),
    priceToSales: fieldNumber(ratioSource, ['priceToSales', 'priceToSalesRatio'], 'ratios.priceToSales', issues),
    priceToBook: fieldNumber(ratioSource, ['priceToBook', 'priceToBookRatio'], 'ratios.priceToBook', issues),
    evToEbitda: fieldNumber(ratioSource, ['evToEbitda', 'EVToEBITDA'], 'ratios.evToEbitda', issues),
    dividendYieldPercent: fieldNumber(ratioSource, ['dividendYieldPercent', 'dividendYield'], 'ratios.dividendYieldPercent', issues),
    beta: fieldNumber(ratioSource, ['beta', 'Beta'], 'ratios.beta', issues),
    fiftyTwoWeekHigh: fieldNumber(ratioSource, ['fiftyTwoWeekHigh', 'high52'], 'ratios.fiftyTwoWeekHigh', issues, { min: 0 }),
    fiftyTwoWeekLow: fieldNumber(ratioSource, ['fiftyTwoWeekLow', 'low52'], 'ratios.fiftyTwoWeekLow', issues, { min: 0 }),
  };

  return finish({ symbol, statements, ratios }, issues, false);
}

export function normalizeEarnings(raw: unknown, symbol: string): ParseResult<EarningsEvent[]> {
  if (!Array.isArray(raw)) return { ok: false, value: null, issues: [{ path: 'earnings', message: 'payload is not an array' }] };
  const issues: ValidationIssue[] = [];
  const events: EarningsEvent[] = [];
  raw.slice(0, 40).forEach((entry, index) => {
    if (!isRecord(entry)) {
      issues.push({ path: `earnings[${index}]`, message: 'not an object' });
      return;
    }
    const path = `earnings[${index}]`;
    const date = fieldIso(entry, ['date', 'reportDate', 'fiscalDateEnding', 'datetime'], `${path}.date`, issues, { required: true });
    if (date === null) return;
    events.push({
      symbol,
      date,
      timeOfDay: fieldEnum(entry, ['timeOfDay', 'hour', 'time'], `${path}.timeOfDay`, issues, ['before_market', 'after_market', 'unknown'] as const, 'unknown'),
      fiscalPeriod: fieldEnum(entry, ['fiscalPeriod', 'period'], `${path}.fiscalPeriod`, issues, ['quarterly', 'annual', 'ttm'] as const, null),
      epsEstimate: fieldNumber(entry, ['epsEstimate', 'epsForecast'], `${path}.epsEstimate`, issues),
      epsActual: fieldNumber(entry, ['epsActual', 'actualEPS'], `${path}.epsActual`, issues),
      revenueEstimate: fieldNumber(entry, ['revenueEstimate'], `${path}.revenueEstimate`, issues),
      revenueActual: fieldNumber(entry, ['revenueActual'], `${path}.revenueActual`, issues),
      status: fieldEnum(entry, ['status'], `${path}.status`, issues, ['confirmed', 'estimated', 'reported'] as const, 'estimated') ?? 'estimated',
    });
  });
  if (events.length === 0 && raw.length > 0) {
    return { ok: false, value: null, issues };
  }
  return { ok: true, value: events, issues };
}

export function normalizeEstimates(raw: unknown, symbol: string): ParseResult<AnalystEstimates> {
  if (!isRecord(raw)) return { ok: false, value: null, issues: [{ path: 'estimates', message: 'payload is not an object' }] };
  const issues: ValidationIssue[] = [];
  const value: AnalystEstimates = {
    symbol,
    ratingConsensus: fieldString(raw, ['ratingConsensus', 'consensusRating', 'recommendation'], 'estimates.ratingConsensus', issues, { maxLength: 64 }),
    ratingScaleNote: fieldString(raw, ['ratingScaleNote', 'scaleNote'], 'estimates.ratingScaleNote', issues, { maxLength: 200 }),
    targetMean: fieldNumber(raw, ['targetMean', 'targetPriceMean', 'targetAverage'], 'estimates.targetMean', issues, { min: 0 }),
    targetHigh: fieldNumber(raw, ['targetHigh'], 'estimates.targetHigh', issues, { min: 0 }),
    targetLow: fieldNumber(raw, ['targetLow'], 'estimates.targetLow', issues, { min: 0 }),
    analystsCovering: fieldNumber(raw, ['analystsCovering', 'analystCount', 'numberOfAnalysts'], 'estimates.analystsCovering', issues, { min: 0 }),
    epsCurrentYear: fieldNumber(raw, ['epsCurrentYear'], 'estimates.epsCurrentYear', issues),
    epsNextYear: fieldNumber(raw, ['epsNextYear'], 'estimates.epsNextYear', issues),
    revenueCurrentYear: fieldNumber(raw, ['revenueCurrentYear'], 'estimates.revenueCurrentYear', issues),
    revenueNextYear: fieldNumber(raw, ['revenueNextYear'], 'estimates.revenueNextYear', issues),
  };
  return finish(value, issues, false);
}

export function normalizeNews(raw: unknown, fallbackSymbol: string | null): ParseResult<NewsItem[]> {
  if (!Array.isArray(raw)) return { ok: false, value: null, issues: [{ path: 'news', message: 'payload is not an array' }] };
  const issues: ValidationIssue[] = [];
  const items: NewsItem[] = [];
  raw.slice(0, 40).forEach((entry, index) => {
    if (!isRecord(entry)) {
      issues.push({ path: `news[${index}]`, message: 'not an object' });
      return;
    }
    const path = `news[${index}]`;
    const headline = fieldString(entry, ['headline', 'title', 'summaryTitle'], `${path}.headline`, issues, { required: true, maxLength: 400 });
    const publishedAt = fieldIso(entry, ['publishedAt', 'datetime', 'date', 'timePublished'], `${path}.publishedAt`, issues, { required: true });
    if (headline === null || publishedAt === null) return;
    const id = fieldString(entry, ['id'], `${path}.id`, issues, { maxLength: 128 }) ?? `${index}:${publishedAt}`;
    items.push({
      id,
      symbol: normalizeSymbolField(entry, ['symbol', 'ticker'], fallbackSymbol),
      headline,
      summary: fieldString(entry, ['summary', 'description'], `${path}.summary`, issues, { maxLength: 2000 }),
      source: fieldString(entry, ['source', 'provider', 'sourceName'], `${path}.source`, issues, { maxLength: 120 }) ?? 'unknown',
      url: fieldString(entry, ['url', 'link'], `${path}.url`, issues, { maxLength: 500 }),
      publishedAt,
      sentiment: fieldEnum(entry, ['sentiment'], `${path}.sentiment`, issues, ['positive', 'negative', 'neutral', 'unknown'] as const, 'unknown') ?? 'unknown',
    });
  });
  return { ok: true, value: items, issues };
}

function normalizeSymbolField(entry: Record<string, unknown>, keys: readonly string[], fallback: string | null): string | null {
  const raw = entry[keys[0]] ?? entry[keys[1]];
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const normalized = raw.trim().toUpperCase();
  return /^[A-Z][A-Z.\-]{0,9}$/.test(normalized) ? normalized : fallback;
}

export function normalizeMacroEvents(raw: unknown): ParseResult<MacroEvent[]> {
  if (!Array.isArray(raw)) return { ok: false, value: null, issues: [{ path: 'macro', message: 'payload is not an array' }] };
  const issues: ValidationIssue[] = [];
  const events: MacroEvent[] = [];
  raw.slice(0, 40).forEach((entry, index) => {
    if (!isRecord(entry)) {
      issues.push({ path: `macro[${index}]`, message: 'not an object' });
      return;
    }
    const path = `macro[${index}]`;
    const name = fieldString(entry, ['name', 'event', 'title'], `${path}.name`, issues, { required: true, maxLength: 200 });
    const scheduledAt = fieldIso(entry, ['scheduledAt', 'datetime', 'date', 'time'], `${path}.scheduledAt`, issues, { required: true });
    if (name === null || scheduledAt === null) return;
    events.push({
      id: fieldString(entry, ['id'], `${path}.id`, issues, { maxLength: 128 }) ?? `${index}:${scheduledAt}`,
      name,
      scheduledAt,
      importance: fieldEnum(entry, ['importance'], `${path}.importance`, issues, ['high', 'medium', 'low'] as const, 'medium') ?? 'medium',
      region: fieldString(entry, ['region', 'country'], `${path}.region`, issues, { maxLength: 64 }) ?? 'US',
      consensus: fieldString(entry, ['consensus', 'forecast'], `${path}.consensus`, issues, { maxLength: 64 }),
      previous: fieldString(entry, ['previous'], `${path}.previous`, issues, { maxLength: 64 }),
      actual: fieldString(entry, ['actual'], `${path}.actual`, issues, { maxLength: 64 }),
      relevanceNote: fieldString(entry, ['relevanceNote'], `${path}.relevanceNote`, issues, { maxLength: 400 }),
    });
  });
  return { ok: true, value: events, issues };
}