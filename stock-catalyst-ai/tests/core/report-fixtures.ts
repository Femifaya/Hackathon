/** A structurally valid report plus helpers for mutating it in negative tests. */

import type { ValidatorContext } from '../../src/lib/ai/validator.ts';

export const EVIDENCE_IDS = ['EV-001', 'EV-002', 'EV-003', 'EV-004', 'EV-005', 'EV-006'];

export const CONTEXT: ValidatorContext = {
  evidenceIds: new Set(EVIDENCE_IDS),
  symbol: 'NVDA',
  horizon: '3_to_12_weeks',
  riskTolerance: 'medium',
  question: 'Should a medium-risk swing trader consider NVDA before its next earnings event?',
  entryPrice: 145.5,
  positionSize: 5000,
  minUniqueCitations: 3,
};

export function citedSection(narrative: string, citations: string[], dataGaps: string[] = []) {
  return { narrative, citations, dataGaps };
}

export function validReport(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    executiveSummary:
      'Evidence shows strong momentum into a scheduled earnings event, with valuation ratios above the sector median and one clear invalidation level below the last close.',
    objective: {
      question: CONTEXT.question,
      symbol: 'NVDA',
      horizon: '3_to_12_weeks',
      riskTolerance: 'medium',
      entryPrice: 145.5,
      positionSize: 5000,
    },
    marketSnapshot: citedSection(
      'The last reported price sits above both the 20 and 50 period simple moving averages, and session volume is above its 20 bar average.',
      ['EV-001', 'EV-002'],
    ),
    priceAction: citedSection(
      'Price advanced over the last three months with higher highs and higher lows, and the largest single day range remains inside the prior volatility band.',
      ['EV-003'],
    ),
    technicalPosture: citedSection(
      'RSI(14) is elevated but below the overbought threshold, MACD histogram is positive, and ATR(14) indicates a normal volatility regime for this name.',
      ['EV-003', 'EV-004'],
    ),
    fundamentalQuality: citedSection(
      'Reported revenue growth and margins support the current multiple, although the free cash flow figure was not available from any configured source.',
      ['EV-005'],
      ['free cash flow unavailable from configured providers'],
    ),
    valuationContext: citedSection(
      'Trailing and forward price to earnings ratios are both above the five year median implied by the retrieved data, which raises the cost of a guidance disappointment.',
      ['EV-005', 'EV-006'],
    ),
    catalysts: {
      narrative:
        'Two catalysts fall inside the requested horizon: a scheduled earnings release and a macro inflation print that historically moves the sector.',
      timeline: [
        {
          title: 'Quarterly earnings release',
          date: '2026-11-04T21:00:00.000Z',
          kind: 'earnings',
          importance: 'high',
          direction: 'mixed',
          whyItMatters: 'Guidance, rather than the reported quarter, has driven the largest post event moves in this name.',
          citations: ['EV-006'],
        },
        {
          title: 'US inflation print',
          date: '2026-10-21T12:30:00.000Z',
          kind: 'macro',
          importance: 'medium',
          direction: 'unknown',
          whyItMatters: 'A hotter print would raise discount rates and pressure high multiple growth names.',
          citations: ['EV-004'],
        },
      ],
    },
    newsAndMacro: citedSection(
      'Retrieved headlines are mixed and none references a material legal or accounting event; the macro calendar contains two high importance US releases.',
      ['EV-004'],
    ),
    scenarios: {
      bull: {
        name: 'bull',
        headline: 'Guidance raised and margins hold',
        narrative:
          'If management raises guidance and gross margin holds near the reported level, the multiple could be sustained and price could test the upper resistance cluster.',
        assumptions: ['Revenue growth continues at the reported rate', 'Gross margin holds within one point', 'No broad market de-rating'],
        estimatedEffects: [
          { metric: 'Price relative to resistance', direction: 'positive', magnitude: 'tests upper cluster', rationale: 'Sustained multiple on higher forward earnings' },
        ],
        probabilityLabel: 'medium',
        citations: ['EV-003', 'EV-006'],
      },
      base: {
        name: 'base',
        headline: 'In line quarter, choppy tape',
        narrative:
          'An in line print with unchanged guidance most likely produces a range bound reaction between the identified support and resistance clusters for several sessions.',
        assumptions: ['Results within consensus range', 'Guidance unchanged', 'Volatility regime unchanged'],
        estimatedEffects: [{ metric: 'Realised range', direction: 'neutral', magnitude: 'within ATR band', rationale: 'No new information to reprice the multiple' }],
        probabilityLabel: 'high',
        citations: ['EV-003'],
      },
      bear: {
        name: 'bear',
        headline: 'Guidance cut or margin slip',
        narrative:
          'A guidance reduction or a gross margin decline would remove the support for the current multiple and price could reach the nearest support cluster quickly.',
        assumptions: ['Guidance reduced', 'Margin compression', 'Sector de-rating'],
        estimatedEffects: [{ metric: 'Price relative to support', direction: 'negative', magnitude: 'tests lower cluster', rationale: 'Multiple contraction on lower forward earnings' }],
        probabilityLabel: 'low',
        citations: ['EV-003', 'EV-005'],
      },
    },
    risks: [
      {
        risk: 'Earnings guidance disappointment compresses the valuation multiple',
        severity: 'high',
        likelihood: 'medium',
        mitigation: 'Size the position so that a gap to the nearest support stays inside the stated risk budget.',
        citations: ['EV-005'],
      },
      {
        risk: 'A macro rate shock de-rates the whole high multiple growth cohort',
        severity: 'medium',
        likelihood: 'medium',
        mitigation: 'Monitor the scheduled inflation and policy releases and reduce exposure before the print if the trend weakens.',
        citations: ['EV-004'],
      },
    ],
    invalidation: [
      {
        condition: 'Daily close below the nearest support cluster',
        observable: 'Daily closing price',
        threshold: 'below the cited support level',
        citations: ['EV-003'],
      },
      {
        condition: 'Guidance reduced below consensus at the next release',
        observable: 'Reported guidance versus consensus',
        threshold: null,
        citations: ['EV-006'],
      },
    ],
    confidence: {
      score: 0.62,
      label: 'medium',
      explanation: 'Price and indicator data are complete, but analyst estimate coverage and free cash flow were unavailable from configured sources.',
      evidenceCount: 6,
    },
    monitoring: [
      'Daily close versus the cited support cluster',
      'Volume expansion on any post earnings gap',
      'Scheduled macro releases inside the horizon',
    ],
    status: 'cautious',
    statusRationale:
      'Technicals are constructive while valuation and an imminent binary event raise downside risk, so the evidence supports caution rather than a directional view.',
    limitations: [
      'Analyst estimate data was unavailable from the configured providers.',
      'All price data is delayed; no real time feed is used.',
    ],
    humanDecisionRequired: true,
    disclaimerAcknowledgementRequired: true,
  };
}

export function mutate(report: Record<string, unknown>, path: (r: Record<string, unknown>) => void): Record<string, unknown> {
  const clone = structuredClone(report);
  path(clone);
  return clone;
}