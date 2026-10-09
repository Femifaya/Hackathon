import { resetConfigCache } from '../src/lib/config/env.ts';
import { resetRegistry } from '../src/lib/market/registry.ts';
import { runResearch, validateResearchInput } from '../src/lib/reports/pipeline.ts';
import { getReportStore, resetReportStore } from '../src/lib/reports/store.ts';

process.env.DEMO_MODE = 'true';
resetConfigCache();
resetRegistry();

const input = validateResearchInput({
  symbol: 'NVDA',
  question: 'What evidence and risks should I review before a medium-risk swing research decision?',
  horizon: '3_to_12_weeks',
  riskTolerance: 'medium',
  entryPrice: null,
  positionSize: null,
});

if (!input.ok) throw new Error(input.message);
const result = await runResearch(input.value);
if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
getReportStore().save(result.saved);
process.stdout.write(`Saved demonstration report ${result.saved.id}. Open http://localhost:3000/reports/${result.saved.id}\n`);
resetReportStore();
