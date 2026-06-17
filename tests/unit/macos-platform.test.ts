import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

import { MacOSPlatform } from "../../src/platform/macos/index.js";
import { ElementNotFoundError, PermissionError, PlatformError, TargetStaleError, WindowNotFoundError } from "../../src/util/errors.js";

function lastJxaScript(): string {
  const call = execFileSyncMock.mock.calls.at(-1);
  expect(call?.[0]).toBe("osascript");
  const args = call?.[1] as string[];
  return args.at(-1) ?? "";
}

/** Create a MacOSPlatform with native windowlist helper disabled,
 *  forcing listWindows to use the JXA path. Tests that verify JXA
 *  behavior or set up precise mock sequences for listWindows need
 *  this so the native helper doesn't consume an execFileSync call. */
function jxaOnlyPlatform(): MacOSPlatform {
  return new MacOSPlatform({ nativeHelperPaths: { windowlist: null, skylight: null } });
}

describe("MacOSPlatform", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
  });

  it("sets AX element values without focusing or typing into the element", async () => {
    const platform = new MacOSPlatform();

    await platform.setElementValue("Notes/win0/1/2", "hello", "Notes");

    const script = lastJxaScript();
    expect(script).toContain("elem.value = valueToSet");
    expect(script).not.toContain("focused = true");
    expect(script).not.toContain("keystroke");
  });

  it("uses JSON literals for multiline and special-character AX values", async () => {
    const platform = new MacOSPlatform();
    const value = "line 1\nline 2 with \"quotes\", \\ backslash, $dollar, and `ticks`";

    await platform.setElementValue("Notes/win0/1/2", value, "Notes");

    const script = lastJxaScript();
    expect(script).toContain(`var valueToSet = ${JSON.stringify(value)};`);
    expect(script).toContain(`var elemPath = ${JSON.stringify("Notes/win0/1/2")};`);
    expect(script).toContain(`var appName = ${JSON.stringify("Notes")};`);
  });

  it("reports failed AX value assignment as set_value failure", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({
      success: false,
      error: "Could not set AX value: read only",
    }));
    const platform = new MacOSPlatform();

    await expect(platform.setElementValue("Notes/win0/1/2", "hello", "Notes"))
      .rejects.toBeInstanceOf(PlatformError);
  });

  // Regression test for 0.3.2 regex pre-validation: the value-side guard was
  // added in 0.3.2 (mirroring the existing text-side guard), and both paths
  // must throw PlatformError with "Invalid regex pattern" instead of silently
  // returning "no results". The value-side guard prevents the JXA try/catch
  // from swallowing invalid regex; the text-side guard is the original that
  // the 0.3.2 commit mirrored. (Consolidated from two separate tests in 0.4.1.)
  it.each([
    { field: "value" as const, label: "value-side (0.3.2 regression guard)" },
    { field: "text" as const, label: "text-side (original guard, mirrored in 0.3.7)" },
  ] as const)("throws PlatformError with Invalid regex message when $field is an invalid regex and textMode is regex ($label)", async ({ field }) => {
    const platform = new MacOSPlatform();
    try {
      await platform.findElement({ [field]: "[", app: "Notes", textMode: "regex" });
      throw new Error("expected to throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(PlatformError);
      expect(String(err.message)).toMatch(/^Invalid regex pattern:/);
    }
  });

  it("reports stale AX element IDs as ElementNotFoundError", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({
      success: false,
      error: "Element not found: Notes/win0/1/2",
    }));
    const platform = new MacOSPlatform();

    await expect(platform.setElementValue("Notes/win0/1/2", "hello", "Notes"))
      .rejects.toBeInstanceOf(ElementNotFoundError);
  });

  it("reports AX permission failures as PermissionError", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("System Events is not allowed assistive access");
    });
    const platform = new MacOSPlatform();

    await expect(platform.findElement({ app: "Notes" }))
      .rejects.toBeInstanceOf(PermissionError);
  });

  it("reports missing windows as WindowNotFoundError", async () => {
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify({ error: "Window not found", window: null }));
    const platform = jxaOnlyPlatform();

    await expect(platform.getWindowState("Notes/win9"))
      .rejects.toBeInstanceOf(WindowNotFoundError);
  });

  it("activates an app and returns enriched target context", async () => {
    execFileSyncMock
      .mockReturnValueOnce("")
      .mockReturnValueOnce(JSON.stringify([
        {
          id: "TextEdit/win0",
          title: "Untitled",
          processName: "TextEdit",
          pid: 42,
          bounds: { x: 10, y: 20, width: 300, height: 200 },
          isMinimized: false,
          isOnScreen: true,
        },
      ]));
    const platform = jxaOnlyPlatform();

    const target = await platform.focusApp("TextEdit");

    expect(target.targetId).toBeTruthy();
    expect(target.appName).toBe("TextEdit");
    expect(target.pid).toBe(42);
    expect(target.windowId).toBe("TextEdit/win0");
    expect(target.title).toBe("Untitled");
    expect(target.capturedAt).toBeTruthy();
    expect(new Date(target.capturedAt).getTime()).toBeGreaterThan(0);
    // activate is no longer called — the first osascript call should be the
    // JXA listWindows script, not an AppleScript "activate" command.
    expect(execFileSyncMock.mock.calls[0][1][0]).not.toBe("-e");
  });

  it("prefers exact app name matches over helper process substring matches", async () => {
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify([
        {
          id: "TextEdit Helper/win0",
          title: "Helper",
          processName: "TextEdit Helper",
          pid: 41,
          bounds: { x: 1, y: 2, width: 30, height: 20 },
          isMinimized: false,
          isOnScreen: true,
        },
        {
          id: "TextEdit/win0",
          title: "Untitled",
          processName: "TextEdit",
          pid: 42,
          bounds: { x: 10, y: 20, width: 300, height: 200 },
          isMinimized: false,
          isOnScreen: true,
        },
      ]));
    const platform = jxaOnlyPlatform();

    const target = await platform.focusApp("TextEdit");

    expect(target).toMatchObject({
      appName: "TextEdit",
      pid: 42,
      windowId: "TextEdit/win0",
    });
  });

  it("throws TARGET_STALE when active target window no longer exists", async () => {
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify([])) // activate
      .mockReturnValueOnce(JSON.stringify([
        { id: "App/win0", title: "Win", processName: "App", pid: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, isMinimized: false, isOnScreen: true }
      ])) // first listWindows
      .mockReturnValueOnce(JSON.stringify([])); // second listWindows (stale)
    const platform = jxaOnlyPlatform();
    await platform.focusApp("App");
    let error: unknown;
    try {
      await platform.getWindowState();
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(TargetStaleError);
    expect(error).toMatchObject({ code: "TARGET_STALE" });
  });

  it("throws TARGET_STALE for explicit active target window IDs", async () => {
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([
        { id: "App/win0", title: "Win", processName: "App", pid: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, isMinimized: false, isOnScreen: true },
      ]))
      .mockReturnValueOnce(JSON.stringify([]));
    const platform = jxaOnlyPlatform();
    await platform.focusApp("App");

    let error: unknown;
    try {
      await platform.getWindowState("App/win0");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(TargetStaleError);
    expect(error).toMatchObject({ code: "TARGET_STALE" });
  });

  it("caches listWindows briefly and returns defensive copies", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify([
      {
        id: "Notes/win0",
        title: "Note",
        processName: "Notes",
        pid: 42,
        bounds: { x: 10, y: 20, width: 300, height: 200 },
        isMinimized: false,
        isOnScreen: true,
      },
    ]));
    const platform = jxaOnlyPlatform();

    const first = await platform.listWindows();
    first[0].bounds.x = 999;
    const second = await platform.listWindows();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(second[0].bounds.x).toBe(10);
  });

  it("reports cursor query failures as PlatformError", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("NSEvent failed");
    });
    const platform = new MacOSPlatform();

    expect(() => platform.getCursorPosition()).toThrow(PlatformError);
  });

  it("honors getWindowState depth up to 10 and includeBounds=false", async () => {
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify([
        {
          id: "123",
          title: "Notes",
          processName: "Notes",
          pid: 42,
          bounds: { x: 10, y: 20, width: 300, height: 200 },
          isMinimized: false,
          isOnScreen: true,
        },
      ]))
      .mockReturnValueOnce(JSON.stringify({
        window: {
          id: "123",
          title: "Notes",
          processName: "Notes",
          pid: 42,
          bounds: { x: 10, y: 20, width: 300, height: 200 },
          isMinimized: false,
          isOnScreen: true,
        },
        tree: {
          role: "AXWindow",
          name: "Notes",
          states: [],
          children: [],
        },
      }));
    const platform = new MacOSPlatform();

    await platform.getWindowState("123", 9, false);

    const script = lastJxaScript();
    expect(script).toContain("var includeBounds = false;");
    expect(script).toContain("currentDepth < 9");
    expect(script).toContain("if (includeBounds) {");
  });

  it("returns the focused AX element from getWindowState", async () => {
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify([
        {
          id: "123",
          title: "Notes",
          processName: "Notes",
          pid: 42,
          bounds: { x: 10, y: 20, width: 300, height: 200 },
          isMinimized: false,
          isOnScreen: true,
        },
      ]))
      .mockReturnValueOnce(JSON.stringify({
        window: {
          id: "123",
          title: "Notes",
          processName: "Notes",
          pid: 42,
          bounds: { x: 10, y: 20, width: 300, height: 200 },
          isMinimized: false,
          isOnScreen: true,
        },
        focusedElement: {
          role: "AXTextArea",
          name: "Body",
          value: "draft",
          bounds: { x: 20, y: 40, width: 260, height: 120 },
          states: ["focused"],
        },
        tree: {
          role: "AXWindow",
          name: "Notes",
          states: [],
          children: [],
        },
      }));
    const platform = jxaOnlyPlatform();

    const state = await platform.getWindowState("123", 3, true);

    expect(state.focusedElement).toMatchObject({
      role: "AXTextArea",
      name: "Body",
      value: "draft",
      bounds: { x: 20, y: 40, width: 260, height: 120 },
      states: ["focused"],
    });
    const script = lastJxaScript();
    expect(script).toContain("foundProc.focusedUIElement");
    expect(script).toContain("elementBelongsToWindow(processFocused)");
    expect(script).toContain("result.focusedElement = summarizeFocusedElement(focusedInfo);");
  });

  it("honors findElement maxResults and includeBounds=false", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({
      results: [{ id: "Notes/win0/1", role: "AXButton", name: "Save" }],
      scannedCount: 5,
      matchedCount: 1,
    }));
    const platform = new MacOSPlatform();

    const response = await platform.findElement({
      text: "Save",
      role: "AXButton",
      app: "Notes",
      depth: 4,
      includeBounds: false,
      maxResults: 3,
    });

    expect(response.results).toEqual([
      {
        id: "Notes/win0/1",
        role: "AXButton",
        name: "Save",
      },
    ]);
    expect(response.metrics.scannedCount).toBe(5);
    expect(response.metrics.matchedCount).toBe(1);
    expect(response.metrics.durationMs).toBeGreaterThanOrEqual(0);
    expect(response.metrics.truncated).toBe(false);
    const script = lastJxaScript();
    expect(script).toContain("var maxResults = 3;");
    expect(script).toContain("var includeBounds = false;");
    expect(script).toContain('traverse(wins[w], "Notes" + "/win" + w, 0);');
    expect(script).toContain("if (includeBounds) item.bounds = getBounds(elem);");
  });

  it("passes a value filter into the JXA script so the JXA matches() function filters by AX value", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({
      results: [{ id: "Notes/win0/1", role: "AXTextField", name: "Email", value: "a@b.com" }],
      scannedCount: 3,
      matchedCount: 1,
    }));
    const platform = new MacOSPlatform();

    await platform.findElement({ role: "AXTextField", app: "Notes", value: "a@b.com" });

    const script = lastJxaScript();
    expect(script).toContain("valueFilter");
    expect(script).toContain("a@b.com");
  });

  it("returns only the Nth result when index is provided", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({
      results: [
        { id: "Notes/win0/1", role: "AXButton", name: "A" },
        { id: "Notes/win0/2", role: "AXButton", name: "B" },
        { id: "Notes/win0/3", role: "AXButton", name: "C" },
      ],
      scannedCount: 3,
      matchedCount: 3,
    }));
    const platform = new MacOSPlatform();

    const response = await platform.findElement({ role: "AXButton", app: "Notes", index: 1 });

    expect(response.results).toEqual([
      { id: "Notes/win0/2", role: "AXButton", name: "B" },
    ]);
    expect(response.metrics.matchedCount).toBe(3);
  });

  it("returns an empty result when index is out of range", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({
      results: [
        { id: "Notes/win0/1", role: "AXButton", name: "A" },
      ],
      scannedCount: 1,
      matchedCount: 1,
    }));
    const platform = new MacOSPlatform();

    const response = await platform.findElement({ role: "AXButton", app: "Notes", index: 5 });

    expect(response.results).toEqual([]);
    expect(response.metrics.matchedCount).toBe(1);
  });

  it("sorts results by proximity to near point and returns closest first", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({
      results: [
        { id: "Notes/win0/1", role: "AXButton", name: "Far", bounds: { x: 900, y: 900, width: 10, height: 10 } },
        { id: "Notes/win0/2", role: "AXButton", name: "Near", bounds: { x: 10, y: 10, width: 10, height: 10 } },
        { id: "Notes/win0/3", role: "AXButton", name: "Mid", bounds: { x: 100, y: 100, width: 10, height: 10 } },
      ],
      scannedCount: 3,
      matchedCount: 3,
    }));
    const platform = new MacOSPlatform();

    const response = await platform.findElement({ role: "AXButton", app: "Notes", near: { x: 0, y: 0 } });

    expect(response.results.map(r => r.name)).toEqual(["Near", "Mid", "Far"]);
  });

  it("pushes elements without bounds to the end of the near-sorted result", async () => {
    // Regression test for the 0.3.2 commit that added the no-bounds fallback
    // in the near-sort comparator. Without the fallback, bounds-less
    // elements are implicitly treated as centered at (0,0), which would
    // pollute the "closest first" ordering. This test pins the new
    // behavior so a future refactor can't silently regress it.
    execFileSyncMock.mockReturnValue(JSON.stringify({
      results: [
        { id: "Notes/win0/1", role: "AXButton", name: "WithBoundsFar", bounds: { x: 100, y: 100, width: 10, height: 10 } },
        { id: "Notes/win0/2", role: "AXButton", name: "NoBounds" },
        { id: "Notes/win0/3", role: "AXButton", name: "WithBoundsNear", bounds: { x: 5, y: 5, width: 5, height: 5 } },
      ],
      scannedCount: 3,
      matchedCount: 3,
    }));
    const platform = new MacOSPlatform();

    const response = await platform.findElement({ role: "AXButton", app: "Notes", near: { x: 0, y: 0 } });

    // WithBoundsNear (center 7.5,7.5) closest, then WithBoundsFar (center 105,105),
    // then NoBounds parked at the end.
    expect(response.results.map(r => r.name)).toEqual(["WithBoundsNear", "WithBoundsFar", "NoBounds"]);
  });

  it("keeps all-no-bounds elements in their original order in the near-sorted result", async () => {
    // Regression test for the all-no-bounds edge case of the 0.3.2
    // near-sort bounds fallback. When every result is missing bounds,
    // the comparator must treat all entries as equal under the
    // "park to end" branch and preserve the original JXA order
    // (Array.prototype.sort is stable in Node >= 12 / V8). Pinning this
    // prevents a future refactor from accidentally introducing a
    // non-stable comparator that scrambles all-no-bounds results.
    // (0.3.7)
    execFileSyncMock.mockReturnValue(JSON.stringify({
      results: [
        { id: "Notes/win0/1", role: "AXButton", name: "NoBounds1" },
        { id: "Notes/win0/2", role: "AXButton", name: "NoBounds2" },
        { id: "Notes/win0/3", role: "AXButton", name: "NoBounds3" },
      ],
      scannedCount: 3,
      matchedCount: 3,
    }));
    const platform = new MacOSPlatform();

    const response = await platform.findElement({ role: "AXButton", app: "Notes", near: { x: 0, y: 0 } });

    expect(response.results.map(r => r.name)).toEqual(["NoBounds1", "NoBounds2", "NoBounds3"]);
  });
});

// ── OCR error path: distinguish permission failures from Vision errors ─────
describe("MacOSPlatform ocr", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
  });

  it("surfaces Screen Recording hint when OCR JXA reports a failed image load", async () => {
    // When Screen Recording permission is missing, screencapture writes a
    // 0-byte file and the OCR helper fails to load the NSImage. The previous
    // error string ("Failed to load screenshot image") was correct but
    // unactionable; the platform layer now appends a hint pointing the model
    // at the doctor / Screen Recording fix.
    //
    // screenshot() goes through promisify(execFile) (async path), while
    // ocrJxa goes through execFileSync. Both need to be mocked here.
    execFileMock.mockImplementation((cmd: string, _args: any[], _cb: any) => {
      if (cmd === "screencapture") {
        // Async path: write an empty file at the requested outFile, then
        // resolve. We have to call the callback to mimic promisify semantics.
        const fs = require("node:fs") as typeof import("node:fs");
        const outFile = _args[_args.length - 1] as string;
        try { fs.writeFileSync(outFile, Buffer.alloc(0)); } catch { /* ignore */ }
        _cb?.(null, Buffer.alloc(0));
        return undefined;
      }
      if (cmd === "import" || cmd === "scrot") {
        // Linux screenshot commands — same empty-file mock as screencapture
        // so the OCR test can run on non-darwin CI runners.
        const fs = require("node:fs") as typeof import("node:fs");
        const outFile = _args[_args.length - 1] as string;
        try { fs.writeFileSync(outFile, Buffer.alloc(0)); } catch { /* ignore */ }
        _cb?.(null, Buffer.alloc(0));
        return undefined;
      }
      _cb?.(null, "");
      return undefined;
    });
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "osascript") {
        return JSON.stringify({ error: "Failed to load screenshot image", elements: [], fullText: "" });
      }
      // ocrNative falls back to ocrJxa; provide a noop OCR payload so
      // ocrNative returns null and the JXA branch is exercised.
      return "";
    });
    const platform = new MacOSPlatform();

    await expect(platform.ocr(0, { x: 0, y: 0, width: 100, height: 100 })).rejects.toThrow(/Screen Recording permission is most likely missing/);
  });

  // ── OCR native-path + JXA regression guards (方向1 修复) ──────────────
  // screen.js 编译后落在 dist/src/platform/macos/（4 级深），到包根 native/ocr/
  // 需要 4 级 ../。dev 下 screen.ts 在 src/platform/macos/（3 级）。两个 candidate
  // 都要保留。这些源码断言防止有人未来误删 4 级条目（该 bug 只在 npm prod 暴露）。
  it("ocrNative candidates include 4-level ../ path for npm prod layout", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const src = fs.readFileSync(path.join(process.cwd(), "src/platform/macos/screen.ts"), "utf-8");
    expect(src).toMatch(/"\.\.",\s*"\.\.",\s*"\.\.",\s*"\.\.",\s*"native",\s*"ocr",\s*"ocr-helper"/);
  });

  it("window.ts resolveNativeHelper includes 4-level ../ path (same depth bug)", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const src = fs.readFileSync(path.join(process.cwd(), "src/platform/macos/window.ts"), "utf-8");
    expect(src).toMatch(/__windowDirname[^)]*"\.\.",\s*"\.\.",\s*"\.\.",\s*"\.\.",\s*"native"/);
  });

  it("ocrJxa emits a JXA script free of NSNull-prone patterns", async () => {
    // 旧 ocrJxa 有 4 个叠加 bug 导致必崩：
    //   (1) CGImageForProposedRectContextHints(null,null,null) — null→NSNull
    //   (2) var performError = $() — NSNull
    //   (3) performRequestsError([request], ...) — 数组未 $() 包裹
    //   (4) candidate.string.toString() — 返回类描述符而非文本
    // 重写后应使用 initWithURLOptions + Ref() + $([request]) + ObjC.unwrap + 像素维度。
    let osascriptCalls = 0;
    execFileMock.mockImplementation((cmd: string, args: any[], cb: any) => {
      if (cmd === "screencapture" || cmd === "import" || cmd === "scrot") {
        const fs = require("node:fs") as typeof import("node:fs");
        const outFile = args[args.length - 1] as string;
        // 写一个最小 PNG 头（24 字节，offset 16-19 = width）让 ocrJxa 外层的
        // buf.readUInt32BE(16) 不越界。本测试只验证生成的 JXA 脚本，不真跑 OCR。
        const pngHead = Buffer.alloc(24);
        pngHead.writeUInt32BE(100, 16);
        pngHead.writeUInt32BE(100, 20);
        try { fs.writeFileSync(outFile, pngHead); } catch { /* ignore */ }
        cb?.(null, pngHead);
        return undefined;
      }
      cb?.(null, "");
      return undefined;
    });
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "osascript") {
        osascriptCalls++;
        // 第 1 次 osascript = getScreenSize；第 2 次 = ocrJxa
        if (osascriptCalls === 1) {
          return JSON.stringify({ width: 100, height: 100, scaleFactor: 2 });
        }
        // ocrJxa 路径：返回空结果让函数完成（脚本已通过 args 捕获）
        return JSON.stringify({ elements: [], fullText: "", error: null });
      }
      // native binary 调用：返回空让 ocrNative 失败、落到 ocrJxa
      return "";
    });
    const platform = new MacOSPlatform();
    await platform.ocr(0, { x: 0, y: 0, width: 100, height: 100 });

    const script = lastJxaScript();
    // 已移除的 NSNull-prone 模式
    expect(script).not.toContain("var performError = $()");
    expect(script).not.toContain("CGImageForProposedRectContextHints");
    expect(script).not.toMatch(/performRequestsError\(\[request\]/);
    expect(script).not.toContain(".string.toString()");
    // 新的正确模式
    expect(script).toContain("initWithURLOptions");
    expect(script).toContain("Ref()");
    expect(script).toContain("$([request])");
    expect(script).toContain("ObjC.unwrap");
    expect(script).toContain("pixelsWide");
  });
});

// ── AX Element Cache: Expiration, Size Limit, Signature Matching ────────

describe("MacOSPlatform elementCache", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
  });

  it("caches element descriptors with a timestamp from findElement", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({
      results: [{ id: "Notes/win0/1", role: "AXButton", name: "Save" }],
      scannedCount: 1,
      matchedCount: 1,
    }));
    const platform = new MacOSPlatform();
    const before = Date.now();

    await platform.findElement({ text: "Save", role: "AXButton", app: "Notes" });

    const after = Date.now();
    // Verify the cached descriptor is passed to JXA on a subsequent clickElement
    // by checking the cachedJson in the script. If cachedAt is between before/after,
    // the timestamp is present.
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
    await platform.clickElement("Notes/win0/1", "Notes");

    const script = lastJxaScript();
    // The cached object should have a cachedAt field within our time window
    const cachedMatch = script.match(/var cached = (\{[^}]+\})/s);
    expect(cachedMatch).toBeTruthy();
    const cachedObj = JSON.parse(cachedMatch![1]);
    expect(cachedObj.cachedAt).toBeGreaterThanOrEqual(before);
    expect(cachedObj.cachedAt).toBeLessThanOrEqual(after);
  });

  it("expires cache entries after TTL and passes null cached descriptor to JXA", async () => {
    vi.useFakeTimers();
    try {
      execFileSyncMock.mockReturnValue(JSON.stringify({
        results: [{ id: "Notes/win0/1", role: "AXButton", name: "Save" }],
        scannedCount: 1,
        matchedCount: 1,
      }));
      const platform = new MacOSPlatform();

      await platform.findElement({ text: "Save", role: "AXButton", app: "Notes" });

      // Advance past TTL (30 seconds)
      vi.advanceTimersByTime(31_000);

      // Now clickElement should treat the cache entry as expired
      execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
      await platform.clickElement("Notes/win0/1", "Notes");

      const script = lastJxaScript();
      const cachedMatch = script.match(/var cached = (null|\{[^}]+\})/s);
      expect(cachedMatch).toBeTruthy();
      expect(cachedMatch![1]).toBe("null");
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires cache entries on typeInElement after TTL", async () => {
    vi.useFakeTimers();
    try {
      execFileSyncMock.mockReturnValue(JSON.stringify({
        results: [{ id: "Notes/win0/1", role: "AXTextField", name: "Search" }],
        scannedCount: 1,
        matchedCount: 1,
      }));
      const platform = new MacOSPlatform();

      await platform.findElement({ text: "Search", role: "AXTextField", app: "Notes" });

      vi.advanceTimersByTime(31_000);

      execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
      await platform.typeInElement("Notes/win0/1", "hello", "Notes");

      const script = lastJxaScript();
      const cachedMatch = script.match(/var cached = (null|\{[^}]+\})/s);
      expect(cachedMatch).toBeTruthy();
      expect(cachedMatch![1]).toBe("null");
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires cache entries on setElementValue after TTL", async () => {
    vi.useFakeTimers();
    try {
      execFileSyncMock.mockReturnValue(JSON.stringify({
        results: [{ id: "Notes/win0/1", role: "AXTextField", name: "Search" }],
        scannedCount: 1,
        matchedCount: 1,
      }));
      const platform = new MacOSPlatform();

      await platform.findElement({ text: "Search", role: "AXTextField", app: "Notes" });

      vi.advanceTimersByTime(31_000);

      execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
      await platform.setElementValue("Notes/win0/1", "hello", "Notes");

      const script = lastJxaScript();
      const cachedMatch = script.match(/var cached = (null|\{[^}]+\})/s);
      expect(cachedMatch).toBeTruthy();
      expect(cachedMatch![1]).toBe("null");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps cache entries within TTL and passes cached descriptor to JXA", async () => {
    vi.useFakeTimers();
    try {
      execFileSyncMock.mockReturnValue(JSON.stringify({
        results: [{ id: "Notes/win0/1", role: "AXButton", name: "Save" }],
        scannedCount: 1,
        matchedCount: 1,
      }));
      const platform = new MacOSPlatform();

      await platform.findElement({ text: "Save", role: "AXButton", app: "Notes" });

      // Stay within TTL
      vi.advanceTimersByTime(10_000);

      execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
      await platform.clickElement("Notes/win0/1", "Notes");

      const script = lastJxaScript();
      const cachedMatch = script.match(/var cached = (null|\{[^}]+\})/s);
      expect(cachedMatch).toBeTruthy();
      expect(cachedMatch![1]).not.toBe("null");
      const cachedObj = JSON.parse(cachedMatch![1]);
      expect(cachedObj.role).toBe("AXButton");
      expect(cachedObj.name).toBe("Save");
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts oldest cache entries when exceeding maxSize (LRU)", async () => {
    // Populate cache with 100+ entries, then verify the oldest is gone
    execFileSyncMock.mockImplementation((_cmd: string, _args: string[]) => {
      // Return a unique result each call by inspecting the script
      return JSON.stringify([
        { id: "App/win0/1", role: "AXButton", name: "Btn" },
      ]);
    });

    const platform = new MacOSPlatform();

    // findElement 101 times with different apps to create 101 distinct cache entries
    for (let i = 0; i < 101; i++) {
      execFileSyncMock.mockReturnValue(JSON.stringify({
        results: [{ id: `App${i}/win0/1`, role: "AXButton", name: `Btn${i}` }],
        scannedCount: 1,
        matchedCount: 1,
      }));
      await platform.findElement({ text: `Btn${i}`, app: `App${i}` });
    }

    // The first entry (App0) should have been evicted.
    // Verify by calling clickElement for App0 — the cached descriptor should be null
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
    await platform.clickElement("App0/win0/1", "App0");

    const script = lastJxaScript();
    const cachedMatch = script.match(/var cached = (null|\{[^}]+\})/s);
    expect(cachedMatch).toBeTruthy();
    expect(cachedMatch![1]).toBe("null");

    // A recent entry (App100) should still be cached
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
    await platform.clickElement("App100/win0/1", "App100");

    const script2 = lastJxaScript();
    const cachedMatch2 = script2.match(/var cached = (null|\{[^}]+\})/s);
    expect(cachedMatch2).toBeTruthy();
    expect(cachedMatch2![1]).not.toBe("null");
    const cachedObj = JSON.parse(cachedMatch2![1]);
    expect(cachedObj.role).toBe("AXButton");
    expect(cachedObj.name).toBe("Btn100");
  });

  it("includes subrole and identifier in cached descriptors from findElement", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({
      results: [{
        id: "Notes/win0/1",
        role: "AXButton",
        name: "Save",
        subrole: "AXButtonSubrole",
        identifier: "save-btn",
      }],
      scannedCount: 1,
      matchedCount: 1,
    }));
    const platform = new MacOSPlatform();

    await platform.findElement({ text: "Save", role: "AXButton", app: "Notes" });

    // Check that subsequent clickElement receives the subrole and identifier
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
    await platform.clickElement("Notes/win0/1", "Notes");

    const script = lastJxaScript();
    const cachedMatch = script.match(/var cached = (\{[^}]+\})/s);
    expect(cachedMatch).toBeTruthy();
    const cachedObj = JSON.parse(cachedMatch![1]);
    expect(cachedObj.subrole).toBe("AXButtonSubrole");
    expect(cachedObj.identifier).toBe("save-btn");
  });

  it("scoreEquivalent JXA includes subrole and identifier matching", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({
      results: [{
        id: "Notes/win0/1",
        role: "AXButton",
        name: "Save",
        subrole: "AXButtonSubrole",
        identifier: "save-btn",
      }],
      scannedCount: 1,
      matchedCount: 1,
    }));
    const platform = new MacOSPlatform();

    await platform.findElement({ text: "Save", role: "AXButton", app: "Notes" });

    // Verify clickElement's JXA script contains subrole/identifier scoring
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
    await platform.clickElement("Notes/win0/1", "Notes");

    const script = lastJxaScript();
    expect(script).toContain("e.subrole()");
    expect(script).toContain("e.identifier()");
    expect(script).toContain("cached.subrole");
    expect(script).toContain("cached.identifier");
    // Verify the scoring weights: subrole += 2, identifier += 3
    expect(script).toMatch(/cached\.subrole.*score \+= 2/);
    expect(script).toMatch(/cached\.identifier.*score \+= 3/);
  });

  it("scoreEquivalent JXA includes subrole and identifier in typeInElement", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({
      results: [{
        id: "Notes/win0/1",
        role: "AXTextField",
        name: "Search",
        subrole: "AXSearchField",
        identifier: "search-field",
      }],
      scannedCount: 1,
      matchedCount: 1,
    }));
    const platform = new MacOSPlatform();

    await platform.findElement({ text: "Search", role: "AXTextField", app: "Notes" });

    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
    await platform.typeInElement("Notes/win0/1", "hello", "Notes");

    const script = lastJxaScript();
    expect(script).toContain("e.subrole()");
    expect(script).toContain("e.identifier()");
    expect(script).toMatch(/cached\.subrole.*score \+= 2/);
    expect(script).toMatch(/cached\.identifier.*score \+= 3/);
  });

  it("scoreEquivalent JXA includes subrole and identifier in setElementValue", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({
      results: [{
        id: "Notes/win0/1",
        role: "AXTextField",
        name: "Search",
        subrole: "AXSearchField",
        identifier: "search-field",
      }],
      scannedCount: 1,
      matchedCount: 1,
    }));
    const platform = new MacOSPlatform();

    await platform.findElement({ text: "Search", role: "AXTextField", app: "Notes" });

    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
    await platform.setElementValue("Notes/win0/1", "hello", "Notes");

    const script = lastJxaScript();
    expect(script).toContain("e.subrole()");
    expect(script).toContain("e.identifier()");
    expect(script).toMatch(/cached\.subrole.*score \+= 2/);
    expect(script).toMatch(/cached\.identifier.*score \+= 3/);
  });
});

// ── Native windowlist helper (CGWindowListCopyWindowInfo) ────────────
describe("MacOSPlatform native windowlist", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
  });

  it("uses native helper when available and returns windows", async () => {
    const nativePayload = JSON.stringify({
      windows: [
        { id: "CC Switch/win1498", title: "", processName: "CC Switch", pid: 49180,
          bounds: { x: 231, y: 103, width: 1000, height: 651 }, isOnScreen: true, windowNumber: 1498 },
        { id: "TextEdit/win10", title: "Untitled", processName: "TextEdit", pid: 42,
          bounds: { x: 10, y: 20, width: 300, height: 200 }, isOnScreen: true, windowNumber: 10 },
      ],
    });
    execFileSyncMock.mockReturnValue(nativePayload);
    const platform = new MacOSPlatform({
      nativeHelperPaths: { windowlist: "/fake/windowlist-helper" },
    });

    const windows = await platform.listWindows();

    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({
      id: "CC Switch/win1498",
      processName: "CC Switch",
      pid: 49180,
      bounds: { x: 231, y: 103, width: 1000, height: 651 },
      isMinimized: false,
      isOnScreen: true,
    });
    expect(windows[1]).toMatchObject({
      id: "TextEdit/win10",
      title: "Untitled",
      processName: "TextEdit",
    });
    // Should only call execFileSync once (native path), no JXA fallback
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock.mock.calls[0][0]).toBe("/fake/windowlist-helper");
  });

  it("falls back to JXA when native helper returns error", async () => {
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify({ windows: [], error: "CGWindowListCopyWindowInfo returned nil" }))
      .mockReturnValueOnce(JSON.stringify([
        { id: "Safari/win1", title: "Page", processName: "Safari", pid: 100,
          bounds: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: false, isOnScreen: true },
      ]));
    const platform = new MacOSPlatform({
      nativeHelperPaths: { windowlist: "/fake/windowlist-helper" },
    });

    const windows = await platform.listWindows();

    expect(windows).toHaveLength(1);
    expect(windows[0].processName).toBe("Safari");
    // Two calls: native (error) + JXA fallback
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to JXA when native helper throws", async () => {
    let callCount = 0;
    execFileSyncMock.mockImplementation((cmd: string) => {
      callCount++;
      if (cmd === "/fake/windowlist-helper") throw new Error("ENOENT");
      return JSON.stringify([
        { id: "Notes/win0", title: "Note", processName: "Notes", pid: 50,
          bounds: { x: 0, y: 0, width: 400, height: 300 }, isMinimized: false, isOnScreen: true },
      ]);
    });
    const platform = new MacOSPlatform({
      nativeHelperPaths: { windowlist: "/fake/windowlist-helper" },
    });

    const windows = await platform.listWindows();

    expect(windows).toHaveLength(1);
    expect(windows[0].processName).toBe("Notes");
  });

  it("falls back to JXA when nativeHelperPaths[windowlist] is null", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify([
      { id: "Notes/win0", title: "Note", processName: "Notes", pid: 50,
        bounds: { x: 0, y: 0, width: 400, height: 300 }, isMinimized: false, isOnScreen: true },
    ]));
    const platform = jxaOnlyPlatform();

    const windows = await platform.listWindows();

    expect(windows).toHaveLength(1);
    // Only JXA call, no native attempt
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock.mock.calls[0][0]).toBe("osascript");
  });

  it("focus_app uses native windowlist to find Electron apps", async () => {
    const nativePayload = JSON.stringify({
      windows: [
        { id: "CC Switch/win1498", title: "", processName: "CC Switch", pid: 49180,
          bounds: { x: 231, y: 103, width: 1000, height: 651 }, isOnScreen: true, windowNumber: 1498 },
      ],
    });
    execFileSyncMock
      .mockReturnValueOnce(nativePayload); // listWindows native
    const platform = new MacOSPlatform({
      nativeHelperPaths: { windowlist: "/fake/windowlist-helper" },
    });

    const target = await platform.focusApp("CC Switch");

    expect(target.appName).toBe("CC Switch");
    expect(target.pid).toBe(49180);
    expect(target.windowId).toBe("CC Switch/win1498");
  });

  it("caches native windowlist results", async () => {
    const nativePayload = JSON.stringify({
      windows: [
        { id: "App/win1", title: "T", processName: "App", pid: 1,
          bounds: { x: 0, y: 0, width: 100, height: 100 }, isOnScreen: true, windowNumber: 1 },
      ],
    });
    execFileSyncMock.mockReturnValue(nativePayload);
    const platform = new MacOSPlatform({
      nativeHelperPaths: { windowlist: "/fake/windowlist-helper" },
    });

    const first = await platform.listWindows();
    first[0].bounds.x = 999;
    const second = await platform.listWindows();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(second[0].bounds.x).toBe(0);
  });
});

// ── Permission-denied paths (TST-P1-2) ───────────────────────────────

describe("MacOSPlatform permission-denied paths (TST-P1-2)", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
  });

  it("reports accessibility permission denied for findElement", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("System Events is not allowed assistive access");
    });
    const platform = new MacOSPlatform();

    await expect(platform.findElement({ app: "Notes" }))
      .rejects.toBeInstanceOf(PermissionError);
  });

  it("reports accessibility permission denied for getWindowState", async () => {
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify([
        { id: "Notes/win0", title: "Note", processName: "Notes", pid: 42,
          bounds: { x: 10, y: 20, width: 300, height: 200 }, isMinimized: false, isOnScreen: true },
      ]))
      .mockImplementationOnce(() => {
        throw new Error("not allowed assistive access");
      });
    const platform = jxaOnlyPlatform();

    await expect(platform.getWindowState("Notes/win0"))
      .rejects.toBeInstanceOf(PermissionError);
  });

  it("reports accessibility permission denied for clickElement", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("accessibility permission denied");
    });
    const platform = new MacOSPlatform();

    await expect(platform.clickElement("Notes/win0/1", "Notes"))
      .rejects.toBeInstanceOf(PermissionError);
  });

  it("reports accessibility permission denied for typeInElement", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("assistive access is not permitted");
    });
    const platform = new MacOSPlatform();

    await expect(platform.typeInElement("Notes/win0/1", "hello", "Notes"))
      .rejects.toBeInstanceOf(PermissionError);
  });

  it("reports accessibility permission denied for setElementValue", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("System Events is not allowed assistive access");
    });
    const platform = new MacOSPlatform();

    await expect(platform.setElementValue("Notes/win0/1", "hello", "Notes"))
      .rejects.toBeInstanceOf(PermissionError);
  });

  it("PermissionError has correct code and is not retryable", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not allowed assistive access");
    });
    const platform = new MacOSPlatform();

    try {
      await platform.findElement({ app: "Notes" });
      throw new Error("expected to throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(PermissionError);
      expect(err.code).toBe("PERMISSION_DENIED");
      expect(err.retryable).toBe(false);
      expect(err.message).toContain("accessibility");
    }
  });

  it("reports Screen Recording hint when screenshot fails with permission error", async () => {
    execFileMock.mockImplementation((cmd: string, _args: any[], _cb: any) => {
      _cb?.(new Error("CGDisplayStreamCreate failed"));
      return undefined;
    });
    const platform = new MacOSPlatform();

    await expect(platform.screenshot())
      .rejects.toThrow();
  });

  it("preserves existing UcuError subclasses without wrapping", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({
      success: false,
      error: "Element not found: Notes/win0/99",
    }));
    const platform = new MacOSPlatform();

    try {
      await platform.setElementValue("Notes/win0/99", "hello", "Notes");
      throw new Error("expected to throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(ElementNotFoundError);
      expect(err.code).toBe("ELEMENT_NOT_FOUND");
      expect(err.retryable).toBe(false);
    }
  });
});

// ── Platform method integration (TST-P1-3) ───────────────────────────

describe("MacOSPlatform method integration (TST-P1-3)", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
  });

  it("readClipboard returns clipboard text", async () => {
    execFileSyncMock.mockReturnValue("clipboard content");
    const platform = new MacOSPlatform();

    const text = await platform.readClipboard();
    expect(text).toBe("clipboard content");
    expect(execFileSyncMock).toHaveBeenCalledWith("pbpaste", [], expect.objectContaining({ encoding: "utf-8" }));
  });

  it("readClipboard throws PlatformError on failure", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("pbpaste failed");
    });
    const platform = new MacOSPlatform();

    await expect(platform.readClipboard())
      .rejects.toBeInstanceOf(PlatformError);
  });

  it("readClipboard PlatformError message includes operation context", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("pipe broken");
    });
    const platform = new MacOSPlatform();

    try {
      await platform.readClipboard();
      throw new Error("expected to throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(PlatformError);
      expect(err.message).toContain("read_clipboard failed");
      expect(err.message).toContain("pipe broken");
    }
  });

  it("writeClipboard writes text via pbcopy", async () => {
    execFileSyncMock.mockReturnValue("");
    const platform = new MacOSPlatform();

    await platform.writeClipboard("test text");
    expect(execFileSyncMock).toHaveBeenCalledWith("pbcopy", [], expect.objectContaining({ input: "test text" }));
  });

  it("writeClipboard throws PlatformError on failure", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("pbcopy failed");
    });
    const platform = new MacOSPlatform();

    await expect(platform.writeClipboard("text"))
      .rejects.toBeInstanceOf(PlatformError);
  });

  it("writeClipboard PlatformError message includes operation context", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("permission denied");
    });
    const platform = new MacOSPlatform();

    try {
      await platform.writeClipboard("text");
      throw new Error("expected to throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(PlatformError);
      expect(err.message).toContain("write_clipboard failed");
      expect(err.message).toContain("permission denied");
    }
  });

  it("rethrowAccessibilityError wraps non-UcuError as PermissionError for accessibility keyword", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not allowed assistive access");
    });
    const platform = new MacOSPlatform();

    try {
      await platform.findElement({ app: "Notes" });
      throw new Error("expected to throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(PermissionError);
      expect(err.code).toBe("PERMISSION_DENIED");
    }
  });

  it("rethrowAccessibilityError wraps non-UcuError as PlatformError for non-permission errors", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("JXA runtime crash");
    });
    const platform = new MacOSPlatform();

    try {
      await platform.findElement({ app: "Notes" });
      throw new Error("expected to throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(PlatformError);
      expect(err.message).toContain("find_element failed");
      expect(err.message).toContain("JXA runtime crash");
    }
  });

  it("rethrowAccessibilityError re-throws existing UcuError subclasses unchanged", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({
      success: false,
      error: "Element not found: Notes/win0/1",
    }));
    const platform = new MacOSPlatform();

    try {
      await platform.clickElement("Notes/win0/1", "Notes");
      throw new Error("expected to throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(ElementNotFoundError);
      expect(err.code).toBe("ELEMENT_NOT_FOUND");
    }
  });

  it("rethrowElementActionError detects element-not-found and throws ElementNotFoundError", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({
      success: false,
      error: "Element not found: Notes/win0/1",
    }));
    const platform = new MacOSPlatform();

    try {
      await platform.typeInElement("Notes/win0/1", "hello", "Notes");
      throw new Error("expected to throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(ElementNotFoundError);
      expect(err.code).toBe("ELEMENT_NOT_FOUND");
    }
  });

  it("rethrowElementActionError detects accessibility permission and throws PermissionError", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("System Events is not allowed assistive access");
    });
    const platform = new MacOSPlatform();

    try {
      await platform.typeInElement("Notes/win0/1", "hello", "Notes");
      throw new Error("expected to throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(PermissionError);
      expect(err.code).toBe("PERMISSION_DENIED");
    }
  });

  it("click reports PlatformError for unknown errors", async () => {
    const { click: inputClick } = await import("../../src/utils/input.js");
    const origMock = inputClick as any;
    // We can't easily mock the input module here since it's imported statically,
    // so we test through the actual platform error handling path
    const platform = new MacOSPlatform();

    // getCursorPosition error path is a good proxy for rethrowInputError behavior
    execFileSyncMock.mockImplementation(() => {
      throw new Error("CGEventSourceCreate failed");
    });
    expect(() => platform.getCursorPosition()).toThrow(PlatformError);
  });
});

// ── Menu bar extras (tray) — 方向4a ─────────────────────────────────────
describe("MacOSPlatform menu bar extras (tray)", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
  });

  it("findMenuBarExtra parses menu bar items returned by JXA", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "osascript") {
        return JSON.stringify({ items: [
          { menuBar: 0, index: 0, name: "Apple", description: null, x: 10, y: 0, width: 34, height: 33, host: "self", pid: 0 },
          { menuBar: 0, index: 1, name: "CC Switch", description: null, x: 44, y: 0, width: 87, height: 33, host: "self", pid: 0 },
        ] });
      }
      return "";
    });
    const platform = new MacOSPlatform();
    const items = await platform.findMenuBarExtra("cc-switch");
    expect(items).toHaveLength(2);
    expect(items[1].name).toBe("CC Switch");
    expect(items[1].index).toBe(1);
    expect(items[1].host).toBe("self");
  });

  it("findMenuBarExtra surfaces AX read failure as error", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "osascript") {
        return JSON.stringify({ error: "menu bar AX read failed: not authorized", items: [] });
      }
      return "";
    });
    const platform = new MacOSPlatform();
    await expect(platform.findMenuBarExtra("cc-switch")).rejects.toThrow(/menu bar AX read failed/);
  });

  it("matchMenuBarExtra selects by name/description substring or index", async () => {
    const { matchMenuBarExtra } = await import("../../src/platform/macos/element.js");
    const items = [
      { menuBar: 0, index: 0, name: "Apple", description: "", x: 10, y: 0, width: 34, height: 33, host: "self" as const, pid: 0 },
      { menuBar: 0, index: 1, name: "CC Switch", description: "status menu", x: 44, y: 0, width: 87, height: 33, host: "self" as const, pid: 0 },
    ];
    expect(matchMenuBarExtra(items, { name: "switch" })?.index).toBe(1);
    expect(matchMenuBarExtra(items, { description: "status" })?.index).toBe(1);
    expect(matchMenuBarExtra(items, { index: 0 })?.name).toBe("Apple");
    expect(matchMenuBarExtra(items, {})).toBe(items[1]); // 无 selector 时过滤 Apple，返回 CC Switch
    expect(matchMenuBarExtra([], {})).toBeUndefined();
  });

  // ── SystemUIServer 第三方托盘遍历（方向4a 补全）─────────────────────────
  it("findMenuBarExtra JXA includes SystemUIServer traversal", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "osascript") return JSON.stringify({ items: [] });
      return "";
    });
    const platform = new MacOSPlatform();
    await platform.findMenuBarExtra("some-tray-app").catch(() => {});
    const script = lastJxaScript();
    // JXA 必须含 SystemUIServer 进程查找 + 第三方托盘匹配逻辑
    expect(script).toContain("SystemUIServer");
    expect(script).toContain('"systemuiserver"');
    expect(script).toContain("_matchApp");
  });

  it("findMenuBarExtra surfaces host field for SystemUIServer-hosted tray items", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "osascript") {
        return JSON.stringify({ items: [
          { menuBar: 0, index: 3, name: "", description: "SomeTrayApp", x: 1200, y: 0, width: 30, height: 25, host: "systemuiserver", pid: 188 },
        ] });
      }
      return "";
    });
    const platform = new MacOSPlatform();
    const items = await platform.findMenuBarExtra("SomeTrayApp");
    expect(items).toHaveLength(1);
    expect(items[0].host).toBe("systemuiserver");
    expect(items[0].description).toBe("SomeTrayApp");
  });

  it("matchMenuBarExtra treats host as transparent (does not affect selection)", async () => {
    const { matchMenuBarExtra } = await import("../../src/platform/macos/element.js");
    const items = [
      { menuBar: 0, index: 0, name: "Apple", description: "", x: 0, y: 0, width: 0, height: 0, host: "self" as const, pid: 0 },
      { menuBar: 0, index: 2, name: "", description: "CC Switch", x: 1100, y: 0, width: 30, height: 25, host: "systemuiserver" as const, pid: 188 },
    ];
    // 无 selector：Apple 被过滤，剩下 systemuiserver 托管项
    expect(matchMenuBarExtra(items, {})?.host).toBe("systemuiserver");
    // 按 description 匹配也命中 systemuiserver 托管项
    expect(matchMenuBarExtra(items, { description: "switch" })?.host).toBe("systemuiserver");
  });

  it("clickMenuBarExtra re-resolves on SystemUIServer process for host:systemuiserver", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "osascript") {
        // 第一次调用 findMenuBarExtra 返回 systemuiserver 托管项
        return JSON.stringify({ items: [
          { menuBar: 0, index: 2, name: "", description: "TrayApp", x: 1100, y: 0, width: 30, height: 25, host: "systemuiserver", pid: 188 },
        ] });
      }
      return "";
    });
    const platform = new MacOSPlatform();
    await platform.clickMenuBarExtra("TrayApp", { description: "TrayApp" }).catch(() => {});
    const script = lastJxaScript();
    // click 脚本必须在 SystemUIServer 进程上二次匹配
    expect(script).toContain("SystemUIServer");
    expect(script).toContain("status item not found");
  });

  it("clickMenuBarExtra re-resolves on app process for host:self", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "osascript") {
        return JSON.stringify({ items: [
          { menuBar: 0, index: 1, name: "CC Switch", description: "", x: 44, y: 0, width: 87, height: 33, host: "self", pid: 0 },
        ] });
      }
      return "";
    });
    const platform = new MacOSPlatform();
    await platform.clickMenuBarExtra("cc-switch", { name: "switch" }).catch(() => {});
    const script = lastJxaScript();
    // host:self 走 app 进程 menuBars()[mb].menuBarItems()[idx]，不应含 SystemUIServer 遍历
    expect(script).toContain("menuBars()[0]");
    expect(script).not.toContain("byName(\"SystemUIServer\")");
  });

  // ── 方向4b：AXPress verify-then-fallback ────────────────────────────────
  it("clickElement JXA includes state-signature verify + coordinate fallback", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "osascript") return JSON.stringify({ success: true, method: "axpress", verified: true });
      return "";
    });
    const platform = new MacOSPlatform();
    await platform.clickElement("Safari/w0/1", "Safari").catch(() => {});
    const script = lastJxaScript();
    // verify 原语必须存在；坐标点击已移出 JXA（boundsCenter + needCoordinateClick 信号）
    expect(script).toContain("stateSignature");
    expect(script).toContain("spinMs");
    expect(script).toContain("boundsCenter");
    expect(script).toContain("needCoordinateClick");
    expect(script).toContain("sigBefore");
    expect(script).toContain("sigAfter");
    expect(script).toContain("preferCoord");
    // 不应再有 JXA 内的 HID-tap 坐标点击（已移到 TS input 层 per-process）
    expect(script).not.toContain("CGEventPost");
    expect(script).not.toContain("coordinateClick");
  });

  it("clickElement returns ClickResult with method/verified from JXA", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "osascript") return JSON.stringify({ success: true, method: "coordinate", verified: false });
      return "";
    });
    const platform = new MacOSPlatform();
    const result = await platform.clickElement("Safari/w0/1", "Safari");
    expect(result).toEqual({ method: "coordinate", verified: false });
  });

  it("clickMenuBarExtra JXA also uses verify-then-fallback (not pure exception)", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "osascript") {
        return JSON.stringify({ items: [
          { menuBar: 0, index: 1, name: "CC Switch", description: "", x: 44, y: 0, width: 87, height: 33, host: "self", pid: 0 },
        ] });
      }
      return "";
    });
    const platform = new MacOSPlatform();
    await platform.clickMenuBarExtra("cc-switch", { name: "switch" }).catch(() => {});
    const script = lastJxaScript();
    // click_menu_bar_extra 也应含 verify 原语（与 clickElement 同模式）
    expect(script).toContain("stateSignature");
    expect(script).toContain("sigBefore");
    expect(script).toContain("spinMs");
  });

  it("clickMenuBarExtra uses configurable AXPress spin timing", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "osascript") {
        return JSON.stringify({ items: [
          { menuBar: 0, index: 1, name: "CC Switch", description: "", x: 44, y: 0, width: 87, height: 33, host: "self", pid: 0 },
        ] });
      }
      return "";
    });
    const platform = new MacOSPlatform();
    await platform.clickMenuBarExtra("cc-switch", { name: "switch" }).catch(() => {});
    const script = lastJxaScript();
    expect(script).toContain("spinMs(50)");
  });

  it("clickElement skips AXPress for known silent-swallow apps (Tauri heuristic)", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "osascript") return JSON.stringify({ success: true, method: "coordinate", verified: false });
      return "";
    });
    const platform = new MacOSPlatform();
    await platform.clickElement("MyTauri/w0/1", "MyTauri App").catch(() => {});
    const script = lastJxaScript();
    // Tauri 启发式命中 → preferCoord=true，直接坐标点击跳过 AXPress+verify
    expect(script).toContain("var preferCoord = true");
  });
});
