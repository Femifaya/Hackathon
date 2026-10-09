import { NextResponse } from 'next/server';
import { getReportStore } from '@/lib/reports/store.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({ reports: getReportStore().list() });
  } catch {
    return NextResponse.json({ code: 'reports_unavailable', message: 'Saved reports are unavailable.' }, { status: 503 });
  }
}
