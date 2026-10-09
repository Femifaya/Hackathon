import Link from 'next/link';
import { getReportStore } from '@/lib/reports/store.ts';
import type { SavedReport } from '@/lib/reports/store.ts';

export const dynamic = 'force-dynamic';

export default function ReportsPage() {
  let reports: SavedReport[] = [];
  let unavailable = false;
  try { reports = getReportStore().list(); } catch { unavailable = true; }
  return <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">C</span><span>CATALYST <small>RESEARCH DESK</small></span></Link><nav><Link href="/">Workspace</Link><Link className="active" href="/reports">Reports</Link><Link href="/settings">Settings</Link></nav><span className="research-only">RESEARCH ONLY</span></header><section className="content"><p className="eyebrow">LIBRARY / LOCAL SQLITE</p><h1>Research reports</h1><p className="muted">Reports are stored on this device. Unreviewed reports remain clearly marked until acknowledged.</p>{unavailable ? <div className="error" role="alert">The local report store could not be opened. Check DATABASE_PATH and file permissions.</div> : reports.length === 0 ? <div className="welcome"><h2>No saved reports yet</h2><p>Run the NVDA demonstration workflow from the workspace to create a report.</p><Link href="/">Start demo research</Link></div> : <div className="report-history">{reports.map((saved) => <Link className="panel report-history-card" href={`/reports/${encodeURIComponent(saved.id)}`} key={saved.id}><div className="panel-title"><h2>{saved.request.symbol} · {saved.report.status.toUpperCase()}</h2><span className="status">{saved.acknowledgedAt ? 'ACKNOWLEDGED' : 'UNREVIEWED'}</span></div><p>{saved.request.question}</p><small>{new Date(saved.createdAt).toLocaleString()} · {saved.generationMode === 'demo-template' ? 'DEMO TEMPLATE · NOT AI OUTPUT' : 'QWEN AI'} · {saved.evidence.length} evidence items</small></Link>)}</div>}</section></main>;
}
