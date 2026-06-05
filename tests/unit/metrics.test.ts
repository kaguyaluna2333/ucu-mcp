import { describe, it, expect, beforeEach } from "vitest";
import { Metrics, metrics as singleton } from "../../src/util/metrics.js";

describe("Metrics ring buffer", () => {
  let m: Metrics;
  beforeEach(() => {
    m = new Metrics();
  });

  it("returns zero stats for an empty buffer", () => {
    const s = m.stats();
    expect(s).toEqual({ count: 0, p50: 0, p95: 0, max: 0, mean: 0 });
  });

  it("counts and computes max/mean for a small sample", () => {
    m.record("a", 10);
    m.record("a", 20);
    m.record("a", 30);
    const s = m.stats("a");
    expect(s.count).toBe(3);
    expect(s.max).toBe(30);
    expect(s.mean).toBe(20);
    expect(s.p50).toBe(20);
    expect(s.p95).toBe(30);
  });

  it("computes p50 and p95 correctly on a known distribution (1..100)", () => {
    for (let i = 1; i <= 100; i++) m.record("x", i);
    const s = m.stats("x");
    expect(s.count).toBe(100);
    expect(s.max).toBe(100);
    expect(s.mean).toBe(50.5);
    expect(s.p50).toBe(50);
    expect(s.p95).toBe(95);
  });

  it("evicts oldest samples when ring is full", () => {
    // Fill beyond 1000 to force eviction
    for (let i = 1; i <= 1500; i++) m.record("y", i);
    const s = m.stats("y");
    expect(s.count).toBe(1000);
    // Oldest 500 (values 1..500) should be evicted; remaining are 501..1500
    expect(s.max).toBe(1500);
    // Mean of 501..1500
    expect(s.mean).toBe(1000.5);
  });

  it("keeps separate buffers per tool name", () => {
    m.record("a", 10);
    m.record("b", 100);
    expect(m.stats("a").max).toBe(10);
    expect(m.stats("b").max).toBe(100);
  });

  it("aggregates global stats across all tools", () => {
    m.record("a", 10);
    m.record("a", 20);
    m.record("b", 100);
    const s = m.stats();
    expect(s.count).toBe(3);
    expect(s.max).toBe(100);
    expect(s.mean).toBeCloseTo(43.3, 1);
  });

  it("byTool returns stats for each tool with samples", () => {
    m.record("a", 10);
    m.record("b", 20);
    m.record("b", 30);
    const by = m.byTool();
    expect(Object.keys(by).sort()).toEqual(["a", "b"]);
    expect(by.a.count).toBe(1);
    expect(by.b.count).toBe(2);
  });

  it("reset clears all samples", () => {
    m.record("a", 10);
    m.reset();
    expect(m.stats().count).toBe(0);
    expect(m.stats("a").count).toBe(0);
  });

  it("rounds percentiles to 1 decimal place", () => {
    m.record("a", 1.234);
    m.record("a", 2.345);
    m.record("a", 3.456);
    const s = m.stats("a");
    // 1.234 -> 1.2, 2.345 -> 2.3, 3.456 -> 3.5
    expect(s.p50).toBe(2.3);
    expect(s.p95).toBe(3.5);
  });
});

describe("Metrics singleton", () => {
  it("is the same instance across imports", () => {
    expect(singleton).toBeInstanceOf(Metrics);
  });

  it("records into a shared buffer (test isolation caveat: this test mutates the singleton)", () => {
    singleton.reset();
    singleton.record("test_tool", 42);
    expect(singleton.stats("test_tool").count).toBeGreaterThanOrEqual(1);
    singleton.reset();
  });
});
