import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { retry } from "../../src/util/retry.js";
import { UcuError, PlatformError, SafetyError } from "../../src/util/errors.js";

describe("retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when fn succeeds on first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const promise = retry(fn);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries up to maxRetries on retryable UcuError and eventually resolves", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new PlatformError("transient"))
      .mockRejectedValueOnce(new PlatformError("transient"))
      .mockResolvedValue("ok");

    const promise = retry(fn, { maxRetries: 3, baseDelay: 10 });
    // Drain microtasks + timers until promise resolves
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws the last error when retries are exhausted", async () => {
    const err = new PlatformError("always fails");
    const fn = vi.fn().mockRejectedValue(err);

    const promise = retry(fn, { maxRetries: 2, baseDelay: 10 });
    promise.catch(() => undefined); // silence unhandled rejection warning
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toBe(err);
    // 1 initial + 2 retries = 3 total attempts
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable UcuError (e.g. SafetyError)", async () => {
    const err = new SafetyError("blocked");
    const fn = vi.fn().mockRejectedValue(err);

    const promise = retry(fn, { maxRetries: 5, baseDelay: 10 });
    promise.catch(() => undefined);
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry plain (non-UcuError) errors", async () => {
    const err = new Error("random");
    const fn = vi.fn().mockRejectedValue(err);

    const promise = retry(fn, { maxRetries: 5, baseDelay: 10 });
    promise.catch(() => undefined);
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects custom shouldRetry predicate", async () => {
    const err = new Error("custom");
    const fn = vi.fn().mockRejectedValue(err);
    const shouldRetry = vi.fn().mockReturnValue(true);

    const promise = retry(fn, { maxRetries: 1, baseDelay: 10, shouldRetry });
    promise.catch(() => undefined);
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(shouldRetry).toHaveBeenCalledWith(err);
  });

  it("caps delay at maxDelay (exponential backoff)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new PlatformError("a"))
      .mockRejectedValueOnce(new PlatformError("b"))
      .mockRejectedValueOnce(new PlatformError("c"))
      .mockResolvedValue("ok");

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const promise = retry(fn, { maxRetries: 3, baseDelay: 100, maxDelay: 250 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");

    // Inspect the delays used. With baseDelay=100, maxDelay=250:
    //   attempt 0 fail -> wait 100
    //   attempt 1 fail -> wait 200
    //   attempt 2 fail -> wait 250 (capped from 400)
    const delays = setTimeoutSpy.mock.calls.map(([, ms]) => ms as number);
    expect(delays).toEqual([100, 200, 250]);
    setTimeoutSpy.mockRestore();
  });

  it("treats UcuError with retryable=true as retryable", async () => {
    const err = new UcuError("x", "X", true);
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");

    const promise = retry(fn, { maxRetries: 2, baseDelay: 10 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
