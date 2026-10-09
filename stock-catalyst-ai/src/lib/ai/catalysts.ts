/**
 * Catalyst timeline.
 *
 * Built deterministically from retrieved calendars and news - not by the model.
 * Each entry keeps a reference to the evidence item that produced it, so the UI can
 * show provenance and the validator can require a citation.
 */

import type { CatalystEntry, CatalystTimeline } from './types.ts';
import type { EvidenceRegistry } from './citations.ts';
import type { MarketSnapshot } from '../market/types.ts';
import type { IndicatorSnapshot } from '../indicators/types.ts';
import { formatNumber } from '../utils/format.ts';
import { sanitizeText } from '../security/sanitize.ts';

const DAY_MS = 86_400_000;

export interface CatalystOptions {
  nowTime?: number;
  horizonDays?: number;
  maxNews?: number;
  maxMacro?: number;
}

export function buildCatalystTimeline(
  snapshot: MarketSnapshot,
  evidence: EvidenceRegistry,
  indicators: IndicatorSnapshot | null,
  options: CatalystOptions = {},
): CatalystTimeline {
  const now = options.nowTime ?? Date.now();
  const horizonDays = options.horizonDays ?? 90;
  const warnings: string[] = [];
  const entries: CatalystEntry[] = [];

  const findEvidenceId = (labelPart: string): string | null => {
    const match = evidence.list().find((item) => item.label.includes(labelPart));
    return match ? match.id : null;
  };

  if (snapshot.earnings.data && snapshot.earnings.data.length > 0) {
    for (const event of snapshot.earnings.data) {
      const time = Date.parse(event.date);
      if (!Number.isFinite(time)) continue;
      const isInPast = time < now;
      const withinHorizon = time <= now + horizonDays * DAY_MS;
      if (isInPast && !withinHorizon && time < now - 180 * DAY_MS) continue;
      const surprise =
        event.epsActual !== null && event.epsEstimate !== null && event.epsEstimate !== 0
          ? ((event.epsActual - event.epsEstimate) / Math.abs(event.epsEstimate)) * 100
          : null;
      entries.push({
        id: `cat_earnings_${event.date.slice(0, 10)}`,
        kind: 'earnings',
        title: `${snapshot.symbol} ${event.fiscalPeriod ?? 'quarterly'} earnings ${isInPast ? 'reported' : 'scheduled'}`,
        detail: isInPast
          ? surprise === null
            ? 'Reported figures were not available from the configured source.'
            : `EPS surprise ${formatNumber(surprise, 1)}% versus the estimate.`
          : `EPS estimate ${event.epsEstimate === null ? 'unavailable' : formatNumber(event.epsEstimate)}${event.timeOfDay && event.timeOfDay !== 'unknown' ? `, ${event.timeOfDay.replace('_', ' ')}` : ''}`,
        date: event.date,
        direction: isInPast ? (surprise === null ? 'unknown' : surprise > 1 ? 'positive' : surprise < -1 ? 'negative' : 'mixed') : 'mixed',
        importance: 'high',
        isInPast,
        evidenceId: findEvidenceId(`earnings ${isInPast ? 'reported' : 'scheduled'} ${event.date.slice(0, 10)}`),
        source: snapshot.earnings.provenance?.source ?? 'unknown',
        status: snapshot.earnings.provenance?.status ?? 'unavailable',
      });
    }
  } else if (snapshot.earnings.error) {
    warnings.push(`earnings calendar unavailable (${snapshot.earnings.error.code})`);
  }

  if (snapshot.news.data && snapshot.news.data.length > 0) {
    for (const item of snapshot.news.data.slice(0, options.maxNews ?? 8)) {
      const time = Date.parse(item.publishedAt);
      entries.push({
        id: `cat_news_${item.id}`,
        kind: 'news',
        title: sanitizeText(item.headline, { maxLength: 200 }),
        detail: item.summary === null ? null : sanitizeText(item.summary, { maxLength: 400 }),
        date: Number.isFinite(time) ? item.publishedAt : new Date(now).toISOString(),
        direction: item.sentiment === 'positive' ? 'positive' : item.sentiment === 'negative' ? 'negative' : 'unknown',
        importance: Number.isFinite(time) && now - time < 3 * DAY_MS ? 'medium' : 'low',
        isInPast: Number.isFinite(time) ? time < now : true,
        evidenceId: findEvidenceId(item.headline.slice(0, 40)),
        source: snapshot.news.provenance?.source ?? item.source,
        status: snapshot.news.provenance?.status ?? 'unavailable',
      });
    }
  } else if (snapshot.news.error) {
    warnings.push(`company news unavailable (${snapshot.news.error.code})`);
  }

  if (snapshot.macro.data && snapshot.macro.data.length > 0) {
    for (const event of snapshot.macro.data.slice(0, options.maxMacro ?? 6)) {
      const time = Date.parse(event.scheduledAt);
      entries.push({
        id: `cat_macro_${event.id}`,
        kind: 'macro',
        title: sanitizeText(event.name, { maxLength: 200 }),
        detail: [
          event.consensus === null ? null : `consensus ${event.consensus}`,
          event.previous === null ? null : `previous ${event.previous}`,
          event.relevanceNote,
        ]
          .filter(Boolean)
          .join('; '),
        date: event.scheduledAt,
        direction: 'unknown',
        importance: event.importance,
        isInPast: Number.isFinite(time) ? time < now : true,
        evidenceId: findEvidenceId(event.name.slice(0, 40)),
        source: snapshot.macro.provenance?.source ?? 'unknown',
        status: snapshot.macro.provenance?.status ?? 'unavailable',
      });
    }
  } else if (snapshot.macro.error) {
    warnings.push(`macro calendar unavailable (${snapshot.macro.error.code})`);
  }

  if (indicators?.levels?.nearestSupport && indicators.lastClose !== null) {
    const distance = ((indicators.levels.nearestSupport.price - indicators.lastClose) / indicators.lastClose) * 100;
    if (Math.abs(distance) <= 3) {
      entries.push({
        id: 'cat_technical_support',
        kind: 'technical',
        title: 'Price is within 3% of the nearest support cluster',
        detail: `Nearest support ${formatNumber(indicators.levels.nearestSupport.price)} versus last close ${formatNumber(indicators.lastClose)} (${formatNumber(distance, 2)}%).`,
        date: indicators.lastTime ?? new Date(now).toISOString(),
        direction: 'unknown',
        importance: 'medium',
        isInPast: false,
        evidenceId: findEvidenceId('nearest support / resistance'),
        source: 'local-calculation',
        status: 'live',
      });
    }
  }

  entries.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

  const futureEarnings = entries.find((entry) => entry.kind === 'earnings' && !entry.isInPast) ?? null;
  const nextEarnings = futureEarnings;
  const daysToNextEarnings = nextEarnings === null ? null : Math.round((Date.parse(nextEarnings.date) - now) / DAY_MS);

  if (entries.length === 0) {
    warnings.push('no catalysts could be retrieved from any configured source');
  }

  return {
    entries,
    nextEarnings,
    daysToNextEarnings,
    warnings,
    generatedAt: new Date(now).toISOString(),
  };
}

/** Compact text form embedded in the prompt. */
export function renderCatalystsForPrompt(timeline: CatalystTimeline): string {
  if (timeline.entries.length === 0) {
    return `No catalysts retrieved. Warnings: ${timeline.warnings.join('; ') || 'none'}`;
  }
  const lines = timeline.entries.slice(0, 20).map((entry) =>
    `- ${entry.date.slice(0, 10)} [${entry.kind}/${entry.importance}/${entry.direction}${entry.isInPast ? '/past' : '/upcoming'}] ${entry.title}${entry.detail ? ` - ${entry.detail}` : ''}${entry.evidenceId ? ` (evidence ${entry.evidenceId})` : ''}`,
  );
  lines.push(
    timeline.nextEarnings
      ? `Next scheduled earnings: ${timeline.nextEarnings.date.slice(0, 10)} (${timeline.daysToNextEarnings} days away).`
      : 'No scheduled earnings date was retrieved; treat the next earnings date as unknown.',
  );
  if (timeline.warnings.length > 0) lines.push(`Gaps: ${timeline.warnings.join('; ')}`);
  return lines.join('\n');
}