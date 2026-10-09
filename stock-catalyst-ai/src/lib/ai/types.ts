/** Shared AI-layer types. */

import type { Horizon, RiskTolerance } from '../config/env.ts';
import type { AiReport } from './report-schema.ts';
import type { EvidenceItem } from './report-schema.ts';
import type { IndicatorSnapshot } from '../indicators/types.ts';
import type { MarketSnapshot } from '../market/types.ts';

export interface ResearchRequest {
  symbol: string;
  question: string;
  horizon: Horizon;
  riskTolerance: RiskTolerance;
  entryPrice: number | null;
  positionSize: number | null;
}

export type StageId =
  | 'validate_input'
  | 'collect_evidence'
  | 'compute_indicators'
  | 'build_catalysts'
  | 'build_prompt'
  | 'call_model'
  | 'validate_output'
  | 'repair_output'
  | 'assemble_report';

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface PipelineStage {
  id: StageId;
  label: string;
  status: StageStatus;
  detail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export type PipelineErrorCode =
  | 'invalid_input'
  | 'no_evidence'
  | 'ai_not_configured'
  | 'ai_timeout'
  | 'ai_rate_limited'
  | 'ai_unauthorized'
  | 'ai_upstream_error'
  | 'ai_invalid_response'
  | 'internal_error';

export interface PipelineMetrics {
  totalDurationMs: number;
  modelLatencyMs: number;
  attempts: number;
  evidenceCount: number;
  evidenceCoverage: number;
  citationCoverage: number;
  validationPassedFirstAttempt: boolean;
  dataSourcesAttempted: number;
  dataSourcesSucceeded: number;
  missingDataDetected: number;
}

export interface PipelineSuccess {
  ok: true;
  report: AiReport;
  evidence: EvidenceItem[];
  indicators: IndicatorSnapshot | null;
  snapshot: MarketSnapshot;
  catalysts: CatalystTimeline;
  stages: PipelineStage[];
  metrics: PipelineMetrics;
  warnings: string[];
}

export interface PipelineFailure {
  ok: false;
  code: PipelineErrorCode;
  message: string;
  evidence: EvidenceItem[];
  indicators: IndicatorSnapshot | null;
  snapshot: MarketSnapshot | null;
  catalysts: CatalystTimeline | null;
  stages: PipelineStage[];
  metrics: PipelineMetrics;
  warnings: string[];
  retryAfterSeconds: number | null;
}

export type PipelineResult = PipelineSuccess | PipelineFailure;

export interface CatalystEntry {
  id: string;
  kind: 'earnings' | 'news' | 'macro' | 'company' | 'technical';
  title: string;
  detail: string | null;
  date: string;
  direction: 'positive' | 'negative' | 'mixed' | 'unknown';
  importance: 'high' | 'medium' | 'low';
  isInPast: boolean;
  evidenceId: string | null;
  source: string;
  status: string;
}

export interface CatalystTimeline {
  entries: CatalystEntry[];
  nextEarnings: CatalystEntry | null;
  daysToNextEarnings: number | null;
  warnings: string[];
  generatedAt: string;
}