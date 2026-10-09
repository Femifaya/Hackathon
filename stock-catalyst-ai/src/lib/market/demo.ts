/**
 * Demonstration provider.
 *
 * Deterministic, offline, and unmistakably synthetic. It exists so the workbench
 * is fully usable with zero API keys - and so demos, CI, and tests never depend on
 * a third party. Every value it returns is labelled `demo`, and every label in the
 * UI, report, and export repeats that this is NOT real market data.
 */

import type {
  AnalystEstimates,
  Candle,
  CandleRequest,
  CandleSeries,
  CompanyProfile,
  EarningsEvent,
  Financials,
  MacroEvent,
  MarketDataProvider,
  NewsItem,
  NewsRequest,
  ProviderCapability,
  ProviderContext,
  ProviderResult,
  Quote,
} from './types.ts';
import { makeProvenance } from './provenance.ts';
import type { DataProvenance } from './types.ts';
import { demoSessionTimes } from './demo-time.ts';

const DEMO_NOTE = 'Synthetic demonstration data generated locally. Not real market data.';

/** mulberry32: tiny deterministic PRNG. Same symbol always yields same series. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSymbol(symbol: string): number {
  let hash = 2166136261;
  for (let index = 0; index < symbol.length; index += 1) {
    hash ^= symbol.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function provenance(asOf: string | null): DataProvenance {
  return makeProvenance({ source: 'demo', status: 'demo', asOf, delaySeconds: 0, note: DEMO_NOTE, staleAfterSeconds: 86_400 });
}

export function demoCandles(symbol: string, count = 400, endTime = Date.now()): Candle[] {
  const random = prng(hashSymbol(symbol));
  const candles: Candle[] = [];
  let price = 40 + random() * 160;
  const drift = (random() - 0.45) * 0.004;
  const volatility = 0.008 + random() * 0.02;
  const times = demoSessionTimes(count, endTime);

  for (let index = 0; index < count; index += 1) {
    const shock = (random() - 0.5) * 2 * volatility;
    const open = price;
    const close = Math.max(1, open * (1 + drift + shock));
    const high = Math.max(open, close) * (1 + random() * volatility * 0.6);
    const low = Math.min(open, close) * (1 - random() * volatility * 0.6);
    const volume = Math.round(500_000 + random() * 4_000_000);
    candles.push({
      time: times[index],
      open: round2(open),
      high: round2(high),
      low: round2(low),
      close: round2(close),
      volume,
    });
    price = close;
  }
  return candles;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export class DemoProvider implements MarketDataProvider {
  readonly id = 'demo';
  readonly label = 'Offline demonstration data';
  readonly capabilities: ProviderCapability[] = [
    'quote',
    'candles',
    'profile',
    'financials',
    'earnings_calendar',
    'estimates',
    'news',
    'macro_events',
  ];
  readonly typicalDelaySeconds = 0;

  isConfigured(): boolean {
    return true;
  }

  async getQuote(symbol: string, _ctx: ProviderContext): Promise<ProviderResult<Quote>> {
    // Quote and history use the same deterministic path so the latest close agrees.
    const candles = demoCandles(symbol, 400);
    const last = candles[candles.length - 1];
    const previous = candles[candles.length - 2] ?? last;
    const change = round2(last.close - previous.close);
    return {
      ok: true,
      data: {
        symbol,
        price: last.close,
        change,
        changePercent: round2((change / previous.close) * 100),
        open: last.open,
        high: last.high,
        low: last.low,
        previousClose: previous.close,
        volume: last.volume,
        marketCap: Math.round(last.close * 500_000_000),
        isMarketOpen: false,
        exchange: 'DEMO',
        currency: 'USD',
      },
      provenance: provenance(last.time),
    };
  }

  async getCandles(request: CandleRequest, _ctx: ProviderContext): Promise<ProviderResult<CandleSeries>> {
    const count = Math.min(400, Math.max(30, request.limit));
    const candles = demoCandles(request.symbol, count);
    return {
      ok: true,
      data: { symbol: request.symbol, interval: '1d', adjustment: 'full', candles },
      provenance: provenance(candles[candles.length - 1].time),
    };
  }

  async getProfile(symbol: string, _ctx: ProviderContext): Promise<ProviderResult<CompanyProfile>> {
    return {
      ok: true,
      data: {
        symbol,
        name: `${symbol} Demonstration Corp`,
        sector: 'Demonstration Sector',
        industry: 'Synthetic Data',
        description:
          'This profile is generated locally for demonstration purposes. It describes no real company and must not be used for research conclusions.',
        exchange: 'DEMO',
        country: 'US',
        employees: 12_345,
        website: null,
        ipoDate: '2010-01-04T00:00:00.000Z',
        marketCap: 12_300_000_000,
      },
      provenance: provenance(null),
    };
  }

  async getFinancials(symbol: string, _ctx: ProviderContext): Promise<ProviderResult<Financials>> {
    return {
      ok: true,
      data: {
        symbol,
        statements: [
          {
            period: 'quarterly',
            asOf: '2025-06-30T00:00:00.000Z',
            revenue: 9_500_000_000,
            revenueGrowthYoY: 12.4,
            grossMargin: 44.1,
            operatingMargin: 21.8,
            netMargin: 18.2,
            eps: 1.42,
            epsGrowthYoY: 9.5,
            freeCashFlow: 2_100_000_000,
            totalDebt: 8_400_000_000,
            totalCash: 15_200_000_000,
            currentRatio: 2.6,
            returnOnEquity: 34.5,
          },
        ],
        ratios: {
          peTrailing: 31.4,
          peForward: 27.1,
          pegRatio: 1.9,
          priceToSales: 8.2,
          priceToBook: 14.6,
          evToEbitda: 22.3,
          dividendYieldPercent: 0,
          beta: 1.35,
          fiftyTwoWeekHigh: 198.5,
          fiftyTwoWeekLow: 82.1,
        },
      },
      provenance: provenance('2025-06-30T00:00:00.000Z'),
    };
  }

  async getEarningsCalendar(symbol: string, _ctx: ProviderContext): Promise<ProviderResult<EarningsEvent[]>> {
    const now = Date.now();
    const upcoming = new Date(now + 26 * 86_400_000).toISOString().slice(0, 10);
    const past = new Date(now - 64 * 86_400_000).toISOString().slice(0, 10);
    return {
      ok: true,
      data: [
        {
          symbol,
          date: `${past}T20:30:00.000Z`,
          timeOfDay: 'after_market',
          fiscalPeriod: 'quarterly',
          epsEstimate: 1.31,
          epsActual: 1.42,
          revenueEstimate: 9_100_000_000,
          revenueActual: 9_500_000_000,
          status: 'reported',
        },
        {
          symbol,
          date: `${upcoming}T20:30:00.000Z`,
          timeOfDay: 'after_market',
          fiscalPeriod: 'quarterly',
          epsEstimate: 1.48,
          epsActual: null,
          revenueEstimate: 9_800_000_000,
          revenueActual: null,
          status: 'estimated',
        },
      ],
      provenance: provenance(new Date(now).toISOString()),
    };
  }

  async getEstimates(symbol: string, _ctx: ProviderContext): Promise<ProviderResult<AnalystEstimates>> {
    return {
      ok: true,
      data: {
        symbol,
        ratingConsensus: 'DEMO consensus',
        ratingScaleNote: 'Synthetic value; no analyst data is used in demonstration mode.',
        targetMean: null,
        targetHigh: null,
        targetLow: null,
        analystsCovering: null,
        epsCurrentYear: 5.8,
        epsNextYear: 6.9,
        revenueCurrentYear: 38_000_000_000,
        revenueNextYear: 43_000_000_000,
      },
      provenance: provenance(null),
    };
  }

  async getNews(request: NewsRequest, _ctx: ProviderContext): Promise<ProviderResult<NewsItem[]>> {
    const symbol = request.symbol ?? 'DEMO';
    const now = Date.now();
    const templates: Array<[string, NewsItem['sentiment']]> = [
      ['[DEMO] Quarterly results scheduled; no real filing exists', 'neutral'],
      ['[DEMO] Synthetic note on sector positioning', 'positive'],
      ['[DEMO] Synthetic note on supply-chain assumptions', 'negative'],
    ];
    return {
      ok: true,
      data: templates.map(([headline, sentiment], index) => ({
        id: `demo-${symbol.toLowerCase()}-${index}`,
        symbol,
        headline,
        summary: 'Generated locally for demonstration. Contains no real reporting and must not be cited as evidence.',
        source: 'demo-generator',
        url: null,
        publishedAt: new Date(now - index * 3_600_000).toISOString(),
        sentiment,
      })).slice(0, Math.max(1, request.limit)),
      provenance: provenance(new Date(now).toISOString()),
    };
  }

  async getMacroEvents(_ctx: ProviderContext): Promise<ProviderResult<MacroEvent[]>> {
    const now = Date.now();
    return {
      ok: true,
      data: [
        {
          id: 'demo-cpi',
          name: '[DEMO] CPI release',
          scheduledAt: new Date(now + 5 * 86_400_000).toISOString(),
          importance: 'high',
          region: 'US',
          consensus: null,
          previous: null,
          actual: null,
          relevanceNote: 'Synthetic calendar entry for demonstration mode.',
        },
        {
          id: 'demo-fomc',
          name: '[DEMO] Policy rate decision',
          scheduledAt: new Date(now + 19 * 86_400_000).toISOString(),
          importance: 'high',
          region: 'US',
          consensus: null,
          previous: null,
          actual: null,
          relevanceNote: 'Synthetic calendar entry for demonstration mode.',
        },
      ],
      provenance: provenance(new Date(now).toISOString()),
    };
  }
}

export const demoProvider = new DemoProvider();
