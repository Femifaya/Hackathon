import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getRegistry } from '@/lib/market/registry.ts';
import { normalizeSymbol } from '@/lib/market/symbols.ts';
import { computeIndicatorSnapshot } from '@/lib/indicators/index.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const symbol = normalizeSymbol(request.nextUrl.searchParams.get('symbol'));
  if (!symbol) return NextResponse.json({ code: 'INVALID_SYMBOL', message: 'Enter a valid US ticker symbol.' }, { status: 400 });
  try {
    const snapshot = await getRegistry().getSnapshot(symbol, { requestId: crypto.randomUUID() });
    const indicators = snapshot.candles.data ? computeIndicatorSnapshot(symbol, snapshot.candles.data) : null;
    return NextResponse.json({ ...snapshot, indicators });
  } catch {
    return NextResponse.json({ code: 'SNAPSHOT_FAILED', message: 'Market research data could not be loaded.' }, { status: 503 });
  }
}
