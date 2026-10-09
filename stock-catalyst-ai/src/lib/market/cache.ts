/**
 * Cache for provider responses.
 *
 * The store is an interface so the default in-memory implementation can be used
 * in tests and the SQLite implementation in production without changing callers.
 * Cache hits are always relabelled `cached` - a cached value is never presented
 * as live.
 */

import type { DataProvenance } from './types.ts';
import { asCached } from './provenance.ts';
import { nowIso, parseIso } from '../utils/dates.ts';

export interface CacheEntry<T> {
  value: T;
  provenance: DataProvenance;
  storedAt: string;
  expiresAt: string;
}

export interface CacheStore {
  get<T>(key: string, staleAfterSeconds: number, nowTime?: number): CacheEntry<T> | null;
  set<T>(key: string, value: T, provenance: DataProvenance, ttlSeconds: number, nowTime?: number): void;
  delete(key: string): boolean;
  clear(): void;
  size(): number;
  keys(): string[];
}

export function cacheKey(kind: string, ...parts: ReadonlyArray<string | number | null | undefined>): string {
  const suffix = parts
    .map((part) => (part === null || part === undefined ? '-' : String(part)))
    .join(':');
  return `${kind}:${suffix}`;
}

export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  get<T>(key: string, staleAfterSeconds: number, nowTime = Date.now()): CacheEntry<T> | null {
    const entry = this.entries.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    const expiresAt = parseIso(entry.expiresAt);
    if (expiresAt !== null && expiresAt <= nowTime) {
      this.entries.delete(key);
      return null;
    }
    return {
      ...entry,
      provenance: asCached(entry.provenance, staleAfterSeconds, nowTime),
    };
  }

  set<T>(key: string, value: T, provenance: DataProvenance, ttlSeconds: number, nowTime = Date.now()): void {
    if (ttlSeconds <= 0) return;
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      // Evict the oldest entry: bounded memory for a long-running dev server.
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey === 'string') this.entries.delete(oldestKey);
    }
    this.entries.set(key, {
      value,
      provenance,
      storedAt: new Date(nowTime).toISOString(),
      expiresAt: new Date(nowTime + ttlSeconds * 1000).toISOString(),
    });
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }
}

/** A store that refuses everything; used when caching is disabled by TTL=0. */
export class NullCacheStore implements CacheStore {
  get<T>(_key: string, _staleAfterSeconds: number, _nowTime?: number): CacheEntry<T> | null {
    return null;
  }
  set<T>(_key: string, _value: T, _provenance: DataProvenance, _ttlSeconds: number, _nowTime?: number): void {}
  delete(): boolean {
    return false;
  }
  clear(): void {}
  size(): number {
    return 0;
  }
  keys(): string[] {
    return [];
  }
}

export function storedAtIso(nowTime = Date.now()): string {
  return new Date(nowTime).toISOString() || nowIso();
}
