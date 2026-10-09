/**
 * Sliding-window rate limiter. Used for two different jobs:
 *   - outbound: keeping us inside provider free-tier ceilings
 *   - inbound: throttling API routes, with a stricter bucket for the AI pipeline
 * Injectable clock so behaviour is testable without waiting.
 */

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number | null;
  limit: number;
  windowSeconds: number;
}

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(maxRequests: number, windowMs: number, now: () => number = Date.now) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.now = now;
    if (!Number.isInteger(maxRequests) || maxRequests < 1) {
      throw new RangeError('maxRequests must be a positive integer');
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError('windowMs must be positive');
    }
  }

  get windowSeconds(): number {
    return Math.round(this.windowMs / 1000);
  }

  get limit(): number {
    return this.maxRequests;
  }

  private prune(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const existing = this.hits.get(key) ?? [];
    const kept = existing.filter((timestamp) => timestamp > cutoff);
    if (kept.length === 0) this.hits.delete(key);
    else this.hits.set(key, kept);
    return kept;
  }

  /** Reads the state without consuming a slot. */
  check(key: string): RateLimitDecision {
    const kept = this.prune(key);
    return this.decide(kept);
  }

  /** Consumes a slot when allowed. */
  consume(key: string): RateLimitDecision {
    const kept = this.prune(key);
    const decision = this.decide(kept);
    if (decision.allowed) {
      kept.push(this.now());
      this.hits.set(key, kept);
    }
    return decision;
  }

  private decide(kept: readonly number[]): RateLimitDecision {
    const remaining = Math.max(0, this.maxRequests - kept.length);
    if (kept.length < this.maxRequests) {
      return { allowed: true, remaining, retryAfterSeconds: null, limit: this.maxRequests, windowSeconds: this.windowSeconds };
    }
    const oldest = kept[0];
    const retryAfterMs = Math.max(0, oldest + this.windowMs - this.now());
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      limit: this.maxRequests,
      windowSeconds: this.windowSeconds,
    };
  }

  reset(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }

  trackedKeys(): number {
    return this.hits.size;
  }
}