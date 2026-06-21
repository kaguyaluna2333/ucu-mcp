/**
 * Retry with exponential backoff for flaky platform calls.
 *
 * Only retries when the thrown error is a `UcuError` with `retryable === true`.
 * Delay for retry attempt *n* is `BASE_DELAY * 2^(n-1)`, capped at `MAX_DELAY`.
 * Up to {@link MAX_RETRIES} retries; non-retryable errors propagate immediately.
 */

import { UcuError } from "./errors.js";

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const BASE_DELAY = 100;
const MAX_DELAY = 5000;

function isRetryable(error: unknown): boolean {
  return error instanceof UcuError && error.retryable === true;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Execute `fn` and retry up to {@link MAX_RETRIES} times with exponential
 * backoff on retryable errors.
 *
 * @param fn - The async function to execute.
 * @returns  The resolved value of `fn`.
 */
export async function retry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      // If we've exhausted all retries or the error is not retryable, throw.
      if (attempt === MAX_RETRIES || !isRetryable(error)) {
        throw error;
      }

      // Exponential backoff: BASE_DELAY * 2^attempt, capped at MAX_DELAY.
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), MAX_DELAY);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Unreachable — the loop either returns or throws.
  throw lastError;
}
