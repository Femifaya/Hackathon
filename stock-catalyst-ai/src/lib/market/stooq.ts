/**
 * Stooq adapter: keyless daily OHLCV and delayed quotes for US listings.
 * Docs: https://stooq.com/db/h/ (free, no key, usage-limited).
 */

import type {
  CandleRequest,
  CandleSeries,
  MarketDataProvider,
  ProviderCapability,
  ProviderContext,
  ProviderResult,
  Quote,
} from './types.ts';
import type { ProviderDeps } from './provider-base.ts';
import { acquireSlot, buildProvenance, createProviderDeps, errorFromResponse, failure, fetchText, providerError, success } from './provider-base.ts';
import { normalizeQuote } from './validators.ts';
import { parseOhlcvCsv } from './csv.ts';
import { toStooqSymbol } from './symbols.ts';
import { validateCandles } from './candles.ts';

const SOURCE = 'stooq';
const BASE_URL = 'https://stooq.com';
const TYPICAL_DELAY_SECONDS = 900;

function ymd(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, '');
}

export class StooqProvider implements MarketDataProvider {
  readonly id = SOURCE;
  readonly label = 'Stooq (keyless, delayed)';
  readonly capabilities: ProviderCapability[] = ['quote', 'candles'];
  readonly typicalDelaySeconds = TYPICAL_DELAY_SECONDS;

  private readonly deps: ProviderDeps;
  private readonly enabled: boolean;

  constructor(deps: Partial<ProviderDeps> = {}, enabled = true) {
    this.deps = createProviderDeps(deps);
    this.enabled = enabled;
  }

  isConfigured(): boolean {
    return this.enabled;
  }

  async getQuote(symbol: string, _ctx: ProviderContext): Promise<ProviderResult<Quote>> {
    if (!this.enabled) return failure(providerError('disabled', 'stooq is disabled by configuration', SOURCE));
    const slot = acquireSlot(this.deps, `${SOURCE}:quote`, SOURCE);
    if (slot) return failure(slot);

    const url = `${BASE_URL}/q/l/?s=${encodeURIComponent(toStooqSymbol(symbol))}&f=sd2t2ohlcv&h&e=csv`;
    const response = await fetchText(url, this.deps);
    const transportError = errorFromResponse(response, SOURCE);
    if (transportError) return failure(transportError);

    const parsed = parseOhlcvCsv(response.text ?? '', { maxRows: 10, maxBytes: this.deps.maxBytes });
    const row = parsed.candles[0];
    if (!row) {
      return failure(providerError('not_found', `stooq returned no quote rows for ${symbol}`, SOURCE));
    }

    const candidate: Record<string, unknown> = {
      price: row.close,
      open: row.open,
      high: row.high,
      low: row.low,
      volume: row.volume,
    };
    const normalized = normalizeQuote(candidate, symbol);
    if (!normalized.ok) {
      return failure(providerError('bad_payload', `stooq quote failed validation: ${summarize(normalized.issues)}`, SOURCE));
    }

    const previousClose = normalized.value.previousClose;
    const price = normalized.value.price;
    const value: Quote = {
      ...normalized.value,
      change: previousClose !== null && price !== null ? round2(price - previousClose) : null,
      changePercent:
        previousClose !== null && previousClose !== 0 && price !== null
          ? round2(((price - previousClose) / previousClose) * 100)
          : null,
      exchange: 'STOOQ',
      currency: 'USD',
      isMarketOpen: null,
      marketCap: null,
    };

    return success(value, buildProvenance({
      source: SOURCE,
      status: 'delayed',
      asOf: row.time,
      delaySeconds: TYPICAL_DELAY_SECONDS,
      note: 'Stooq free feed; typically delayed at least 15 minutes',
      deps: this.deps,
    }));
  }

  async getCandles(request: CandleRequest, _ctx: ProviderContext): Promise<ProviderResult<CandleSeries>> {
    if (!this.enabled) return failure(providerError('disabled', 'stooq is disabled by configuration', SOURCE));
    const slot = acquireSlot(this.deps, `${SOURCE}:candles`, SOURCE);
    if (slot) return failure(slot);

    const params = new URLSearchParams({ s: toStooqSymbol(request.symbol), i: intervalCode(request.interval) });
    if (request.from) params.set('d1', ymd(request.from));
    if (request.to) params.set('d2', ymd(request.to));
    const url = `${BASE_URL}/q/d/l/?${params.toString()}`;

    const response = await fetchText(url, this.deps);
    const transportError = errorFromResponse(response, SOURCE);
    if (transportError) return failure(transportError);

    const text = response.text ?? '';
    if (/^No data/i.test(text.trim()) || text.trim() === '') {
      return failure(providerError('not_found', `stooq has no daily data for ${request.symbol}`, SOURCE));
    }

    const parsed = parseOhlcvCsv(text, { maxRows: Math.max(request.limit, 5000), maxBytes: this.deps.maxBytes });
    const validated = validateCandles(parsed.candles);
    if (validated.candles.length === 0) {
      return failure(
        providerError('bad_payload', `stooq CSV for ${request.symbol} produced no valid rows (${parsed.rejected.length} rejected)`, SOURCE),
      );
    }

    const candles = validated.candles.slice(Math.max(0, validated.candles.length - request.limit));
    const last = candles[candles.length - 1];
    return success(
      { symbol: request.symbol, interval: request.interval, adjustment: 'unknown', candles },
      buildProvenance({
        source: SOURCE,
        status: 'delayed',
        asOf: last.time,
        delaySeconds: TYPICAL_DELAY_SECONDS,
        note: `Stooq daily CSV; adjustment method not published (${parsed.warnings.concat(validated.warnings).join('; ') || 'no warnings'})`,
        deps: this.deps,
      }),
    );
  }
}

function intervalCode(interval: CandleRequest['interval']): string {
  if (interval === '1wk') return 'w';
  if (interval === '1mo') return 'm';
  return 'd';
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function summarize(issues: ReadonlyArray<{ path: string; message: string }>): string {
  return issues.slice(0, 3).map((issue) => `${issue.path}: ${issue.message}`).join(', ');
}
