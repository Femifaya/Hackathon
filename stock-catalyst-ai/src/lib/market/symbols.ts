/**
 * Symbol handling. The symbol is the only user-controlled value interpolated into
 * an outbound URL, so it is constrained here and re-checked in every adapter.
 */

export const SYMBOL_PATTERN = /^[A-Z][A-Z.\-]{0,9}$/;
export const MAX_SYMBOL_LENGTH = 10;

export function normalizeSymbol(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  // Only the outer whitespace is trimmed: an inner space means this is not a ticker.
  const trimmed = input.trim().toUpperCase();
  if (trimmed.length === 0 || trimmed.length > MAX_SYMBOL_LENGTH) return null;
  return SYMBOL_PATTERN.test(trimmed) ? trimmed : null;
}

export function isValidSymbol(input: unknown): boolean {
  return normalizeSymbol(input) !== null;
}

/** Stooq appends the exchange suffix for US listings. */
export function toStooqSymbol(symbol: string): string {
  return `${symbol.toLowerCase()}.us`;
}

/** Rejects anything that could be used for path traversal or SSRF. */
export function isSafePathSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,32}$/.test(value) && !value.includes('..');
}