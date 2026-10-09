import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  citationCoverage,
  collectCitations,
  describeIssues,
  findForbiddenLanguage,
  validateAiReport,
} from '../../src/lib/ai/validator.ts';
import type { AiReport } from '../../src/lib/ai/report-schema.ts';
import { CONTEXT, EVIDENCE_IDS, mutate, validReport } from './report-fixtures.ts';

describe('validateAiReport accepts a compliant report', () => {
  const result = validateAiReport(validReport(), CONTEXT);

  it('returns the typed report', () => {
    assert.equal(result.ok, true, JSON.stringify(result.ok ? [] : result.issues, null, 1));
    if (!result.ok) return;
    assert.equal(result.value.schemaVersion, 1);
    assert.equal(result.value.status, 'cautious');
    assert.equal(result.value.humanDecisionRequired, true);
    assert.equal(result.value.disclaimerAcknowledgementRequired, true);
    assert.equal(result.value.objective.symbol, 'NVDA');
    assert.equal(result.value.confidence.label, 'medium');
    assert.equal(result.value.scenarios.bear.name, 'bear');
    assert.equal(result.value.catalysts.timeline.length, 2);
    assert.equal(result.value.risks.length, 2);
  });

  it('normalises an ISO date on catalysts', () => {
    if (result.ok) assert.equal(result.value.catalysts.timeline[0].date, '2026-11-04T21:00:00.000Z');
  });
});

describe('validateAiReport rejects malformed output', () => {
  const rejects = (name: string, payload: unknown, expectedMessage: RegExp) => {
    it(name, () => {
      const result = validateAiReport(payload, CONTEXT);
      assert.equal(result.ok, false);
      if (result.ok) return;
      const text = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
      assert.match(text, expectedMessage);
    });
  };

  rejects('a non-object payload', null, /report: expected an object/);
  rejects('an array payload', [], /report: expected an object/);
  rejects('a string payload', 'not json', /report: expected an object/);
  rejects('the wrong schema version', mutate(validReport(), (r) => { r.schemaVersion = 2; }), /schemaVersion/);
  rejects('a missing human decision flag', mutate(validReport(), (r) => { delete r.humanDecisionRequired; }), /humanDecisionRequired/);
  rejects('a false acknowledgement flag', mutate(validReport(), (r) => { r.disclaimerAcknowledgementRequired = false; }), /must be true/);

  rejects('an unexpected top-level field (smuggled reasoning)', mutate(validReport(), (r) => {
    r.hiddenReasoning = 'first I thought about the supply chain, then I decided';
  }), /unexpected field/);

  rejects('an unexpected nested field', mutate(validReport(), (r) => {
    const section = r.marketSnapshot as Record<string, unknown>;
    section.thoughtProcess = 'step by step';
  }), /report\.marketSnapshot\.thoughtProcess: unexpected field/);

  rejects('a citation to an id that was never minted', mutate(validReport(), (r) => {
    const section = r.marketSnapshot as Record<string, unknown>;
    section.citations = ['EV-999'];
  }), /does not exist in the retrieved evidence set/);

  rejects('a citation in the wrong format', mutate(validReport(), (r) => {
    const section = r.priceAction as Record<string, unknown>;
    section.citations = ['https://example.com/article'];
  }), /not a valid evidence id/);

  rejects('an uncited factual section', mutate(validReport(), (r) => {
    const section = r.technicalPosture as Record<string, unknown>;
    section.citations = [];
    section.dataGaps = [];
  }), /requires at least 1 valid citation/);

  rejects('too few distinct citations across the report', mutate(validReport(), (r) => {
    // Collapse every citation in the document onto one evidence item.
    const collapse = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(collapse);
        return;
      }
      if (node && typeof node === 'object') {
        const record = node as Record<string, unknown>;
        for (const [key, value] of Object.entries(record)) {
          if (key === 'citations' && Array.isArray(value)) record[key] = ['EV-001'];
          else collapse(value);
        }
      }
    };
    collapse(r);
  }), /at least 3 are required/);

  rejects('guaranteed outcome language', mutate(validReport(), (r) => {
    r.executiveSummary = 'The stock is guaranteed to rise after earnings and the trade is risk-free for a medium risk trader.';
  }), /forbidden language: guarantee/);

  rejects('a prediction phrased as certainty in a scenario', mutate(validReport(), (r) => {
    const scenarios = r.scenarios as Record<string, Record<string, unknown>>;
    scenarios.bull.narrative = 'Price will rise at least twenty percent within three weeks of the release, a sure thing for swing traders.';
  }), /forbidden language/);

  rejects('a direct trading instruction', mutate(validReport(), (r) => {
    r.monitoring = ['Buy now before the announcement and go all-in', 'Watch volume'];
  }), /forbidden language: direct_instruction/);

  rejects('an altered objective symbol', mutate(validReport(), (r) => {
    (r.objective as Record<string, unknown>).symbol = 'AMD';
  }), /must equal the requested symbol/);

  rejects('an altered horizon', mutate(validReport(), (r) => {
    (r.objective as Record<string, unknown>).horizon = '6_to_18_months';
  }), /must equal the requested horizon/);

  rejects('an altered risk tolerance', mutate(validReport(), (r) => {
    (r.objective as Record<string, unknown>).riskTolerance = 'high';
  }), /must equal the requested risk tolerance/);

  rejects('an invented entry price', mutate(validReport(), (r) => {
    (r.objective as Record<string, unknown>).entryPrice = 999;
  }), /entryPrice/);

  rejects('a rewritten user question', mutate(validReport(), (r) => {
    (r.objective as Record<string, unknown>).question = 'Is NVDA a perfect long term compounder with no downside?';
  }), /altered the user question/);

  rejects('an executive summary that is too short', mutate(validReport(), (r) => {
    r.executiveSummary = 'Looks fine.';
  }), /at least 40 characters/);

  rejects('a missing scenario', mutate(validReport(), (r) => {
    delete (r.scenarios as Record<string, unknown>).bear;
  }), /report\.scenarios\.bear: expected an object/);

  rejects('a scenario name that does not match its key', mutate(validReport(), (r) => {
    const scenarios = r.scenarios as Record<string, Record<string, unknown>>;
    scenarios.base.name = 'bull';
  }), /must equal "base"/);

  rejects('a scenario with no assumptions', mutate(validReport(), (r) => {
    const scenarios = r.scenarios as Record<string, Record<string, unknown>>;
    scenarios.bear.assumptions = [];
  }), /at least 1 item/);

  rejects('an invalid effect direction', mutate(validReport(), (r) => {
    const scenarios = r.scenarios as Record<string, Record<string, unknown>>;
    const effects = scenarios.bull.estimatedEffects as Array<Record<string, unknown>>;
    effects[0].direction = 'sideways';
  }), /must be one of positive, negative, neutral/);

  rejects('a confidence label that contradicts the score', mutate(validReport(), (r) => {
    (r.confidence as Record<string, unknown>).label = 'high';
  }), /does not match score/);

  rejects('a confidence score outside 0..1', mutate(validReport(), (r) => {
    (r.confidence as Record<string, unknown>).score = 95;
  }), /must be within \[0, 1\]/);

  rejects('an evidence count above what was retrieved', mutate(validReport(), (r) => {
    (r.confidence as Record<string, unknown>).evidenceCount = 42;
  }), /only 6 were retrieved/);

  rejects('a single risk', mutate(validReport(), (r) => {
    r.risks = [(r.risks as unknown[])[0]];
  }), /at least 2 risks/);

  rejects('no invalidation conditions', mutate(validReport(), (r) => {
    r.invalidation = [];
  }), /at least one invalidation condition/);

  rejects('an invalidation condition without a citation', mutate(validReport(), (r) => {
    const items = r.invalidation as Array<Record<string, unknown>>;
    items[0].citations = [];
  }), /report\.invalidation\[0\]\.citations: requires at least 1 valid citation/);

  rejects('one monitoring item', mutate(validReport(), (r) => {
    r.monitoring = ['Watch the close'];
  }), /report\.monitoring: must contain at least 2/);

  rejects('no limitations', mutate(validReport(), (r) => {
    r.limitations = [];
  }), /report\.limitations: must contain at least 1/);

  rejects('an unknown status', mutate(validReport(), (r) => {
    r.status = 'strong_buy';
  }), /must be one of bullish, neutral, cautious, bearish/);

  rejects('an unknown catalyst kind', mutate(validReport(), (r) => {
    const catalysts = r.catalysts as Record<string, unknown>;
    const timeline = catalysts.timeline as Array<Record<string, unknown>>;
    timeline[0].kind = 'rumour';
  }), /must be one of earnings, news, macro, company, technical/);

  rejects('a malformed catalyst date', mutate(validReport(), (r) => {
    const catalysts = r.catalysts as Record<string, unknown>;
    const timeline = catalysts.timeline as Array<Record<string, unknown>>;
    timeline[0].date = 'soon';
  }), /must be an ISO-8601 date or null/);

  rejects('a narrative that is not a string', mutate(validReport(), (r) => {
    (r.newsAndMacro as Record<string, unknown>).narrative = 42;
  }), /expected a string/);
});

describe('citation accounting', () => {
  const report = validateAiReport(validReport(), CONTEXT);
  assert.equal(report.ok, true);
  const value = report.ok ? (report.value as AiReport) : (null as unknown as AiReport);

  it('collects distinct citations from every section', () => {
    const cited = collectCitations(value);
    assert.ok(cited.length >= 3);
    assert.ok(cited.every((id) => EVIDENCE_IDS.includes(id)));
  });

  it('measures coverage against the retrieved evidence set', () => {
    const coverage = citationCoverage(value, CONTEXT.evidenceIds);
    assert.equal(coverage.available, EVIDENCE_IDS.length);
    assert.ok(coverage.coverage > 0 && coverage.coverage <= 1);
    assert.deepEqual(coverage.uncitedIds, EVIDENCE_IDS.filter((id) => !collectCitations(value).includes(id)));
  });

  it('reports zero coverage when no evidence exists', () => {
    assert.equal(citationCoverage(value, new Set()).coverage, 0);
  });

  it('summarises issues for the repair prompt', () => {
    const bad = validateAiReport(mutate(validReport(), (r) => { r.status = 'nope'; }), CONTEXT);
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    const text = describeIssues(bad.issues);
    assert.match(text, /^- report\.status:/m);
  });
});

describe('forbidden language detection', () => {
  it('flags guarantee and certainty phrasing', () => {
    assert.deepEqual(findForbiddenLanguage('This is a guaranteed winner'), ['guarantee']);
    assert.ok(findForbiddenLanguage('a risk free trade').includes('risk_free'));
    assert.ok(findForbiddenLanguage('the stock will double').includes('prediction'));
    assert.ok(findForbiddenLanguage('buy now before it runs').includes('direct_instruction'));
    assert.ok(findForbiddenLanguage('it is certainly going to beat estimates').includes('prediction'));
    assert.ok(findForbiddenLanguage('certainly to outperform the sector').includes('certainty'));
  });

  it('leaves properly hedged research language alone', () => {
    assert.deepEqual(
      findForbiddenLanguage(
        'The evidence is consistent with a range of outcomes; a guidance cut could pressure the multiple, while an in line print may leave price range bound.',
      ),
      [],
    );
  });
});