import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

import { MacOSPlatform } from "../../src/platform/macos/index.js";

describe("MacOSPlatform element cache (AX refetch)", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
    execFileMock.mockReset();
  });

  function makeElement(id: string, overrides: Record<string, unknown> = {}) {
    return {
      elementId: id,
      appName: "TestApp",
      role: "AXButton",
      name: "OK",
      cachedAt: Date.now(),
      ...overrides,
    };
  }

  it("evicts expired cache entries when TTL elapses", async () => {
    vi.useFakeTimers();
    const platform = new MacOSPlatform();
    const cache = (platform as any).elementCache as Map<string, any>;
    const TTL = (platform as any).elementCacheTtlMs as number;

    cache.set("App/win0/1", makeElement("App/win0/1"));
    expect(cache.size).toBe(1);

    vi.advanceTimersByTime(TTL + 1);
    await platform.clickElement("App/win0/1", "TestApp");
    expect(cache.has("App/win0/1")).toBe(false);

    vi.useRealTimers();
  });

  it("keeps fresh cache entries within TTL", async () => {
    const platform = new MacOSPlatform();
    const cache = (platform as any).elementCache as Map<string, any>;

    cache.set("App/win0/2", makeElement("App/win0/2", { cachedAt: Date.now() }));
    await platform.clickElement("App/win0/2", "TestApp");
    expect(cache.has("App/win0/2")).toBe(true);

    const lastCall = execFileSyncMock.mock.calls.at(-1);
    const script = (lastCall?.[1] as string[])?.at(-1) ?? "";
    expect(script).toContain("AXButton");
    expect(script).toContain('"name":"OK"');
  });

  it("evicts oldest entries when cache exceeds maxSize (LRU)", () => {
    const platform = new MacOSPlatform();
    const cache = (platform as any).elementCache as Map<string, any>;
    const maxSize = (platform as any).elementCacheMaxSize as number;

    for (let i = 0; i < maxSize; i++) {
      cache.set("App/win0/" + i, makeElement("App/win0/" + i, { cachedAt: i }));
    }
    expect(cache.size).toBe(maxSize);

    cache.set("App/win0/extra", makeElement("App/win0/extra", { cachedAt: maxSize + 1000 }));
    (platform as any).evictOverflowCacheEntries();

    expect(cache.size).toBe(maxSize);
    expect(cache.has("App/win0/0")).toBe(false);
    expect(cache.has("App/win0/extra")).toBe(true);
  });

  it("clickElement passes cached descriptor JSON to JXA when available", async () => {
    const platform = new MacOSPlatform();
    const cache = (platform as any).elementCache as Map<string, any>;

    const descriptor = makeElement("Notes/win0/3/4", {
      role: "AXTextArea",
      name: "document body",
      value: "hello world",
    });
    cache.set("Notes/win0/3/4", descriptor);

    await platform.clickElement("Notes/win0/3/4", "Notes");

    const lastCall = execFileSyncMock.mock.calls.at(-1);
    const script = (lastCall?.[1] as string[])?.at(-1) ?? "";
    expect(script).toContain("AXTextArea");
    expect(script).toContain("document body");
    expect(script).toContain("hello world");
    expect(script).toContain("function descriptorMatches");
  });

  it("clickElement passes cached=null when no cache hit", async () => {
    const platform = new MacOSPlatform();
    await platform.clickElement("UnknownApp/win0/9", "UnknownApp");

    const lastCall = execFileSyncMock.mock.calls.at(-1);
    const script = (lastCall?.[1] as string[])?.at(-1) ?? "";
    expect(script).toContain("var cached = null;");
  });

  it("typeInElement evicts expired entries and keeps fresh ones", async () => {
    vi.useFakeTimers();
    const platform = new MacOSPlatform();
    const cache = (platform as any).elementCache as Map<string, any>;
    const TTL = (platform as any).elementCacheTtlMs;

    cache.set("App/win0/5", makeElement("App/win0/5", { cachedAt: Date.now() - TTL - 1 }));
    cache.set("App/win0/6", makeElement("App/win0/6", { cachedAt: Date.now() }));

    await platform.typeInElement("App/win0/5", "expired", "App");
    expect(cache.has("App/win0/5")).toBe(false);

    await platform.typeInElement("App/win0/6", "fresh", "App");
    expect(cache.has("App/win0/6")).toBe(true);

    vi.useRealTimers();
  });

  it("setElementValue evicts expired entries", async () => {
    vi.useFakeTimers();
    const platform = new MacOSPlatform();
    const cache = (platform as any).elementCache as Map<string, any>;
    const TTL = (platform as any).elementCacheTtlMs;

    cache.set("App/win0/7", makeElement("App/win0/7", { cachedAt: Date.now() - TTL - 1 }));
    await platform.setElementValue("App/win0/7", "new value", "App");
    expect(cache.has("App/win0/7")).toBe(false);

    vi.useRealTimers();
  });

  it("clickElement escapes backticks in elementId to prevent JXA breakout", async () => {
    const platform = new MacOSPlatform();
    await platform.clickElement("App/win0/1\\` injected()", "App");

    const lastCall = execFileSyncMock.mock.calls.at(-1);
    const script = (lastCall?.[1] as string[])?.at(-1) ?? "";
    // Backtick should be escaped (\\` in the JXA source)
    expect(script).toContain("\\\\`");
  });

  it("typeInElement passes text content through to JXA for typing", async () => {
    const platform = new MacOSPlatform();
    await platform.typeInElement("App/win0/1", "Hello World", "App");

    const lastCall = execFileSyncMock.mock.calls.at(-1);
    const script = (lastCall?.[1] as string[])?.at(-1) ?? "";
    // The text should appear in the JXA script
    expect(script).toContain("Hello World");
    // Should have the clear-first and typing logic
    expect(script).toContain("var textToType =");
  });
});
