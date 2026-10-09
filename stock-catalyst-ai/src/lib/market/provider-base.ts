/**
 * Shared plumbing for provider adapters: dependency injection, rate limiting,
 * timeouts, and error shaping.
 *
 * Adapters never throw for expected failures. They return a `ProviderError` with a
 * closed-set code so the registry can decide whether to fall through to the next
 * provider or surface an explicit unavailable state.
 */

import type { ProviderError, ProviderErrorCode } from './types.ts';
import { classifyHttpFailure, httpRequest } from './http.ts';
import type { FetchLike, HttpResponse } from './http.ts';
import type { SlidingWindowRateLimiter } from '../utils/rate-limiter.ts';
import { Logger } from '../utils/logger.ts';
import { makeProvenance } from './provenance.ts';
import type { DataProvenance, DataStatus } from './types.ts';

export interface ProviderDeps {
  fetchImpl: FetchLike | null;
  timeoutMs: number;
  maxBytes: number;
  limiter: SlidingWindowRateLimiter | null;
  logger: Logger;
  staleAfterSeconds: number;
  now: () => number;
}

export function createProviderDeps(partial: Partial<ProviderDeps> = {}): ProviderDeps {
  return {
    fetchImpl: partial.fetchImpl ?? null,
    timeoutMs: partial.timeoutMs ?? 10_000,
    maxBytes: partial.maxBytes ?? 2_000_000,
    limiter: partial.limiter ?? null,
    logger: partial.logger ?? new Logger({ scope: 'market' }),
    staleAfterSeconds: partial.staleAfterSeconds ?? 900,
    now: partial.now ?? (() => Date.now()),
  };
}

export function providerError(
  code: ProviderErrorCode,
  message: string,
  source: string,
  retryAfterSeconds: number | null = null,
): ProviderError {
  return { code, message, source, retryAfterSeconds };
}

export type ProviderFailure = { ok: false } & ProviderError;

export function failure(error: ProviderError): ProviderFailure {
  return { ok: false, ...error };
}

export function success<T>(data: T, provenance: DataProvenance): { ok: true; data: T; provenance: DataProvenance } {
  return { ok: true, data, provenance };
}

export function buildProvenance(params: {
  source: string;
  status: DataStatus;
  asOf?: string | null;
  delaySeconds?: number | null;
  note?: string | null;
  deps: ProviderDeps;
}): DataProvenance {
  return makeProvenance({
    source: params.source,
    status: params.status,
    asOf: params.asOf ?? null,
    retrievedAt: new Date(params.deps.now()).toISOString(),
    delaySeconds: params.delaySeconds ?? null,
    note: params.note ?? null,
    staleAfterSeconds: params.deps.staleAfterSeconds,
    nowTime: params.deps.now(),
  });
}

/** Checks the outbound limiter before spending a request. */
export function acquireSlot(deps: ProviderDeps, key: string, source: string): ProviderError | null {
  if (deps.limiter === null) return null;
  const decision = deps.limiter.consume(key);
  if (decision.allowed) return null;
  return providerError(
    'rate_limited',
    `outbound rate limit reached for ${source}; retry in ${decision.retryAfterSeconds ?? deps.limiter.windowSeconds}s`,
    source,
    decision.retryAfterSeconds,
  );
}

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
}

export async function fetchText(url: string, deps: ProviderDeps, options: FetchJsonOptions = {}): Promise<HttpResponse> {
  return httpRequest(
    url,
    {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      timeoutMs: deps.timeoutMs,
      maxBytes: deps.maxBytes,
    },
    deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike),
  );
}

/** Converts a transport-level failure into a provider error, or null when usable. */
export function errorFromResponse(response: HttpResponse, source: string): ProviderError | null {
  const code = classifyHttpFailure(response);
  if (code === null) return null;
  const message =
    code === 'rate_limited'
      ? `${source} rate limit reached (HTTP 429)`
      : code === 'timeout'
        ? `${source} request timed out after ${response.elapsedMs}ms`
        : code === 'unauthenticated'
          ? `${source} rejected the API key (HTTP ${response.status})`
          : `${source} returned HTTP ${response.status}`;
  return providerError(code, message, source, response.retryAfterSeconds);
}
