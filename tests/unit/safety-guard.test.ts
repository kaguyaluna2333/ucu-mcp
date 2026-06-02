import { describe, it, expect } from "vitest";
import { SafetyGuard } from "../../src/safety/guard.js";

describe("SafetyGuard", () => {
  it("should block cmd+q key combination", () => {
    const guard = new SafetyGuard();
    const result = guard.checkAction("key", { keys: ["cmd", "q"] });
    expect(result.allowed).toBe(false);
  });

  it("should allow normal key combination like cmd+c", () => {
    const guard = new SafetyGuard();
    const result = guard.checkAction("key", { keys: ["cmd", "c"] });
    expect(result.allowed).toBe(true);
  });

  it("should block cmd+l (lock screen) key combination", () => {
    const guard = new SafetyGuard();
    const result = guard.checkAction("key", { keys: ["cmd", "l"] });
    expect(result.allowed).toBe(false);
  });

  it("should block alt+f4 key combination", () => {
    const guard = new SafetyGuard();
    const result = guard.checkAction("key", { keys: ["alt", "f4"] });
    expect(result.allowed).toBe(false);
  });

  it("should block actions targeting sensitive windows", () => {
    const guard = new SafetyGuard();
    const result = guard.checkAction("click", { x: 100, y: 200, windowTitle: "1Password" });
    expect(result.allowed).toBe(false);
  });

  it("should allow actions targeting normal windows", () => {
    const guard = new SafetyGuard();
    const result = guard.checkAction("click", { x: 100, y: 200, windowTitle: "VS Code" });
    expect(result.allowed).toBe(true);
  });

  it("should enforce rate limit", () => {
    const guard = new SafetyGuard({ rateLimitMs: 1000 });
    guard.checkAction("click", { x: 1, y: 1 });
    const result = guard.checkAction("click", { x: 2, y: 2 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Rate-limited");
  });

  it("should allow action with no args", () => {
    const guard = new SafetyGuard();
    const result = guard.checkAction("click", {});
    expect(result.allowed).toBe(true);
  });

  it("should respect custom blockedKeys config", () => {
    const guard = new SafetyGuard({ blockedKeys: ["my+custom+combo"] });
    const result = guard.checkAction("key", { keys: ["my", "custom", "combo"] });
    expect(result.allowed).toBe(false);
  });

  it("should respect custom skippedWindows config", () => {
    const guard = new SafetyGuard({ skippedWindows: ["SecretApp"] });
    const result = guard.checkAction("click", { x: 1, y: 1, windowTitle: "SecretApp" });
    expect(result.allowed).toBe(false);
  });

  it("should block actions targeting sensitive URLs", () => {
    const guard = new SafetyGuard();
    const result = guard.checkAction("click", { x: 1, y: 1, url: "https://www.paypal.com/myaccount" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("sensitive URL");
  });

  it("should respect custom blockedUrls config", () => {
    const guard = new SafetyGuard({ blockedUrls: ["internal.example"] });
    const result = guard.checkAction("type_text", { text: "hello", url: "https://internal.example/settings" });
    expect(result.allowed).toBe(false);
  });

  it("should block suspicious shell substitution typed text", () => {
    const guard = new SafetyGuard();
    const result = guard.checkAction("type_text", { text: "hello $(rm -rf /)" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("suspicious typed text");
  });

  it("should block suspicious JXA injection primitives in typed text", () => {
    const guard = new SafetyGuard();
    const result = guard.checkAction("type_in_element", { text: "ObjC.import('Foundation')" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("suspicious typed text");
  });

  it("should allow unsafe text scan to be disabled for controlled harnesses", () => {
    const guard = new SafetyGuard({ allowUnsafeText: true });
    const result = guard.checkAction("type_text", { text: "hello $(example)" });
    expect(result.allowed).toBe(true);
  });
  it("should block actions during user activity pause", () => {
    const guard = new SafetyGuard();
    guard.recordUserActivity();
    const result = guard.checkAction("click", { x: 100, y: 200 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("User activity detected");
  });

  it("should allow actions after user activity pause expires", async () => {
    const guard = new SafetyGuard();
    guard.setUserActivityPauseMs(50);
    guard.recordUserActivity();
    await new Promise((r) => setTimeout(r, 100));
    const result = guard.checkAction("click", { x: 100, y: 200 });
    expect(result.allowed).toBe(true);
  });

  it("should allow actions when user activity pause is disabled", () => {
    const guard = new SafetyGuard();
    guard.setUserActivityPauseMs(0);
    guard.recordUserActivity();
    const result = guard.checkAction("click", { x: 100, y: 200 });
    expect(result.allowed).toBe(true);
  });
});
