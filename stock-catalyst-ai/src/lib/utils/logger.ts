/**
 * Structured logger. Server-side only.
 * Redacts anything that looks like a credential before it can reach stdout.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|authorization|bearer)/i;
const SECRET_VALUE_RE = /\b(sk-[A-Za-z0-9]{8,}|[A-Za-z0-9_-]{32,})\b/g;

export interface LoggerOptions {
  level?: LogLevel;
  scope?: string;
}

function resolveLevel(raw: string | undefined): LogLevel {
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && raw && raw.trim() !== '') {
    if (numeric <= 0.25) return 'error';
    if (numeric <= 0.5) return 'warn';
    if (numeric <= 0.75) return 'info';
    return 'debug';
  }
  const lowered = (raw ?? 'info').toLowerCase();
  return (['debug', 'info', 'warn', 'error'] as const).find((level) => level === lowered) ?? 'info';
}

export function redactSecrets(input: unknown): unknown {
  if (typeof input === 'string') {
    return input.replace(SECRET_VALUE_RE, '[REDACTED]');
  }
  if (Array.isArray(input)) {
    return input.map(redactSecrets);
  }
  if (input && typeof input === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      output[key] = SECRET_KEY_RE.test(key) ? '[REDACTED]' : redactSecrets(value);
    }
    return output;
  }
  return input;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly scope: string;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? resolveLevel(process.env.LOG_LEVEL);
    this.scope = options.scope ?? 'app';
  }

  child(scope: string): Logger {
    return new Logger({ level: this.level, scope: `${this.scope}:${scope}` });
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;
    const record = {
      time: new Date().toISOString(),
      level,
      scope: this.scope,
      message,
      ...(meta ? { meta: redactSecrets(meta) as Record<string, unknown> } : {}),
    };
    const line = JSON.stringify(record);
    if (level === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }
}

export const logger = new Logger();