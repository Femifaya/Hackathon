/**
 * Hardened HTTP client for provider calls.
 *
 * - Host allowlist (SSRF guard): the only user-controlled URL fragment is the
 *   symbol, and it is regex-validated before it reaches here.
 * - Hard timeout via AbortController.
 * - Response size cap enforced while streaming, not after buffering.
 * - Never throws: failures are returned as a typed `failure` so adapters can map
 *   them to provider error codes.
 */

export type HttpFailure = 'timeout' | 'network' | 'too_large' | 'blocked_host' | 'invalid_url';

export const ALLOWED_PROVIDER_HOSTS: readonly string[] = [
  'stooq.com',
  'www.alphavantage.co',
  'finnhub.io',
  'api.twelvedata.com',
];

export const ALLOWED_AI_HOSTS: readonly string[] = [
  'dashscope-intl.aliyuncs.com',
  'dashscope.aliyuncs.com',
];

export interface HttpResponse {
  status: number;
  ok: boolean;
  url: string;
  headers: Record<string, string>;
  text: string | null;
  json: unknown;
  failure: HttpFailure | null;
  retryAfterSeconds: number | null;
  elapsedMs: number;
  truncated: boolean;
}

export interface HttpRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  allowedHosts?: readonly string[];
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function isAllowedHost(url: string, allowedHosts: readonly string[] = ALLOWED_PROVIDER_HOSTS): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

export function parseRetryAfter(headerValue: string | null | undefined): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(3600, Math.ceil(seconds));
  const date = Date.parse(headerValue);
  if (Number.isFinite(date)) {
    const delta = Math.ceil((date - Date.now()) / 1000);
    return Math.max(0, Math.min(3600, delta));
  }
  return null;
}

export function safeJsonParse(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function emptyResponse(url: string, failure: HttpFailure, elapsedMs: number): HttpResponse {
  return {
    status: 0,
    ok: false,
    url,
    headers: {},
    text: null,
    json: null,
    failure,
    retryAfterSeconds: null,
    elapsedMs,
    truncated: false,
  };
}

async function readWithLimit(response: Response, maxBytes: number): Promise<{ text: string | null; truncated: boolean }> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    return { text: null, truncated: true };
  }
  if (!response.body) {
    const text = await response.text();
    return { text: text.length > maxBytes ? null : text, truncated: text.length > maxBytes };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { text: null, truncated: true };
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  }
  chunks.push(decoder.decode());
  return { text: chunks.join(''), truncated: false };
}

export async function httpRequest(
  url: string,
  options: HttpRequestOptions,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<HttpResponse> {
  const started = Date.now();
  const allowedHosts = options.allowedHosts ?? ALLOWED_PROVIDER_HOSTS;

  if (!isAllowedHost(url, allowedHosts)) {
    return emptyResponse(url, isSafeUrl(url) ? 'blocked_host' : 'invalid_url', Date.now() - started);
  }
  if (typeof fetchImpl !== 'function') {
    return emptyResponse(url, 'network', Date.now() - started);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), Math.max(1, options.timeoutMs));
  const onOuterAbort = () => controller.abort(new Error('aborted'));
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const response = await fetchImpl(url, {
      method: options.method ?? 'GET',
      headers: { accept: 'application/json, text/csv;q=0.9, */*;q=0.5', ...options.headers },
      body: options.body,
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store',
    });

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const { text, truncated } = await readWithLimit(response, options.maxBytes);
    const retryAfterSeconds = parseRetryAfter(headers['retry-after'] ?? null);

    return {
      status: response.status,
      ok: response.ok && !truncated,
      url,
      headers,
      text: truncated ? null : text,
      json: truncated ? null : safeJsonParse(text),
      failure: truncated ? 'too_large' : null,
      retryAfterSeconds,
      elapsedMs: Date.now() - started,
      truncated,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure: HttpFailure = /abort|timeout/i.test(message) ? 'timeout' : 'network';
    return emptyResponse(url, failure, Date.now() - started);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}

function isSafeUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/** Maps an HTTP failure/response to a provider error code. */
export function classifyHttpFailure(response: HttpResponse): 'timeout' | 'rate_limited' | 'upstream_error' | 'not_found' | 'unauthenticated' | 'bad_payload' | null {
  if (response.failure === 'timeout') return 'timeout';
  if (response.failure === 'too_large' || response.failure === 'network') return 'upstream_error';
  if (response.status === 429) return 'rate_limited';
  if (response.status === 401 || response.status === 403) return 'unauthenticated';
  if (response.status === 404) return 'not_found';
  if (response.status >= 400) return 'upstream_error';
  return null;
}