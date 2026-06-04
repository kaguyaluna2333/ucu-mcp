import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("logger", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let originalLevel: string | undefined;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    originalLevel = process.env.UCU_LOG_LEVEL;
  });

  afterEach(() => {
    errorSpy.mockRestore();
    if (originalLevel === undefined) {
      delete process.env.UCU_LOG_LEVEL;
    } else {
      process.env.UCU_LOG_LEVEL = originalLevel;
    }
  });

  it("emits info+ entries to stderr as JSON with name and msg", async () => {
    delete process.env.UCU_LOG_LEVEL;
    vi.resetModules();
    const { createLogger } = await import("../../src/util/logger.js");
    const log = createLogger("test");
    log.info("hello", { foo: 1 });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = errorSpy.mock.calls[0][0] as string;
    const entry = JSON.parse(line);
    expect(entry.level).toBe("info");
    expect(entry.name).toBe("test");
    expect(entry.msg).toBe("hello");
    expect(entry.foo).toBe(1);
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof entry.time).toBe("number");
  });

  it("does not emit debug when level is info", async () => {
    delete process.env.UCU_LOG_LEVEL;
    vi.resetModules();
    const { createLogger } = await import("../../src/util/logger.js");
    const log = createLogger("test");
    log.debug("hidden");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("emits debug when UCU_LOG_LEVEL=debug", async () => {
    process.env.UCU_LOG_LEVEL = "debug";
    vi.resetModules();
    const { createLogger } = await import("../../src/util/logger.js");
    const log = createLogger("verbose");
    log.debug("visible");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(entry.level).toBe("debug");
    expect(entry.msg).toBe("visible");
  });

  it("warn and error levels are emitted", async () => {
    delete process.env.UCU_LOG_LEVEL;
    vi.resetModules();
    const { createLogger } = await import("../../src/util/logger.js");
    const log = createLogger("lvl");
    log.warn("w");
    log.error("e");
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(errorSpy.mock.calls[0][0] as string).level).toBe("warn");
    expect(JSON.parse(errorSpy.mock.calls[1][0] as string).level).toBe("error");
  });

  it("error level suppresses info and debug", async () => {
    process.env.UCU_LOG_LEVEL = "error";
    vi.resetModules();
    const { createLogger } = await import("../../src/util/logger.js");
    const log = createLogger("strict");
    log.info("i");
    log.debug("d");
    log.warn("w");
    log.error("e");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(errorSpy.mock.calls[0][0] as string).level).toBe("error");
  });

  it("withCorrelationId adds correlationId to all subsequent entries", async () => {
    delete process.env.UCU_LOG_LEVEL;
    vi.resetModules();
    const { createLogger } = await import("../../src/util/logger.js");
    const log = createLogger("corr").withCorrelationId("req-abc");
    log.info("first");
    log.error("second");

    expect(errorSpy).toHaveBeenCalledTimes(2);
    for (const call of errorSpy.mock.calls) {
      const entry = JSON.parse(call[0] as string);
      expect(entry.correlationId).toBe("req-abc");
    }
  });

  it("parent logger is not mutated by withCorrelationId", async () => {
    delete process.env.UCU_LOG_LEVEL;
    vi.resetModules();
    const { createLogger } = await import("../../src/util/logger.js");
    const parent = createLogger("parent");
    const child = parent.withCorrelationId("x");
    child.info("child");
    parent.info("parent");

    const childEntry = JSON.parse(errorSpy.mock.calls[0][0] as string);
    const parentEntry = JSON.parse(errorSpy.mock.calls[1][0] as string);
    expect(childEntry.correlationId).toBe("x");
    expect(parentEntry.correlationId).toBeUndefined();
  });

  it("falls back to info when UCU_LOG_LEVEL is invalid", async () => {
    process.env.UCU_LOG_LEVEL = "bogus";
    vi.resetModules();
    const { createLogger } = await import("../../src/util/logger.js");
    const log = createLogger("fb");
    log.debug("d");
    log.info("i");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(errorSpy.mock.calls[0][0] as string).level).toBe("info");
  });

  it("merges arbitrary fields into the entry", async () => {
    delete process.env.UCU_LOG_LEVEL;
    vi.resetModules();
    const { createLogger } = await import("../../src/util/logger.js");
    const log = createLogger("merge");
    log.info("event", { tool: "click", duration: 42, ok: true });
    const entry = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(entry.tool).toBe("click");
    expect(entry.duration).toBe(42);
    expect(entry.ok).toBe(true);
  });
});
