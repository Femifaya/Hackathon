/**
 * Twelve Data adapter (free tier: ~800 requests/day, 8/minute, key required).
 * Docs: https://twelvedata.com/docs
 *
 * Twelve Data reports errors as HTTP 200 with `{ status: "error", code, message }`,
 * so that shape is checked before the payload is used.
 */

import type {
  AnalystEstimates,
  CandleRequest,
  CandleSeries,
  EarningsEvent,
  Financials,
  MarketDataProvider,
  NewsItem,
  ProviderCapability,
  ProviderContext,
  ProviderResult,
  Quote,
} from './types.ts';
import type { ProviderDeps } from './provider-base.ts';
import { acquireSlot, buildProvenance, createProviderDeps, errorFromResponse, failure, fetchText, providerError, success } from './provider-base.ts';
import { isRecord, normalizeEarnings, normalizeEstimates, normalizeFinancials, normalizeNews, normalizeQuote } from './validators.ts';
import { validateCandles } from './candles.ts';

const SOURCE = 'twelvedata';
const BASE_URL = 'https://api.twelvedata.com';
const TYPICAL_DELAY_SECONDS = 900;

export interface TwelveDataError {
  kind: 'rate_limited' | 'unauthenticated' | 'not_found' | 'upstream_error' | 'bad_payload';
  message: string;
}

/** Exported for tests. */
export function detectTwelveDataError(payload: unknown): TwelveDataError | null {
  if (!isRecord(payload)) return { kind: 'bad_payload', message: 'response was not an object' };
  if (payload.status !== 'error' && payload.code === undefined) return null;
  const code = Number(payload.code);
  const message = typeof payload.message === 'string' ? payload.message : 'twelvedata returned an error';
  const lowered = message.toLowerCase();
  if (code === 429 || lowered.includes('api credit') || lowered.includes('rate limit')) {
    return { kind: 'rate_limited', message };
  }
  if (code === 401 || code === 403 || lowered.includes('invalid api key')) {
    return { kind: 'unauthenticated', message };
  }
  if (code === 404 || lowered.includes('not found') || lowered.includes('no data')) {
    return { kind: 'not_found', message };
  }
  return { kind: 'upstream_error', message };
}

function toIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value.includes('T') || value.includes('Z') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export class TwelveDataProvider implements MarketDataProvider {
  readonly id = SOURCE;
  readonly label = 'Twelve Data (free tier)';
  readonly capabilities: ProviderCapability[] = ['quote', 'candles', 'financials', 'earnings_calendar', 'estimates', 'news'];
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
    search.set('apikey', this.apiKey ?? '');
    return `${BASE_URL}${path}?${search.toString()}`;
  }

  private unavailable(): ProviderResult<never> {
    return failure(providerError('disabled', 'TWELVEDATA_API_KEY is not configured', SOURCE));
  }

  private async call(path: string, params: Record<string, string>) {
    const response = await fetchText(this.url(path, params), this.deps);
    const transportError = errorFromResponse(response, SOURCE);
    if (transportError) return { error: transportError, payload: null };
    const soft = detectTwelveDataError(response.json);
    if (soft) return { error: providerError(soft.kind, soft.message, SOURCE, soft.kind === 'rate_limited' ? 60 : null), payload: null };
    return { error: null, payload: response.json };
  }

  async getQuote(symbol: string, _ctx: ProviderContext): Promise<ProviderResult<Quote>> {
    if (!this.isConfigured()) return this.unavailable();
    const slot = acquireSlot(this.deps, `${SOURCE}:quote`, SOURCE);
    if (slot) return failure(slot);

    const { error, payload } = await this.call('/quote', { symbol });
    if (error) return failure(error);
    if (!isRecord(payload)) return failure(providerError('bad_payload', 'twelvedata quote was not an object', SOURCE));

    const normalized = normalizeQuote(payload, symbol);
    if (!normalized.ok) return failure(providerError('bad_payload', 'twelvedata quote failed validation', SOURCE));
    const value: Quote = {
      ...normalized.value,
      isMarketOpen: payload.is_market_open === undefined ? null : String(payload.is_market_open) === '1' || payload.is_market_open === true,
      exchange: typeof payload.exchange === 'string' ? payload.exchange : null,
      currency: typeof payload.currency === 'string' ? payload.currency : null,
      marketCap: null,
    };
    return success(value, buildProvenance({
      source: SOURCE,
      status: 'delayed',
      asOf: toIso(payload.datetime),
      delaySeconds: TYPICAL_DELAY_SECONDS,
      note: 'Twelve Data quote endpoint; delayed on the free tier',
      deps: this.deps,
    }));
  }

  async getCandles(request: CandleRequest, _ctx: ProviderContext): Promise<ProviderResult<CandleSeries>> {
    if (!this.isConfigured()) return this.unavailable();
    const slot = acquireSlot(this.deps, `${SOURCE}:candles`, SOURCE);
    if (slot) return failure(slot);

    const interval = request.interval === '1wk' ? '1week' : request.interval === '1mo' ? '1month' : '1day';
    const params: Record<string, string> = {
      symbol: request.symbol,
      interval,
      outputsize: String(Math.min(5000, Math.max(30, request.limit))),
      format: 'JSON',
      adjustment: 'split_and_dividend',
    };
    if (request.to) params.end_date = request.to.slice(0, 10);
    if (request.from) params.start_date = request.from.slice(0, 10);

    const { error, payload } = await this.call('/time_series', params);
    if (error) return failure(error);
    const values = isRecord(payload) && Array.isArray(payload.values) ? payload.values : [];
    if (values.length === 0) {
      return failure(providerError('not_found', `twelvedata returned no candles for ${request.symbol}`, SOURCE));
    }

    const rows = values.map((entry) => {
      const row = isRecord(entry) ? entry : {};
      return {
        time: toIso(row.datetime),
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
      };
    });
    const validated = validateCandles(rows);
    if (validated.candles.length === 0) {
      return failure(providerError('bad_payload', 'twelvedata candles failed validation', SOURCE));
    }
    // Twelve Data returns newest-first; validateCandles sorts ascending.
    const candles = validated.candles.slice(Math.max(0, validated.candles.length - request.limit));
    return success(
      { symbol: request.symbol, interval: request.interval, adjustment: 'full', candles },
      buildProvenance({
        source: SOURCE,
        status: 'delayed',
        asOf: candles[candles.length - 1].time,
        delaySeconds: TYPICAL_DELAY_SECONDS,
        note: 'time_series with split_and_dividend adjustment requested',
        deps: this.deps,
      }),
    );
  }

  async getFinancials(symbol: string, _ctx: ProviderContext): Promise<ProviderResult<Financials>> {
    if (!this.isConfigured()) return this.unavailable();
    const slot = acquireSlot(this.deps, `${SOURCE}:statistics`, SOURCE);
    if (slot) return failure(slot);

    const { error, payload } = await this.call('/statistics', { symbol });
    if (error) return failure(error);
    if (!isRecord(payload)) return failure(providerError('bad_payload', 'twelvedata statistics was not an object', SOURCE));

    const valuation = isRecord(payload.Valuation) ? payload.Valuation : {};
    const financials = isRecord(payload.Financials) ? payload.Financials : {};
    const meta = isRecord(payload.Meta) ? payload.Meta : {};
    const ratios = {
      peTrailing: valuation['Trailing PE'] ?? null,
      peForward: valuation['Forward PE'] ?? null,
      priceToBook: valuation['Price to Book Ratio'] ?? null,
      priceToSales: null,
      pegRatio: null,
      evToEbitda: null,
      dividendYieldPercent: financials['Dividend Yield'] ?? null,
      beta: valuation.Beta ?? financials.Beta ?? null,
      fiftyTwoWeekHigh: null,
      fiftyTwoWeekLow: null,
    };
    const normalized = normalizeFinancials({ statements: [], ratios }, symbol);
    if (!normalized.ok) return failure(providerError('bad_payload', 'twelvedata statistics failed validation', SOURCE));
    if (Object.values(normalized.value.ratios).every((value) => value === null)) {
      return failure(providerError('not_found', `twelvedata has no statistics for ${symbol} on this key`, SOURCE));
    }
    return success(normalized.value, buildProvenance({
      source: SOURCE,
      status: 'delayed',
      asOf: toIso(meta.Last_updated),
      delaySeconds: null,
      note: 'Valuation ratios only; income-statement detail is not served on the free tier',
      deps: this.deps,
    }));
  }

  async getEarningsCalendar(symbol: string, _ctx: ProviderContext): Promise<ProviderResult<EarningsEvent[]>> {
    if (!this.isConfigured()) return this.unavailable();
    const slot = acquireSlot(this.deps, `${SOURCE}:earnings`, SOURCE);
    if (slot) return failure(slot);

    const { error, payload } = await this.call('/earnings_calendar', { symbol, format: 'JSON' });
    if (error) return failure(error);
    const rows = isRecord(payload) && Array.isArray(payload.earnings) ? payload.earnings : [];
    const mapped = rows.map((entry) => {
      const row = isRecord(entry) ? entry : {};
      const time = typeof row.time === 'string' ? row.time.toLowerCase() : '';
      return {
        date: typeof row.date === 'string' ? `${row.date}T00:00:00.000Z` : null,
        timeOfDay: time === 'amc' || time.includes('after') ? 'after_market' : time === 'bmo' || time.includes('before') ? 'before_market' : 'unknown',
        fiscalPeriod: null,
        epsEstimate: row.eps_estimate,
        epsActual: row.eps_actual,
        revenueEstimate: row.revenue_estimate ?? null,
        revenueActual: null,
        status: row.eps_actual === null || row.eps_actual === undefined ? 'estimated' : 'reported',
      };
    });
    const normalized = normalizeEarnings(mapped, symbol);
    if (!normalized.ok) return failure(providerError('bad_payload', 'twelvedata earnings calendar failed validation', SOURCE));
    return success(normalized.value, buildProvenance({ source: SOURCE, status: 'delayed', asOf: null, delaySeconds: null, note: 'Twelve Data earnings calendar', deps: this.deps }));
  }

  async getEstimates(symbol: string, _ctx: ProviderContext): Promise<ProviderResult<AnalystEstimates>> {
    if (!this.isConfigured()) return this.unavailable();
    const slot = acquireSlot(this.deps, `${SOURCE}:estimates`, SOURCE);
    if (slot) return failure(slot);

    const { error, payload } = await this.call('/analyst_estimates', { symbol });
    if (error) return failure(error);
    if (!isRecord(payload)) return failure(providerError('bad_payload', 'twelvedata estimates was not an object', SOURCE));
    const normalized = normalizeEstimates(
      {
        ratingConsensus: payload.consensus_rating ?? null,
        ratingScaleNote: 'Twelve Data analyst estimates; third-party opinion, not a fact',
        targetMean: payload.target_price_mean ?? payload.target_mean ?? null,
        targetHigh: payload.target_price_high ?? null,
        targetLow: payload.target_price_low ?? null,
        analystsCovering: payload.analysts_count ?? null,
      },
      symbol,
    );
    if (!normalized.ok) return failure(providerError('bad_payload', 'twelvedata estimates failed validation', SOURCE));
    if (normalized.value.targetMean === null && normalized.value.ratingConsensus === null) {
      return failure(providerError('not_found', `twelvedata has no analyst estimates for ${symbol} on this key`, SOURCE));
    }
    return success(normalized.value, buildProvenance({ source: SOURCE, status: 'delayed', asOf: null, delaySeconds: null, note: 'Analyst estimates are opinions from a third party', deps: this.deps }));
  }

  async getNews(request: { symbol: string | null; topic: string | null; limit: number; from: string | null }, _ctx: ProviderContext): Promise<ProviderResult<NewsItem[]>> {
    if (!this.isConfigured()) return this.unavailable();
    const slot = acquireSlot(this.deps, `${SOURCE}:news`, SOURCE);
    if (slot) return failure(slot);

    const params: Record<string, string> = { format: 'JSON', limit: String(Math.min(50, Math.max(5, request.limit))) };
    if (request.symbol) params.symbol = request.symbol;
    const { error, payload } = await this.call('/news', params);
    if (error) return failure(error);
    const rows = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
    const mapped = rows.map((entry) => {
      const row = isRecord(entry) ? entry : {};
      return {
        id: row.id ?? null,
        headline: row.title,
        summary: row.summary ?? row.description ?? null,
        source: row.source_name ?? row.source ?? null,
        url: row.url ?? null,
        publishedAt: toIso(row.published_at),
        symbol: request.symbol,
        sentiment: typeof row.sentiment === 'string' ? row.sentiment : 'unknown',
      };
    });
    const normalized = normalizeNews(mapped, request.symbol);
    if (!normalized.ok) return failure(providerError('bad_payload', 'twelvedata news failed validation', SOURCE));
    return success(normalized.value, buildProvenance({ source: SOURCE, status: 'delayed', asOf: normalized.value[0]?.publishedAt ?? null, delaySeconds: null, note: 'Twelve Data news feed', deps: this.deps }));
  }
}