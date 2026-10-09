/**
 * Alpha Vantage adapter (free tier: ~25 requests/day, key required).
 * Docs: https://www.alphavantage.co/documentation/
 *
 * Alpha Vantage reports throttling and premium-only endpoints with HTTP 200 and an
 * "Information"/"Note"/"Error Message" body. Those are detected here and mapped to
 * `rate_limited` / `unauthenticated` so the registry falls through cleanly instead
 * of treating a throttle notice as data.
 */

import type {
  AnalystEstimates,
  CandleRequest,
  CandleSeries,
  CompanyProfile,
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
import { isRecord, normalizeEarnings, normalizeEstimates, normalizeFinancials, normalizeNews, normalizeProfile, normalizeQuote } from './validators.ts';
import { validateCandles } from './candles.ts';

const SOURCE = 'alphavantage';
const BASE_URL = 'https://www.alphavantage.co/query';
const TYPICAL_DELAY_SECONDS = 900;

const THROTTLE_HINTS = ['call frequency', '25 calls per day', '75 calls per day', 'premium endpoint', 'higher API call frequency'];

export interface AlphaVantageThrottle {
  kind: 'rate_limited' | 'unauthenticated' | 'upstream_error';
  message: string;
}

/** Exported for tests: classifies Alpha Vantage's "soft error" payloads. */
export function detectSoftError(payload: unknown): AlphaVantageThrottle | null {
  if (!isRecord(payload)) return null;
  const note =
    (typeof payload['Information'] === 'string' && payload['Information']) ||
    (typeof payload['Note'] === 'string' && payload['Note']) ||
    (typeof payload['Error Message'] === 'string' && payload['Error Message']) ||
    null;
  if (note === null) return null;
  const lowered = note.toLowerCase();
  if (lowered.includes('invalid api key') || lowered.includes('apikey')) {
    return { kind: 'unauthenticated', message: note };
  }
  if (THROTTLE_HINTS.some((hint) => lowered.includes(hint))) {
    return { kind: 'rate_limited', message: note };
  }
  return { kind: 'upstream_error', message: note };
}

function avTimePublishedToIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!match) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])),
  ).toISOString();
}

function numericOrNull(value: unknown): unknown {
  if (value === null || value === undefined || value === '' || value === 'None' || value === '-') return null;
  if (typeof value === 'number') return value;
  const text = String(value).replace(/[%,$\s]/g, '');
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export class AlphaVantageProvider implements MarketDataProvider {
  readonly id = SOURCE;
  readonly label = 'Alpha Vantage (free tier, 25 req/day)';
  readonly capabilities: ProviderCapability[] = ['quote', 'candles', 'profile', 'financials', 'earnings_calendar', 'estimates', 'news'];
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

  private url(params: Record<string, string>): string {
    const search = new URLSearchParams(params);
    search.set('apikey', this.apiKey ?? '');
    return `${BASE_URL}?${search.toString()}`;
  }

  private unavailable(): ProviderResult<never> {
    return failure(providerError('disabled', 'ALPHAVANTAGE_API_KEY is not configured', SOURCE));
  }

  private async call(params: Record<string, string>) {
    const response = await fetchText(this.url(params), this.deps);
    const transportError = errorFromResponse(response, SOURCE);
    if (transportError) return { error: transportError, payload: null };
    const soft = detectSoftError(response.json);
    if (soft) return { error: providerError(soft.kind, soft.message, SOURCE, soft.kind === 'rate_limited' ? 86_400 : null), payload: null };
    return { error: null, payload: response.json };
  }

  async getQuote(symbol: string, _ctx: ProviderContext): Promise<ProviderResult<Quote>> {
    if (!this.isConfigured()) return this.unavailable();
    const slot = acquireSlot(this.deps, `${SOURCE}:quote`, SOURCE);
    if (slot) return failure(slot);

    const { error, payload } = await this.call({ function: 'GLOBAL_QUOTE', symbol });
    if (error) return failure(error);
    if (!isRecord(payload)) return failure(providerError('bad_payload', 'alphavantage response was not an object', SOURCE));

    const quote = payload['Global Quote'];
    if (!isRecord(quote) || Object.keys(quote).length === 0) {
      return failure(providerError('not_found', `alphavantage has no quote for ${symbol}`, SOURCE));
    }

    const mapped = {
      price: numericOrNull(quote['05. price']),
      open: numericOrNull(quote['02. open']),
      high: numericOrNull(quote['03. high']),
      low: numericOrNull(quote['04. low']),
      volume: numericOrNull(quote['06. volume']),
      previousClose: numericOrNull(quote['08. previous close']),
      change: numericOrNull(quote['09. change']),
      changePercent: numericOrNull(quote['10. change percent']),
    };
    const normalized = normalizeQuote(mapped, symbol);
    if (!normalized.ok) return failure(providerError('bad_payload', 'alphavantage quote failed validation', SOURCE));

    return success(
      { ...normalized.value, exchange: 'ALPHA_VANTAGE', currency: 'USD', isMarketOpen: null, marketCap: null },
      buildProvenance({
        source: SOURCE,
        status: 'delayed',
        asOf: typeof quote['07. latest trading day'] === 'string' ? `${quote['07. latest trading day']}T00:00:00.000Z` : null,
        delaySeconds: TYPICAL_DELAY_SECONDS,
        note: 'Alpha Vantage GLOBAL_QUOTE; delayed on the free tier',
        deps: this.deps,
      }),
    );
  }

  async getCandles(request: CandleRequest, _ctx: ProviderContext): Promise<ProviderResult<CandleSeries>> {
    if (!this.isConfigured()) return this.unavailable();
    if (request.interval !== '1d') {
      return failure(providerError('unsupported', 'alphavantage adapter serves daily candles only in this build', SOURCE));
    }
    const slot = acquireSlot(this.deps, `${SOURCE}:candles`, SOURCE);
    if (slot) return failure(slot);

    const { error, payload } = await this.call({
      function: 'TIME_SERIES_DAILY_ADJUSTED',
      symbol: request.symbol,
      outputsize: request.limit > 100 ? 'full' : 'compact',
    });
    if (error) return failure(error);
    if (!isRecord(payload)) return failure(providerError('bad_payload', 'alphavantage response was not an object', SOURCE));

    const series = payload['Time Series (Daily)'] ?? payload['Time Series (Daily Adjusted)'];
    if (!isRecord(series)) {
      return failure(providerError('not_found', `alphavantage returned no daily series for ${request.symbol}`, SOURCE));
    }

    const rows = Object.entries(series).map(([date, values]) => {
      const row = isRecord(values) ? values : {};
      return {
        time: `${date}T00:00:00.000Z`,
        open: numericOrNull(row['1. open']),
        high: numericOrNull(row['2. high']),
        low: numericOrNull(row['3. low']),
        close: numericOrNull(row['5. adjusted close'] ?? row['4. close']),
        volume: numericOrNull(row['6. volume']),
      };
    });

    const validated = validateCandles(rows);
    if (validated.candles.length === 0) {
      return failure(providerError('bad_payload', 'alphavantage daily series failed validation', SOURCE));
    }
    const candles = validated.candles.slice(Math.max(0, validated.candles.length - request.limit));
    return success(
      { symbol: request.symbol, interval: '1d', adjustment: 'full', candles },
      buildProvenance({
        source: SOURCE,
        status: 'delayed',
        asOf: candles[candles.length - 1].time,
        delaySeconds: TYPICAL_DELAY_SECONDS,
        note: 'TIME_SERIES_DAILY_ADJUSTED: splits and dividends applied',
        deps: this.deps,
      }),
    );
  }

  async getProfile(symbol: string, _ctx: ProviderContext): Promise<ProviderResult<CompanyProfile>> {
    if (!this.isConfigured()) return this.unavailable();
    const slot = acquireSlot(this.deps, `${SOURCE}:overview`, SOURCE);
    if (slot) return failure(slot);

    const { error, payload } = await this.call({ function: 'OVERVIEW', symbol });
    if (error) return failure(error);
    if (!isRecord(payload) || Object.keys(payload).length === 0) {
      return failure(providerError('not_found', `alphavantage has no overview for ${symbol}`, SOURCE));
    }
    const normalized = normalizeProfile(payload, symbol);
    if (!normalized.ok) return failure(providerError('bad_payload', 'alphavantage overview failed validation', SOURCE));
    return success(normalized.value, buildProvenance({ source: SOURCE, status: 'delayed', asOf: null, delaySeconds: null, note: 'Alpha Vantage OVERVIEW', deps: this.deps }));
  }

  async getFinancials(symbol: string, _ctx: ProviderContext): Promise<ProviderResult<Financials>> {
    if (!this.isConfigured()) return this.unavailable();
    const slot = acquireSlot(this.deps, `${SOURCE}:financials`, SOURCE);
    if (slot) return failure(slot);

    const overview = await this.call({ function: 'OVERVIEW', symbol });
    const earnings = await this.call({ function: 'EARNINGS', symbol });
    if (overview.error && earnings.error) return failure(overview.error);

    const overviewPayload = isRecord(overview.payload) ? overview.payload : {};
    const earningsPayload = isRecord(earnings.payload) ? earnings.payload : {};

    const quarterly = Array.isArray(earningsPayload.quarterlyEarnings) ? earningsPayload.quarterlyEarnings : [];
    const statements = quarterly.slice(0, 8).map((entry) => {
      const row = isRecord(entry) ? entry : {};
      const revenue = numericOrNull(row['totalRevenue']);
      return {
        period: 'quarterly',
        asOf: typeof row['fiscalDateEnding'] === 'string' ? `${row['fiscalDateEnding']}T00:00:00.000Z` : null,
        revenue,
        revenueGrowthYoY: numericOrNull(overviewPayload['QuarterlyRevenueGrowthYOY']) !== null
          ? Number(numericOrNull(overviewPayload['QuarterlyRevenueGrowthYOY'])) * 100
          : null,
        grossMargin: numericOrNull(overviewPayload['GrossMarginTTM']),
        operatingMargin: numericOrNull(overviewPayload['OperatingMarginTTM']),
        netMargin: numericOrNull(overviewPayload['ProfitMargin']),
        eps: numericOrNull(row['reportedEPS']),
        epsGrowthYoY: numericOrNull(overviewPayload['QuarterlyEarningsGrowthYOY']) !== null
          ? Number(numericOrNull(overviewPayload['QuarterlyEarningsGrowthYOY'])) * 100
          : null,
        freeCashFlow: null,
        totalDebt: numericOrNull(overviewPayload['TotalDebt']) ?? null,
        totalCash: null,
        currentRatio: null,
        returnOnEquity: numericOrNull(overviewPayload['ReturnOnEquityTTM']),
      };
    });

    const ratios = {
      peTrailing: numericOrNull(overviewPayload['PERatio']),
      peForward: numericOrNull(overviewPayload['ForwardPE']),
      pegRatio: numericOrNull(overviewPayload['PEGRatio']),
      priceToSales: numericOrNull(overviewPayload['PriceToSalesRatioTTM']),
      priceToBook: numericOrNull(overviewPayload['PriceToBookRatio']),
      evToEbitda: numericOrNull(overviewPayload['EVToEBITDA']),
      dividendYieldPercent: numericOrNull(overviewPayload['DividendYield']),
      beta: numericOrNull(overviewPayload['Beta']),
      fiftyTwoWeekHigh: numericOrNull(overviewPayload['52WeekHigh']),
      fiftyTwoWeekLow: numericOrNull(overviewPayload['52WeekLow']),
    };

    const normalized = normalizeFinancials({ statements, ratios }, symbol);
    if (!normalized.ok) return failure(providerError('bad_payload', 'alphavantage financials failed validation', SOURCE));
    if (normalized.value.statements.length === 0 && Object.values(normalized.value.ratios).every((value) => value === null)) {
      return failure(providerError('not_found', `alphavantage returned no fundamentals for ${symbol}`, SOURCE));
    }

    return success(normalized.value, buildProvenance({
      source: SOURCE,
      status: 'delayed',
      asOf: normalized.value.statements[0]?.asOf ?? null,
      delaySeconds: null,
      note: 'Fundamentals combine OVERVIEW ratios with EARNINGS history; fields Alpha Vantage omits are null',
      deps: this.deps,
    }));
  }

  async getEarningsCalendar(symbol: string, _ctx: ProviderContext): Promise<ProviderResult<EarningsEvent[]>> {
    if (!this.isConfigured()) return this.unavailable();
    const slot = acquireSlot(this.deps, `${SOURCE}:earnings`, SOURCE);
    if (slot) return failure(slot);

    const { error, payload } = await this.call({ function: 'EARNINGS', symbol });
    if (error) return failure(error);
    if (!isRecord(payload)) return failure(providerError('bad_payload', 'alphavantage earnings was not an object', SOURCE));

    const quarterly = Array.isArray(payload.quarterlyEarnings) ? payload.quarterlyEarnings : [];
    const mapped = quarterly.map((entry) => {
      const row = isRecord(entry) ? entry : {};
      const reported = row['reportedDate'] ?? row['fiscalDateEnding'];
      return {
        date: typeof reported === 'string' ? `${reported}T00:00:00.000Z` : null,
        timeOfDay: 'unknown',
        fiscalPeriod: 'quarterly',
        epsEstimate: numericOrNull(row['estimatedEPS']),
        epsActual: numericOrNull(row['reportedEPS']),
        revenueEstimate: null,
        revenueActual: numericOrNull(row['totalRevenue']),
        status: numericOrNull(row['reportedEPS']) === null ? 'estimated' : 'reported',
      };
    });
    const normalized = normalizeEarnings(mapped, symbol);
    if (!normalized.ok) return failure(providerError('bad_payload', 'alphavantage earnings failed validation', SOURCE));
    return success(normalized.value, buildProvenance({ source: SOURCE, status: 'delayed', asOf: null, delaySeconds: null, note: 'Historical and scheduled earnings from the EARNINGS function', deps: this.deps }));
  }

  async getEstimates(symbol: string, _ctx: ProviderContext): Promise<ProviderResult<AnalystEstimates>> {
    if (!this.isConfigured()) return this.unavailable();
    const slot = acquireSlot(this.deps, `${SOURCE}:estimates`, SOURCE);
    if (slot) return failure(slot);

    const { error, payload } = await this.call({ function: 'ANALYST_ESTIMATES', symbol });
    if (error) return failure(error);
    const rows = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
    if (rows.length === 0) {
      return failure(providerError('not_found', `alphavantage has no analyst estimates for ${symbol} on this key`, SOURCE));
    }
    const latest = isRecord(rows[0]) ? rows[0] : {};
    const mapped = {
      ratingConsensus: latest['consensusRating'] ?? null,
      ratingScaleNote: 'Alpha Vantage ANALYST_ESTIMATES consensus; scale is not published with the payload',
      targetMean: numericOrNull(latest['consensusTargetPrice']) ?? null,
      epsCurrentYear: numericOrNull(latest['consensusEstimatedEPS']),
      revenueCurrentYear: numericOrNull(latest['consensusEstimatedRevenue']),
    };
    const normalized = normalizeEstimates(mapped, symbol);
    if (!normalized.ok) return failure(providerError('bad_payload', 'alphavantage estimates failed validation', SOURCE));
    return success(normalized.value, buildProvenance({ source: SOURCE, status: 'delayed', asOf: typeof latest['fiscalDateEnding'] === 'string' ? `${latest['fiscalDateEnding']}T00:00:00.000Z` : null, delaySeconds: null, note: 'Analyst estimates are third-party opinions, not facts', deps: this.deps }));
  }

  async getNews(request: { symbol: string | null; topic: string | null; limit: number; from: string | null }, _ctx: ProviderContext): Promise<ProviderResult<NewsItem[]>> {
    if (!this.isConfigured()) return this.unavailable();
    const slot = acquireSlot(this.deps, `${SOURCE}:news`, SOURCE);
    if (slot) return failure(slot);

    const params: Record<string, string> = { function: 'NEWS_SENTIMENT', limit: String(Math.min(50, Math.max(5, request.limit))) };
    if (request.symbol) params.tickers = request.symbol;
    else if (request.topic) params.topics = request.topic;

    const { error, payload } = await this.call(params);
    if (error) return failure(error);
    const feed = isRecord(payload) && Array.isArray(payload.feed) ? payload.feed : [];
    const mapped = feed.map((entry) => {
      const row = isRecord(entry) ? entry : {};
      const sentiments = Array.isArray(row.ticker_sentiment) ? row.ticker_sentiment : [];
      const match = sentiments.find((item) => isRecord(item) && item.ticker === request.symbol);
      return {
        id: row.banner_image ?? null,
        headline: row.title,
        summary: row.summary,
        source: row.source,
        url: row.url,
        publishedAt: avTimePublishedToIso(row.time_published),
        symbol: request.symbol,
        sentiment:
          isRecord(match) && typeof match.ticker_sentiment_label === 'string'
            ? match.ticker_sentiment_label.toLowerCase().includes('bull')
              ? 'positive'
              : match.ticker_sentiment_label.toLowerCase().includes('bear')
                ? 'negative'
                : 'neutral'
            : 'unknown',
      };
    });
    const normalized = normalizeNews(mapped, request.symbol);
    if (!normalized.ok) return failure(providerError('bad_payload', 'alphavantage news failed validation', SOURCE));
    return success(normalized.value, buildProvenance({ source: SOURCE, status: 'delayed', asOf: normalized.value[0]?.publishedAt ?? null, delaySeconds: null, note: 'NEWS_SENTIMENT feed; sentiment labels come from the provider', deps: this.deps }));
  }
}