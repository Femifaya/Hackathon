/**
 * Output sanitisation.
 *
 * React escapes interpolated text by default and this codebase never uses
 * dangerouslySetInnerHTML, so these helpers are defence in depth: they make
 * strings from external sources (news, filings, model output) safe to render,
 * log, and embed in exported Markdown/JSON/print documents.
 */

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const BIDI_OVERRIDES = /[\u202A-\u202E\u2066-\u2069]/g;
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

export interface SanitizeOptions {
  maxLength?: number;
  allowNewlines?: boolean;
}

/** Removes control characters, bidi overrides, and zero-width characters. */
export function stripInvisible(text: string): string {
  return text.replace(CONTROL_CHARS, '').replace(BIDI_OVERRIDES, '').replace(ZERO_WIDTH, '');
}

export function normalizeWhitespace(text: string, allowNewlines = true): string {
  const collapsed = allowNewlines ? text.replace(/[ \t\r\f\v]+/g, ' ') : text.replace(/\s+/g, ' ');
  return collapsed
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeText(input: unknown, options: SanitizeOptions = {}): string {
  if (typeof input !== 'string') return '';
  // Markup is stripped, not escaped: research text is plain prose and must stay
  // safe when re-rendered in Markdown, JSON, or the print view.
  const cleaned = stripMarkup(stripInvisible(input));
  const normalized = normalizeWhitespace(cleaned, options.allowNewlines ?? true);
  const maxLength = options.maxLength ?? 4000;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

/** Escapes the five HTML-active characters. Used only for the print stylesheet path. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Neutralises Markdown that could break an exported document's structure. */
export function escapeMarkdown(input: string): string {
  return input.replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1');
}

/** Escapes the characters that would break out of a CSV cell. */
export function escapeCsvCell(input: string): string {
  const needsQuotes = /[",\n\r]/.test(input);
  const escaped = input.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

/** True when a string contains markup that should never appear in plain research text. */
export function containsMarkup(input: string): boolean {
  return /<\/?[a-z][\s\S]*?>/i.test(input) || /javascript:/i.test(input) || /data:text\/html/i.test(input);
}

/** Removes markup rather than escaping it: research text is plain prose. */
export function stripMarkup(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, '[filtered]')
    .replace(/<style[\s\S]*?<\/style>/gi, '[filtered]')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/javascript:/gi, '[filtered]')
    .replace(/data:text\/html/gi, '[filtered]');
}

/** Sanitises every string in a nested structure; used on model output before storage. */
export function sanitizeDeep(input: unknown, maxLength = 4000): unknown {
  if (typeof input === 'string') return sanitizeText(input, { maxLength });
  if (Array.isArray(input)) return input.map((item) => sanitizeDeep(item, maxLength));
  if (input && typeof input === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      output[sanitizeText(key, { maxLength: 80 })] = sanitizeDeep(value, maxLength);
    }
    return output;
  }
  return input;
}

/** Rejects a symbol-looking string that is not a plain US ticker. */
export function sanitizeSymbol(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toUpperCase();
  return /^[A-Z][A-Z.\-]{0,9}$/.test(trimmed) ? trimmed : null;
}