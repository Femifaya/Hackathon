/**
 * Minimal Result type. Provider adapters and the AI layer must never throw for
 * expected failures; they return a typed error so callers can render an explicit
 * "unavailable" state instead of a fabricated value.
 */

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

export function mapError<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/** Returns the first successful result, or the last error when all fail. */
export function firstOk<T, E>(results: ReadonlyArray<Result<T, E>>): Result<T, E> | null {
  let lastError: Result<T, E> | null = null;
  for (const result of results) {
    if (result.ok) return result;
    lastError = result;
  }
  return lastError;
}