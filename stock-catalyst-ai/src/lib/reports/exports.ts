import { REPORT_DISCLAIMER, HUMAN_DECISION_NOTICE } from '../ai/report-schema.ts';
import type { SavedReport } from './store.ts';

export function exportReportJson(saved: SavedReport): string {
  return JSON.stringify({ ...saved, disclaimer: REPORT_DISCLAIMER, humanDecisionNotice: HUMAN_DECISION_NOTICE }, null, 2);
}

export function exportReportMarkdown(saved: SavedReport): string {
  const report = saved.report;
  const section = (heading: string, value: { narrative: string; citations: string[]; dataGaps: string[] }) =>
    [`## ${heading}`, value.narrative, `Evidence: ${value.citations.join(', ') || 'none'}`, ...(value.dataGaps.length ? [`Data gaps: ${value.dataGaps.join('; ')}`] : [])].join('\n\n');
  return [
    `# ${saved.request.symbol} research report`,
    `Generated ${saved.createdAt} · ${saved.generationMode === 'demo-template' ? 'DEMONSTRATION TEMPLATE — not AI output' : 'Qwen AI'} · ${saved.acknowledgedAt ? 'ACKNOWLEDGED' : 'UNREVIEWED'}`,
    `Question: ${saved.request.question}`,
    '',
    REPORT_DISCLAIMER,
    '',
    HUMAN_DECISION_NOTICE,
    '',
    `## Executive summary\n\n${report.executiveSummary}`,
    section('Market snapshot', report.marketSnapshot),
    section('Price action', report.priceAction),
    section('Technical posture', report.technicalPosture),
    section('Fundamental quality', report.fundamentalQuality),
    section('Valuation context', report.valuationContext),
    section('News and macro', report.newsAndMacro),
    `## Catalysts\n\n${report.catalysts.narrative}\n\n${report.catalysts.timeline.map((item) => `- ${item.date ?? 'Date unavailable'} · ${item.title} — ${item.whyItMatters} [${item.citations.join(', ')}]`).join('\n') || 'No catalysts retrieved.'}`,
    `## Bull / base / bear scenarios\n\n${(['bull', 'base', 'bear'] as const).map((name) => `### ${name.toUpperCase()}: ${report.scenarios[name].headline}\n\n${report.scenarios[name].narrative}\n\nAssumptions: ${report.scenarios[name].assumptions.join('; ')}\n\nEvidence: ${report.scenarios[name].citations.join(', ')}`).join('\n\n')}`,
    `## Risks\n\n${report.risks.map((risk) => `- ${risk.severity.toUpperCase()}: ${risk.risk} (${risk.likelihood} likelihood). ${risk.mitigation} [${risk.citations.join(', ')}]`).join('\n')}`,
    `## Invalidation conditions\n\n${report.invalidation.map((item) => `- ${item.condition} · observe ${item.observable}${item.threshold ? ` · threshold ${item.threshold}` : ''} [${item.citations.join(', ')}]`).join('\n')}`,
    `## Confidence and limitations\n\n${report.confidence.label} (${report.confidence.score.toFixed(2)}): ${report.confidence.explanation}\n\n${report.limitations.map((item) => `- ${item}`).join('\n')}`,
    `## Evidence and provenance\n\n${saved.evidence.map((item) => `- **${item.id}** ${item.kind}: ${item.label} = ${item.value ?? 'Unavailable'} · ${item.source} · ${item.status.toUpperCase()} · as of ${item.asOf ?? 'unknown'} · retrieved ${item.retrievedAt}${item.url ? ` · ${item.url}` : ''}`).join('\n')}`,
    `\nGenerated at ${saved.createdAt}. Human decision required.`,
  ].join('\n\n');
}
