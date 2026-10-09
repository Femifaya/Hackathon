/** Presentation helpers. Pure and locale-stable so tests are deterministic. */

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (!isFiniteNumber(value)) return 'n/a';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatPrice(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return 'n/a';
  const digits = Math.abs(value) >= 1000 ? 2 : Math.abs(value) >= 1 ? 2 : 4;
  return `$${formatNumber(value, digits)}`;
}

export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (!isFiniteNumber(value)) return 'n/a';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatNumber(value, digits)}%`;
}

/** Accepts a ratio (0.031) and renders it as a percentage (+3.10%). */
export function formatRatioAsPercent(ratio: number | null | undefined, digits = 2): string {
  if (!isFiniteNumber(ratio)) return 'n/a';
  return formatPercent(ratio * 100, digits);
}

export function formatCompact(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return 'n/a';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

export function formatSigned(value: number | null | undefined, digits = 2): string {
  if (!isFiniteNumber(value)) return 'n/a';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatNumber(value, digits)}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!isFiniteNumber(bytes) || bytes < 0) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let size = bytes;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${formatNumber(size, index === 0 ? 0 : 1)} ${units[index]}`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Renders a closed enum value as a stable human label without trusting input casing. */
export function labelFor(value: string, fallback = 'Unknown'): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return titleCase(trimmed.replace(/_/g, ' '));
}