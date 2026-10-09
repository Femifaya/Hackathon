import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MarketDataRegistry } from '../../src/lib/market/registry.ts';
import { MemoryCacheStore, NullCacheStore, cacheKey } from '../../src/lib/market/cache.ts';
import { SlidingWindowRateLimiter } from '../../src/lib/utils/rate-limiter.ts';
import { loadConfig } from '../../src/lib/config/env.ts';
import { makeProvenance } from '../../src/lib/market/provenance.ts';
import type { AppConfig } from '../../src/lib/config/env.ts';
import type {
  CandleRequest,
  CandleSeries,
  MarketDataProvider,
  NewsRequest,
  ProviderCapability,
  ProviderContext,
  ProviderErrorCode,
  ProviderResult,
  Quote,
} from '../../src/lib/market/types.ts';

const NOW = Date.UTC(2025, 5, 15, 12, 0, 0);

function configWith(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ STOOQ_ENABLED: 'false', ...overrides });
}

function quote(symbol: string, price: number): Quote {
  return {
    symbol,
    price,
    change: null,
    changePercent: null,
    open: null,
    high: null,
    low: null,
    previousClose: null,
    volume: null,
    marketCap: null,
    isMarketOpen: null,
    exchange: 'TEST',
    currency: 'USD',
  };
}

function seriesOf(symbol: string, count = 60): CandleSeries {
  const candles = Array.from({ length: count }, (_, index) => ({
    time: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 1_000_000,
  }));
  return { symbol, interval: '1d', adjustment: 'full', candles };
}

interface FakeOptions {
  capabilities?: ProviderCapability[];
  configured?: boolean;
  quote?: (symbol: string) => ProviderResult<Quote>;
  candles?: (request: CandleRequest) => ProviderResult<CandleSeries>;
  news?: (request: NewsRequest) => ProviderResult<unknown[]>;
}

function fakeProvider(id: string, options: FakeOptions = {}): MarketDataProvider & { calls: Record<string, number> } {
  const calls: Record<string, number> = { quote: 0, candles: 0, news: 0, profile: 0, financials: 0, estimates: 0, earnings_calendar: 0, macro_events: 0 };
  const capabilities = options.capabilities ?? ['quote', 'candles'];
  // A capability with no handler answers like a provider that does not support it,
  // which is exactly how the registry must behave in production.
  const unsupported = <T>(capability: string): ProviderResult<T> => ({
    ok: false,
    code: 'unsupported',
    message: `${id} has no ${capability} handler`,
    source: id,
    retryAfterSeconds: null,
  });

  const provider: MarketDataProvider & { calls: Record<string, number> } = {
    id,
    label: `fake ${id}`,
    capabilities,
    typicalDelaySeconds: 0,
    calls,
    isConfigured: () => options.configured ?? true,
    getQuote: async (symbol: string, _ctx: ProviderContext) => {
      calls.quote += 1;
      return options.quote ? options.quote(symbol) : unsupported<Quote>('quote');
    },
    getCandles: async (request: CandleRequest, _ctx: ProviderContext) => {
      calls.candles += 1;
      return options.candles ? options.candles(request) : unsupported<CandleSeries>('candles');
    },
  };

  if (capabilities.includes('news')) {
    provider.getNews = async (request: NewsRequest, _ctx: ProviderContext) => {
      calls.news += 1;
      return (options.news ? options.news(request) : unsupported<unknown[]>('news')) as ProviderResult<never>;
    };
  }
  return provider;
}

function okQuote(symbol: string, price: number, source: string, asOf: string | null = new Date(NOW).toISOString()): ProviderResult<Quote> {
  return {
    ok: true,
    data: quote(symbol, price),
    provenance: makeProvenance({ source, status: 'live', asOf, retrievedAt: new Date(NOW).toISOString(), staleAfterSeconds: 900, nowTime: NOW }),
  };
}

function errQuote(source: string, code: ProviderErrorCode): ProviderResult<Quote> {
  return { ok: false, code, message: `${source} failed with ${code}`, source, retryAfterSeconds: code === 'rate_limited' ? 30 : null };
}

function registryWith(providers: MarketDataProvider[], overrides: Record<string, string> = {}) {
  const events: Array<{ provider: string; outcome: string; code: ProviderErrorCode | null; capability: string }> = [];
  const registry = new MarketDataRegistry({
    config: configWith(overrides),
    providers,
    limiter: null,
    deps: { now: () => NOW },
    onEvent: (event) => events.push({ provider: event.provider, outcome: event.outcome, code: event.code, capability: event.capability }),
  });
  return { registry, events };
}

describe('registry provider selection', () => {
  it('prefers the provider listed first in the configured order', async () => {
    const primary = fakeProvider('finnhub', { quote: (symbol) => okQuote(symbol, 111, 'finnhub') });
    const secondary = fakeProvider('alphavantage', { quote: (symbol) => okQuote(symbol, 222, 'alphavantage') });
    const { registry } = registryWith([secondary, primary], { MARKET_DATA_PROVIDER: 'finnhub,alphavantage' });
    const result = await registry.getQuote('NVDA', 'r1');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.price, 111);
      assert.equal(result.provenance.source, 'finnhub');
    }
    assert.equal(primary.calls.quote, 1);
    assert.equal(secondary.calls.quote, 0);
  });

  it('falls through to the next provider when the first is rate limited', async () => {
    const primary = fakeProvider('finnhub', { quote: (symbol) => errQuote('finnhub', 'rate_limited') });
    const secondary = fakeProvider('alphavantage', { quote: (symbol) => okQuote(symbol, 222, 'alphavantage') });
    const { registry, events } = registryWith([primary, secondary], { MARKET_DATA_PROVIDER: 'finnhub,alphavantage' });
    const result = await registry.getQuote('NVDA', 'r2');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.price, 222);
    assert.deepEqual(events, [
      { provider: 'finnhub', outcome: 'failure', code: 'rate_limited', capability: 'quote' },
      { provider: 'alphavantage', outcome: 'success', code: null, capability: 'quote' },
    ]);
  });

  it('skips providers that are not configured or lack the capability', async () => {
    const unconfigured = fakeProvider('finnhub', { configured: false, quote: (symbol) => okQuote(symbol, 111, 'finnhub') });
    const noQuote = fakeProvider('stooq', { capabilities: ['candles'], candles: (request) => ({ ok: true, data: seriesOf(request.symbol), provenance: makeProvenance({ source: 'stooq', status: 'delayed', nowTime: NOW }) }) });
    const working = fakeProvider('demo', { quote: (symbol) => okQuote(symbol, 333, 'demo') });
    const { registry } = registryWith([unconfigured, noQuote, working], { MARKET_DATA_PROVIDER: 'demo' });
    const result = await registry.getQuote('NVDA', 'r3');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.price, 333);
    assert.equal(unconfigured.calls.quote, 0);
  });

  it('aggregates failures and reports the most actionable code', async () => {
    const a = fakeProvider('finnhub', { quote: () => errQuote('finnhub', 'not_found') });
    const b = fakeProvider('alphavantage', { quote: () => errQuote('alphavantage', 'rate_limited') });
    const { registry } = registryWith([a, b], { MARKET_DATA_PROVIDER: 'finnhub,alphavantage' });
    const result = await registry.getQuote('NVDA', 'r4');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'rate_limited');
      assert.equal(result.retryAfterSeconds, 30);
      assert.match(result.message, /finnhub: not_found/);
      assert.match(result.message, /alphavantage: rate_limited/);
      assert.equal(result.source, 'registry');
    }
  });

  it('reports unsupported when no provider can serve the capability', async () => {
    const provider = fakeProvider('demo', { capabilities: ['quote'], quote: (symbol) => okQuote(symbol, 1, 'demo') });
    const { registry } = registryWith([provider], { MARKET_DATA_PROVIDER: 'demo' });
    const result = await registry.getMacroEvents('r5');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'unsupported');
      assert.match(result.message, /no provider is configured for macro_events/);
    }
  });
});

describe('registry caching', () => {
  it('serves the second request from cache and relabels it', async () => {
    const provider = fakeProvider('demo', { quote: (symbol) => okQuote(symbol, 100, 'demo') });
    const { registry, events } = registryWith([provider], { MARKET_DATA_PROVIDER: 'demo' });
    const first = await registry.getQuote('NVDA', 'c1');
    const second = await registry.getQuote('NVDA', 'c2');
    assert.equal(provider.calls.quote, 1);
    assert.equal(first.ok && first.provenance.status, 'live');
    assert.equal(second.ok && second.provenance.status, 'cached');
    assert.match(second.ok ? second.provenance.note ?? '' : '', /served from cache/);
    assert.deepEqual(events.map((event) => event.outcome), ['success', 'cache_hit']);
  });

  it('does not share cache entries across symbols', async () => {
    const provider = fakeProvider('demo', { quote: (symbol) => okQuote(symbol, symbol === 'AAA' ? 1 : 2, 'demo') });
    const { registry } = registryWith([provider], { MARKET_DATA_PROVIDER: 'demo' });
    await registry.getQuote('AAA', 'c3');
    const second = await registry.getQuote('BBB', 'c4');
    assert.equal(provider.calls.quote, 2);
    assert.equal(second.ok && second.data.price, 2);
  });

  it('disables caching when the TTL is zero', async () => {
    const provider = fakeProvider('demo', { quote: (symbol) => okQuote(symbol, 100, 'demo') });
    const { registry } = registryWith([provider], { MARKET_DATA_PROVIDER: 'demo', CACHE_TTL_QUOTE_SECONDS: '0' });
    await registry.getQuote('NVDA', 'c5');
    await registry.getQuote('NVDA', 'c6');
    assert.equal(provider.calls.quote, 2);
  });

  it('builds stable, namespaced cache keys', () => {
    assert.equal(cacheKey('quote', 'NVDA'), 'quote:NVDA');
    assert.equal(cacheKey('candles', 'NVDA', '1d', 400, null, undefined), 'candles:NVDA:1d:400:-:-');
  });
});

describe('registry staleness and uploads', () => {
  it('marks data stale when it is older than the tolerance', async () => {
    const old = new Date(NOW - 3600 * 1000).toISOString();
    const provider = fakeProvider('demo', { quote: (symbol) => okQuote(symbol, 100, 'demo', old) });
    const { registry } = registryWith([provider], { MARKET_DATA_PROVIDER: 'demo', STALE_AFTER_SECONDS: '900' });
    const result = await registry.getQuote('NVDA', 's1');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.provenance.stale, true);
      assert.equal(result.provenance.delaySeconds, 3600);
    }
  });

  it('prefers user-uploaded candles and labels them as uploaded', async () => {
    const provider = fakeProvider('demo', {
      candles: (request) => ({ ok: true, data: seriesOf(request.symbol, 10), provenance: makeProvenance({ source: 'demo', status: 'demo', nowTime: NOW }) }),
    });
    const uploaded = seriesOf('NVDA', 250);
    const { registry } = registryWith([provider], { MARKET_DATA_PROVIDER: 'demo' });
    const snapshot = await registry.getSnapshot('NVDA', { requestId: 'u1', uploadedCandles: uploaded });
    assert.equal(snapshot.candles.provenance?.status, 'uploaded');
    assert.equal(snapshot.candles.provenance?.source, 'csv-upload');
    assert.equal(snapshot.candles.data?.candles.length, 250);
    assert.match(snapshot.candles.provenance?.note ?? '', /not mixed/);
    assert.equal(provider.calls.candles, 0);
  });
});

describe('registry snapshot isolation', () => {
  it('keeps each data slot independent when one capability fails', async () => {
    const provider = fakeProvider('demo', {
      capabilities: ['quote', 'candles', 'news'],
      quote: (symbol) => okQuote(symbol, 100, 'demo'),
      candles: (request) => ({ ok: true, data: seriesOf(request.symbol), provenance: makeProvenance({ source: 'demo', status: 'demo', nowTime: NOW }) }),
      news: () => ({ ok: false as const, code: 'rate_limited' as const, message: 'news rate limited', source: 'demo', retryAfterSeconds: 60 }),
    });
    const { registry } = registryWith([provider], { MARKET_DATA_PROVIDER: 'demo' });
    const snapshot = await registry.getSnapshot('NVDA', { requestId: 'iso1' });

    assert.equal(snapshot.symbol, 'NVDA');
    assert.ok(snapshot.quote.data !== null);
    assert.ok(snapshot.candles.data !== null);
    assert.equal(snapshot.news.data, null);
    assert.equal(snapshot.news.error?.code, 'rate_limited');
    assert.equal(snapshot.news.provenance, null);
    assert.equal(snapshot.profile.data, null);
    assert.equal(snapshot.profile.error?.code, 'unsupported');
    assert.equal(snapshot.generatedAt, new Date(NOW).toISOString());
  });

  it('never throws when every capability fails', async () => {
    const provider = fakeProvider('demo', { quote: () => errQuote('demo', 'timeout') });
    const { registry } = registryWith([provider], { MARKET_DATA_PROVIDER: 'demo' });
    const snapshot = await registry.getSnapshot('NVDA', { requestId: 'iso2' });
    assert.equal(snapshot.quote.error?.code, 'timeout');
    assert.equal(snapshot.candles.data, null);
    assert.equal(snapshot.macro.data, null);
  });
});

describe('cache store', () => {
  const provenance = makeProvenance({ source: 'test', status: 'live', asOf: new Date(NOW).toISOString(), nowTime: NOW });

  it('expires entries after their TTL', () => {
    const store = new MemoryCacheStore();
    store.set('k', { value: 1 }, provenance, 60, NOW);
    assert.equal(store.get<{ value: number }>('k', 900, NOW + 59_000)?.value.value, 1);
    assert.equal(store.get('k', 900, NOW + 61_000), null);
    assert.equal(store.size(), 0);
  });

  it('evicts the oldest entry when full', () => {
    const store = new MemoryCacheStore(2);
    store.set('a', 1, provenance, 600, NOW);
    store.set('b', 2, provenance, 600, NOW);
    store.set('c', 3, provenance, 600, NOW);
    assert.equal(store.size(), 2);
    assert.equal(store.get('a', 900, NOW), null);
    assert.deepEqual(store.keys(), ['b', 'c']);
  });

  it('ignores a non-positive TTL', () => {
    const store = new MemoryCacheStore();
    store.set('k', 1, provenance, 0, NOW);
    assert.equal(store.size(), 0);
  });

  it('supports delete and clear', () => {
    const store = new MemoryCacheStore();
    store.set('k', 1, provenance, 600, NOW);
    assert.equal(store.delete('k'), true);
    assert.equal(store.delete('k'), false);
    store.set('k2', 1, provenance, 600, NOW);
    store.clear();
    assert.equal(store.size(), 0);
  });

  it('provides a null object store when caching is disabled', () => {
    const store = new NullCacheStore();
    store.set('k', 1, provenance, 600);
    assert.equal(store.get('k', 900), null);
    assert.equal(store.size(), 0);
    assert.deepEqual(store.keys(), []);
  });
});

describe('sliding window rate limiter', () => {
  it('allows up to the limit then reports a retry delay', () => {
    let clock = 1_000;
    const limiter = new SlidingWindowRateLimiter(3, 10_000, () => clock);
    assert.equal(limiter.consume('ip').allowed, true);
    assert.equal(limiter.consume('ip').allowed, true);
    assert.equal(limiter.check('ip').remaining, 1);
    assert.equal(limiter.consume('ip').allowed, true);
    const blocked = limiter.consume('ip');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, 10);
    assert.equal(blocked.limit, 3);
    assert.equal(blocked.windowSeconds, 10);
  });

  it('slides the window forward', () => {
    let clock = 0;
    const limiter = new SlidingWindowRateLimiter(2, 1000, () => clock);
    limiter.consume('ip');
    clock = 400;
    limiter.consume('ip');
    assert.equal(limiter.consume('ip').allowed, false);
    clock = 1001;
    assert.equal(limiter.consume('ip').allowed, true);
  });

  it('tracks keys independently and can be reset', () => {
    const limiter = new SlidingWindowRateLimiter(1, 60_000);
    assert.equal(limiter.consume('a').allowed, true);
    assert.equal(limiter.consume('b').allowed, true);
    assert.equal(limiter.consume('a').allowed, false);
    assert.equal(limiter.trackedKeys(), 2);
    limiter.reset('a');
    assert.equal(limiter.consume('a').allowed, true);
    limiter.reset();
    assert.equal(limiter.trackedKeys(), 0);
  });

  it('validates its configuration', () => {
    assert.throws(() => new SlidingWindowRateLimiter(0, 1000), RangeError);
    assert.throws(() => new SlidingWindowRateLimiter(1, 0), RangeError);
  });

  it('does not consume a slot when checking', () => {
    const limiter = new SlidingWindowRateLimiter(1, 60_000);
    assert.equal(limiter.check('a').allowed, true);
    assert.equal(limiter.check('a').allowed, true);
    assert.equal(limiter.consume('a').allowed, true);
    assert.equal(limiter.check('a').allowed, false);
  });
});
