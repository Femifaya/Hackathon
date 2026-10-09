/**
 * The ONLY module that reads process.env for secrets.
 *
 * Rules:
 *  - Nothing here is prefixed with NEXT_PUBLIC_, so no value can be inlined into
 *    the client bundle.
 *  - Every variable is parsed, range-checked, and defaulted. A malformed value
 *    falls back to the safe default and is reported in `warnings` rather than
 *    crashing the app at import time.
 *  - API keys are exposed through accessor functions so they can be logged as
 *    "configured"/"missing" without ever printing the value.
 */

export type ProviderId = 'stooq' | 'finnhub' | 'alphavantage' | 'twelvedata' | 'demo';
export type RiskTolerance = 'low' | 'medium' | 'high';
export type Horizon = 'days_to_2_weeks' | '2_to_8_weeks' | '3_to_12_weeks' | '6_to_18_months';

export interface QwenConfig {
  apiKey: string | null;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  maxTokens: number;
  temperature: number;
  strictValidation: boolean;
  isConfigured: boolean;
}

export interface ProviderConfig {
  order: ProviderId[];
  keys: Record<'finnhub' | 'alphavantage' | 'twelvedata', string | null>;
  stooqEnabled: boolean;
  requestsPerMinute: number;
  httpTimeoutMs: number;
}

export interface CacheConfig {
  ttlQuoteSeconds: number;
  ttlCandlesSeconds: number;
  ttlFundamentalsSeconds: number;
  ttlNewsSeconds: number;
  staleAfterSeconds: number;
}

export interface RateLimitConfig {
  windowSeconds: number;
  maxRequests: number;
  aiWindowSeconds: number;
  aiMaxRequests: number;
}

export interface AppConfig {
  appEnv: string;
  logLevel: string;
  demoMode: boolean;
  database: { path: string; autoMigrate: boolean };
  qwen: QwenConfig;
  providers: ProviderConfig;
  cache: CacheConfig;
  upload: { maxBytes: number; maxRows: number };
  http: { maxBodyBytes: number };
  rateLimit: RateLimitConfig;
  ui: { defaultHorizon: Horizon; defaultRiskTolerance: RiskTolerance };
  warnings: string[];
}

const PROVIDER_IDS: ProviderId[] = ['stooq', 'finnhub', 'alphavantage', 'twelvedata', 'demo'];
const HORIZONS: Horizon[] = ['days_to_2_weeks', '2_to_8_weeks', '3_to_12_weeks', '6_to_18_months'];
const RISKS: RiskTolerance[] = ['low', 'medium', 'high'];
const DEFAULT_QWEN_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

export interface ParseContext {
  warnings: string[];
}

export type Environment = Readonly<Record<string, string | undefined>>;

function readString(env: Environment, key: string): string | null {
  const value = env[key];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function readInt(env: Environment, key: string, fallback: number, min: number, max: number, ctx: ParseContext): number {
  const raw = readString(env, key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    ctx.warnings.push(`${key}="${raw}" is not an integer in [${min}, ${max}]; using ${fallback}`);
    return fallback;
  }
  return parsed;
}

export function readFloat(env: Environment, key: string, fallback: number, min: number, max: number, ctx: ParseContext): number {
  const raw = readString(env, key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    ctx.warnings.push(`${key}="${raw}" is not a number in [${min}, ${max}]; using ${fallback}`);
    return fallback;
  }
  return parsed;
}

export function readBool(env: Environment, key: string, fallback: boolean, ctx: ParseContext): boolean {
  const raw = readString(env, key);
  if (raw === null) return fallback;
  const lowered = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  ctx.warnings.push(`${key}="${raw}" is not a boolean; using ${fallback}`);
  return fallback;
}

function readEnum<T extends string>(env: Environment, key: string, allowed: readonly T[], fallback: T, ctx: ParseContext): T {
  const raw = readString(env, key);
  if (raw === null) return fallback;
  const match = allowed.find((value) => value === raw.toLowerCase());
  if (!match) {
    ctx.warnings.push(`${key}="${raw}" is not one of ${allowed.join(', ')}; using ${fallback}`);
    return fallback;
  }
  return match;
}

function readProviderOrder(env: Environment, ctx: ParseContext): ProviderId[] {
  const raw = readString(env, 'MARKET_DATA_PROVIDER');
  if (raw === null || raw.toLowerCase() === 'auto') {
    // Keyless providers first, demo last: demo data must never shadow real data.
    return ['stooq', 'finnhub', 'alphavantage', 'twelvedata', 'demo'];
  }
  const requested = raw
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const known: ProviderId[] = [];
  for (const token of requested) {
    const match = PROVIDER_IDS.find((id) => id === token);
    if (match) known.push(match);
    else ctx.warnings.push(`MARKET_DATA_PROVIDER contains unknown provider "${token}"; ignored`);
  }
  if (known.length === 0) {
    ctx.warnings.push('MARKET_DATA_PROVIDER resolved to nothing; falling back to auto order');
    return ['stooq', 'finnhub', 'alphavantage', 'twelvedata', 'demo'];
  }
  return [...new Set(known)];
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function loadConfig(env: Environment = process.env): AppConfig {
  const ctx: ParseContext = { warnings: [] };

  const qwenBaseUrlRaw = readString(env, 'QWEN_BASE_URL') ?? DEFAULT_QWEN_BASE_URL;
  let qwenBaseUrl = DEFAULT_QWEN_BASE_URL;
  if (!isSafeHttpUrl(qwenBaseUrlRaw)) {
    ctx.warnings.push(`QWEN_BASE_URL="${qwenBaseUrlRaw}" is not a valid http(s) URL; using the default`);
  } else {
    qwenBaseUrl = qwenBaseUrlRaw.replace(/\/+$/, '');
  }

  const qwenApiKey = readString(env, 'QWEN_API_KEY');
  const appEnv = readString(env, 'APP_ENV') ?? 'development';
  const demoMode = readBool(env, 'DEMO_MODE', false, ctx);

  const config: AppConfig = {
    appEnv,
    logLevel: readString(env, 'LOG_LEVEL') ?? '0.5',
    demoMode,
    database: {
      path: readString(env, 'DATABASE_PATH') ?? './data/stock-catalyst.sqlite',
      autoMigrate: readBool(env, 'DATABASE_AUTO_MIGRATE', appEnv !== 'production', ctx),
    },
    qwen: {
      apiKey: qwenApiKey,
      baseUrl: qwenBaseUrl,
      model: readString(env, 'QWEN_MODEL') ?? 'qwen-plus',
      timeoutMs: readInt(env, 'QWEN_TIMEOUT_MS', 45_000, 1_000, 300_000, ctx),
      maxRetries: readInt(env, 'QWEN_MAX_RETRIES', 2, 0, 5, ctx),
      maxTokens: readInt(env, 'QWEN_MAX_TOKENS', 3_000, 256, 16_000, ctx),
      temperature: readFloat(env, 'QWEN_TEMPERATURE', 0.2, 0, 1, ctx),
      strictValidation: readBool(env, 'QWEN_STRICT_VALIDATION', true, ctx),
      isConfigured: qwenApiKey !== null,
    },
    providers: {
      order: demoMode ? ['demo'] : readProviderOrder(env, ctx),
      keys: {
        finnhub: readString(env, 'FINNHUB_API_KEY'),
        alphavantage: readString(env, 'ALPHAVANTAGE_API_KEY'),
        twelvedata: readString(env, 'TWELVEDATA_API_KEY'),
      },
      stooqEnabled: readBool(env, 'STOOQ_ENABLED', true, ctx),
      requestsPerMinute: readInt(env, 'PROVIDER_REQUESTS_PER_MINUTE', 20, 1, 600, ctx),
      httpTimeoutMs: readInt(env, 'PROVIDER_HTTP_TIMEOUT_MS', 10_000, 1_000, 120_000, ctx),
    },
    cache: {
      ttlQuoteSeconds: readInt(env, 'CACHE_TTL_QUOTE_SECONDS', 60, 0, 86_400, ctx),
      ttlCandlesSeconds: readInt(env, 'CACHE_TTL_CANDLES_SECONDS', 3_600, 0, 604_800, ctx),
      ttlFundamentalsSeconds: readInt(env, 'CACHE_TTL_FUNDAMENTALS_SECONDS', 21_600, 0, 604_800, ctx),
      ttlNewsSeconds: readInt(env, 'CACHE_TTL_NEWS_SECONDS', 900, 0, 86_400, ctx),
      staleAfterSeconds: readInt(env, 'STALE_AFTER_SECONDS', 900, 30, 86_400, ctx),
    },
    upload: {
      maxBytes: readInt(env, 'MAX_UPLOAD_BYTES', 2_097_152, 1_024, 20_971_520, ctx),
      maxRows: readInt(env, 'MAX_UPLOAD_ROWS', 20_000, 10, 200_000, ctx),
    },
    http: {
      maxBodyBytes: readInt(env, 'MAX_BODY_BYTES', 262_144, 1_024, 10_485_760, ctx),
    },
    rateLimit: {
      windowSeconds: readInt(env, 'RATE_LIMIT_WINDOW_SECONDS', 60, 1, 3_600, ctx),
      maxRequests: readInt(env, 'RATE_LIMIT_MAX_REQUESTS', 60, 1, 10_000, ctx),
      aiWindowSeconds: readInt(env, 'RATE_LIMIT_AI_WINDOW_SECONDS', 60, 1, 3_600, ctx),
      aiMaxRequests: readInt(env, 'RATE_LIMIT_AI_MAX_REQUESTS', 6, 1, 1_000, ctx),
    },
    ui: {
      defaultHorizon: readEnum(env, 'DEFAULT_HORIZON', HORIZONS, '3_to_12_weeks', ctx),
      defaultRiskTolerance: readEnum(env, 'DEFAULT_RISK_TOLERANCE', RISKS, 'medium', ctx),
    },
    warnings: ctx.warnings,
  };

  return config;
}

let cachedConfig: AppConfig | null = null;

/** Lazily initialised singleton so tests can call loadConfig with a fake env. */
export function getConfig(): AppConfig {
  if (cachedConfig === null) cachedConfig = loadConfig();
  return cachedConfig;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}

/** Returns 'configured' | 'missing' - safe to log and to render in the UI. */
export function describeSecret(value: string | null): 'configured' | 'missing' {
  return value === null ? 'missing' : 'configured';
}

/** Redacted view of the configuration, safe to return from /api/health. */
export function publicConfigSummary(config: AppConfig = getConfig()) {
  return {
    appEnv: config.appEnv,
    demoMode: config.demoMode,
    ai: {
      configured: config.qwen.isConfigured,
      model: config.qwen.model,
      baseUrlHost: safeHost(config.qwen.baseUrl),
      timeoutMs: config.qwen.timeoutMs,
      maxRetries: config.qwen.maxRetries,
      strictValidation: config.qwen.strictValidation,
    },
    providers: {
      order: config.providers.order,
      keys: {
        finnhub: describeSecret(config.providers.keys.finnhub),
        alphavantage: describeSecret(config.providers.keys.alphavantage),
        twelvedata: describeSecret(config.providers.keys.twelvedata),
      },
      stooqEnabled: config.providers.stooqEnabled,
    },
    cache: config.cache,
    rateLimit: config.rateLimit,
    limits: { maxBodyBytes: config.http.maxBodyBytes, maxUploadBytes: config.upload.maxBytes, maxUploadRows: config.upload.maxRows },
    warnings: config.warnings,
  };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export const HORIZON_LABELS: Record<Horizon, string> = {
  days_to_2_weeks: 'Days to 2 weeks',
  '2_to_8_weeks': '2 to 8 weeks',
  '3_to_12_weeks': '3 to 12 weeks (swing)',
  '6_to_18_months': '6 to 18 months',
};

export const RISK_LABELS: Record<RiskTolerance, string> = {
  low: 'Low - capital preservation first',
  medium: 'Medium - balanced swing trading',
  high: 'High - accepts larger drawdowns',
};
