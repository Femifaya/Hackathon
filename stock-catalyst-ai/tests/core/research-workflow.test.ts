import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache } from '../../src/lib/config/env.ts';
import { resetRegistry } from '../../src/lib/market/registry.ts';
import { DemoProvider, demoCandles } from '../../src/lib/market/demo.ts';
import { runResearch, validateResearchInput } from '../../src/lib/reports/pipeline.ts';
import { ReportStore } from '../../src/lib/reports/store.ts';
import { exportReportJson, exportReportMarkdown } from '../../src/lib/reports/exports.ts';

const previousDemoMode = process.env.DEMO_MODE;
process.env.DEMO_MODE = 'true';
resetConfigCache();
resetRegistry();

after(() => {
  if (previousDemoMode === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = previousDemoMode;
  resetConfigCache();
  resetRegistry();
});

describe('research request validation', () => {
  it('normalizes a valid ticker and accepts the requested research controls', () => {
    const result = validateResearchInput({
      symbol: ' nvda ',
      question: 'What evidence and risks should I review before a swing trade?',
      horizon: '3_to_12_weeks',
      riskTolerance: 'medium',
      entryPrice: null,
      positionSize: null,
    });
    assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.message}`);
    if (result.ok) assert.equal(result.value.symbol, 'NVDA');
  });

  it('rejects invalid symbols, missing questions, and unexpected fields', () => {
    assert.equal(validateResearchInput({ symbol: 'NVDA; DROP TABLE', question: 'Please review the evidence', horizon: '3_to_12_weeks', riskTolerance: 'medium' }).ok, false);
    assert.equal(validateResearchInput({ symbol: 'NVDA', question: 'short', horizon: '3_to_12_weeks', riskTolerance: 'medium' }).ok, false);
    assert.equal(validateResearchInput({ symbol: 'NVDA', question: 'Please review all available evidence', horizon: '3_to_12_weeks', riskTolerance: 'medium', executeTrade: true }).ok, false);
  });
});

describe('deterministic demonstration data', () => {
  it('keeps the latest quote consistent with its deterministic candle series', async () => {
    const provider = new DemoProvider();
    const context = { timeoutMs: 1000, requestId: 'demo-test' };
    const [quote, series] = await Promise.all([
      provider.getQuote('NVDA', context),
      provider.getCandles({ symbol: 'NVDA', interval: '1d', from: null, to: null, limit: 400 }, context),
    ]);
    assert.equal(quote.ok, true);
    assert.equal(series.ok, true);
    if (quote.ok && series.ok) assert.equal(quote.data.price, series.data.candles.at(-1)?.close);
    assert.deepEqual(demoCandles('NVDA', 8, 1_800_000_000_000), demoCandles('NVDA', 8, 1_800_000_000_000));
  });
});

describe('offline end-to-end report workflow', () => {
  it('returns an explicit AI-unavailable result without calling market providers when Qwen is not configured', async () => {
    const savedDemoMode = process.env.DEMO_MODE;
    const savedQwenKey = process.env.QWEN_API_KEY;
    process.env.DEMO_MODE = 'false';
    delete process.env.QWEN_API_KEY;
    resetConfigCache();
    resetRegistry();
    try {
      const input = validateResearchInput({ symbol: 'NVDA', question: 'Review the available evidence and discuss material risks.', horizon: '3_to_12_weeks', riskTolerance: 'medium' });
      assert.equal(input.ok, true);
      if (input.ok) {
        const result = await runResearch(input.value);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, 'ai_not_configured');
      }
    } finally {
      if (savedDemoMode === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = savedDemoMode;
      if (savedQwenKey === undefined) delete process.env.QWEN_API_KEY;
      else process.env.QWEN_API_KEY = savedQwenKey;
      resetConfigCache();
      resetRegistry();
    }
  });

  it('builds a labelled deterministic report, persists it, requires acknowledgement, and exports provenance', async () => {
    const input = validateResearchInput({
      symbol: 'NVDA',
      question: 'What evidence and risks should I review before a swing trade?',
      horizon: '3_to_12_weeks',
      riskTolerance: 'medium',
      entryPrice: null,
      positionSize: null,
    });
    assert.equal(input.ok, true);
    if (!input.ok) return;

    const result = await runResearch(input.value);
    assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.message}`);
    if (!result.ok) return;
    assert.equal(result.saved.generationMode, 'demo-template');
    assert.equal(result.saved.acknowledgedAt, null);
    assert.ok(result.saved.evidence.some((item) => item.status === 'demo'));
    assert.match(result.saved.report.executiveSummary, /not AI output/i);
    assert.equal(result.saved.report.humanDecisionRequired, true);

    const directory = mkdtempSync(join(tmpdir(), 'stock-catalyst-reports-'));
    const store = new ReportStore(join(directory, 'reports.sqlite'));
    try {
      store.save(result.saved);
      assert.equal(store.get(result.saved.id)?.acknowledgedAt, null);
      const acknowledged = store.acknowledge(result.saved.id, '2026-10-09T12:00:00.000Z');
      assert.equal(acknowledged?.acknowledgedAt, '2026-10-09T12:00:00.000Z');
      assert.equal(store.list()[0]?.id, result.saved.id);
      const markdown = exportReportMarkdown(acknowledged ?? result.saved);
      assert.match(markdown, /DEMONSTRATION TEMPLATE — not AI output/);
      assert.match(markdown, /Evidence and provenance/);
      assert.match(markdown, /Human decision required/);
      const json = exportReportJson(acknowledged ?? result.saved);
      assert.match(json, /"status": "demo"/);
      assert.match(json, /"acknowledgedAt": "2026-10-09T12:00:00.000Z"/);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
