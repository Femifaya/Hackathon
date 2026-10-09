/**
 * Provider registry: the only place that decides where data comes from.
 *
 * Behaviour contract:
 *  1. Cache first (a cache hit is always relabelled `cached`, never `live`).
 *  2. Then providers in configured order, skipping those that lack the capability
 *     or are not configured.
 *  3. The first success wins and is cached.
 *  4. If every provider fails, return a typed failure. Nothing is invented.
 *  5. Uploaded data, when supplied by the caller, takes precedence for candles and
 *     is labelled `uploaded`.
 */

import type {
  AnalystEstimates,
  CandleRequest,
  CandleSeries,
  CompanyProfile,
  DataProvenance,
  EarningsEvent,
  Financials,
  MacroEvent,
  MarketDataProvider,
  MarketSnapshot,
  NewsItem,
  NewsRequest,
  ProviderCapability,
  ProviderContext,
  ProviderError,
  ProviderErrorCode,
  ProviderResult,
  Quote,
} from './types.ts';
import type { CacheStore } from './cache.ts';
import { MemoryCacheStore, cacheKey } from './cache.ts';
import type { ProviderDeps } from './provider-base.ts';
import { createProviderDeps, failure, providerError } from './provider-base.ts';
import { makeProvenance } from './provenance.ts';
import { StooqProvider } from './stooq.ts';
import { FinnhubProvider } from './finnhub.ts';
import { AlphaVantageProvider } from './alpha-vantage.ts';
import { TwelveDataProvider } from './twelve-data.ts';
import { DemoProvider } from './demo.ts';
import { SlidingWindowRateLimiter } from '../utils/rate-limiter.ts';
import { Logger } from '../utils/logger.ts';
import type { AppConfig } from '../config/env.ts';
import { loadConfig } from '../config/env.ts';

export interface FetchEvent {
  capability: ProviderCapability;
  symbol: string | null;
  provider: string;
  outcome: 'cache_hit' | 'success' | 'failure';
  code: ProviderErrorCode | null;
  durationMs: number;
}

export interface RegistryOptions {
  config?: AppConfig;
  providers?: MarketDataProvider[];
  cache?: CacheStore;
  limiter?: SlidingWindowRateLimiter | null;
  deps?: Partial<ProviderDeps>;
  logger?: Logger;
  onEvent?: (event: FetchEvent) => void;
}

const CAPABILITY_TTL: Record<string, keyof AppConfig['cache']> = {
  quote: 'ttlQuoteSeconds',
  candles: 'ttlCandlesSeconds',
  profile: 'ttlFundamentalsSeconds',
  financials: 'ttlFundamentalsSeconds',
  estimates: 'ttlFundamentalsSeconds',
  earnings_calendar: 'ttlFundamentalsSeconds',
  news: 'ttlNewsSeconds',
  macro_events: 'ttlNewsSeconds',
};

function aggregateError(capability: ProviderCapability, errors: readonly ProviderError[]): ProviderError {
  if (errors.length === 0) {
    return providerError('unsupported', `no provider is configured for ${capability}`, 'registry');
  }
  const priority: ProviderErrorCode[] = ['rate_limited', 'timeout', 'unauthenticated', 'upstream_error', 'bad_payload', 'not_found', 'unsupported', 'disabled'];
  const ranked = [...errors].sort(
    (a, b) => priority.indexOf(a.code) - priority.indexOf(b.code),
  );
  const primary = ranked[0];
  const detail = errors.map((error) => `${error.source}: ${error.code}`).join(', ');
  return providerError(
    primary.code,
    `${capability} unavailable from every configured source (${detail})`,
    'registry',
    primary.retryAfterSeconds,
  );
}

export class MarketDataRegistry {
  private readonly config: AppConfig;
  private readonly providers: MarketDataProvider[];
  private readonly cache: CacheStore;
  private readonly limiter: SlidingWindowRateLimiter | null;
  private readonly deps: ProviderDeps;
  private readonly logger: Logger;
  private readonly onEvent: ((event: FetchEvent) => void) | null;

  constructor(options: RegistryOptions = {}) {
    this.config = options.config ?? loadConfig();
    this.cache = options.cache ?? new MemoryCacheStore(1000);
    this.limiter =
      options.limiter === undefined
        ? new SlidingWindowRateLimiter(this.config.providers.requestsPerMinute, 60_000)
        : options.limiter;
    this.logger = options.logger ?? new Logger({ scope: 'market' });
    this.onEvent = options.onEvent ?? null;
    this.deps = createProviderDeps({
      timeoutMs: this.config.providers.httpTimeoutMs,
      limiter: this.limiter,
      logger: this.logger,
      staleAfterSeconds: this.config.cache.staleAfterSeconds,
      ...options.deps,
    });
    this.providers = options.providers ?? defaultProviders(this.config, this.deps);
  }

  describeProviders(): Array<{ id: string; label: string; configured: boolean; capabilities: ProviderCapability[] }> {
    return this.providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      configured: provider.isConfigured(),
      capabilities: provider.capabilities,
    }));
  }

  private eligible(capability: ProviderCapability): MarketDataProvider[] {
    const order = this.config.providers.order;
    return [...this.providers]
      .filter((provider) => provider.capabilities.includes(capability))
      .filter((provider) => provider.isConfigured())
      .sort((a, b) => {
        const ai = order.indexOf(a.id as never);
        const bi = order.indexOf(b.id as never);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });
  }

  private context(requestId: string): ProviderContext {
    return { timeoutMs: this.config.providers.httpTimeoutMs, requestId };
  }

  private async fetch<T>(
    capability: ProviderCapability,
    key: string,
    symbol: string | null,
    requestId: string,
    invoke: (provider: MarketDataProvider, ctx: ProviderContext) => Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>> {
    const started = Date.now();
    const ttlKey = CAPABILITY_TTL[capability] ?? 'ttlQuoteSeconds';
    const ttl = this.config.cache[ttlKey];

    if (ttl > 0) {
      const hit = this.cache.get<T>(key, this.config.cache.staleAfterSeconds, this.deps.now());
      if (hit) {
        this.emit(capability, symbol, 'cache', 'cache_hit', null, started);
        return { ok: true, data: hit.value, provenance: hit.provenance };
      }
    }

    const errors: ProviderError[] = [];
    for (const provider of this.eligible(capability)) {
      const result = await invoke(provider, this.context(requestId));
      if (result.ok) {
        if (ttl > 0) this.cache.set(key, result.data, result.provenance, ttl, this.deps.now());
        this.emit(capability, symbol, provider.id, 'success', null, started);
        return result;
      }
      errors.push({ code: result.code, message: result.message, source: result.source, retryAfterSeconds: result.retryAfterSeconds });
      this.emit(capability, symbol, provider.id, 'failure', result.code, started);
      this.logger.warn('provider failure', { capability, provider: provider.id, code: result.code });
    }

    return failure(aggregateError(capability, errors));
  }

  private emit(
    capability: ProviderCapability,
    symbol: string | null,
    provider: string,
    outcome: FetchEvent['outcome'],
    code: ProviderErrorCode | null,
    started: number,
  ): void {
    this.onEvent?.({ capability, symbol, provider, outcome, code, durationMs: Date.now() - started });
  }

  async getQuote(symbol: string, requestId = 'req'): Promise<ProviderResult<Quote>> {
    return this.fetch<Quote>('quote', cacheKey('quote', symbol), symbol, requestId, (provider, ctx) =>
      provider.getQuote(symbol, ctx),
    );
  }

  async getCandles(request: CandleRequest, requestId = 'req'): Promise<ProviderResult<CandleSeries>> {
    return this.fetch<CandleSeries>(
      'candles',
      cacheKey('candles', request.symbol, request.interval, request.limit, request.from, request.to),
      request.symbol,
      requestId,
      (provider, ctx) => provider.getCandles(request, ctx),
    );
  }

  async getProfile(symbol: string, requestId = 'req'): Promise<ProviderResult<CompanyProfile>> {
    return this.fetch<CompanyProfile>('profile', cacheKey('profile', symbol), symbol, requestId, (provider, ctx) =>
      provider.getProfile ? provider.getProfile(symbol, ctx) : Promise.resolve(failure(providerError('unsupported', 'provider has no profile capability', provider.id))),
    );
  }

  async getFinancials(symbol: string, requestId = 'req'): Promise<ProviderResult<Financials>> {
    return this.fetch<Financials>('financials', cacheKey('financials', symbol), symbol, requestId, (provider, ctx) =>
      provider.getFinancials ? provider.getFinancials(symbol, ctx) : Promise.resolve(failure(providerError('unsupported', 'provider has no financials capability', provider.id))),
    );
  }

  async getEstimates(symbol: string, requestId = 'req'): Promise<ProviderResult<AnalystEstimates>> {
    return this.fetch<AnalystEstimates>('estimates', cacheKey('estimates', symbol), symbol, requestId, (provider, ctx) =>
      provider.getEstimates ? provider.getEstimates(symbol, ctx) : Promise.resolve(failure(providerError('unsupported', 'provider has no estimates capability', provider.id))),
    );
  }

  async getEarningsCalendar(symbol: string, requestId = 'req'): Promise<ProviderResult<EarningsEvent[]>> {
    return this.fetch<EarningsEvent[]>('earnings_calendar', cacheKey('earnings', symbol), symbol, requestId, (provider, ctx) =>
      provider.getEarningsCalendar
        ? provider.getEarningsCalendar(symbol, ctx)
        : Promise.resolve(failure(providerError('unsupported', 'provider has no earnings calendar capability', provider.id))),
    );
  }

  async getNews(request: NewsRequest, requestId = 'req'): Promise<ProviderResult<NewsItem[]>> {
    return this.fetch<NewsItem[]>('news', cacheKey('news', request.symbol ?? '-', request.topic ?? '-', request.limit), request.symbol, requestId, (provider, ctx) =>
      provider.getNews ? provider.getNews(request, ctx) : Promise.resolve(failure(providerError('unsupported', 'provider has no news capability', provider.id))),
    );
  }

  async getMacroEvents(requestId = 'req'): Promise<ProviderResult<MacroEvent[]>> {
    return this.fetch<MacroEvent[]>('macro_events', cacheKey('macro', 'us'), null, requestId, (provider, ctx) =>
      provider.getMacroEvents
        ? provider.getMacroEvents(ctx)
        : Promise.resolve(failure(providerError('unsupported', 'provider has no macro calendar capability', provider.id))),
    );
  }

  /**
   * Collects everything a research surface needs. Requests run concurrently; each
   * slot keeps its own provenance and error so one provider failure never hides
   * the rest.
   */
  async getSnapshot(
    symbol: string,
    options: { requestId?: string; uploadedCandles?: CandleSeries | null; candleLimit?: number } = {},
  ): Promise<MarketSnapshot> {
    const requestId = options.requestId ?? `snap_${Date.now()}`;
    const limit = options.candleLimit ?? 400;

    const candleRequest: CandleRequest = { symbol, interval: '1d', from: null, to: null, limit };

    const candlesTask = options.uploadedCandles
      ? Promise.resolve<ProviderResult<CandleSeries>>({
          ok: true,
          data: options.uploadedCandles,
          provenance: uploadedProvenance(options.uploadedCandles, this.config.cache.staleAfterSeconds, this.deps.now()),
        })
      : this.getCandles(candleRequest, requestId);

    const [quote, candles, profile, financials, estimates, earnings, news, macro] = await Promise.all([
      this.getQuote(symbol, requestId),
      candlesTask,
      this.getProfile(symbol, requestId),
      this.getFinancials(symbol, requestId),
      this.getEstimates(symbol, requestId),
      this.getEarningsCalendar(symbol, requestId),
      this.getNews({ symbol, topic: null, limit: 15, from: null }, requestId),
      this.getMacroEvents(requestId),
    ]);

    return {
      symbol,
      generatedAt: new Date(this.deps.now()).toISOString(),
      quote: slot(quote),
      candles: slot(candles),
      profile: slot(profile),
      financials: slot(financials),
      estimates: slot(estimates),
      earnings: slot(earnings),
      news: slot(news),
      macro: slot(macro),
    };
  }
}

function slot<T>(result: ProviderResult<T>): { data: T | null; provenance: DataProvenance | null; error: ProviderError | null } {
  if (result.ok) {
    return { data: result.data, provenance: result.provenance, error: null };
  }
  return {
    data: null,
    provenance: null,
    error: { code: result.code, message: result.message, source: result.source, retryAfterSeconds: result.retryAfterSeconds },
  };
}

function uploadedProvenance(series: CandleSeries, staleAfterSeconds: number, nowTime: number): DataProvenance {
  const last = series.candles[series.candles.length - 1];
  return makeProvenance({
    source: 'csv-upload',
    status: 'uploaded',
    asOf: last ? last.time : null,
    retrievedAt: new Date(nowTime).toISOString(),
    delaySeconds: 0,
    note: `CSV upload: ${series.candles.length} bars; provider data was not mixed into this series`,
    staleAfterSeconds,
    nowTime,
  });
}

export function defaultProviders(config: AppConfig, deps: ProviderDeps): MarketDataProvider[] {
  return [
    new StooqProvider({ ...deps, limiter: deps.limiter }, config.providers.stooqEnabled && !config.demoMode),
    new FinnhubProvider(config.providers.keys.finnhub, deps),
    new AlphaVantageProvider(config.providers.keys.alphavantage, deps),
    new TwelveDataProvider(config.providers.keys.twelvedata, deps),
    new DemoProvider(),
  ];
}

let singleton: MarketDataRegistry | null = null;

export function getRegistry(): MarketDataRegistry {
  if (singleton === null) singleton = new MarketDataRegistry();
  return singleton;
}

export function resetRegistry(): void {
  singleton = null;
}
