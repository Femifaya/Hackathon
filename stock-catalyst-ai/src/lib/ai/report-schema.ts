/**
 * The exact shape the model must return.
 *
 * Design rules baked into these types:
 *  - Every analytical section carries `citations` (evidence IDs minted server-side)
 *    and `dataGaps` so absence of data is explicit.
 *  - Scenarios carry `assumptions` and `estimatedEffects`, never a price target
 *    presented as a forecast.
 *  - `disclaimerAcknowledgementRequired` is a literal `true`: a report that omits
 *    it fails validation.
 */

import type { CatalystKind, DataStatus } from '../market/types.ts';

export type ReportStatus = 'bullish' | 'neutral' | 'cautious' | 'bearish';
export type EvidenceKind = 'fact' | 'calculation' | 'estimate' | 'ai_interpretation';
export type ConfidenceLabel = 'low' | 'medium' | 'high';
export type Severity = 'low' | 'medium' | 'high';
export type ScenarioName = 'bull' | 'base' | 'bear';
export type EffectDirection = 'positive' | 'negative' | 'neutral';

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  label: string;
  value: string | null;
  source: string;
  status: DataStatus;
  asOf: string | null;
  retrievedAt: string;
  url: string | null;
}

export interface CitedSection {
  narrative: string;
  citations: string[];
  dataGaps: string[];
}

export interface CatalystItem {
  title: string;
  date: string | null;
  kind: CatalystKind;
  importance: Severity;
  direction: 'positive' | 'negative' | 'mixed' | 'unknown';
  whyItMatters: string;
  citations: string[];
}

export interface ScenarioEffect {
  metric: string;
  direction: EffectDirection;
  magnitude: string;
  rationale: string;
}

export interface Scenario {
  name: ScenarioName;
  headline: string;
  narrative: string;
  assumptions: string[];
  estimatedEffects: ScenarioEffect[];
  probabilityLabel: ConfidenceLabel;
  citations: string[];
}

export interface RiskItem {
  risk: string;
  severity: Severity;
  likelihood: ConfidenceLabel;
  mitigation: string;
  citations: string[];
}

export interface InvalidationCondition {
  condition: string;
  observable: string;
  threshold: string | null;
  citations: string[];
}

export interface ReportObjective {
  question: string;
  symbol: string;
  horizon: string;
  riskTolerance: string;
  entryPrice: number | null;
  positionSize: number | null;
}

export interface ConfidenceAssessment {
  score: number;
  label: ConfidenceLabel;
  explanation: string;
  evidenceCount: number;
}

export interface AiReport {
  schemaVersion: 1;
  executiveSummary: string;
  objective: ReportObjective;
  marketSnapshot: CitedSection;
  priceAction: CitedSection;
  technicalPosture: CitedSection;
  fundamentalQuality: CitedSection;
  valuationContext: CitedSection;
  catalysts: {
    narrative: string;
    timeline: CatalystItem[];
  };
  newsAndMacro: CitedSection;
  scenarios: Record<ScenarioName, Scenario>;
  risks: RiskItem[];
  invalidation: InvalidationCondition[];
  confidence: ConfidenceAssessment;
  monitoring: string[];
  status: ReportStatus;
  statusRationale: string;
  limitations: string[];
  humanDecisionRequired: true;
  disclaimerAcknowledgementRequired: true;
}

export const REPORT_SCHEMA_VERSION = 1;

export const REQUIRED_TOP_LEVEL_KEYS: readonly string[] = [
  'schemaVersion',
  'executiveSummary',
  'objective',
  'marketSnapshot',
  'priceAction',
  'technicalPosture',
  'fundamentalQuality',
  'valuationContext',
  'catalysts',
  'newsAndMacro',
  'scenarios',
  'risks',
  'invalidation',
  'confidence',
  'monitoring',
  'status',
  'statusRationale',
  'limitations',
  'humanDecisionRequired',
  'disclaimerAcknowledgementRequired',
];

export const REPORT_STATUSES: readonly ReportStatus[] = ['bullish', 'neutral', 'cautious', 'bearish'];
export const CONFIDENCE_LABELS: readonly ConfidenceLabel[] = ['low', 'medium', 'high'];
export const SEVERITIES: readonly Severity[] = ['low', 'medium', 'high'];
export const SCENARIO_NAMES: readonly ScenarioName[] = ['bull', 'base', 'bear'];
export const EFFECT_DIRECTIONS: readonly EffectDirection[] = ['positive', 'negative', 'neutral'];
export const EVIDENCE_KINDS: readonly EvidenceKind[] = ['fact', 'calculation', 'estimate', 'ai_interpretation'];
export const CATALYST_KINDS: readonly CatalystKind[] = ['earnings', 'news', 'macro', 'company', 'technical'];
export const DIRECTIONS: ReadonlyArray<'positive' | 'negative' | 'mixed' | 'unknown'> = ['positive', 'negative', 'mixed', 'unknown'];

export const REPORT_DISCLAIMER =
  'Stock Catalyst AI produces research only. Nothing here is investment, legal, or tax advice, no order can be placed from this application, and no outcome is guaranteed. Markets involve risk of loss, including total loss of capital. Verify every figure against primary sources before acting. The human user is solely responsible for any decision.';

export const HUMAN_DECISION_NOTICE =
  'Human decision required: this report is an evidence summary, not a recommendation. Review the evidence table, risks, and invalidation conditions, then decide for yourself.';
