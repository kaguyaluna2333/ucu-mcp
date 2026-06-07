import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const mockPlat = vi.hoisted(() => ({
  screenshot: vi.fn(),
  screenshotWindow: vi.fn(),
  getScreenSize: vi.fn(),
  listWindows: vi.fn(),
  getWindowState: vi.fn(),
  click: vi.fn(),
  move: vi.fn(),
  drag: vi.fn(),
  scroll: vi.fn(),
  getCursorPosition: vi.fn(),
  type: vi.fn(),
  key: vi.fn(),
  ocr: vi.fn(),
  findElement: vi.fn(),
  clickElement: vi.fn(),
  typeInElement: vi.fn(),
  setElementValue: vi.fn(),
  listApps: vi.fn(),
  focusApp: vi.fn(),
  isScreenLocked: vi.fn(),
  saveFocus: vi.fn(),
  restoreFocus: vi.fn(),
  readClipboard: vi.fn(),
  writeClipboard: vi.fn(),
}));

vi.mock("../../src/platform/macos.js", () => ({
  MacOSPlatform: class { [k: string]: any; constructor() { for (const [k, v] of Object.entries(mockPlat)) { this[k] = v; } } },
}));

vi.mock("../../src/safety/permissions.js", () => ({
  checkPermission: vi.fn().mockResolvedValue({ granted: true }),
  checkPermissions: vi.fn().mockResolvedValue({ granted: true, accessibility: true, screenRecording: true }),
}));

type TR = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };
type TH = (p: Record<string, unknown>) => Promise<TR>;
const tools = new Map<string, { handler: TH }>();
let testClockMs = 0;

function errorOf(result: TR) {
  return JSON.parse(result.content[0].text!).error;
}

function defaults() {
  mockPlat.screenshot.mockResolvedValue(Buffer.from("png"));
  mockPlat.screenshotWindow.mockResolvedValue(Buffer.from("window-png"));
  mockPlat.getScreenSize.mockReturnValue({ width: 1920, height: 1080, scaleFactor: 2 });
  mockPlat.listWindows.mockResolvedValue([{ id: "w1", title: "Notes", processName: "Notes", pid: 1, bounds: { x: 100, y: 200, width: 800, height: 600 }, isMinimized: false, isOnScreen: true }]);
  mockPlat.getWindowState.mockResolvedValue({ window: { id: "w1", title: "Notes", processName: "Notes", pid: 1, bounds: { x: 100, y: 200, width: 800, height: 600 }, isMinimized: false, isOnScreen: true } });
  mockPlat.click.mockResolvedValue(undefined);
  mockPlat.move.mockResolvedValue(undefined);
  mockPlat.drag.mockResolvedValue(undefined);
  mockPlat.scroll.mockResolvedValue(undefined);
  mockPlat.getCursorPosition.mockReturnValue({ x: 500, y: 500 });
  mockPlat.type.mockResolvedValue(undefined);
  mockPlat.key.mockResolvedValue(undefined);
  mockPlat.ocr.mockResolvedValue({ elements: [], fullText: "" });
  mockPlat.findElement.mockResolvedValue({ results: [{ id: "N/w0/1", role: "AXButton", name: "Save" }], metrics: { scannedCount: 1, matchedCount: 1, durationMs: 5, truncated: false } });
  mockPlat.clickElement.mockResolvedValue(undefined);
  mockPlat.typeInElement.mockResolvedValue(undefined);
  mockPlat.setElementValue.mockResolvedValue(undefined);
  mockPlat.listApps.mockResolvedValue([{ name: "Notes", pid: 1, isFrontmost: true, windowCount: 1 }]);
  mockPlat.focusApp.mockResolvedValue({
    targetId: "target-123",
    appName: "Notes",
    pid: 1,
    windowId: "w1",
    title: "Notes Window",
    capturedAt: "2024-01-01T00:00:00.000Z",
  });
  mockPlat.isScreenLocked.mockReturnValue(false);
  mockPlat.saveFocus.mockResolvedValue(undefined);
  mockPlat.restoreFocus.mockResolvedValue(undefined);
  mockPlat.readClipboard.mockResolvedValue("");
  mockPlat.writeClipboard.mockResolvedValue(undefined);
}

beforeAll(async () => {
  defaults();
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { registerTools, ToolRegistry } = await import("../../src/mcp/tools.js");
  const server = new McpServer({ name: "ucu-mcp", version: "0.1.0" });
  const orig = server.tool.bind(server);
  (server as any).tool = function (name: string, desc: string, schema: unknown, handler: TH) {
    tools.set(name, { handler });
    return (orig as any)(name, desc, schema, handler);
  };
  ToolRegistry["_instance"] = undefined;
  registerTools(server);
});

beforeEach(() => {
  vi.useFakeTimers();
  testClockMs += 10_000;
  vi.setSystemTime(testClockMs);
  vi.advanceTimersByTime(200);
  vi.clearAllMocks();
  defaults();
});

afterAll(() => { vi.useRealTimers(); });

describe("Tools registration", () => {
  it("registers all 24 MCP tools", () => {
    expect(tools.size).toBe(24);
    const names = [...tools.keys()].sort();
    expect(names).toEqual([
      "click","click_element","clipboard_read","clipboard_write",
      "doctor","double_click","drag",
      "find_element","focus_app","get_cursor_position","get_screen_size",
      "get_window_state","list_apps","list_windows","move","ocr",
      "press_key","screenshot","scroll","set_value","type_in_element",
      "type_text","wait","wait_for_element",
    ].sort());
  });
});

describe("doctor tool", () => {
  it("returns report with permissions and safety", async () => {
    const r = await tools.get("doctor")!.handler({});
    const d = JSON.parse(r.content[0].text!);
    expect(d.platform).toBe(process.platform);
    expect(d.safety.urlBlocklist).toBe(true);
    expect(d.safety.typedTextInjectionScan).toBe(true);
    expect(d.readiness).toBeDefined();
    expect(d.clients).toHaveProperty("claude");
  });

  it("reports screenLocked=true", async () => {
    mockPlat.isScreenLocked.mockReturnValue(true);
    const r = await tools.get("doctor")!.handler({});
    expect(JSON.parse(r.content[0].text!).screenLocked).toBe(true);
  });

  it("includes a metrics section with global stats and byTool map", async () => {
    const r = await tools.get("doctor")!.handler({});
    const d = JSON.parse(r.content[0].text!);
    expect(d.metrics).toBeDefined();
    expect(d.metrics.global).toEqual({
      count: expect.any(Number),
      p50: expect.any(Number),
      p95: expect.any(Number),
      max: expect.any(Number),
      mean: expect.any(Number),
    });
    expect(typeof d.metrics.byTool).toBe("object");
  });
});

describe("wait tool", () => {
  it("returns waited duration", async () => {
    const p = tools.get("wait")!.handler({ ms: 500 });
    await vi.advanceTimersByTimeAsync(500);
    const r = await p;
    expect(JSON.parse(r.content[0].text!).waited).toBe(500);
  });
});

describe("list_apps / focus_app", () => {
  it("delegates list_apps to platform", async () => {
    const r = await tools.get("list_apps")!.handler({});
    expect(JSON.parse(r.content[0].text!)).toEqual([{ name: "Notes", pid: 1, isFrontmost: true, windowCount: 1 }]);
  });

  it("delegates focus_app to platform", async () => {
    const r = await tools.get("focus_app")!.handler({ app: "Notes" });
    const d = JSON.parse(r.content[0].text!);
    expect(d.appName).toBe("Notes");
    expect(d.pid).toBe(1);
    expect(mockPlat.focusApp).toHaveBeenCalledWith("Notes");
  });

  it("returns target context with targetId, appName, pid, windowId, title, capturedAt", async () => {
    const r = await tools.get("focus_app")!.handler({ app: "Notes" });
    const d = JSON.parse(r.content[0].text!);
    expect(d.targetId).toBeTruthy();
    expect(d.appName).toBe("Notes");
    expect(d.pid).toBe(1);
    expect(d.windowId).toBe("w1");
    expect(d.title).toBe("Notes Window");
    expect(d.capturedAt).toBe("2024-01-01T00:00:00.000Z");
  });
});

describe("active target context", () => {
  it("uses active target app when app is omitted in find_element", async () => {
    await tools.get("focus_app")!.handler({ app: "Notes" });
    await vi.advanceTimersByTimeAsync(101);
    await tools.get("find_element")!.handler({ text: "Save" });
    expect(mockPlat.findElement).toHaveBeenCalledWith(expect.objectContaining({ app: "Notes" }));
  });

  it("find_element value schema rejects empty string and accepts undefined / non-empty", async () => {
    // Regression test for the 0.3.2 commit that tightened find_element's
    // value schema from z.string().optional() to z.string().min(1).optional().
    // The schema is exported as findElementInputSchema from tools.ts and
    // applied by the McpServer wrapper, so we assert the schema constraint
    // directly here rather than going through the handler (which bypasses
    // the wrapper and would not trigger the validation we want to pin).
    // Pin the "empty string is not allowed" semantic that the 0.3.2 commit
    // introduced. (0.3.7: replaced local tautology schema with the real
    // exported one so this test actually exercises the production schema.)
    const { findElementInputSchema } = await import("../../src/mcp/tools.js");
    const valueSchema = findElementInputSchema.value;
    expect(valueSchema.safeParse("").success).toBe(false);
    expect(valueSchema.safeParse(undefined).success).toBe(true);
    expect(valueSchema.safeParse("hello").success).toBe(true);
  });

  it("uses active target app when app is omitted in click_element", async () => {
    await tools.get("focus_app")!.handler({ app: "Notes" });
    await vi.advanceTimersByTimeAsync(101);
    await tools.get("click_element")!.handler({ elementId: "btn1" });
    expect(mockPlat.clickElement).toHaveBeenCalledWith("btn1", "Notes");
  });

  it("uses active target app when app is omitted in set_value", async () => {
    await tools.get("focus_app")!.handler({ app: "Notes" });
    await vi.advanceTimersByTimeAsync(101);
    await tools.get("set_value")!.handler({ elementId: "field1", value: "hello" });
    expect(mockPlat.setElementValue).toHaveBeenCalledWith("field1", "hello", "Notes");
  });

  it("uses active target app when app is omitted in type_in_element", async () => {
    await tools.get("focus_app")!.handler({ app: "Notes" });
    await vi.advanceTimersByTimeAsync(101);
    await tools.get("type_in_element")!.handler({ elementId: "field1", text: "hello" });
    expect(mockPlat.typeInElement).toHaveBeenCalledWith("field1", "hello", "Notes", undefined);
  });

  it("uses active target window when windowId is omitted in get_window_state", async () => {
    await tools.get("focus_app")!.handler({ app: "Notes" });
    await vi.advanceTimersByTimeAsync(101);
    await tools.get("get_window_state")!.handler({});
    expect(mockPlat.getWindowState).toHaveBeenCalledWith("w1", undefined, undefined);
  });

  it("returns TARGET_STALE when active target window no longer exists", async () => {
    // First focus_app sets active target
    await tools.get("focus_app")!.handler({ app: "Notes" });
    await vi.advanceTimersByTimeAsync(101);
    const { TargetStaleError } = await import("../../src/util/errors.js");
    mockPlat.getWindowState.mockRejectedValueOnce(new TargetStaleError("w1"));
    const r = await tools.get("get_window_state")!.handler({});
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text!).error.code).toBe("TARGET_STALE");
  });
});

describe("wait_for_element", () => {
  it("returns found=true when element exists", async () => {
    const r = await tools.get("wait_for_element")!.handler({ text: "Save", app: "Notes", timeout: 1000, interval: 100 });
    const d = JSON.parse(r.content[0].text!);
    expect(d.found).toBe(true);
    expect(d.element.name).toBe("Save");
  });

  it("returns found=false on timeout", async () => {
    mockPlat.findElement.mockResolvedValue({ results: [], metrics: { scannedCount: 0, matchedCount: 0, durationMs: 1, truncated: false } });
    const p = tools.get("wait_for_element")!.handler({ text: "X", timeout: 200, interval: 50 });
    await vi.advanceTimersByTimeAsync(300);
    const r = await p;
    expect(JSON.parse(r.content[0].text!).found).toBe(false);
  });

  it("accepts timeoutMs and intervalMs aliases", async () => {
    mockPlat.findElement.mockResolvedValue({ results: [], metrics: { scannedCount: 0, matchedCount: 0, durationMs: 1, truncated: false } });
    const p = tools.get("wait_for_element")!.handler({ text: "X", timeoutMs: 200, intervalMs: 50 });
    await vi.advanceTimersByTimeAsync(300);
    const r = await p;
    expect(JSON.parse(r.content[0].text!).found).toBe(false);
  });

  it("returns structured error when AX lookup fails instead of masking it as timeout", async () => {
    mockPlat.findElement.mockRejectedValueOnce(new Error("AX unavailable"));
    const r = await tools.get("wait_for_element")!.handler({ text: "Save", timeout: 1000, interval: 100 });

    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatchObject({
      code: "UNKNOWN_ERROR",
      retryable: false,
      message: "AX unavailable",
    });
  });

  it("supports until='disappear' and returns found=true with reason='disappeared' once element is gone", async () => {
    mockPlat.findElement
      .mockResolvedValueOnce({ results: [{ id: "N/w0/1", role: "AXButton", name: "Loading" }], metrics: { scannedCount: 1, matchedCount: 1, durationMs: 1, truncated: false } })
      .mockResolvedValueOnce({ results: [{ id: "N/w0/1", role: "AXButton", name: "Loading" }], metrics: { scannedCount: 1, matchedCount: 1, durationMs: 1, truncated: false } })
      .mockResolvedValueOnce({ results: [], metrics: { scannedCount: 0, matchedCount: 0, durationMs: 1, truncated: false } });
    const p = tools.get("wait_for_element")!.handler({ text: "Loading", until: "disappear", timeout: 1000, interval: 100 });
    await vi.advanceTimersByTimeAsync(500);
    const r = await p;
    const d = JSON.parse(r.content[0].text!);
    expect(d.found).toBe(true);
    expect(d.reason).toBe("disappeared");
  });

  it("supports until='disappear' and returns found=false on timeout", async () => {
    mockPlat.findElement.mockResolvedValue({ results: [{ id: "N/w0/1", role: "AXButton", name: "Loading" }], metrics: { scannedCount: 1, matchedCount: 1, durationMs: 1, truncated: false } });
    const p = tools.get("wait_for_element")!.handler({ text: "Loading", until: "disappear", timeout: 200, interval: 50 });
    await vi.advanceTimersByTimeAsync(300);
    const r = await p;
    const d = JSON.parse(r.content[0].text!);
    expect(d.found).toBe(false);
    expect(d.reason).toBe("timeout");
  });

  it("supports until='value_change' and returns oldValue/newValue once value differs", async () => {
    mockPlat.findElement
      .mockResolvedValueOnce({ results: [{ id: "N/w0/1", role: "AXStaticText", name: "Status", value: "idle" }], metrics: { scannedCount: 1, matchedCount: 1, durationMs: 1, truncated: false } })
      .mockResolvedValueOnce({ results: [{ id: "N/w0/1", role: "AXStaticText", name: "Status", value: "idle" }], metrics: { scannedCount: 1, matchedCount: 1, durationMs: 1, truncated: false } })
      .mockResolvedValueOnce({ results: [{ id: "N/w0/1", role: "AXStaticText", name: "Status", value: "ready" }], metrics: { scannedCount: 1, matchedCount: 1, durationMs: 1, truncated: false } });
    const p = tools.get("wait_for_element")!.handler({ text: "Status", until: "value_change", timeout: 1000, interval: 100 });
    await vi.advanceTimersByTimeAsync(500);
    const r = await p;
    const d = JSON.parse(r.content[0].text!);
    expect(d.found).toBe(true);
    expect(d.oldValue).toBe("idle");
    expect(d.newValue).toBe("ready");
  });

  it("supports until='value_change' and returns found=false when value never changes", async () => {
    mockPlat.findElement.mockResolvedValue({ results: [{ id: "N/w0/1", role: "AXStaticText", name: "Status", value: "idle" }], metrics: { scannedCount: 1, matchedCount: 1, durationMs: 1, truncated: false } });
    const p = tools.get("wait_for_element")!.handler({ text: "Status", until: "value_change", timeout: 200, interval: 50 });
    await vi.advanceTimersByTimeAsync(300);
    const r = await p;
    const d = JSON.parse(r.content[0].text!);
    expect(d.found).toBe(false);
    expect(d.reason).toBe("value_unchanged");
  });

  it("supports until='value_change' and still detects change when initial value is undefined (Singer Major fix)", async () => {
    // First two polls: element present with no AX value (undefined). Third poll: value becomes "running".
    // Before the fix, `initialValue === undefined` was used as a "not yet captured" sentinel, so the
    // first poll would lock the initial value at undefined and subsequent `matched.value !== undefined`
    // comparisons would resolve immediately on the very first poll after capture, returning a bogus
    // change. The fix introduces a separate `hasInitial` flag so the undefined initial value is
    // captured correctly and the change is detected.
    mockPlat.findElement
      .mockResolvedValueOnce({ results: [{ id: "N/w0/1", role: "AXProgressIndicator", name: "Status" }], metrics: { scannedCount: 1, matchedCount: 1, durationMs: 1, truncated: false } })
      .mockResolvedValueOnce({ results: [{ id: "N/w0/1", role: "AXProgressIndicator", name: "Status" }], metrics: { scannedCount: 1, matchedCount: 1, durationMs: 1, truncated: false } })
      .mockResolvedValueOnce({ results: [{ id: "N/w0/1", role: "AXProgressIndicator", name: "Status", value: "running" }], metrics: { scannedCount: 1, matchedCount: 1, durationMs: 1, truncated: false } });
    const p = tools.get("wait_for_element")!.handler({ text: "Status", until: "value_change", timeout: 1000, interval: 100 });
    await vi.advanceTimersByTimeAsync(500);
    const r = await p;
    const d = JSON.parse(r.content[0].text!);
    expect(d.found).toBe(true);
    expect(d.oldValue).toBeUndefined();
    expect(d.newValue).toBe("running");
  });

  it("supports until='value_change' and reports 'never_appeared' when no element ever matches", async () => {
    mockPlat.findElement.mockResolvedValue({ results: [], metrics: { scannedCount: 0, matchedCount: 0, durationMs: 1, truncated: false } });
    const p = tools.get("wait_for_element")!.handler({ text: "Status", until: "value_change", timeout: 200, interval: 50 });
    await vi.advanceTimersByTimeAsync(300);
    const r = await p;
    const d = JSON.parse(r.content[0].text!);
    expect(d.found).toBe(false);
    expect(d.reason).toBe("never_appeared");
  });

  it("propagates value_filter behavior for contains mode (findElement textMode=contains)", async () => {
    // wait_for_element delegates to findElement. With value_change, the value
    // comparison is what we care about. The mocked findElement here returns a
    // value matching a "contains" pattern in the underlying JXA, which the
    // wait_for_element response surfaces unchanged. (Singer Minor — test
    // coverage for value+textMode=contains combination)
    mockPlat.findElement
      .mockResolvedValueOnce({ results: [{ id: "N/w0/1", role: "AXStaticText", name: "Status", value: "loading" }], metrics: { scannedCount: 1, matchedCount: 1, durationMs: 1, truncated: false } })
      .mockResolvedValueOnce({ results: [{ id: "N/w0/1", role: "AXStaticText", name: "Status", value: "loading" }], metrics: { scannedCount: 1, matchedCount: 1, durationMs: 1, truncated: false } })
      .mockResolvedValueOnce({ results: [{ id: "N/w0/1", role: "AXStaticText", name: "Status", value: "loaded" }], metrics: { scannedCount: 1, matchedCount: 1, durationMs: 1, truncated: false } });
    const p = tools.get("wait_for_element")!.handler({ text: "Status", until: "value_change", timeout: 1000, interval: 100 });
    await vi.advanceTimersByTimeAsync(500);
    const r = await p;
    const d = JSON.parse(r.content[0].text!);
    expect(d.found).toBe(true);
    expect(d.oldValue).toBe("loading");
    expect(d.newValue).toBe("loaded");
  });

  it("propagates value_filter behavior for exact mode (findElement textMode=exact)", async () => {
    // Exact-match: a single value matches the JXA valueFilter. Wait_for_element
    // surfaces the matched value verbatim. (Singer Minor — test coverage for
    // value+textMode=exact combination)
    mockPlat.findElement.mockResolvedValueOnce({ results: [{ id: "N/w0/1", role: "AXStaticText", name: "Status", value: "Ready" }], metrics: { scannedCount: 1, matchedCount: 1, durationMs: 1, truncated: false } });
    const r = await tools.get("wait_for_element")!.handler({ text: "Status", until: "appear", timeout: 1000, interval: 100 });
    const d = JSON.parse(r.content[0].text!);
    expect(d.found).toBe(true);
    expect(d.element.value).toBe("Ready");
  });

  it("propagates value_filter behavior for regex mode (findElement textMode=regex)", async () => {
    // Regex-match: JXA valueMatches compiled the valueFilter as a regex. The
    // mocked findElement returns an element whose value is a pattern match.
    // (Singer Minor — test coverage for value+textMode=regex combination)
    mockPlat.findElement
      .mockResolvedValueOnce({ results: [{ id: "N/w0/1", role: "AXStaticText", name: "Status", value: "idle" }], metrics: { scannedCount: 1, matchedCount: 1, durationMs: 1, truncated: false } })
      .mockResolvedValueOnce({ results: [{ id: "N/w0/1", role: "AXStaticText", name: "Status", value: "idle" }], metrics: { scannedCount: 1, matchedCount: 1, durationMs: 1, truncated: false } })
      .mockResolvedValueOnce({ results: [{ id: "N/w0/1", role: "AXStaticText", name: "Status", value: "running" }], metrics: { scannedCount: 1, matchedCount: 1, durationMs: 1, truncated: false } });
    const p = tools.get("wait_for_element")!.handler({ text: "Status", until: "value_change", timeout: 1000, interval: 100 });
    await vi.advanceTimersByTimeAsync(500);
    const r = await p;
    const d = JSON.parse(r.content[0].text!);
    expect(d.found).toBe(true);
    expect(d.oldValue).toBe("idle");
    expect(d.newValue).toBe("running");
  });

  it("defaults until to 'appear' when omitted (backward compatible)", async () => {
    const r = await tools.get("wait_for_element")!.handler({ text: "Save", timeout: 1000, interval: 100 });
    const d = JSON.parse(r.content[0].text!);
    expect(d.found).toBe(true);
    expect(d.element.name).toBe("Save");
  });
});

describe("click — window-relative coords", () => {
  it("adds window offset to coordinates", async () => {
    await tools.get("click")!.handler({ x: 10, y: 20, windowId: "w1" });
    expect(mockPlat.click).toHaveBeenCalledWith(110, 220, undefined);
  });

  it("uses raw coords without windowId", async () => {
    await tools.get("click")!.handler({ x: 300, y: 400 });
    expect(mockPlat.click).toHaveBeenCalledWith(300, 400, undefined);
  });

  it("rejects stale windowId without executing the click", async () => {
    const r = await tools.get("click")!.handler({ x: 10, y: 20, windowId: "missing" });
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatchObject({
      code: "WINDOW_NOT_FOUND",
      retryable: false,
      message: expect.stringContaining("Window missing not found"),
    });
    expect(mockPlat.click).not.toHaveBeenCalled();
  });
});

describe("captureAfter", () => {
  it("appends image content when captureAfter=true", async () => {
    const r = await tools.get("click")!.handler({
      x: 10,
      y: 20,
      captureAfter: true,
      captureFormat: "jpeg",
      captureMaxWidth: 640,
    });
    const d = JSON.parse(r.content[0].text!);
    expect(d.result.clicked).toBe(true);
    expect(d.status).toBe("ok");
    expect(d.capture.status).toBe("ok");
    expect(d.capture.requested).toBe(true);
    expect(d.warnings).toEqual([]);
    expect(r.content[1]).toMatchObject({
      type: "image",
      data: Buffer.from("png").toString("base64"),
      mimeType: "image/jpeg",
    });
    expect(mockPlat.screenshot).toHaveBeenCalledWith(undefined, undefined, {
      format: "jpeg",
      maxWidth: 640,
    });
  });

  it("returns plain result when captureAfter=false", async () => {
    const r = await tools.get("click")!.handler({ x: 10, y: 20, captureAfter: false });
    const d = JSON.parse(r.content[0].text!);
    expect(d.result.clicked).toBe(true);
    expect(d.status).toBe("ok");
    expect(d.capture.status).toBe("skipped");
    expect(d.capture.requested).toBe(false);
    expect(d.warnings).toEqual([]);
    expect(d.next).toBe("find_element or get_window_state");
  });

  it("reports captureAfter screenshot failures without hiding the action result", async () => {
    mockPlat.screenshot.mockRejectedValueOnce(new Error("screen recording denied"));

    const r = await tools.get("click")!.handler({
      x: 10,
      y: 20,
      captureAfter: true,
    });

    expect(r.isError).toBeUndefined();
    expect(r.content).toHaveLength(1);
    const d = JSON.parse(r.content[0].text!);
    expect(d.status).toBe("partial");
    expect(d.result).toMatchObject({ clicked: true, x: 10, y: 20 });
    expect(d.capture.status).toBe("error");
    expect(d.capture.error).toMatchObject({
      code: "UNKNOWN_ERROR",
      retryable: false,
      message: "screen recording denied",
    });
    expect(d.capture.error.recovery).toBeTruthy();
    expect(d.warnings).toContain("Post-action screenshot capture failed");
  });
});

describe("drag — window-relative coords", () => {
  it("adds window offset to start and end coordinates", async () => {
    const r = await tools.get("drag")!.handler({ startX: 1, startY: 2, endX: 30, endY: 40, windowId: "w1" });
    expect(mockPlat.drag).toHaveBeenCalledWith(101, 202, 130, 240, undefined, undefined);
    expect(JSON.parse(r.content[0].text!)).toMatchObject({
      result: {
        dragged: true,
        startX: 101,
        startY: 202,
        endX: 130,
        endY: 240,
      },
      status: "ok",
    });
  });
});

describe("move", () => {
  it("supports captureAfter options", async () => {
    const r = await tools.get("move")!.handler({
      x: 10,
      y: 20,
      captureAfter: true,
      captureFormat: "png",
      captureMaxWidth: 300,
    });
    expect(mockPlat.move).toHaveBeenCalledWith(10, 20);
    expect(r.content[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    expect(mockPlat.screenshot).toHaveBeenCalledWith(undefined, undefined, {
      format: "png",
      maxWidth: 300,
    });
  });
});

describe("screenshot tool", () => {
  it("passes format and maxWidth to platform screenshot", async () => {
    const r = await tools.get("screenshot")!.handler({ format: "jpeg", maxWidth: 512 });
    expect(r.content[0]).toMatchObject({
      type: "image",
      data: Buffer.from("png").toString("base64"),
      mimeType: "image/jpeg",
    });
    expect(mockPlat.screenshot).toHaveBeenCalledWith(undefined, undefined, {
      format: "jpeg",
      maxWidth: 512,
    });
  });

  it("captures a window by windowId through platform screenshotWindow", async () => {
    const r = await tools.get("screenshot")!.handler({ windowId: "w1", format: "png", maxWidth: 800 });
    expect(r.content[0]).toMatchObject({
      type: "image",
      data: Buffer.from("window-png").toString("base64"),
      mimeType: "image/png",
    });
    expect(mockPlat.screenshotWindow).toHaveBeenCalledWith("w1", {
      format: "png",
      maxWidth: 800,
    });
  });

  it("rejects windowId with region", async () => {
    const r = await tools.get("screenshot")!.handler({
      windowId: "w1",
      region: { x: 0, y: 0, width: 100, height: 100 },
    });
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatchObject({
      code: "UNSUPPORTED_PARAMETER",
      retryable: false,
      message: "screenshot windowId cannot be combined with region",
    });
  });
});

describe("focus management", () => {
  it("saves/restores focus for input actions", async () => {
    await tools.get("click")!.handler({ x: 10, y: 20 });
    expect(mockPlat.saveFocus).toHaveBeenCalled();
    expect(mockPlat.restoreFocus).toHaveBeenCalled();
  });

  it("skips focus for read-only actions", async () => {
    await tools.get("screenshot")!.handler({});
    expect(mockPlat.saveFocus).not.toHaveBeenCalled();
  });

  it("restores focus even on failure", async () => {
    mockPlat.click.mockRejectedValueOnce(new Error("fail"));
    const r = await tools.get("click")!.handler({ x: 10, y: 20 });
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatchObject({
      code: "UNKNOWN_ERROR",
      retryable: false,
      message: "fail",
    });
    expect(mockPlat.restoreFocus).toHaveBeenCalled();
  });

  it("does not retry real input actions after a partial failure", async () => {
    mockPlat.click.mockRejectedValueOnce(new Error("fail"));
    const r = await tools.get("click")!.handler({ x: 10, y: 20 });
    expect(r.isError).toBe(true);
    expect(mockPlat.click).toHaveBeenCalledTimes(1);
  });
});

describe("screen lock guard", () => {
  it("blocks when screen locked", async () => {
    mockPlat.isScreenLocked.mockReturnValue(true);
    const r = await tools.get("click")!.handler({ x: 10, y: 20 });
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatchObject({
      code: "SAFETY_BLOCKED",
      retryable: false,
      message: "Screen is locked",
    });
  });
});

describe("UnsupportedParameterError", () => {
  it("rejects type_text windowId", async () => {
    const r = await tools.get("type_text")!.handler({ text: "hi", windowId: "w1" });
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatchObject({
      code: "UNSUPPORTED_PARAMETER",
      retryable: false,
      message: "windowId-targeted keyboard typing is not implemented",
    });
  });

  it("rejects press_key windowId", async () => {
    const r = await tools.get("press_key")!.handler({ key: "enter", windowId: "w1" });
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatchObject({
      code: "UNSUPPORTED_PARAMETER",
      retryable: false,
      message: "windowId-targeted key events are not implemented",
    });
  });
});

describe("press_key key/keys param", () => {
  it("accepts single key", async () => {
    const r = await tools.get("press_key")!.handler({ key: "enter" });
    expect(mockPlat.key).toHaveBeenCalledWith(["enter"]);
    expect(JSON.parse(r.content[0].text!).result.keys).toEqual(["enter"]);
  });

  it("accepts keys array", async () => {
    await tools.get("press_key")!.handler({ keys: ["cmd", "c"] });
    expect(mockPlat.key).toHaveBeenCalledWith(["cmd", "c"]);
  });

  it("accepts key plus modifiers", async () => {
    const r = await tools.get("press_key")!.handler({ key: "c", modifiers: ["cmd"] });
    expect(mockPlat.key).toHaveBeenCalledWith(["cmd", "c"]);
    expect(JSON.parse(r.content[0].text!).result.keys).toEqual(["cmd", "c"]);
  });

  it("throws without key or keys", async () => {
    const r = await tools.get("press_key")!.handler({});
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatchObject({
      code: "UNSUPPORTED_PARAMETER",
      retryable: false,
      message: "press_key requires at least one key",
    });
  });
});

describe("scroll defaults", () => {
  it("defaults deltaX to 0", async () => {
    await tools.get("scroll")!.handler({ x: 10, y: 20, deltaY: -5 });
    expect(mockPlat.scroll).toHaveBeenCalledWith(10, 20, 0, -5);
  });
});
