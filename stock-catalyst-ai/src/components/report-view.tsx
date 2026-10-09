'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { SavedReport } from '@/lib/reports/store.ts';

export function ReportView({ initialReport }: { initialReport: SavedReport }) {
  const [saved, setSaved] = useState(initialReport);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function acknowledge() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/reports/${encodeURIComponent(saved.id)}/acknowledge`, { method: 'POST' });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const message = typeof payload === 'object' && payload !== null && 'message' in payload && typeof payload.message === 'string' ? payload.message : 'Could not save acknowledgement.';
        throw new Error(message);
      }
      if (typeof payload !== 'object' || payload === null || !('acknowledgedAt' in payload) || typeof payload.acknowledgedAt !== 'string') throw new Error('The acknowledgement response was invalid.');
      const acknowledgedAt = payload.acknowledgedAt;
      setSaved((current) => ({ ...current, acknowledgedAt }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save acknowledgement.');
    } finally {
      setBusy(false);
    }
  }

  const report = saved.report;
  const sections = [
    ['Market snapshot', report.marketSnapshot], ['Price action', report.priceAction], ['Technical posture', report.technicalPosture],
    ['Fundamental quality', report.fundamentalQuality], ['Valuation context', report.valuationContext], ['News and macro', report.newsAndMacro],
  ] as const;
  return <article className="report-view">
    <div className="report-toolbar"><div><span className="status">{saved.generationMode === 'demo-template' ? 'DEMO TEMPLATE · NOT AI OUTPUT' : 'QWEN AI'}</span><span className="status">{saved.acknowledgedAt ? 'ACKNOWLEDGED' : 'UNREVIEWED'}</span></div><div className="export-links"><a href={`/api/reports/${encodeURIComponent(saved.id)}?format=markdown`}>Download Markdown</a><a href={`/api/reports/${encodeURIComponent(saved.id)}?format=json`}>Download JSON</a></div></div>
    <p className="muted">Created {new Date(saved.createdAt).toLocaleString()} · {saved.request.horizon.replaceAll('_', ' ')} · {saved.request.riskTolerance} risk</p>
    <div className="human-notice"><strong>Human decision required</strong><p>This report is research context, not a recommendation. You are responsible for all decisions.</p><p>{report.limitations[0]}</p></div>
    <section className="panel"><p className="eyebrow">EXECUTIVE SUMMARY</p><p>{report.executiveSummary}</p><strong className="status">{report.status.toUpperCase()} · CONFIDENCE {report.confidence.label.toUpperCase()} ({report.confidence.score.toFixed(2)})</strong><p>{report.confidence.explanation}</p></section>
    <div className="columns report-columns">{sections.map(([title, value]) => <section className="panel" key={title}><h3>{title}</h3><p>{value.narrative}</p>{value.citations.length > 0 && <p className="citation-line">Evidence: <Citations ids={value.citations}/></p>}{value.dataGaps.map((gap) => <p className="warning" key={gap}>Data gap: {gap}</p>)}</section>)}</div>
    <div className="columns report-columns"><section className="panel"><h3>Catalysts</h3><p>{report.catalysts.narrative}</p>{report.catalysts.timeline.map((event) => <div className="indicator-row" key={`${event.title}-${event.date}`}><span>{event.date?.slice(0, 10) ?? 'Date unavailable'} · {event.kind}</span><strong>{event.title}<small><Citations ids={event.citations}/></small></strong></div>)}</section><section className="panel"><h3>Risks</h3>{report.risks.map((risk) => <div className="list-row" key={risk.risk}><span>{risk.severity} · {risk.likelihood}</span><strong>{risk.risk}<small><Citations ids={risk.citations}/></small></strong><p>{risk.mitigation}</p></div>)}</section></div>
    <section className="panel scenario-grid"><h3>Bull / base / bear scenarios</h3>{(['bull', 'base', 'bear'] as const).map((name) => <article key={name}><h4>{name.toUpperCase()} · {report.scenarios[name].probabilityLabel} confidence</h4><strong>{report.scenarios[name].headline}</strong><p>{report.scenarios[name].narrative}</p><small>Assumptions: {report.scenarios[name].assumptions.join(' · ')}</small><p><Citations ids={report.scenarios[name].citations}/></p></article>)}</section>
    <div className="columns report-columns"><section className="panel"><h3>Invalidation conditions</h3>{report.invalidation.map((condition) => <div className="indicator-row" key={condition.condition}><span>{condition.observable}</span><strong>{condition.condition}</strong></div>)}<h3>Monitor</h3><ul>{report.monitoring.map((item) => <li key={item}>{item}</li>)}</ul></section><section className="panel"><h3>Evidence and provenance</h3><div className="evidence-list">{saved.evidence.map((item) => <article key={item.id}><strong id={item.id}>{item.id} · {item.label}</strong><p>{item.value ?? 'Unavailable'} <span className="status">{item.status.toUpperCase()}</span></p><small>{item.source} · as of {item.asOf ?? 'unknown'} · retrieved {new Date(item.retrievedAt).toLocaleString()}</small>{item.url && <p><a href={item.url} rel="noreferrer" target="_blank">Open source</a></p>}</article>)}</div></section></div>
    <div className="human-ack"><label><input type="checkbox" checked={saved.acknowledgedAt !== null} disabled={saved.acknowledgedAt !== null || busy} onChange={() => void acknowledge()}/> I reviewed this research and will make my own decision.</label>{saved.acknowledgedAt ? <p>Completed with acknowledgement at {new Date(saved.acknowledgedAt).toLocaleString()}.</p> : <p>The report remains unreviewed until you check this box.</p>}{error && <p className="error" role="alert">{error}</p>}</div>
    <p className="disclaimer">Nothing in this report is investment, legal, or tax advice. No trade can be made from this application. Verify all figures with primary sources.</p>
    <Link href="/reports">View report history</Link>
  </article>;
}

function Citations({ ids }: { ids: string[] }) { return <span className="citation-links">{ids.map((id) => <a href={`#${encodeURIComponent(id)}`} key={id}>{id}</a>)}</span>; }
