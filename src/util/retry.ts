/**
 * Retry with exponential backoff for flaky platform calls.
 *
 * Only retries when the thrown error is a `UcuError` with `retryable === true`,
 * unless a custom `shouldRetry` predicate overrides the decision.
 */

import { UcuError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Maximum number of retries (not including the initial attempt). Default: 3 */
  maxRetries?: number;

  /** Base delay in milliseconds for the first retry. Default: 100 */
  baseDelay?: number;

  /** Ceiling for the backoff delay in milliseconds. Default: 5000 */
  maxDelay?: number;

  /** Custom predicate to decide whether an error is retryable.
   *  Defaults to `(err) => err instanceof UcuError && err.retryable === true`. */
  shouldRetry?: (error: unknown) => boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY = 100;
const DEFAULT_MAX_DELAY = 5000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Execute `fn` and retry with exponential backoff on retryable errors.
 *
 * The delay for retry attempt *n* is `baseDelay * 2^(n-1)`, capped at
 * `maxDelay`. Only errors that are `UcuError` with `retryable === true`
 * (or that pass the custom `shouldRetry` predicate) trigger a retry.
 * All other errors propagate immediately.
 *
 * @param fn      - The async function to execute.
 * @param options - Retry configuration.
 * @returns       The resolved value of `fn`.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options?.baseDelay ?? DEFAULT_BASE_DELAY;
  const maxDelay = options?.maxDelay ?? DEFAULT_MAX_DELAY;
  const shouldRetry =
    options?.shouldRetry ??
    ((err: unknown): boolean => err instanceof UcuError && err.retryable === true);

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      // If we've exhausted all retries or the error is not retryable, throw.
      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // Exponential backoff: baseDelay * 2^attempt, capped at maxDelay.
      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Unreachable — the loop either returns or throws.
  throw lastError;
}
