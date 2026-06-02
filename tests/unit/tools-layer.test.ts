import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const mockPlat = vi.hoisted(() => ({
  screenshot: vi.fn(),
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
}));

vi.mock("../../src/platform/macos.js", () => ({
  MacOSPlatform: class { [k: string]: any; constructor() { for (const [k, v] of Object.entries(mockPlat)) { this[k] = v; } } },
}));

vi.mock("../../src/safety/permissions.js", () => ({
  checkPermission: vi.fn().mockResolvedValue({ granted: true }),
  checkPermissions: vi.fn().mockResolvedValue({ granted: true, accessibility: true, screenRecording: true }),
}));

type TH = (p: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }>;
const tools = new Map<string, { handler: TH }>();

function defaults() {
  mockPlat.screenshot.mockResolvedValue(Buffer.from("png"));
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
  mockPlat.findElement.mockResolvedValue([{ id: "N/w0/1", role: "AXButton", name: "Save" }]);
  mockPlat.clickElement.mockResolvedValue(undefined);
  mockPlat.typeInElement.mockResolvedValue(undefined);
  mockPlat.setElementValue.mockResolvedValue(undefined);
  mockPlat.listApps.mockResolvedValue([{ name: "Notes", pid: 1, isFrontmost: true, windowCount: 1 }]);
  mockPlat.focusApp.mockResolvedValue({ appName: "Notes", pid: 1 });
  mockPlat.isScreenLocked.mockReturnValue(false);
  mockPlat.saveFocus.mockResolvedValue(undefined);
  mockPlat.restoreFocus.mockResolvedValue(undefined);
}

beforeAll(async () => {
  defaults();
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { registerTools, ToolRegistry } = await import("../../src/mcp/tools.js");
  const server = new McpServer({ name: "ucu-mcp", version: "0.1.0" });
  const orig = server.tool.bind(server);
  (server as any).tool = function (name: string, desc: string, schema: unknown, handler: TH) {
    tools.set(name, { handler });
    return orig(name, desc, schema, handler);
  };
  ToolRegistry["_instance"] = undefined;
  registerTools(server);
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.advanceTimersByTime(200);
  vi.clearAllMocks();
  defaults();
});

afterAll(() => { vi.useRealTimers(); });

describe("Tools registration", () => {
  it("registers all 22 MCP tools", () => {
    expect(tools.size).toBe(22);
    const names = [...tools.keys()].sort();
    expect(names).toEqual([
      "click","click_element","doctor","double_click","drag",
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
    expect(d.clients).toHaveProperty("claudeCodeCli");
  });

  it("reports screenLocked=true", async () => {
    mockPlat.isScreenLocked.mockReturnValue(true);
    const r = await tools.get("doctor")!.handler({});
    expect(JSON.parse(r.content[0].text!).screenLocked).toBe(true);
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
    expect(JSON.parse(r.content[0].text!)).toEqual({ appName: "Notes", pid: 1 });
    expect(mockPlat.focusApp).toHaveBeenCalledWith("Notes");
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
    mockPlat.findElement.mockResolvedValue([]);
    const p = tools.get("wait_for_element")!.handler({ text: "X", timeout: 200, interval: 50 });
    await vi.advanceTimersByTimeAsync(300);
    const r = await p;
    expect(JSON.parse(r.content[0].text!).found).toBe(false);
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
});

describe("captureAfter", () => {
  it("appends screenshot when captureAfter=true", async () => {
    const r = await tools.get("click")!.handler({ x: 10, y: 20, captureAfter: true });
    const d = JSON.parse(r.content[0].text!);
    expect(d.actionResult.clicked).toBe(true);
    expect(d.screenshot.type).toBe("image");
  });

  it("returns plain result when captureAfter=false", async () => {
    const r = await tools.get("click")!.handler({ x: 10, y: 20, captureAfter: false });
    const d = JSON.parse(r.content[0].text!);
    expect(d.clicked).toBe(true);
    expect(d.screenshot).toBeUndefined();
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
    await expect(tools.get("click")!.handler({ x: 10, y: 20 })).rejects.toThrow("fail");
    expect(mockPlat.restoreFocus).toHaveBeenCalled();
  });
});

describe("screen lock guard", () => {
  it("blocks when screen locked", async () => {
    mockPlat.isScreenLocked.mockReturnValue(true);
    await expect(tools.get("click")!.handler({ x: 10, y: 20 })).rejects.toThrow("Screen is locked");
  });
});

describe("UnsupportedParameterError", () => {
  it("rejects type_text windowId", async () => {
    await expect(tools.get("type_text")!.handler({ text: "hi", windowId: "w1" }))
      .rejects.toThrow("windowId-targeted keyboard typing is not implemented");
  });

  it("rejects press_key windowId", async () => {
    await expect(tools.get("press_key")!.handler({ key: "enter", windowId: "w1" }))
      .rejects.toThrow("windowId-targeted key events are not implemented");
  });
});

describe("press_key key/keys param", () => {
  it("accepts single key", async () => {
    await tools.get("press_key")!.handler({ key: "enter" });
    expect(mockPlat.key).toHaveBeenCalledWith(["enter"]);
  });

  it("accepts keys array", async () => {
    await tools.get("press_key")!.handler({ keys: ["cmd", "c"] });
    expect(mockPlat.key).toHaveBeenCalledWith(["cmd", "c"]);
  });

  it("throws without key or keys", async () => {
    await expect(tools.get("press_key")!.handler({})).rejects.toThrow("press_key requires at least one key");
  });
});
