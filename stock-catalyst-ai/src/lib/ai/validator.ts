/**
 * Strict structural validation of model output.
 *
 * Failure modes this catches, all of which are required by the product rules:
 *  - a claim with no citation, or a citation to an evidence ID that was never
 *    minted from retrieved data;
 *  - guaranteed-outcome language ("will rise", "risk-free", "guaranteed");
 *  - missing or altered objective fields (the model must echo the user's inputs);
 *  - extra fields, which is how hidden chain-of-thought or injected instructions
 *    would be smuggled into a stored report;
 *  - out-of-range numbers, wrong enums, and empty sections.
 *
 * A failure is never partially rendered: the pipeline retries once with a repair
 * prompt and otherwise returns an explicit AI_INVALID_RESPONSE state.
 */

import type { ValidationIssue } from '../market/validators.ts';
import type {
  AiReport,
  CatalystItem,
  CitedSection,
  ConfidenceAssessment,
  InvalidationCondition,
  ReportObjective,
  RiskItem,
  Scenario,
  ScenarioEffect,
  ScenarioName,
} from './report-schema.ts';
import {
  CATALYST_KINDS,
  CONFIDENCE_LABELS,
  DIRECTIONS,
  EFFECT_DIRECTIONS,
  REPORT_SCHEMA_VERSION,
  REPORT_STATUSES,
  SCENARIO_NAMES,
  SEVERITIES,
} from './report-schema.ts';

export interface ValidatorContext {
  evidenceIds: ReadonlySet<string>;
  symbol: string;
  horizon: string;
  riskTolerance: string;
  question: string;
  entryPrice: number | null;
  positionSize: number | null;
  minUniqueCitations?: number;
}

export type ReportValidation =
  | { ok: true; value: AiReport; issues: ValidationIssue[]; warnings: ValidationIssue[] }
  | { ok: false; value: null; issues: ValidationIssue[] };

const CITATION_PATTERN = /^EV-\d{3}$/;

/** Phrases that promise an outcome. Any match fails validation. */
export const FORBIDDEN_PATTERNS: ReadonlyArray<{ regex: RegExp; label: string }> = [
  { regex: /\bguarantee[ds]?\b/i, label: 'guarantee' },
  { regex: /\brisk[- ]?free\b/i, label: 'risk_free' },
  { regex: /\b(can|could) not lose\b/i, label: 'no_loss' },
  { regex: /\bcan't lose\b/i, label: 'no_loss' },
  { regex: /\bsure thing\b/i, label: 'certainty' },
  { regex: /\bcertain(ly)? (to )?(rise|fall|profit|gain|beat|outperform)\b/i, label: 'certainty' },
  { regex: /\bwill (definitely |certainly )?(rise|fall|go up|go down|double|crash|beat|miss|outperform|underperform)\b/i, label: 'prediction' },
  { regex: /\bis (certainly |definitely |surely )?(going to |about to )?(rise|fall|go up|go down|double|crash|beat|miss|outperform|underperform)\b/i, label: 'prediction' },
  { regex: /\bpromised returns?\b/i, label: 'promised_returns' },
  { regex: /\bno risk\b/i, label: 'no_risk' },
  { regex: /\bbuy now\b/i, label: 'direct_instruction' },
  { regex: /\bsell now\b/i, label: 'direct_instruction' },
  { regex: /\b(put|go) all-?in\b/i, label: 'direct_instruction' },
];

export function findForbiddenLanguage(text: string): string[] {
  const hits: string[] = [];
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.regex.test(text)) hits.push(pattern.label);
  }
  return [...new Set(hits)];
}

class Checker {
  readonly issues: ValidationIssue[] = [];
  readonly warnings: ValidationIssue[] = [];
  readonly citations = new Set<string>();

  fail(path: string, message: string): void {
    this.issues.push({ path, message, fatal: true });
  }

  warn(path: string, message: string): void {
    this.warnings.push({ path, message });
  }

  record(value: unknown, path: string): void {
    if (typeof value === 'string') {
      for (const label of findForbiddenLanguage(value)) {
        this.fail(path, `forbidden language: ${label}`);
      }
    }
  }

  isRecord(value: unknown, path: string): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(path, 'expected an object');
      return false;
    }
    return true;
  }

  string(value: unknown, path: string, min: number, max: number, required = true): string | null {
    if (typeof value !== 'string') {
      if (required) this.fail(path, 'expected a string');
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length < min) {
      this.fail(path, `must be at least ${min} characters (got ${trimmed.length})`);
      return null;
    }
    if (trimmed.length > max) {
      this.fail(path, `must be at most ${max} characters (got ${trimmed.length})`);
      return null;
    }
    this.record(trimmed, path);
    return trimmed;
  }

  number(value: unknown, path: string, min: number, max: number, required = true): number | null {
    if (value === null || value === undefined) {
      if (required) this.fail(path, 'expected a number');
      return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.fail(path, 'expected a finite number');
      return null;
    }
    if (value < min || value > max) {
      this.fail(path, `must be within [${min}, ${max}] (got ${value})`);
      return null;
    }
    return value;
  }

  optionalNumber(value: unknown, path: string, min: number, max: number): number | null {
    if (value === null || value === undefined) return null;
    return this.number(value, path, min, max, true);
  }

  enumeration<T extends string>(value: unknown, path: string, allowed: readonly T[]): T | null {
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
      this.fail(path, `must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`);
      return null;
    }
    return value as T;
  }

  boolean(value: unknown, path: string, expected: boolean): boolean {
    if (value !== expected) {
      this.fail(path, `must be ${expected}`);
      return false;
    }
    return true;
  }

  stringArray(value: unknown, path: string, min: number, max: number, itemMin = 3, itemMax = 400): string[] {
    if (!Array.isArray(value)) {
      this.fail(path, 'expected an array of strings');
      return [];
    }
    if (value.length < min) {
      this.fail(path, `must contain at least ${min} item(s) (got ${value.length})`);
    }
    if (value.length > max) {
      this.fail(path, `must contain at most ${max} item(s) (got ${value.length})`);
    }
    const out: string[] = [];
    value.slice(0, max).forEach((entry, index) => {
      const text = this.string(entry, `${path}[${index}]`, itemMin, itemMax);
      if (text !== null) out.push(text);
    });
    return out;
  }

  citationArray(value: unknown, path: string, context: ValidatorContext, min = 0): string[] {
    if (!Array.isArray(value)) {
      this.fail(path, 'expected an array of citation ids');
      return [];
    }
    const out: string[] = [];
    value.slice(0, 25).forEach((entry, index) => {
      if (typeof entry !== 'string') {
        this.fail(`${path}[${index}]`, 'citation must be a string id');
        return;
      }
      if (!CITATION_PATTERN.test(entry)) {
        this.fail(`${path}[${index}]`, `citation "${entry}" is not a valid evidence id`);
        return;
      }
      if (!context.evidenceIds.has(entry)) {
        this.fail(`${path}[${index}]`, `citation "${entry}" does not exist in the retrieved evidence set`);
        return;
      }
      out.push(entry);
      this.citations.add(entry);
    });
    if (out.length < min) {
      this.fail(path, `requires at least ${min} valid citation(s) (got ${out.length})`);
    }
    return out;
  }

  unknownKeys(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.fail(`${path}.${key}`, 'unexpected field; the report schema is strict and extra content is rejected');
      }
    }
  }
}

const CITED_SECTION_KEYS = ['narrative', 'citations', 'dataGaps'] as const;
const SCENARIO_KEYS = ['name', 'headline', 'narrative', 'assumptions', 'estimatedEffects', 'probabilityLabel', 'citations'] as const;
const RISK_KEYS = ['risk', 'severity', 'likelihood', 'mitigation', 'citations'] as const;
const INVALIDATION_KEYS = ['condition', 'observable', 'threshold', 'citations'] as const;
const CATALYST_KEYS = ['title', 'date', 'kind', 'importance', 'direction', 'whyItMatters', 'citations'] as const;
const EFFECT_KEYS = ['metric', 'direction', 'magnitude', 'rationale'] as const;
const OBJECTIVE_KEYS = ['question', 'symbol', 'horizon', 'riskTolerance', 'entryPrice', 'positionSize'] as const;
const CONFIDENCE_KEYS = ['score', 'label', 'explanation', 'evidenceCount'] as const;

export function validateAiReport(payload: unknown, context: ValidatorContext): ReportValidation {
  const checker = new Checker();
  const minUniqueCitations = context.minUniqueCitations ?? 3;

  if (!checker.isRecord(payload, 'report')) {
    return { ok: false, value: null, issues: checker.issues };
  }
  const root = payload;
  const topKeys = [
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
  checker.unknownKeys(root, 'report', topKeys);

  if (root.schemaVersion !== REPORT_SCHEMA_VERSION) {
    checker.fail('report.schemaVersion', `must equal ${REPORT_SCHEMA_VERSION}`);
  }
  checker.boolean(root.humanDecisionRequired, 'report.humanDecisionRequired', true);
  checker.boolean(root.disclaimerAcknowledgementRequired, 'report.disclaimerAcknowledgementRequired', true);

  const executiveSummary = checker.string(root.executiveSummary, 'report.executiveSummary', 40, 1200);
  const objective = readObjective(root.objective, 'report.objective', checker, context);

  const citedSection = (value: unknown, path: string, requireCitation = true): CitedSection => {
    const empty: CitedSection = { narrative: '', citations: [], dataGaps: [] };
    if (!checker.isRecord(value, path)) return empty;
    checker.unknownKeys(value, path, CITED_SECTION_KEYS);
    const narrative = checker.string(value.narrative, `${path}.narrative`, 30, 1500) ?? '';
    const dataGaps = checker.stringArray(value.dataGaps, `${path}.dataGaps`, 0, 10, 3, 300);
    const citations = checker.citationArray(value.citations, `${path}.citations`, context, requireCitation && dataGaps.length === 0 ? 1 : 0);
    return { narrative, citations, dataGaps };
  };

  const marketSnapshot = citedSection(root.marketSnapshot, 'report.marketSnapshot');
  const priceAction = citedSection(root.priceAction, 'report.priceAction');
  const technicalPosture = citedSection(root.technicalPosture, 'report.technicalPosture');
  const fundamentalQuality = citedSection(root.fundamentalQuality, 'report.fundamentalQuality');
  const valuationContext = citedSection(root.valuationContext, 'report.valuationContext');
  const newsAndMacro = citedSection(root.newsAndMacro, 'report.newsAndMacro', false);

  const catalysts = readCatalysts(root.catalysts, 'report.catalysts', checker, context);
  const scenarios = readScenarios(root.scenarios, 'report.scenarios', checker, context);
  const risks = readRisks(root.risks, 'report.risks', checker, context);
  const invalidation = readInvalidation(root.invalidation, 'report.invalidation', checker, context);
  const confidence = readConfidence(root.confidence, 'report.confidence', checker, context);
  const monitoring = checker.stringArray(root.monitoring, 'report.monitoring', 2, 12, 3, 200);

  const status = checker.enumeration(root.status, 'report.status', REPORT_STATUSES);
  const statusRationale = checker.string(root.statusRationale, 'report.statusRationale', 20, 800);
  const limitations = checker.stringArray(root.limitations, 'report.limitations', 1, 12, 5, 300);

  if (checker.citations.size < minUniqueCitations) {
    checker.fail(
      'report.citations',
      `report cites ${checker.citations.size} distinct evidence item(s); at least ${minUniqueCitations} are required`,
    );
  }

  if (checker.issues.length > 0) {
    return { ok: false, value: null, issues: checker.issues };
  }

  const value: AiReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    executiveSummary: executiveSummary as string,
    objective: objective as ReportObjective,
    marketSnapshot,
    priceAction,
    technicalPosture,
    fundamentalQuality,
    valuationContext,
    catalysts,
    newsAndMacro,
    scenarios: scenarios as Record<ScenarioName, Scenario>,
    risks,
    invalidation,
    confidence: confidence as ConfidenceAssessment,
    monitoring,
    status: status as AiReport['status'],
    statusRationale: statusRationale as string,
    limitations,
    humanDecisionRequired: true,
    disclaimerAcknowledgementRequired: true,
  };

  return { ok: true, value, issues: [], warnings: checker.warnings };
}

function readObjective(value: unknown, path: string, checker: Checker, context: ValidatorContext): ReportObjective | null {
  if (!checker.isRecord(value, path)) return null;
  checker.unknownKeys(value, path, OBJECTIVE_KEYS);

  const question = checker.string(value.question, `${path}.question`, 5, 600);
  if (question !== null) {
    const normalizedQuestion = context.question.trim().toLowerCase();
    const normalizedEcho = question.trim().toLowerCase();
    if (!normalizedEcho.includes(normalizedQuestion.slice(0, 20)) && !normalizedQuestion.includes(normalizedEcho.slice(0, 20))) {
      checker.fail(`${path}.question`, 'the model altered the user question instead of echoing it');
    }
  }

  const symbol = checker.string(value.symbol, `${path}.symbol`, 1, 10);
  if (symbol !== null && symbol !== context.symbol) {
    checker.fail(`${path}.symbol`, `must equal the requested symbol ${context.symbol}`);
  }
  const horizon = checker.string(value.horizon, `${path}.horizon`, 1, 40);
  if (horizon !== null && horizon !== context.horizon) {
    checker.fail(`${path}.horizon`, 'must equal the requested horizon');
  }
  const riskTolerance = checker.string(value.riskTolerance, `${path}.riskTolerance`, 1, 40);
  if (riskTolerance !== null && riskTolerance !== context.riskTolerance) {
    checker.fail(`${path}.riskTolerance`, 'must equal the requested risk tolerance');
  }

  const entryPrice = checker.optionalNumber(value.entryPrice, `${path}.entryPrice`, 0, 1_000_000);
  if (entryPrice !== context.entryPrice) {
    checker.fail(`${path}.entryPrice`, 'must echo the value the user supplied (or null)');
  }
  const positionSize = checker.optionalNumber(value.positionSize, `${path}.positionSize`, 0, 1_000_000_000);
  if (positionSize !== context.positionSize) {
    checker.fail(`${path}.positionSize`, 'must echo the value the user supplied (or null)');
  }

  return {
    question: question ?? '',
    symbol: context.symbol,
    horizon: context.horizon,
    riskTolerance: context.riskTolerance,
    entryPrice,
    positionSize,
  };
}

function readCatalysts(value: unknown, path: string, checker: Checker, context: ValidatorContext): AiReport['catalysts'] {
  const fallback: AiReport['catalysts'] = { narrative: '', timeline: [] };
  if (!checker.isRecord(value, path)) return fallback;
  checker.unknownKeys(value, path, ['narrative', 'timeline']);
  const narrative = checker.string(value.narrative, `${path}.narrative`, 20, 1200) ?? '';
  if (!Array.isArray(value.timeline)) {
    checker.fail(`${path}.timeline`, 'expected an array');
    return { narrative, timeline: [] };
  }
  if (value.timeline.length > 20) {
    checker.fail(`${path}.timeline`, 'must contain at most 20 items');
  }
  const timeline: CatalystItem[] = [];
  value.timeline.slice(0, 20).forEach((entry, index) => {
    const itemPath = `${path}.timeline[${index}]`;
    if (!checker.isRecord(entry, itemPath)) return;
    checker.unknownKeys(entry, itemPath, CATALYST_KEYS);
    const title = checker.string(entry.title, `${itemPath}.title`, 3, 200);
    const kind = checker.enumeration(entry.kind, `${itemPath}.kind`, CATALYST_KINDS);
    const importance = checker.enumeration(entry.importance, `${itemPath}.importance`, SEVERITIES);
    const direction = checker.enumeration(entry.direction, `${itemPath}.direction`, DIRECTIONS);
    const whyItMatters = checker.string(entry.whyItMatters, `${itemPath}.whyItMatters`, 10, 600);
    const citations = checker.citationArray(entry.citations, `${itemPath}.citations`, context, 1);

    let date: string | null = null;
    if (entry.date === null || entry.date === undefined) {
      date = null;
    } else if (typeof entry.date === 'string' && Number.isFinite(Date.parse(entry.date))) {
      date = new Date(entry.date).toISOString();
    } else {
      checker.fail(`${itemPath}.date`, 'must be an ISO-8601 date or null');
    }

    if (title && kind && importance && direction && whyItMatters) {
      timeline.push({ title, date, kind, importance, direction, whyItMatters, citations });
    }
  });
  return { narrative, timeline };
}

function readScenarios(value: unknown, path: string, checker: Checker, context: ValidatorContext): Record<ScenarioName, Scenario> | null {
  if (!checker.isRecord(value, path)) return null;
  checker.unknownKeys(value, path, SCENARIO_NAMES);
  let complete = true;
  const out = {} as Record<ScenarioName, Scenario>;

  for (const name of SCENARIO_NAMES) {
    const scenarioPath = `${path}.${name}`;
    const raw = value[name];
    if (!checker.isRecord(raw, scenarioPath)) {
      complete = false;
      continue;
    }
    checker.unknownKeys(raw, scenarioPath, SCENARIO_KEYS);
    const echoedName = checker.enumeration(raw.name, `${scenarioPath}.name`, SCENARIO_NAMES);
    if (echoedName !== name) checker.fail(`${scenarioPath}.name`, `must equal "${name}"`);

    const headline = checker.string(raw.headline, `${scenarioPath}.headline`, 5, 160);
    const narrative = checker.string(raw.narrative, `${scenarioPath}.narrative`, 40, 1200);
    const assumptions = checker.stringArray(raw.assumptions, `${scenarioPath}.assumptions`, 1, 8, 3, 300);
    const probabilityLabel = checker.enumeration(raw.probabilityLabel, `${scenarioPath}.probabilityLabel`, CONFIDENCE_LABELS);
    const citations = checker.citationArray(raw.citations, `${scenarioPath}.citations`, context, 0);

    const effects: ScenarioEffect[] = [];
    if (!Array.isArray(raw.estimatedEffects)) {
      checker.fail(`${scenarioPath}.estimatedEffects`, 'expected an array');
    } else {
      if (raw.estimatedEffects.length > 8) {
        checker.fail(`${scenarioPath}.estimatedEffects`, 'must contain at most 8 items');
      }
      raw.estimatedEffects.slice(0, 8).forEach((entry, index) => {
        const effectPath = `${scenarioPath}.estimatedEffects[${index}]`;
        if (!checker.isRecord(entry, effectPath)) return;
        checker.unknownKeys(entry, effectPath, EFFECT_KEYS);
        const metric = checker.string(entry.metric, `${effectPath}.metric`, 2, 60);
        const direction = checker.enumeration(entry.direction, `${effectPath}.direction`, EFFECT_DIRECTIONS);
        const magnitude = checker.string(entry.magnitude, `${effectPath}.magnitude`, 1, 40);
        const rationale = checker.string(entry.rationale, `${effectPath}.rationale`, 5, 300);
        if (metric && direction && magnitude && rationale) {
          effects.push({ metric, direction, magnitude, rationale });
        }
      });
    }

    if (headline && narrative && probabilityLabel && assumptions.length > 0) {
      out[name] = { name, headline, narrative, assumptions, estimatedEffects: effects, probabilityLabel, citations };
    } else {
      complete = false;
    }
  }

  return complete ? out : null;
}

function readRisks(value: unknown, path: string, checker: Checker, context: ValidatorContext): RiskItem[] {
  if (!Array.isArray(value)) {
    checker.fail(path, 'expected an array');
    return [];
  }
  if (value.length < 2) checker.fail(path, 'must identify at least 2 risks');
  if (value.length > 12) checker.fail(path, 'must contain at most 12 risks');

  const risks: RiskItem[] = [];
  value.slice(0, 12).forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (!checker.isRecord(entry, itemPath)) return;
    checker.unknownKeys(entry, itemPath, RISK_KEYS);
    const risk = checker.string(entry.risk, `${itemPath}.risk`, 5, 300);
    const severity = checker.enumeration(entry.severity, `${itemPath}.severity`, SEVERITIES);
    const likelihood = checker.enumeration(entry.likelihood, `${itemPath}.likelihood`, CONFIDENCE_LABELS);
    const mitigation = checker.string(entry.mitigation, `${itemPath}.mitigation`, 5, 400);
    const citations = checker.citationArray(entry.citations, `${itemPath}.citations`, context, 0);
    if (risk && severity && likelihood && mitigation) {
      risks.push({ risk, severity, likelihood, mitigation, citations });
    }
  });
  return risks;
}

function readInvalidation(value: unknown, path: string, checker: Checker, context: ValidatorContext): InvalidationCondition[] {
  if (!Array.isArray(value)) {
    checker.fail(path, 'expected an array');
    return [];
  }
  if (value.length < 1) checker.fail(path, 'must state at least one invalidation condition');
  if (value.length > 8) checker.fail(path, 'must contain at most 8 conditions');

  const conditions: InvalidationCondition[] = [];
  value.slice(0, 8).forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (!checker.isRecord(entry, itemPath)) return;
    checker.unknownKeys(entry, itemPath, INVALIDATION_KEYS);
    const condition = checker.string(entry.condition, `${itemPath}.condition`, 5, 300);
    const observable = checker.string(entry.observable, `${itemPath}.observable`, 3, 200);
    const citations = checker.citationArray(entry.citations, `${itemPath}.citations`, context, 1);
    let threshold: string | null = null;
    if (entry.threshold === null || entry.threshold === undefined) {
      threshold = null;
    } else if (typeof entry.threshold === 'string' && entry.threshold.length <= 100) {
      threshold = entry.threshold.trim();
      checker.record(threshold, `${itemPath}.threshold`);
    } else {
      checker.fail(`${itemPath}.threshold`, 'must be a short string or null');
    }
    if (condition && observable) conditions.push({ condition, observable, threshold, citations });
  });
  return conditions;
}

function readConfidence(value: unknown, path: string, checker: Checker, context: ValidatorContext): ConfidenceAssessment | null {
  if (!checker.isRecord(value, path)) return null;
  checker.unknownKeys(value, path, CONFIDENCE_KEYS);
  const score = checker.number(value.score, `${path}.score`, 0, 1);
  const label = checker.enumeration(value.label, `${path}.label`, CONFIDENCE_LABELS);
  const explanation = checker.string(value.explanation, `${path}.explanation`, 20, 600);
  const evidenceCount = checker.number(value.evidenceCount, `${path}.evidenceCount`, 0, 100_000);

  if (score !== null && label !== null) {
    const expected = score < 0.4 ? 'low' : score < 0.7 ? 'medium' : 'high';
    if (label !== expected) {
      checker.fail(`${path}.label`, `label "${label}" does not match score ${score} (expected "${expected}")`);
    }
  }
  if (evidenceCount !== null && evidenceCount > context.evidenceIds.size) {
    checker.fail(`${path}.evidenceCount`, `claims ${evidenceCount} evidence items but only ${context.evidenceIds.size} were retrieved`);
  }
  if (score === null || label === null || explanation === null || evidenceCount === null) return null;
  return { score, label, explanation, evidenceCount };
}

export function collectCitations(report: AiReport): string[] {
  const ids = new Set<string>();
  const add = (values: readonly string[]) => values.forEach((id) => ids.add(id));
  add(report.marketSnapshot.citations);
  add(report.priceAction.citations);
  add(report.technicalPosture.citations);
  add(report.fundamentalQuality.citations);
  add(report.valuationContext.citations);
  add(report.newsAndMacro.citations);
  report.catalysts.timeline.forEach((item) => add(item.citations));
  SCENARIO_NAMES.forEach((name) => add(report.scenarios[name].citations));
  report.risks.forEach((item) => add(item.citations));
  report.invalidation.forEach((item) => add(item.citations));
  return [...ids];
}

export interface CitationCoverage {
  cited: number;
  available: number;
  coverage: number;
  uncitedIds: string[];
}

export function citationCoverage(report: AiReport, evidenceIds: ReadonlySet<string>): CitationCoverage {
  const cited = collectCitations(report);
  const uncitedIds = [...evidenceIds].filter((id) => !cited.includes(id));
  return {
    cited: cited.length,
    available: evidenceIds.size,
    coverage: evidenceIds.size === 0 ? 0 : cited.length / evidenceIds.size,
    uncitedIds,
  };
}

/** Summarises issues for the repair prompt sent back to the model. */
export function describeIssues(issues: readonly ValidationIssue[], limit = 12): string {
  return issues
    .slice(0, limit)
    .map((issue) => `- ${issue.path}: ${issue.message}`)
    .join('\n');
}