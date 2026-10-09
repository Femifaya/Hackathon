/** Identifier helpers. Injectable randomness keeps tests deterministic. */

export type RandomFn = () => number;

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomSuffix(length: number, random: RandomFn): string {
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += ALPHABET.charAt(Math.floor(random() * ALPHABET.length) % ALPHABET.length);
  }
  return out;
}

/**
 * Prefixed, lexicographically sortable id, e.g. `rpt_lz4k3f9a2b`.
 * Uses crypto.randomUUID when available for collision resistance.
 */
export function createId(prefix: string, random: RandomFn = Math.random, nowTime: number = Date.now()): string {
  const timePart = nowTime.toString(36);
  let entropy: string;
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function' && random === Math.random) {
    entropy = cryptoRef.randomUUID().replace(/-/g, '').slice(0, 12);
  } else {
    entropy = randomSuffix(12, random);
  }
  return `${prefix}_${timePart}${entropy}`;
}

export function isPrefixedId(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && value.startsWith(`${prefix}_`) && value.length <= 80;
}