/**
 * Evidence registry.
 *
 * Citation IDs are minted here, server-side, from data that was actually
 * retrieved. The model may only reference IDs in this registry; anything else is
 * rejected by the validator. That is what makes "reject uncited factual claims"
 * enforceable rather than aspirational.
 */

import type { EvidenceItem, EvidenceKind } from './report-schema.ts';
import type { DataProvenance, DataStatus, MarketSnapshot } from '../market/types.ts';
import type { IndicatorSnapshot } from '../indicators/types.ts';
import { formatCompact, formatNumber, formatPercent, formatPrice } from '../utils/format.ts';

export class EvidenceRegistry {
  private readonly items = new Map<string, EvidenceItem>();
  private counter = 0;

  add(input: Omit<EvidenceItem, 'id'>): EvidenceItem {
    this.counter += 1;
    const id = `EV-${String(this.counter).padStart(3, '0')}`;
    const item: EvidenceItem = { ...input, id };
    this.items.set(id, item);
    return item;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  get(id: string): EvidenceItem | null {
    return this.items.get(id) ?? null;
  }

  ids(): Set<string> {
    return new Set(this.items.keys());
  }

  list(): EvidenceItem[] {
    return [...this.items.values()];
  }

  size(): number {
    return this.items.size;
  }
}

function provenanceFields(provenance: DataProvenance | null): { source: string; status: DataStatus; asOf: string | null; retrievedAt: string } {
  if (provenance === null) {
    return { source: 'none', status: 'unavailable', asOf: null, retrievedAt: new Date(0).toISOString() };
  }
  return {
    source: provenance.source,
    status: provenance.status,
    asOf: provenance.asOf,
    retrievedAt: provenance.retrievedAt,
  };
}

function ratioValue(value: number | null, digits = 2): string | null {
  return value === null ? null : formatNumber(value, digits);
}

/** Builds the evidence set from a market snapshot plus locally computed indicators. */
export function buildEvidence(snapshot: MarketSnapshot, indicators: IndicatorSnapshot | null, registry = new EvidenceRegistry()): EvidenceRegistry {
  const quoteMeta = provenanceFields(snapshot.quote.provenance);

  if (snapshot.quote.data) {
    const quote = snapshot.quote.data;
    registry.add({
      kind: 'fact',
      label: `${snapshot.symbol} last price`,
      value: formatPrice(quote.price),
      url: null,
      ...quoteMeta,
    });
    registry.add({
      kind: 'fact',
      label: `${snapshot.symbol} session change`,
      value: quote.changePercent === null ? null : formatPercent(quote.changePercent),
      url: null,
      ...quoteMeta,
    });
    if (quote.volume !== null) {
      registry.add({ kind: 'fact', label: `${snapshot.symbol} session volume`, value: formatCompact(quote.volume), url: null, ...quoteMeta });
    }
    if (quote.marketCap !== null) {
      registry.add({ kind: 'fact', label: `${snapshot.symbol} market capitalisation`, value: formatCompact(quote.marketCap), url: null, ...quoteMeta });
    }
  } else {
    registry.add({
      kind: 'fact',
      label: `${snapshot.symbol} quote`,
      value: null,
      url: null,
      ...provenanceFields(null),
    });
  }

  if (indicators) {
    const calc = (label: string, value: string | null): void => {
      registry.add({
        kind: 'calculation',
        label,
        value,
        source: 'local-calculation',
        status: snapshot.candles.provenance?.status ?? 'unavailable',
        asOf: indicators.lastTime,
        retrievedAt: indicators.computedAt,
        url: null,
      });
    };
    calc(`${snapshot.symbol} SMA20 / SMA50`, `${formatNumber(indicators.sma20?.latest)} / ${formatNumber(indicators.sma50?.latest)}`);
    calc(`${snapshot.symbol} EMA20 / EMA50`, `${formatNumber(indicators.ema20?.latest)} / ${formatNumber(indicators.ema50?.latest)}`);
    calc(`${snapshot.symbol} RSI(14)`, indicators.rsi14?.latest === null || indicators.rsi14?.latest === undefined ? null : formatNumber(indicators.rsi14.latest, 1));
    calc(
      `${snapshot.symbol} MACD(12,26,9) line / signal`,
      indicators.macd?.latest.macd === null || indicators.macd?.latest.macd === undefined
        ? null
        : `${formatNumber(indicators.macd.latest.macd)} / ${formatNumber(indicators.macd.latest.signal)}`,
    );
    calc(`${snapshot.symbol} ATR(14)`, indicators.atr14?.latest === null || indicators.atr14?.latest === undefined ? null : `${formatNumber(indicators.atr14.latest)} (${formatNumber(indicators.atrPercent)}% of price)`);
    calc(
      `${snapshot.symbol} Bollinger(20,2) position`,
      indicators.bollinger ? `${indicators.bollinger.latest.position} (%B ${formatNumber(indicators.bollinger.latest.percentB)})` : null,
    );
    calc(`${snapshot.symbol} volume trend`, indicators.volume ? `${indicators.volume.direction} (last/avg ${formatNumber(indicators.volume.latestRatio)})` : null);
    calc(
      `${snapshot.symbol} nearest support / resistance`,
      indicators.levels ? `${formatPrice(indicators.levels.nearestSupport?.price ?? null)} / ${formatPrice(indicators.levels.nearestResistance?.price ?? null)}` : null,
    );
    calc(
      `${snapshot.symbol} trend classification`,
      indicators.trend ? `${indicators.trend.direction} (strength ${formatNumber(indicators.trend.strength)}, slope ${formatNumber(indicators.trend.slopePercentPerBar, 3)}%/bar)` : null,
    );
    calc(
      `${snapshot.symbol} multi-timeframe alignment`,
      indicators.multiTimeframe ? `${indicators.multiTimeframe.alignment} (score ${formatNumber(indicators.multiTimeframe.score)})` : null,
    );
    calc(`${snapshot.symbol} 52-week range from candles`, indicators.levels ? `${formatPrice(indicators.levels.fiftyTwoWeekLow)} - ${formatPrice(indicators.levels.fiftyTwoWeekHigh)}` : null);
    calc(`${snapshot.symbol} bars used`, String(indicators.barsUsed));
  }

  if (snapshot.profile.data) {
    const meta = provenanceFields(snapshot.profile.provenance);
    const profile = snapshot.profile.data;
    registry.add({ kind: 'fact', label: `${snapshot.symbol} company profile`, value: [profile.name, profile.sector, profile.industry].filter(Boolean).join(' | ') || null, url: profile.website, ...meta });
  }

  if (snapshot.financials.data) {
    const meta = provenanceFields(snapshot.financials.provenance);
    const ratios = snapshot.financials.data.ratios;
    const statements = snapshot.financials.data.statements;
    registry.add({
      kind: 'fact',
      label: `${snapshot.symbol} valuation ratios`,
      value: `P/E ${ratioValue(ratios.peTrailing)} | fwd P/E ${ratioValue(ratios.peForward)} | P/S ${ratioValue(ratios.priceToSales)} | P/B ${ratioValue(ratios.priceToBook)} | EV/EBITDA ${ratioValue(ratios.evToEbitda)} | beta ${ratioValue(ratios.beta)}`,
      url: null,
      ...meta,
    });
    const latest = statements[0];
    if (latest) {
      registry.add({
        kind: 'fact',
        label: `${snapshot.symbol} latest reported period (${latest.period}${latest.asOf ? `, as of ${latest.asOf.slice(0, 10)}` : ''})`,
        value: `revenue ${latest.revenue === null ? 'n/a' : formatCompact(latest.revenue)} | rev growth YoY ${ratioValue(latest.revenueGrowthYoY)}% | gross margin ${ratioValue(latest.grossMargin)}% | operating margin ${ratioValue(latest.operatingMargin)}% | net margin ${ratioValue(latest.netMargin)}% | EPS ${ratioValue(latest.eps)}`,
        url: null,
        ...meta,
      });
    }
  }

  if (snapshot.estimates.data) {
    const meta = provenanceFields(snapshot.estimates.provenance);
    const estimates = snapshot.estimates.data;
    registry.add({
      kind: 'estimate',
      label: `${snapshot.symbol} analyst estimates (third-party opinion)`,
      value: `consensus ${estimates.ratingConsensus ?? 'n/a'} | target mean ${formatPrice(estimates.targetMean)} | range ${formatPrice(estimates.targetLow)}-${formatPrice(estimates.targetHigh)} | analysts ${estimates.analystsCovering === null ? 'n/a' : estimates.analystsCovering}`,
      url: null,
      ...meta,
    });
  }

  if (snapshot.earnings.data && snapshot.earnings.data.length > 0) {
    const meta = provenanceFields(snapshot.earnings.provenance);
    for (const event of snapshot.earnings.data.slice(0, 6)) {
      registry.add({
        kind: event.status === 'reported' ? 'fact' : 'estimate',
        label: `${snapshot.symbol} earnings ${event.status === 'reported' ? 'reported' : 'scheduled'} ${event.date.slice(0, 10)}`,
        value: `EPS estimate ${ratioValue(event.epsEstimate)} | EPS actual ${ratioValue(event.epsActual)} | revenue estimate ${event.revenueEstimate === null ? 'n/a' : formatCompact(event.revenueEstimate)}`,
        url: null,
        ...meta,
      });
    }
  }

  if (snapshot.news.data) {
    const meta = provenanceFields(snapshot.news.provenance);
    for (const item of snapshot.news.data.slice(0, 10)) {
      registry.add({
        kind: 'fact',
        label: `News (${item.source}, ${item.publishedAt.slice(0, 10)}): ${item.headline}`,
        value: item.summary,
        url: item.url,
        ...meta,
      });
    }
  }

  if (snapshot.macro.data) {
    const meta = provenanceFields(snapshot.macro.provenance);
    for (const event of snapshot.macro.data.slice(0, 6)) {
      registry.add({
        kind: 'fact',
        label: `Macro (${event.region}, ${event.importance}): ${event.name}`,
        value: [
          `scheduled ${event.scheduledAt}`,
          event.consensus === null ? null : `consensus ${event.consensus}`,
          event.previous === null ? null : `previous ${event.previous}`,
          event.relevanceNote,
        ]
          .filter(Boolean)
          .join(' | '),
        url: null,
        ...meta,
      });
    }
  }

  return registry;
}

/** Compact evidence table for the prompt: id, kind, label, value, source, status. */
export function renderEvidenceForPrompt(registry: EvidenceRegistry, maxItems = 60): string {
  const lines = registry.list().slice(0, maxItems).map((item) => {
    const value = item.value === null ? 'UNAVAILABLE' : item.value.replace(/\s+/g, ' ').slice(0, 300);
    return `${item.id} [${item.kind.toUpperCase()}] ${item.label} = ${value} (source: ${item.source}, status: ${item.status}${item.asOf ? `, as of ${item.asOf}` : ''})`;
  });
  return lines.join('\n');
}

export function countEvidenceByKind(registry: EvidenceRegistry): Record<EvidenceKind, number> {
  const counts: Record<EvidenceKind, number> = { fact: 0, calculation: 0, estimate: 0, ai_interpretation: 0 };
  for (const item of registry.list()) counts[item.kind] += 1;
  return counts;
}

/** Fraction of available evidence slots that actually hold data. */
export function evidenceCoverage(registry: EvidenceRegistry): number {
  const items = registry.list();
  if (items.length === 0) return 0;
  const filled = items.filter((item) => item.value !== null && item.status !== 'unavailable').length;
  return filled / items.length;
}