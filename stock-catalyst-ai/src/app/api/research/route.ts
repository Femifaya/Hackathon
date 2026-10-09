import { NextResponse } from 'next/server';
import { validateResearchInput, runResearch } from '@/lib/reports/pipeline.ts';
import { getReportStore } from '@/lib/reports/store.ts';
import { getConfig } from '@/lib/config/env.ts';
import { SlidingWindowRateLimiter } from '@/lib/utils/rate-limiter.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
let aiLimiter: SlidingWindowRateLimiter | null = null;

function getAiLimiter(): SlidingWindowRateLimiter {
  aiLimiter ??= new SlidingWindowRateLimiter(getConfig().rateLimit.aiMaxRequests, getConfig().rateLimit.aiWindowSeconds * 1000);
  return aiLimiter;
}

export async function POST(request: Request) {
  const rate = getAiLimiter().consume('local-research');
  if (!rate.allowed) return NextResponse.json({ code: 'ai_rate_limited', message: 'The local research request limit was reached. Try again after the current window.' }, { status: 429, headers: { 'retry-after': String(rate.retryAfterSeconds) } });
  let body: unknown;
  try {
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > 32_000) return NextResponse.json({ code: 'request_too_large', message: 'Research request is too large.' }, { status: 413 });
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 32_000) return NextResponse.json({ code: 'request_too_large', message: 'Research request is too large.' }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ code: 'invalid_json', message: 'Request body must be valid JSON.' }, { status: 400 });
  }
  const validated = validateResearchInput(body);
  if (!validated.ok) return NextResponse.json({ code: 'invalid_input', message: validated.message }, { status: 400 });
  try {
    const result = await runResearch(validated.value);
    if (!result.ok) return NextResponse.json({ code: result.code, message: result.message }, { status: result.code === 'no_evidence' ? 422 : 503 });
    getReportStore().save(result.saved);
    return NextResponse.json(result.saved, { status: 201 });
  } catch {
    return NextResponse.json({ code: 'research_failed', message: 'Research could not be completed. No report was saved.' }, { status: 500 });
  }
}
