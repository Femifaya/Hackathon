/**
 * Qwen adapter (server-side only).
 *
 * - Reads the API key from validated config; the key is never logged, never
 *   returned to a caller, and never included in an error message.
 * - Uses the OpenAI-compatible chat-completions endpoint with JSON output.
 * - Bounded timeout, bounded retries with exponential backoff, and a closed set of
 *   error codes so the pipeline can render an explicit failure state.
 * - Response text is parsed defensively; a truncated or fenced payload is handled,
 *   and anything unparseable becomes `invalid_payload` rather than a crash.
 */

import { httpRequest, isAllowedHost, ALLOWED_AI_HOSTS } from '../market/http.ts';
import type { FetchLike } from '../market/http.ts';
import { Logger } from '../utils/logger.ts';
import { isRecord } from '../market/validators.ts';

export type QwenErrorCode =
  | 'not_configured'
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'unauthorized'
  | 'upstream_error'
  | 'empty_response'
  | 'invalid_payload'
  | 'blocked_host';

export interface QwenMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface QwenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface QwenClientOptions {
  apiKey: string | null;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  maxTokens: number;
  temperature: number;
  fetchImpl?: FetchLike | null;
  logger?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxResponseBytes?: number;
}

export interface QwenSuccess {
  ok: true;
  content: string;
  finishReason: string | null;
  usage: QwenUsage | null;
  latencyMs: number;
  attempts: number;
  model: string;
}

export interface QwenFailure {
  ok: false;
  code: QwenErrorCode;
  message: string;
  latencyMs: number;
  attempts: number;
  retryAfterSeconds: number | null;
}

export type QwenResult = QwenSuccess | QwenFailure;

const RETRYABLE: QwenErrorCode[] = ['timeout', 'rate_limited', 'upstream_error', 'network'];

export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = 500 * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(base, 8000);
  return Math.round(capped + random() * 250);
}

/** Tolerant JSON extraction: handles code fences and surrounding prose. */
export function extractJsonObject(text: string): unknown {
  if (typeof text !== 'string') return null;
  const cleaned = text
    .trim()
    .replace(/^```(?:json|javascript)?/i, '')
    .replace(/```$/, '')
    .trim();

  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    // fall through
  }

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function mapFailure(code: QwenErrorCode, message: string, latencyMs: number, attempts: number, retryAfterSeconds: number | null): QwenFailure {
  return { ok: false, code, message, latencyMs, attempts, retryAfterSeconds };
}

export async function requestJsonCompletion(messages: QwenMessage[], options: QwenClientOptions): Promise<QwenResult> {
  const started = options.now ? options.now() : Date.now();
  const logger = options.logger ?? new Logger({ scope: 'ai' });
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;

  if (options.apiKey === null || options.apiKey.trim() === '') {
    return mapFailure('not_configured', 'QWEN_API_KEY is not configured, so AI research is unavailable. Data and indicators are still shown.', 0, 0, null);
  }

  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  if (!isAllowedHost(endpoint, ALLOWED_AI_HOSTS)) {
    logger.warn('refusing to call a host outside the AI allowlist', { host: safeHost(endpoint) });
    return mapFailure('blocked_host', 'the configured Qwen base URL host is not in the allowlist', 0, 0, null);
  }

  const body = JSON.stringify({
    model: options.model,
    messages,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    response_format: { type: 'json_object' },
    stream: false,
  });

  const maxAttempts = Math.max(1, options.maxRetries + 1);
  let attempt = 0;
  let lastFailure: QwenFailure | null = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    const response = await httpRequest(
      endpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body,
        timeoutMs: options.timeoutMs,
        maxBytes: options.maxResponseBytes ?? 4_000_000,
        allowedHosts: ALLOWED_AI_HOSTS,
      },
      options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike),
    );

    const latencyMs = (options.now ? options.now() : Date.now()) - started;

    if (response.failure === 'timeout') {
      lastFailure = mapFailure('timeout', `the model did not respond within ${options.timeoutMs}ms`, latencyMs, attempt, null);
    } else if (response.failure === 'blocked_host') {
      return mapFailure('blocked_host', 'the AI endpoint host is not allowed', latencyMs, attempt, null);
    } else if (response.failure !== null) {
      lastFailure = mapFailure('network', 'the model endpoint could not be reached', latencyMs, attempt, null);
    } else if (response.status === 429) {
      lastFailure = mapFailure('rate_limited', 'the model provider rate limited this request', latencyMs, attempt, response.retryAfterSeconds ?? 30);
    } else if (response.status === 401 || response.status === 403) {
      return mapFailure('unauthorized', 'the model provider rejected the API key', latencyMs, attempt, null);
    } else if (!response.ok) {
      lastFailure = mapFailure('upstream_error', `the model provider returned HTTP ${response.status}`, latencyMs, attempt, response.retryAfterSeconds);
    } else {
      const parsed = response.json ?? extractJsonObject(response.text ?? '');
      const content = readContent(parsed);
      if (content === null) {
        return mapFailure('invalid_payload', 'the model response did not contain a usable completion', latencyMs, attempt, null);
      }
      if (content.trim() === '') {
        return mapFailure('empty_response', 'the model returned an empty completion', latencyMs, attempt, null);
      }
      return {
        ok: true,
        content,
        finishReason: readFinishReason(parsed),
        usage: readUsage(parsed),
        latencyMs,
        attempts: attempt,
        model: options.model,
      };
    }

    const retryable = lastFailure !== null && RETRYABLE.includes(lastFailure.code);
    if (!retryable || attempt >= maxAttempts) break;

    const delay = Math.max(backoffDelayMs(attempt, random), (lastFailure?.retryAfterSeconds ?? 0) * 1000);
    logger.warn('retrying model request', { attempt, code: lastFailure?.code, delayMs: delay });
    await sleep(delay);
  }

  return lastFailure ?? mapFailure('upstream_error', 'the model request failed', (options.now ? options.now() : Date.now()) - started, attempt, null);
}

function readContent(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const choices = payload.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (isRecord(first)) {
      const message = first.message;
      if (isRecord(message) && typeof message.content === 'string') return message.content;
      if (typeof first.text === 'string') return first.text;
    }
  }
  if (typeof payload.output === 'string') return payload.output;
  if (isRecord(payload.output) && typeof payload.output.text === 'string') return payload.output.text;
  return null;
}

function readFinishReason(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) return null;
  const first = payload.choices[0];
  return isRecord(first) && typeof first.finish_reason === 'string' ? first.finish_reason : null;
}

function readUsage(payload: unknown): QwenUsage | null {
  if (!isRecord(payload) || !isRecord(payload.usage)) return null;
  const usage = payload.usage;
  const read = (keys: string[]): number | null => {
    for (const key of keys) {
      const value = usage[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
  };
  return {
    promptTokens: read(['prompt_tokens', 'input_tokens']),
    completionTokens: read(['completion_tokens', 'output_tokens']),
    totalTokens: read(['total_tokens']),
  };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}