import { NextResponse } from 'next/server';
import { getReportStore } from '@/lib/reports/store.ts';
import { exportReportJson, exportReportMarkdown } from '@/lib/reports/exports.ts';
import { isPrefixedId } from '@/lib/utils/id.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isPrefixedId(id, 'rpt')) return NextResponse.json({ code: 'invalid_id', message: 'Invalid report id.' }, { status: 400 });
  try {
    const report = getReportStore().get(id);
    if (!report) return NextResponse.json({ code: 'not_found', message: 'Report was not found.' }, { status: 404 });
    const format = new URL(request.url).searchParams.get('format');
    if (format === 'markdown') return new Response(exportReportMarkdown(report), { headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${report.request.symbol}-${report.id}.md"` } });
    if (format === 'json') return new Response(exportReportJson(report), { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${report.request.symbol}-${report.id}.json"` } });
    return NextResponse.json(report);
  } catch {
    return NextResponse.json({ code: 'reports_unavailable', message: 'Saved report is unavailable.' }, { status: 503 });
  }
}
