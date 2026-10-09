import { z } from 'zod';
import { getConfig, HORIZON_LABELS, RISK_LABELS } from '../config/env.ts';
import type { Horizon, RiskTolerance } from '../config/env.ts';
import { getRegistry } from '../market/registry.ts';
import { normalizeSymbol } from '../market/symbols.ts';
import { computeIndicatorSnapshot } from '../indicators/index.ts';
import { buildCatalystTimeline, renderCatalystsForPrompt } from '../ai/catalysts.ts';
import { buildEvidence, evidenceCoverage } from '../ai/citations.ts';
import { buildRepairPrompt, buildUserPrompt, SYSTEM_PROMPT } from '../ai/prompts.ts';
import { extractJsonObject, requestJsonCompletion } from '../ai/qwen-client.ts';
import { validateAiReport, describeIssues, citationCoverage } from '../ai/validator.ts';
import type { AiReport, EvidenceItem } from '../ai/report-schema.ts';
import type { ResearchRequest } from '../ai/types.ts';
import type { IndicatorSnapshot } from '../indicators/types.ts';
import type { MarketSnapshot } from '../market/types.ts';
import { createId } from '../utils/id.ts';
import type { SavedReport } from './store.ts';

const requestSchema = z.object({
  symbol: z.string().trim().min(1).max(10),
  question: z.string().trim().min(10).max(600),
  horizon: z.enum(['days_to_2_weeks', '2_to_8_weeks', '3_to_12_weeks', '6_to_18_months']),
  riskTolerance: z.enum(['low', 'medium', 'high']),
  entryPrice: z.number().finite().positive().max(10_000_000).nullable().default(null),
  positionSize: z.number().finite().positive().max(1_000_000_000).nullable().default(null),
}).strict();

export type ResearchInput = z.input<typeof requestSchema>;

export function validateResearchInput(input: unknown): { ok: true; value: ResearchRequest } | { ok: false; message: string } {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ') };
  const symbol = normalizeSymbol(parsed.data.symbol);
  if (!symbol) return { ok: false, message: 'Enter a valid US ticker symbol.' };
  return { ok: true, value: { ...parsed.data, symbol } };
}

function qualityNotes(snapshot: MarketSnapshot, evidence: EvidenceItem[]): string[] {
  const notes = evidence.filter((item) => item.value === null || item.status === 'unavailable').map((item) => `${item.label} unavailable`);
  for (const [name, slot] of Object.entries(snapshot)) {
    if (slot && typeof slot === 'object' && 'error' in slot && slot.error && !notes.some((note) => note.includes(name))) {
      notes.push(`${name} source unavailable (${slot.error.code})`);
    }
  }
  return [...new Set(notes)];
}

function cited(evidence: EvidenceItem[]): string[] {
  return evidence.filter((item) => item.value !== null).slice(0, 5).map((item) => item.id);
}

function demoReport(request: ResearchRequest, evidence: EvidenceItem[], indicators: IndicatorSnapshot | null, snapshot: MarketSnapshot): AiReport {
  const ids = cited(evidence);
  const fallbackIds = evidence.slice(0, 3).map((item) => item.id);
  const quoteId = evidence.find((item) => item.label.includes('last price'))?.id;
  const technicalId = evidence.find((item) => item.label.includes('trend classification'))?.id;
  const fundamentalsId = evidence.find((item) => item.label.includes('valuation ratios') || item.label.includes('company profile'))?.id;
  const newsId = evidence.find((item) => item.label.startsWith('News') || item.label.startsWith('Macro'))?.id;
  const sectionCitations = (specific: string | undefined) => specific ? [specific] : ids.slice(0, 1);
  const gapLabels = evidence.filter((item) => item.value === null).map((item) => `${item.label} was not returned by the selected source.`);
  const evidenceIds = ids.length >= 3 ? ids : fallbackIds;
  const priceText = snapshot.quote.data?.price === null || snapshot.quote.data?.price === undefined
    ? 'The selected demonstration source returned no quote for this symbol.'
    : `The synthetic demonstration quote records ${snapshot.symbol} at ${snapshot.quote.data.price.toFixed(2)} USD.`;
  const trendText = indicators?.trend
    ? `The local indicator calculation classifies the supplied synthetic series as ${indicators.trend.direction}, with a strength score of ${indicators.trend.strength.toFixed(2)}.`
    : 'A technical trend could not be computed from the available candle history.';
  const modeLabel = 'This is a deterministic local demonstration template built from synthetic demonstration inputs; it is not AI output or investment advice.';
  const commonAssumptions = ['This scenario is conditional and illustrative, not a forecast.', 'No unobserved price, event, or fundamental value is assumed.'];
  return {
    schemaVersion: 1,
    executiveSummary: `${modeLabel} ${priceText} ${trendText}`,
    objective: { question: request.question, symbol: request.symbol, horizon: request.horizon, riskTolerance: request.riskTolerance, entryPrice: request.entryPrice, positionSize: request.positionSize },
    marketSnapshot: { narrative: `${priceText} Market data status is ${snapshot.quote.provenance?.status ?? 'unavailable'} and must be interpreted using its source label.`, citations: sectionCitations(quoteId), dataGaps: gapLabels },
    priceAction: { narrative: `${trendText} The local series is synthetic in demo mode and must not be treated as an observed market history.`, citations: sectionCitations(technicalId), dataGaps: indicators ? [] : ['Candle history was unavailable for local calculations.'] },
    technicalPosture: { narrative: indicators ? `The locally calculated RSI(14) is ${indicators.rsi14?.latest?.toFixed(1) ?? 'unavailable'} and the multi-timeframe alignment is ${indicators.multiTimeframe?.alignment ?? 'unavailable'}. These are calculations over demonstration inputs.` : 'Technical posture is unavailable because sufficient candle data was not returned.', citations: sectionCitations(technicalId), dataGaps: indicators ? [] : ['Technical indicators unavailable.'] },
    fundamentalQuality: { narrative: snapshot.profile.data ? `The demonstration profile identifies ${snapshot.profile.data.name ?? request.symbol} in ${snapshot.profile.data.sector ?? 'an unavailable sector'}. This profile is synthetic and does not describe a real company.` : 'No company profile was returned by the selected source.', citations: sectionCitations(fundamentalsId), dataGaps: snapshot.profile.data ? ['Fundamental figures in demo mode are synthetic.'] : ['Company profile unavailable.'] },
    valuationContext: { narrative: 'No valuation conclusion is drawn from this local demo template. Review provider-backed filings and financial data before forming a view.', citations: sectionCitations(fundamentalsId), dataGaps: ['No real valuation evidence is supplied by this demo template.'] },
    catalysts: { narrative: 'The listed timeline is derived from the selected data source. Synthetic demonstration events, if present, are not real scheduled catalysts.', timeline: [] },
    newsAndMacro: { narrative: 'News and macro coverage is limited to retrieved evidence. No headline or calendar event is invented when a source returns none.', citations: sectionCitations(newsId), dataGaps: snapshot.news.data?.length || snapshot.macro.data?.length ? [] : ['No news or macro events were returned.'] },
    scenarios: {
      bull: { name: 'bull', headline: 'Evidence improves under a constructive case', narrative: 'If future verified evidence improves while the observed data remains consistent with the cited context, the research case could become more constructive. No price outcome is estimated.', assumptions: commonAssumptions, estimatedEffects: [{ metric: 'Research assessment', direction: 'positive', magnitude: 'qualitative only', rationale: 'Conditional on new verified evidence supporting the case.' }], probabilityLabel: 'low', citations: evidenceIds.slice(0, 2) },
      base: { name: 'base', headline: 'Evidence remains mixed or unchanged', narrative: 'If no material verified information changes the current evidence set, the research assessment remains informational and requires ongoing review.', assumptions: commonAssumptions, estimatedEffects: [{ metric: 'Research assessment', direction: 'neutral', magnitude: 'no numerical estimate', rationale: 'No unsupported price or return estimate is generated.' }], probabilityLabel: 'low', citations: evidenceIds.slice(0, 1) },
      bear: { name: 'bear', headline: 'Verified evidence weakens the case', narrative: 'If newly verified evidence contradicts the cited context or key data becomes unavailable, confidence in the research case should be reconsidered.', assumptions: commonAssumptions, estimatedEffects: [{ metric: 'Research assessment', direction: 'negative', magnitude: 'qualitative only', rationale: 'Conditional on verified contradictory evidence.' }], probabilityLabel: 'low', citations: evidenceIds.slice(0, 2) },
    },
    risks: [
      { risk: 'Synthetic demonstration inputs do not represent real market conditions.', severity: 'high', likelihood: 'high', mitigation: 'Use verified provider data before drawing any conclusion.', citations: evidenceIds.slice(0, 1) },
      { risk: 'Provider coverage may omit relevant events or financial information.', severity: 'medium', likelihood: 'medium', mitigation: 'Check the data gaps and verify against primary sources.', citations: evidenceIds.slice(0, 1) },
    ],
    invalidation: [{ condition: 'New verified evidence contradicts the cited research context.', observable: 'Subsequent provider evidence and primary-source disclosures', threshold: null, citations: evidenceIds.slice(0, 1) }],
    confidence: { score: 0.2, label: 'low', explanation: 'Confidence is deliberately low because this local demonstration template uses synthetic data and does not provide model-generated research.', evidenceCount: evidence.length },
    monitoring: ['Verify market price and timestamp from a primary source.', 'Review upcoming company disclosures and reported fundamentals.', 'Reassess if the retrieved evidence or its provenance changes.'],
    status: 'cautious',
    statusRationale: 'The output is a labelled demonstration template using synthetic inputs, so it does not express a real-world directional view.',
    limitations: [modeLabel, 'Research only; no investment, legal, or tax advice. Verify all information and make your own decision.', ...gapLabels.slice(0, 8)],
    humanDecisionRequired: true,
    disclaimerAcknowledgementRequired: true,
  };
}

export type ResearchRunResult = { ok: true; saved: SavedReport } | { ok: false; code: string; message: string };

export async function runResearch(request: ResearchRequest): Promise<ResearchRunResult> {
  const config = getConfig();
  if (!config.demoMode && !config.qwen.apiKey) {
    return { ok: false, code: 'ai_not_configured', message: 'QWEN_API_KEY is not configured. Market data is available, but no AI report was generated.' };
  }
  const id = createId('rpt');
  const createdAt = new Date().toISOString();
  const snapshot = await getRegistry().getSnapshot(request.symbol, { requestId: id });
  const indicators = snapshot.candles.data ? computeIndicatorSnapshot(request.symbol, snapshot.candles.data) : null;
  const evidenceRegistry = buildEvidence(snapshot, indicators);
  const evidence = evidenceRegistry.list();
  const catalysts = buildCatalystTimeline(snapshot, evidenceRegistry, indicators);
  const warnings = qualityNotes(snapshot, evidence);
  if (evidence.filter((item) => item.value !== null && item.status !== 'unavailable').length < 3) {
    return { ok: false, code: 'no_evidence', message: 'Too little verified data was returned to create a research report. Check data-provider settings and try again.' };
  }

  let generated: AiReport;
  let generationMode: SavedReport['generationMode'];
  if (config.demoMode) {
    generationMode = 'demo-template';
    generated = demoReport(request, evidence, indicators, snapshot);
  } else {
    if (!config.qwen.apiKey) return { ok: false, code: 'ai_not_configured', message: 'QWEN_API_KEY is not configured. Market data is available, but no AI report was generated.' };
    const prompt = buildUserPrompt({ request, evidence: evidenceRegistry, indicators, snapshot, catalystSummary: renderCatalystsForPrompt(catalysts), dataQualityNotes: warnings });
    const options = { apiKey: config.qwen.apiKey, baseUrl: config.qwen.baseUrl, model: config.qwen.model, timeoutMs: config.qwen.timeoutMs, maxRetries: config.qwen.maxRetries, maxTokens: config.qwen.maxTokens, temperature: config.qwen.temperature };
    let completion = await requestJsonCompletion([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }], options);
    if (!completion.ok) return { ok: false, code: completion.code, message: completion.message };
    let parsed: unknown = extractJsonObject(completion.content);
    const validationContext = { evidenceIds: evidenceRegistry.ids(), symbol: request.symbol, horizon: request.horizon, riskTolerance: request.riskTolerance, question: request.question, entryPrice: request.entryPrice, positionSize: request.positionSize };
    let validation = validateAiReport(parsed, validationContext);
    if (!validation.ok) {
      completion = await requestJsonCompletion([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }, { role: 'assistant', content: completion.content }, { role: 'user', content: buildRepairPrompt(describeIssues(validation.issues)) }], options);
      if (!completion.ok) return { ok: false, code: completion.code, message: completion.message };
      parsed = extractJsonObject(completion.content);
      validation = validateAiReport(parsed, validationContext);
    }
    if (!validation.ok) return { ok: false, code: 'ai_invalid_response', message: `The model response failed strict report validation: ${describeIssues(validation.issues)}` };
    generated = validation.value;
    generationMode = 'qwen';
  }

  const validatorContext = { evidenceIds: evidenceRegistry.ids(), symbol: request.symbol, horizon: request.horizon, riskTolerance: request.riskTolerance, question: request.question, entryPrice: request.entryPrice, positionSize: request.positionSize };
  const finalValidation = validateAiReport(generated, validatorContext);
  if (!finalValidation.ok) return { ok: false, code: 'ai_invalid_response', message: `The report failed strict validation: ${describeIssues(finalValidation.issues)}` };
  const citationRate = citationCoverage(generated, evidenceRegistry.ids()).coverage;
  const saved: SavedReport = { id, createdAt, acknowledgedAt: null, generationMode, request, report: finalValidation.value, evidence, catalysts, warnings: [...warnings, `Evidence coverage: ${(evidenceCoverage(evidenceRegistry) * 100).toFixed(0)}%.`, `Citation coverage: ${(citationRate * 100).toFixed(0)}%.`] };
  return { ok: true, saved };
}

export const RESEARCH_CHOICES: { horizons: readonly Horizon[]; risks: readonly RiskTolerance[] } = {
  horizons: ['days_to_2_weeks', '2_to_8_weeks', '3_to_12_weeks', '6_to_18_months'],
  risks: ['low', 'medium', 'high'],
};

export function horizonLabel(value: Horizon): string { return HORIZON_LABELS[value]; }
export function riskLabel(value: RiskTolerance): string { return RISK_LABELS[value]; }
