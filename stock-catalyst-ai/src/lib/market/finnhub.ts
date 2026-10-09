/**
 * Finnhub adapter (free tier, key required).
 * Docs: https://finnhub.io/docs/api
 *
 * Free-tier notes encoded here:
 *  - `/quote` is delayed ~15 minutes for US listings -> status `delayed`.
 *  - Premium-only endpoints answer HTTP 403 -> mapped to `unauthenticated` so the
 *    registry can fall through instead of failing the whole panel.
 */

import type {
  CandleRequest,
  CandleSeries,
  CompanyProfile,
  EarningsEvent,
  MarketDataProvider,
  NewsItem,
  ProviderCapability,
  ProviderContext,
  ProviderResult,
  Quote,
} from './types.ts';
import type { ProviderDeps } from './provider-base.ts';
import { acquireSlot, buildProvenance, createProviderDeps, errorFromResponse, failure, fetchText, providerError, success } from './provider-base.ts';
import { isRecord, normalizeEarnings, normalizeNews, normalizeProfile, normalizeQuote } from './validators.ts';
import { validateCandles } from './candles.ts';

const SOURCE = 'finnhub';
const BASE_URL = 'https://finnhub.io/api/v1';
const TYPICAL_DELAY_SECONDS = 900;

function unixToIso(seconds: unknown): string | null {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return new Date(numeric * 1000).toISOString();
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

export class FinnhubProvider implements MarketDataProvider {
  readonly id = SOURCE;
  readonly label = 'Finnhub (free tier, delayed)';
  readonly capabilities: ProviderCapability[] = ['quote', 'candles', 'profile', 'earnings_calendar', 'news'];
  readonly typicalDelaySeconds = TYPICAL_DELAY_SECONDS;

  private readonly deps: ProviderDeps;
  private readonly apiKey: string | null;

  constructor(apiKey: string | null, deps: Partial<ProviderDeps> = {}) {
    this.apiKey = apiKey;
    this.deps = createProviderDeps(deps);
  }

  isConfigured(): boolean {
    return this.apiKey !== null && this.apiKey.length > 0;
  }

  private url(path: string, params: Record<string, string>): string {
    const search = new URLSearchParams(params);
    search.set('token', this.apiKey ?? '');
    return `${BASE_URL}${path}?${search.toString()}`;
  }

  private unavailable(): ProviderResult<never> {
    return failure(providerError('disabled', 'FINNHUB_API_KEY is not configured', SOURCE));
  }

  async getQuote(symbol: string, _ctx: ProviderContext): Promise<ProviderResult<Quote>> {
    if (!this.isConfigured()) return this.unavailable();
    const slot = acquireSlot(this.deps, `${SOURCE}:quote`, SOURCE);
    if (slot) return failure(slot);

    const response = await fetchText(this.url('/quote', { symbol }), this.deps);
    const transportError = errorFromResponse(response, SOURCE);
    if (transportError) return failure(transportError);

    const payload = response.json;
    if (!isRecord(payload)) return failure(providerError('bad_payload', 'finnhub quote was not an object', SOURCE));
    if (payload.c === undefined && payload.pc === undefined) {
      return failure(providerError('not_found', `finnhub has no quote for ${symbol}`, SOURCE));
    }

    const normalized = normalizeQuote(payload, symbol);
    if (!normalized.ok) {
      return failure(providerError('bad_payload', `finnhub quote failed validation (${normalized.issues.length} issues)`, SOURCE));
    }
    const value: Quote = { ...normalized.value, isMarketOpen: null };
    return success(value, buildProvenance({
      source: SOURCE,
      status: 'delayed',
      asOf: unixToIso(payload.t),
      delaySeconds: TYPICAL_DELAY_SECONDS,
      note: 'Finnhub free tier; US quotes delayed about 15 minutes',
      deps: this.deps,
    }));
  }

  async getCandles(request: CandleRequest, _ctx: ProviderContext): Promise<ProviderResult<CandleSeries>> {
    if (!this.isConfigured()) return this.unavailable();
    const slot = acquireSlot(this.deps, `${SOURCE}:candles`, SOURCE);
    if (slot) return failure(slot);

    const to = request.to ? Math.floor(Date.parse(request.to) / 1000) : Math.floor(this.deps.now() / 1000);
    const from = request.from
      ? Math.floor(Date.parse(request.from) / 1000)
      : to - Math.min(3650, Math.max(request.limit, 400)) * 86_400;

    const response = await fetchText(
      this.url('/stock/candle', {
        symbol: request.symbol,
        resolution: request.interval === '1wk' ? 'W' : request.interval === '1mo' ? 'M' : 'D',
        from: String(from),
        to: String(to),
      }),
      this.deps,
    );
    const transportError = errorFromResponse(response, SOURCE);
    if (transportError) return failure(transportError);

    const payload = response.json;
    if (!isRecord(payload)) return failure(providerError('bad_payload', 'finnhub candles were not an object', SOURCE));
    if (payload.s === 'no_data') {
      return failure(providerError('not_found', `finnhub returned no candles for ${request.symbol}`, SOURCE));
    }
    if (payload.s !== 'ok') {
      return failure(providerError('bad_payload', `finnhub candle status was "${String(payload.s)}"`, SOURCE));
    }

    const times = Array.isArray(payload.t) ? payload.t : [];
    const rows = times.map((time, index) => ({
      time: unixToIso(time),
      open: (payload.o as unknown[])?.[index],
      high: (payload.h as unknown[])?.[index],
      low: (payload.l as unknown[])?.[index],
      close: (payload.c as unknown[])?.[index],
      volume: (payload.v as unknown[])?.[index] ?? null,
    }));

    const validated = validateCandles(rows);
    if (validated.candles.length === 0) {
      return failure(providerError('bad_payload', 'finnhub candle arrays failed validation', SOURCE));
    }
    const candles = validated.candles.slice(Math.max(0, validated.candles.length - request.limit));
    return success(
      { symbol: request.symbol, interval: request.interval, adjustment: 'none', candles },
      buildProvenance({
        source: SOURCE,
        status: 'delayed',
        asOf: candles[candles.length - 1].time,
        delaySeconds: TYPICAL_DELAY_SECONDS,
        note: 'Finnhub candles are unadjusted; splits and dividends are not applied',
        deps: this.deps,
      }),
    );
  }

  async getProfile(symbol: string, _ctx: ProviderContext): Promise<ProviderResult<CompanyProfile>> {
    if (!this.isConfigured()) return this.unavailable();
    const slot = acquireSlot(this.deps, `${SOURCE}:profile`, SOURCE);
    if (slot) return failure(slot);

    const response = await fetchText(this.url('/stock/profile2', { symbol }), this.deps);
    const transportError = errorFromResponse(response, SOURCE);
    if (transportError) return failure(transportError);

    const payload = response.json;
    if (!isRecord(payload) || Object.keys(payload).length === 0) {
      return failure(providerError('not_found', `finnhub has no profile for ${symbol}`, SOURCE));
    }
    const mapped = {
      name: payload.name,
      sector: payload.finnhubIndustry,
      industry: payload.finnhubIndustry,
      description: null,
      exchange: payload.exchange,
      country: payload.country,
      website: payload.weburl,
      ipoDate: payload.ipo,
      marketCap: payload.marketCapitalization ? Number(payload.marketCapitalization) * 1_000_000 : null,
    };
    const normalized = normalizeProfile(mapped, symbol);
    if (!normalized.ok) {
      return failure(providerError('bad_payload', 'finnhub profile failed validation', SOURCE));
    }
    return success(normalized.value, buildProvenance({ source: SOURCE, status: 'delayed', asOf: null, delaySeconds: null, note: 'Finnhub company profile', deps: this.deps }));
  }

  async getEarningsCalendar(symbol: string, _ctx: ProviderContext): Promise<ProviderResult<EarningsEvent[]>> {
    if (!this.isConfigured()) return this.unavailable();
    const slot = acquireSlot(this.deps, `${SOURCE}:earnings`, SOURCE);
    if (slot) return failure(slot);

    const now = this.deps.now();
    const from = dateOnly(new Date(now - 120 * 86_400_000).toISOString());
    const to = dateOnly(new Date(now + 120 * 86_400_000).toISOString());
    const response = await fetchText(this.url('/calendar/earnings', { symbol, from, to }), this.deps);
    const transportError = errorFromResponse(response, SOURCE);
    if (transportError) return failure(transportError);

    const payload = response.json;
    const rows = isRecord(payload) && Array.isArray(payload.earningsCalendar) ? payload.earningsCalendar : [];
    const mapped = rows.map((row) => {
      const record = isRecord(row) ? row : {};
      return {
        date: typeof record.date === 'string' ? `${record.date}T00:00:00.000Z` : null,
        timeOfDay:
          record.hour === 'bmo' ? 'before_market' : record.hour === 'amc' ? 'after_market' : 'unknown',
        epsEstimate: record.epsEstimate,
        epsActual: record.epsActual,
        revenueEstimate: record.revenueEstimate,
        revenueActual: record.revenueActual,
        status: record.epsActual === null || record.epsActual === undefined ? 'estimated' : 'reported',
      };
    });
    const normalized = normalizeEarnings(mapped, symbol);
    if (!normalized.ok) {
      return failure(providerError('bad_payload', 'finnhub earnings calendar failed validation', SOURCE));
    }
    return success(normalized.value, buildProvenance({ source: SOURCE, status: 'delayed', asOf: new Date(now).toISOString(), delaySeconds: null, note: 'Finnhub earnings calendar; dates may be estimates', deps: this.deps }));
  }

  async getNews(request: { symbol: string | null; topic: string | null; limit: number; from: string | null }, _ctx: ProviderContext): Promise<ProviderResult<NewsItem[]>> {
    if (!this.isConfigured()) return this.unavailable();
    const slot = acquireSlot(this.deps, `${SOURCE}:news`, SOURCE);
    if (slot) return failure(slot);

    const now = this.deps.now();
    const to = dateOnly(new Date(now).toISOString());
    const from = request.from ? dateOnly(request.from) : dateOnly(new Date(now - 14 * 86_400_000).toISOString());
    const path = request.symbol ? '/company-news' : '/news';
    const params: Record<string, string> = request.symbol ? { symbol: request.symbol, from, to } : { category: request.topic ?? 'general', from, to };

    const response = await fetchText(this.url(path, params), this.deps);
    const transportError = errorFromResponse(response, SOURCE);
    if (transportError) return failure(transportError);

    const payload = response.json;
    const rows = Array.isArray(payload) ? payload : [];
    const mapped = rows.slice(0, request.limit).map((row) => {
      const record = isRecord(row) ? row : {};
      return {
        id: record.id,
        headline: record.headline,
        summary: record.summary,
        source: record.source,
        url: record.url,
        publishedAt: unixToIso(record.datetime),
        symbol: request.symbol,
        sentiment: 'unknown',
      };
    });
    const normalized = normalizeNews(mapped, request.symbol);
    if (!normalized.ok) {
      return failure(providerError('bad_payload', 'finnhub news failed validation', SOURCE));
    }
    return success(normalized.value, buildProvenance({ source: SOURCE, status: 'delayed', asOf: new Date(now).toISOString(), delaySeconds: null, note: 'Finnhub news feed; sentiment is not supplied and is reported as unknown', deps: this.deps }));
  }
}