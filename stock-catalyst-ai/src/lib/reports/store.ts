import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { getConfig } from '../config/env.ts';
import type { AiReport, EvidenceItem } from '../ai/report-schema.ts';
import { validateAiReport } from '../ai/validator.ts';
import type { ResearchRequest, CatalystTimeline } from '../ai/types.ts';
import { isRecord } from '../market/validators.ts';

export interface SavedReport {
  id: string;
  createdAt: string;
  acknowledgedAt: string | null;
  generationMode: 'demo-template' | 'qwen';
  request: ResearchRequest;
  report: AiReport;
  evidence: EvidenceItem[];
  catalysts: CatalystTimeline;
  warnings: string[];
}

const storedRequestSchema = z.object({
  symbol: z.string().regex(/^[A-Z][A-Z.-]{0,9}$/),
  question: z.string().min(10).max(600),
  horizon: z.enum(['days_to_2_weeks', '2_to_8_weeks', '3_to_12_weeks', '6_to_18_months']),
  riskTolerance: z.enum(['low', 'medium', 'high']),
  entryPrice: z.number().finite().positive().nullable(),
  positionSize: z.number().finite().positive().nullable(),
});

const evidenceSchema = z.object({
  id: z.string().regex(/^EV-\d{3}$/),
  kind: z.enum(['fact', 'calculation', 'estimate', 'ai_interpretation']),
  label: z.string(),
  value: z.string().nullable(),
  source: z.string(),
  status: z.enum(['live', 'delayed', 'cached', 'uploaded', 'demo', 'unavailable']),
  asOf: z.string().nullable(),
  retrievedAt: z.string(),
  url: z.string().nullable(),
});

const catalystsSchema = z.object({
  entries: z.array(z.object({
    id: z.string(), kind: z.enum(['earnings', 'news', 'macro', 'company', 'technical']), title: z.string(), detail: z.string().nullable(), date: z.string(),
    direction: z.enum(['positive', 'negative', 'mixed', 'unknown']), importance: z.enum(['high', 'medium', 'low']), isInPast: z.boolean(),
    evidenceId: z.string().nullable(), source: z.string(), status: z.string(),
  })),
  nextEarnings: z.object({
    id: z.string(), kind: z.enum(['earnings', 'news', 'macro', 'company', 'technical']), title: z.string(), detail: z.string().nullable(), date: z.string(),
    direction: z.enum(['positive', 'negative', 'mixed', 'unknown']), importance: z.enum(['high', 'medium', 'low']), isInPast: z.boolean(),
    evidenceId: z.string().nullable(), source: z.string(), status: z.string(),
  }).nullable(),
  daysToNextEarnings: z.number().nullable(),
  warnings: z.array(z.string()),
  generatedAt: z.string(),
});

function parseSavedReport(value: unknown): SavedReport | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^rpt_[a-z0-9]+$/i.test(value.id)
    || typeof value.createdAt !== 'string' || !(value.acknowledgedAt === null || typeof value.acknowledgedAt === 'string')
    || !(value.generationMode === 'demo-template' || value.generationMode === 'qwen') || !Array.isArray(value.evidence)) return null;
  const request = storedRequestSchema.safeParse(value.request);
  const evidenceResult = z.array(evidenceSchema).safeParse(value.evidence);
  const catalysts = catalystsSchema.safeParse(value.catalysts);
  const warnings = z.array(z.string()).safeParse(value.warnings);
  if (!request.success || !evidenceResult.success || !catalysts.success || !warnings.success) return null;
  const validation = validateAiReport(value.report, {
    evidenceIds: new Set(evidenceResult.data.map((item) => item.id)),
    symbol: request.data.symbol,
    horizon: request.data.horizon,
    riskTolerance: request.data.riskTolerance,
    question: request.data.question,
    entryPrice: request.data.entryPrice,
    positionSize: request.data.positionSize,
  });
  if (!validation.ok) return null;
  return {
    id: value.id,
    createdAt: value.createdAt,
    acknowledgedAt: value.acknowledgedAt,
    generationMode: value.generationMode,
    request: request.data,
    report: validation.value,
    evidence: evidenceResult.data,
    catalysts: catalysts.data,
    warnings: warnings.data,
  };
}

export class ReportStore {
  private readonly db: Database.Database;

  constructor(path = resolve(process.cwd(), getConfig().database.path), autoMigrate = true) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    if (autoMigrate) this.db.exec(`CREATE TABLE IF NOT EXISTS research_reports (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      acknowledged_at TEXT,
      generation_mode TEXT NOT NULL CHECK (generation_mode IN ('demo-template', 'qwen')),
      payload TEXT NOT NULL
    );`);
    else {
      const table: unknown = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'research_reports'").get();
      if (!table) throw new Error('Report database schema is missing; run the database migration first.');
    }
  }

  save(report: SavedReport): void {
    this.db.prepare(`INSERT INTO research_reports (id, created_at, acknowledged_at, generation_mode, payload)
      VALUES (@id, @createdAt, @acknowledgedAt, @generationMode, @payload)
      ON CONFLICT(id) DO UPDATE SET acknowledged_at = excluded.acknowledged_at, payload = excluded.payload`)
      .run({ ...report, payload: JSON.stringify(report) });
  }

  get(id: string): SavedReport | null {
    const row: unknown = this.db.prepare('SELECT payload FROM research_reports WHERE id = ?').get(id);
    if (!isRecord(row) || typeof row.payload !== 'string') return null;
    try {
      const payload: unknown = JSON.parse(row.payload);
      return parseSavedReport(payload);
    } catch {
      return null;
    }
  }

  list(limit = 50): SavedReport[] {
    const rows: unknown[] = this.db.prepare('SELECT payload FROM research_reports ORDER BY created_at DESC LIMIT ?').all(limit);
    return rows.flatMap((row) => {
      if (!isRecord(row) || typeof row.payload !== 'string') return [];
      try {
        const payload: unknown = JSON.parse(row.payload);
        const report = parseSavedReport(payload);
        return report ? [report] : [];
      } catch { return []; }
    });
  }

  acknowledge(id: string, acknowledgedAt = new Date().toISOString()): SavedReport | null {
    const report = this.get(id);
    if (!report) return null;
    const updated = { ...report, acknowledgedAt };
    this.save(updated);
    return updated;
  }

  close(): void {
    this.db.close();
  }
}

let singleton: ReportStore | null = null;

export function getReportStore(): ReportStore {
  singleton ??= new ReportStore(resolve(process.cwd(), getConfig().database.path), getConfig().database.autoMigrate);
  return singleton;
}

export function resetReportStore(): void {
  singleton?.close();
  singleton = null;
}
