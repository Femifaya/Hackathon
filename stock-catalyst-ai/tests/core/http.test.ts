import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyHttpFailure,
  httpRequest,
  isAllowedHost,
  parseRetryAfter,
  safeJsonParse,
} from '../../src/lib/market/http.ts';
import type { FetchLike, HttpResponse } from '../../src/lib/market/http.ts';

const BASE = { timeoutMs: 500, maxBytes: 100_000 };

function jsonResponse(body: unknown, init: ResponseInit = {}): FetchLike {
  return async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

describe('host allowlist', () => {
  it('permits the configured providers and their subdomains', () => {
    assert.equal(isAllowedHost('https://stooq.com/q/d/l/?s=aapl.us'), true);
    assert.equal(isAllowedHost('https://api.twelvedata.com/quote'), true);
    assert.equal(isAllowedHost('https://www.alphavantage.co/query'), true);
    assert.equal(isAllowedHost('https://finnhub.io/api/v1/quote'), true);
  });

  it('blocks everything else, including lookalikes and non-http schemes', () => {
    assert.equal(isAllowedHost('https://evil.example.com/'), false);
    assert.equal(isAllowedHost('https://stooq.com.evil.example/'), false);
    assert.equal(isAllowedHost('file:///etc/passwd'), false);
    assert.equal(isAllowedHost('http://169.254.169.254/latest/meta-data/'), false);
    assert.equal(isAllowedHost('not a url'), false);
  });

  it('honours an explicit allowlist override', () => {
    assert.equal(isAllowedHost('https://dashscope-intl.aliyuncs.com/v1/chat', ['dashscope-intl.aliyuncs.com']), true);
    assert.equal(isAllowedHost('https://stooq.com/x', ['dashscope-intl.aliyuncs.com']), false);
  });
});

describe('parseRetryAfter', () => {
  it('reads both the seconds and HTTP-date forms', () => {
    assert.equal(parseRetryAfter('30'), 30);
    assert.equal(parseRetryAfter(null), null);
    const future = new Date(Date.now() + 60_000).toUTCString();
    const parsed = parseRetryAfter(future);
    assert.ok(parsed !== null && parsed >= 55 && parsed <= 61, `unexpected ${parsed}`);
  });

  it('caps the value so a hostile header cannot stall a caller', () => {
    assert.equal(parseRetryAfter('999999999'), 3600);
    assert.equal(parseRetryAfter('garbage'), null);
  });
});

describe('httpRequest', () => {
  it('parses JSON, lowercases headers, and reports timing', async () => {
    const response = await httpRequest('https://stooq.com/x', BASE, jsonResponse({ a: 1 }, { headers: { 'Content-Type': 'application/json', 'X-Custom': 'v' } }));
    assert.equal(response.ok, true);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { a: 1 });
    assert.equal(response.headers['x-custom'], 'v');
    assert.equal(response.failure, null);
    assert.ok(response.elapsedMs >= 0);
  });

  it('blocks a disallowed host without performing the request', async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return new Response('x');
    };
    const response = await httpRequest('https://evil.example.com/x', BASE, fetchImpl);
    assert.equal(called, false);
    assert.equal(response.failure, 'blocked_host');
    assert.equal(response.text, null);
  });

  it('refuses to buffer a response above the size cap', async () => {
    const response = await httpRequest(
      'https://stooq.com/x',
      { ...BASE, maxBytes: 10 },
      async () => new Response('x'.repeat(5000), { status: 200 }),
    );
    assert.equal(response.failure, 'too_large');
    assert.equal(response.text, null);
    assert.equal(response.truncated, true);
    assert.equal(response.ok, false);
  });

  it('enforces the cap while streaming when content-length is absent', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(1024).fill(65);
        for (let index = 0; index < 20; index += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = await httpRequest(
      'https://stooq.com/x',
      { ...BASE, maxBytes: 4096 },
      async () => new Response(stream, { status: 200 }),
    );
    assert.equal(response.failure, 'too_large');
    assert.equal(response.text, null);
  });

  it('reports a timeout instead of hanging', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal;
        signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    const response = await httpRequest('https://stooq.com/x', { ...BASE, timeoutMs: 20 }, fetchImpl);
    assert.equal(response.failure, 'timeout');
    assert.equal(response.status, 0);
  });

  it('maps a network rejection to a typed failure', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const response = await httpRequest('https://stooq.com/x', BASE, fetchImpl);
    assert.equal(response.failure, 'network');
  });

  it('returns 429 with a retry hint rather than throwing', async () => {
    const response = await httpRequest(
      'https://stooq.com/x',
      BASE,
      async () => new Response('slow down', { status: 429, headers: { 'retry-after': '45' } }),
    );
    assert.equal(response.status, 429);
    assert.equal(response.ok, false);
    assert.equal(response.retryAfterSeconds, 45);
    assert.equal(classifyHttpFailure(response), 'rate_limited');
  });

  it('yields null json for a non-JSON body without throwing', async () => {
    const response = await httpRequest('https://stooq.com/x', BASE, async () => new Response('Date,Close\n2024-01-02,10\n', { status: 200 }));
    assert.equal(response.json, null);
    assert.match(response.text ?? '', /Date,Close/);
  });
});

describe('classifyHttpFailure', () => {
  const base = { url: 'u', headers: {}, text: null, json: null, retryAfterSeconds: null, elapsedMs: 1, truncated: false, ok: false };
  it('maps status codes to closed-set provider error codes', () => {
    assert.equal(classifyHttpFailure({ ...base, status: 401 } as HttpResponse), 'unauthenticated');
    assert.equal(classifyHttpFailure({ ...base, status: 403 } as HttpResponse), 'unauthenticated');
    assert.equal(classifyHttpFailure({ ...base, status: 404 } as HttpResponse), 'not_found');
    assert.equal(classifyHttpFailure({ ...base, status: 500 } as HttpResponse), 'upstream_error');
    assert.equal(classifyHttpFailure({ ...base, status: 200, ok: true } as HttpResponse), null);
    assert.equal(classifyHttpFailure({ ...base, status: 0, failure: 'timeout' } as HttpResponse), 'timeout');
    assert.equal(classifyHttpFailure({ ...base, status: 0, failure: 'network' } as HttpResponse), 'upstream_error');
  });
});

describe('safeJsonParse', () => {
  it('never throws on malformed input', () => {
    assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 });
    assert.equal(safeJsonParse('{bad json'), null);
    assert.equal(safeJsonParse(null), null);
  });
});