/**
 * Domain types for the market-data layer. This module is intentionally
 * dependency-free (types only) so adapters, indicators, and tests can import it
 * without a bundler.
 */

export type DataStatus = 'live' | 'delayed' | 'cached' | 'uploaded' | 'demo' | 'unavailable';

export type ProviderErrorCode =
  | 'rate_limited'
  | 'timeout'
  | 'upstream_error'
  | 'not_found'
  | 'unsupported'
  | 'bad_payload'
  | 'unauthenticated'
  | 'disabled';

export type ProviderCapability =
  | 'quote'
  | 'candles'
  | 'profile'
  | 'financials'
  | 'earnings_calendar'
  | 'estimates'
  | 'news'
  | 'macro_events';

/** How prices in a candle series were adjusted for corporate actions. */
export type AdjustmentKind = 'full' | 'close_only' | 'none' | 'unknown';

export type CandleInterval = '1d' | '1wk' | '1mo';

export interface DataProvenance {
  source: string;
  status: DataStatus;
  retrievedAt: string;
  asOf: string | null;
  delaySeconds: number | null;
  stale: boolean;
  note: string | null;
}

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  source: string;
  retryAfterSeconds: number | null;
}

export type ProviderResult<T> =
  | { ok: true; data: T; provenance: DataProvenance }
  | ({ ok: false } & ProviderError);

export interface Quote {
  symbol: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  volume: number | null;
  marketCap: number | null;
  isMarketOpen: boolean | null;
  exchange: string | null;
  currency: string | null;
}

export interface Candle {
  /** Session start, UTC ISO-8601. */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface CandleSeries {
  symbol: string;
  interval: CandleInterval;
  adjustment: AdjustmentKind;
  candles: Candle[];
}

export interface CandleRequest {
  symbol: string;
  interval: CandleInterval;
  from: string | null;
  to: string | null;
  limit: number;
}

export interface CompanyProfile {
  symbol: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  description: string | null;
  exchange: string | null;
  country: string | null;
  employees: number | null;
  website: string | null;
  ipoDate: string | null;
  marketCap: number | null;
}

export type FiscalPeriod = 'quarterly' | 'annual' | 'ttm';

export interface FinancialStatement {
  period: FiscalPeriod;
  asOf: string | null;
  revenue: number | null;
  revenueGrowthYoY: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  eps: number | null;
  epsGrowthYoY: number | null;
  freeCashFlow: number | null;
  totalDebt: number | null;
  totalCash: number | null;
  currentRatio: number | null;
  returnOnEquity: number | null;
}

export interface Financials {
  symbol: string;
  statements: FinancialStatement[];
  ratios: ValuationRatios;
}

export interface ValuationRatios {
  peTrailing: number | null;
  peForward: number | null;
  pegRatio: number | null;
  priceToSales: number | null;
  priceToBook: number | null;
  evToEbitda: number | null;
  dividendYieldPercent: number | null;
  beta: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
}

export interface AnalystEstimates {
  symbol: string;
  ratingConsensus: string | null;
  ratingScaleNote: string | null;
  targetMean: number | null;
  targetHigh: number | null;
  targetLow: number | null;
  analystsCovering: number | null;
  epsCurrentYear: number | null;
  epsNextYear: number | null;
  revenueCurrentYear: number | null;
  revenueNextYear: number | null;
}

export type EarningsEventStatus = 'confirmed' | 'estimated' | 'reported';

export interface EarningsEvent {
  symbol: string;
  /** Date of the event; time may be unknown for calendar-only sources. */
  date: string;
  timeOfDay: 'before_market' | 'after_market' | 'unknown' | null;
  fiscalPeriod: FiscalPeriod | null;
  epsEstimate: number | null;
  epsActual: number | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
  status: EarningsEventStatus;
}

export interface NewsItem {
  id: string;
  symbol: string | null;
  headline: string;
  summary: string | null;
  source: string;
  url: string | null;
  publishedAt: string;
  sentiment: 'positive' | 'negative' | 'neutral' | 'unknown';
}

export interface NewsRequest {
  symbol: string | null;
  topic: string | null;
  limit: number;
  from: string | null;
}

export interface MacroEvent {
  id: string;
  name: string;
  /** UTC ISO-8601 date/time of the release. */
  scheduledAt: string;
  importance: 'high' | 'medium' | 'low';
  region: string;
  consensus: string | null;
  previous: string | null;
  actual: string | null;
  relevanceNote: string | null;
}

export interface ProviderContext {
  /** Milliseconds; adapters must abort beyond this. */
  timeoutMs: number;
  requestId: string;
  signal?: AbortSignal;
}

export interface MarketDataProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapability[];
  readonly typicalDelaySeconds: number | null;
  isConfigured(): boolean;
  getQuote(symbol: string, ctx: ProviderContext): Promise<ProviderResult<Quote>>;
  getCandles(req: CandleRequest, ctx: ProviderContext): Promise<ProviderResult<CandleSeries>>;
  getProfile?(symbol: string, ctx: ProviderContext): Promise<ProviderResult<CompanyProfile>>;
  getFinancials?(symbol: string, ctx: ProviderContext): Promise<ProviderResult<Financials>>;
  getEarningsCalendar?(symbol: string, ctx: ProviderContext): Promise<ProviderResult<EarningsEvent[]>>;
  getEstimates?(symbol: string, ctx: ProviderContext): Promise<ProviderResult<AnalystEstimates>>;
  getNews?(req: NewsRequest, ctx: ProviderContext): Promise<ProviderResult<NewsItem[]>>;
  getMacroEvents?(ctx: ProviderContext): Promise<ProviderResult<MacroEvent[]>>;
}

export type CatalystKind = 'earnings' | 'news' | 'macro' | 'company' | 'technical';

export interface Catalyst {
  id: string;
  kind: CatalystKind;
  title: string;
  detail: string | null;
  /** UTC ISO-8601. Past catalysts keep their occurrence date. */
  date: string;
  direction: 'positive' | 'negative' | 'mixed' | 'unknown';
  importance: 'high' | 'medium' | 'low';
  isInPast: boolean;
  evidenceId: string | null;
  provenance: DataProvenance;
}

/** Everything the UI needs to render one symbol's research surface. */
export interface MarketSnapshot {
  symbol: string;
  generatedAt: string;
  quote: { data: Quote | null; provenance: DataProvenance | null; error: ProviderError | null };
  candles: { data: CandleSeries | null; provenance: DataProvenance | null; error: ProviderError | null };
  profile: { data: CompanyProfile | null; provenance: DataProvenance | null; error: ProviderError | null };
  financials: { data: Financials | null; provenance: DataProvenance | null; error: ProviderError | null };
  estimates: { data: AnalystEstimates | null; provenance: DataProvenance | null; error: ProviderError | null };
  earnings: { data: EarningsEvent[] | null; provenance: DataProvenance | null; error: ProviderError | null };
  news: { data: NewsItem[] | null; provenance: DataProvenance | null; error: ProviderError | null };
  macro: { data: MacroEvent[] | null; provenance: DataProvenance | null; error: ProviderError | null };
}
