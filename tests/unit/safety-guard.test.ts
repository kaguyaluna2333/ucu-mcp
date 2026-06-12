import { describe, it, expect } from "vitest";
import {
  SafetyGuard,
  OBSERVE_ACTIONS,
  INPUT_ACTIONS,
  classifyAction,
} from "../../src/safety/guard.js";

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

describe("OBSERVE_ACTIONS / INPUT_ACTIONS classification (M6.1)", () => {
  it("OBSERVE_ACTIONS contains all read-only tools", () => {
    const expected = [
      "screenshot",
      "list_windows",
      "list_apps",
      "get_window_state",
      "get_screen_size",
      "get_cursor_position",
      "ocr",
      "find_element",
      "wait",
      "wait_for_element",
      "doctor",
      "clipboard_read",
      // focus_app is read-only: it only sets the active target context via
      // AppleScript activate and an AX window lookup — it does not synthesize
      // mouse or keyboard input, so the user-activity pause must not block it.
      "focus_app",
    ];
    for (const action of expected) {
      expect(OBSERVE_ACTIONS.has(action)).toBe(true);
    }
  });

  it("INPUT_ACTIONS contains all mutating tools", () => {
    const expected = [
      "click",
      "double_click",
      "scroll",
      "drag",
      "move",
      "type_text",
      "press_key",
      "click_element",
      "type_in_element",
      "set_value",
    ];
    for (const action of expected) {
      expect(INPUT_ACTIONS.has(action)).toBe(true);
    }
  });

  it("OBSERVE_ACTIONS and INPUT_ACTIONS do not overlap", () => {
    const overlap: string[] = [];
    for (const action of OBSERVE_ACTIONS) {
      if (INPUT_ACTIONS.has(action)) overlap.push(action);
    }
    expect(overlap).toEqual([]);
  });

  it("classifyAction returns correct class for observe/input/unknown actions", () => {
    expect(classifyAction("screenshot")).toBe("observe");
    expect(classifyAction("list_windows")).toBe("observe");
    expect(classifyAction("doctor")).toBe("observe");
    expect(classifyAction("click")).toBe("input");
    expect(classifyAction("type_text")).toBe("input");
    expect(classifyAction("press_key")).toBe("input");
    expect(classifyAction("totally_unknown_action_xyz")).toBe("other");
    expect(classifyAction("")).toBe("other");
  });

  it("checkAction skips user activity pause for observe actions", () => {
    const guard = new SafetyGuard({ rateLimitMs: 0 });
    guard.setUserActivityPauseMs(5000);
    guard.recordUserActivity();

    const skipped = guard.checkAction("screenshot", {}, { skipUserActivityPause: true });
    expect(skipped.allowed).toBe(true);

    const notSkipped = guard.checkAction("screenshot", {});
    expect(notSkipped.allowed).toBe(false);
    expect(notSkipped.reason).toContain("User activity detected");
  });

  it("checkAction skips user activity pause for focus_app when the caller threads classifyAction() through (as withSafety does)", () => {
    // SafetyGuard.checkAction itself does NOT auto-classify; the auto-skip
    // for observe actions is computed by withSafety() in tools.ts using
    // classifyAction(). This test pins that contract: if the caller passes
    // skipUserActivityPause: true for an action that classifyAction() labels
    // as "observe", the user-activity pause does not block.
    const guard = new SafetyGuard({ rateLimitMs: 0 });
    guard.setUserActivityPauseMs(5000);
    guard.recordUserActivity();

    // (a) Without skip, focus_app is blocked — the bare guard has no
    // knowledge of OBSERVE_ACTIONS.
    const blocked = guard.checkAction("focus_app", { app: "CC Switch" });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("User activity detected");

    // (b) With skip, focus_app passes. This is what withSafety() does for
    // any action where classifyAction() returns "observe", and it is the
    // path that focus_app follows in production.
    const skipped = guard.checkAction("focus_app", { app: "CC Switch" }, { skipUserActivityPause: true });
    expect(skipped.allowed).toBe(true);

    // (c) classifyAction() must label focus_app as observe so that the
    // production withSafety() default actually skips.
    expect(classifyAction("focus_app")).toBe("observe");
  });

  it("classifyAction classifies focus_app as observe", () => {
    expect(classifyAction("focus_app")).toBe("observe");
  });

  it("checkAction applies user activity pause for input actions", () => {
    const guard = new SafetyGuard({ rateLimitMs: 0 });
    guard.setUserActivityPauseMs(5000);
    guard.recordUserActivity();

    const blocked = guard.checkAction("click");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("User activity detected");

    const explicitSkip = guard.checkAction("click", {}, { skipUserActivityPause: true });
    expect(explicitSkip.allowed).toBe(true);
  });
});

describe("clipboard injection safety (TST-P1-1)", () => {
  it("blocks shell command substitution in clipboard_write", () => {
    const guard = new SafetyGuard({ rateLimitMs: 0 });
    const result = guard.checkAction("clipboard_write", { text: "hello $(rm -rf /)" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("suspicious typed text");
  });

  it("blocks shell backtick substitution in clipboard_write", () => {
    const guard = new SafetyGuard({ rateLimitMs: 0 });
    const result = guard.checkAction("clipboard_write", { text: "result=`whoami`" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("suspicious typed text");
  });

  it("blocks shell command chaining in clipboard_write", () => {
    const guard = new SafetyGuard({ rateLimitMs: 0 });
    const result = guard.checkAction("clipboard_write", { text: "echo hello && rm -rf /" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("suspicious typed text");
  });

  it("blocks piping into an interpreter in clipboard_write", () => {
    const guard = new SafetyGuard({ rateLimitMs: 0 });
    const result = guard.checkAction("clipboard_write", { text: "data | bash" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("suspicious typed text");
  });

  it("blocks dangerous shell commands in clipboard_write", () => {
    const guard = new SafetyGuard({ rateLimitMs: 0 });
    const result = guard.checkAction("clipboard_write", { text: "sudo rm -rf /important" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("suspicious typed text");
  });

  it("blocks JXA injection primitives in clipboard_write", () => {
    const guard = new SafetyGuard({ rateLimitMs: 0 });
    const result = guard.checkAction("clipboard_write", { text: "ObjC.import('Foundation')" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("suspicious typed text");
  });

  it("blocks AppleScript injection in clipboard_write", () => {
    const guard = new SafetyGuard({ rateLimitMs: 0 });
    const result = guard.checkAction("clipboard_write", { text: "do shell script 'rm -rf /'" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("suspicious typed text");
  });

  it("allows safe text in clipboard_write", () => {
    const guard = new SafetyGuard({ rateLimitMs: 0 });
    const result = guard.checkAction("clipboard_write", { text: "Hello, world! This is safe text." });
    expect(result.allowed).toBe(true);
  });

  it("allows clipboard_write with special characters that are not injection patterns", () => {
    const guard = new SafetyGuard({ rateLimitMs: 0 });
    const result = guard.checkAction("clipboard_write", { text: "Price: $50.00 | Qty: 3" });
    expect(result.allowed).toBe(true);
  });

  it("allows unsafe text scan to be disabled for clipboard_write", () => {
    const guard = new SafetyGuard({ allowUnsafeText: true, rateLimitMs: 0 });
    const result = guard.checkAction("clipboard_write", { text: "hello $(example)" });
    expect(result.allowed).toBe(true);
  });

  it("clipboard_read is classified as observe action", () => {
    expect(classifyAction("clipboard_read")).toBe("observe");
  });

  it("clipboard_write is classified as input action", () => {
    expect(classifyAction("clipboard_write")).toBe("input");
  });

  it("clipboard_read skips user activity pause", () => {
    const guard = new SafetyGuard({ rateLimitMs: 0 });
    guard.setUserActivityPauseMs(5000);
    guard.recordUserActivity();

    const result = guard.checkAction("clipboard_read", {}, { skipUserActivityPause: true });
    expect(result.allowed).toBe(true);
  });

  it("clipboard_write respects user activity pause", () => {
    const guard = new SafetyGuard({ rateLimitMs: 0 });
    guard.setUserActivityPauseMs(5000);
    guard.recordUserActivity();

    const result = guard.checkAction("clipboard_write", { text: "safe" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("User activity detected");
  });
});
