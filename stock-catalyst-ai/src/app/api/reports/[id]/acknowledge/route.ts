import { NextResponse } from 'next/server';
import { getReportStore } from '@/lib/reports/store.ts';
import { isPrefixedId } from '@/lib/utils/id.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isPrefixedId(id, 'rpt')) return NextResponse.json({ code: 'invalid_id', message: 'Invalid report id.' }, { status: 400 });
  try {
    const report = getReportStore().acknowledge(id);
    if (!report) return NextResponse.json({ code: 'not_found', message: 'Report was not found.' }, { status: 404 });
    return NextResponse.json({ acknowledgedAt: report.acknowledgedAt });
  } catch {
    return NextResponse.json({ code: 'reports_unavailable', message: 'Acknowledgement could not be saved.' }, { status: 503 });
  }
}
