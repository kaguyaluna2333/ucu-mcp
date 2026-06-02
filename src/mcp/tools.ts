/**
 * Tool registry for UCU-MCP.
 *
 * Registers 22 MCP tools on the server and dispatches each call through
 * a shared safety/permission/retry pipeline (`withSafety`).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Platform, WindowInfo, CursorPosition, OcrResult, FindElementResult, WindowState } from "../platform/base.js";
import { MacOSPlatform } from "../platform/macos.js";
import { SafetyGuard } from "../safety/guard.js";
import { checkPermission } from "../safety/permissions.js";
import { retry } from "../util/retry.js";
import { createLogger } from "../util/logger.js";
import { SafetyError, PermissionError, UnsupportedParameterError } from "../util/errors.js";

const log = createLogger("tools");

let _platform: Platform | undefined;
function getPlatform(): Platform {
  if (!_platform) {
    _platform = process.platform === "darwin" ? new MacOSPlatform() : undefined as never;
  }
  return _platform;
}
const safety = new SafetyGuard();

// User activity monitor — pauses automation when user moves the cursor
let lastCursorPos = { x: 0, y: 0 };
let userActivityInterval: ReturnType<typeof setInterval> | undefined;

function startUserActivityMonitor(): void {
  if (userActivityInterval) return;
  userActivityInterval = setInterval(() => {
    try {
      const pos = getPlatform().getCursorPosition();
      if (pos.x !== lastCursorPos.x || pos.y !== lastCursorPos.y) {
        safety.recordUserActivity();
        lastCursorPos = pos;
      }
    } catch { /* can't check cursor */ }
  }, 250);
}

function stopUserActivityMonitor(): void {
  if (userActivityInterval) {
    clearInterval(userActivityInterval);
    userActivityInterval = undefined;
  }
}

const captureAfterFields = {
  captureAfter: z.boolean().default(false).describe("Take a screenshot after the action completes and include it in the response"),
  captureMaxWidth: z.number().default(1280).describe("Maximum width for the post-action screenshot"),
  captureFormat: z.enum(["png", "jpeg"]).default("jpeg").describe("Format for the post-action screenshot"),
};

async function resolvePoint(x: number, y: number, windowId?: string): Promise<{ x: number; y: number }> {
  if (!windowId) return { x, y };
  try {
    const win = (await getPlatform().listWindows()).find(w => w.id === windowId);
    if (!win) return { x, y };
    return { x: win.bounds.x + x, y: win.bounds.y + y };
  } catch { return { x, y }; }
}

interface SafetyAction {
  action: string; params: Record<string, unknown>;
  requiresAccessibility?: boolean; requiresScreenRecording?: boolean;
  dryRun?: () => Promise<string>; execute: () => Promise<unknown>;
}
async function withSafety<T>(sa: SafetyAction): Promise<T> {
  const platform = getPlatform();
  if (platform.isScreenLocked?.()) throw new SafetyError("Screen is locked");
  const check = safety.checkAction(sa.action, sa.params);
  if (!check.allowed) throw new SafetyError(check.reason ?? "Action blocked by safety guard");
  if (sa.requiresAccessibility) { const { granted } = await checkPermission("accessibility"); if (!granted) throw new PermissionError("accessibility", process.platform); }
  if (sa.requiresScreenRecording) { const { granted } = await checkPermission("screenRecording"); if (!granted) throw new PermissionError("screenRecording", process.platform); }
  if (sa.dryRun) return `[DRY-RUN] ${await sa.dryRun()}` as T;
  const shouldManageFocus = sa.requiresAccessibility && !["screenshot", "list_windows", "list_apps", "get_window_state", "get_cursor_position", "get_screen_size", "ocr", "doctor", "wait", "wait_for_element", "find_element", "focus_app"].includes(sa.action);
  if (shouldManageFocus) await platform.saveFocus?.();
  try {
    return await retry(() => sa.execute() as Promise<T>);
  } finally {
    if (shouldManageFocus) await platform.restoreFocus?.();
  }
}
async function appendCaptureAfter(result: unknown, captureAfter?: boolean): Promise<unknown> {
  if (!captureAfter) return result;
  try {
    const buf = await getPlatform().screenshot();
    return { actionResult: result, screenshot: { type: "image", data: buf.toString("base64"), mimeType: "image/png" } };
  } catch { return result; }
}

export function registerTools(server: McpServer): void {
  const registry = ToolRegistry.instance;

  server.tool("screenshot", "Capture a screenshot of the entire screen or a region", {
    display: z.number().optional().describe("Display index (default 0)"),
    region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional().describe("Region to capture"),
    format: z.enum(["png", "jpeg"]).default("png").describe("Image format"),
    maxWidth: z.number().default(1280).describe("Maximum output width in pixels. Aspect ratio is preserved."),
  }, async (params) => {
    const buf = await withSafety<Buffer>({ action: "screenshot", params: {}, requiresScreenRecording: true, execute: () => getPlatform().screenshot(params.display, params.region, { format: params.format }) });
    return { content: [{ type: "image", data: buf.toString("base64"), mimeType: `image/${params.format}` }] };
  });
  registry.register("screenshot");

  server.tool("list_windows", "List all visible windows on screen", {
    includeMinimized: z.boolean().optional().describe("Include minimized windows"),
  }, async (params) => {
    const windows = await withSafety<WindowInfo[]>({ action: "list_windows", params: {}, requiresAccessibility: true, execute: () => getPlatform().listWindows(params.includeMinimized) });
    return { content: [{ type: "text", text: JSON.stringify(windows, null, 2) }] };
  });
  registry.register("list_windows");

  server.tool("list_apps", "List all running applications", {}, async () => {
    const apps = await withSafety({ action: "list_apps", params: {}, requiresAccessibility: true, execute: async () => getPlatform().listApps!() });
    return { content: [{ type: "text", text: JSON.stringify(apps, null, 2) }] };
  });
  registry.register("list_apps");

  server.tool("focus_app", "Bring an application to the foreground", {
    app: z.string().describe("Application name to focus"),
  }, async (params) => {
    const target = await withSafety({ action: "focus_app", params: {}, requiresAccessibility: true, execute: () => getPlatform().focusApp!(params.app) });
    return { content: [{ type: "text", text: JSON.stringify(target, null, 2) }] };
  });
  registry.register("focus_app");

  server.tool("get_window_state", "Get detailed state of a window including accessibility tree", {
    windowId: z.string().optional().describe("Window ID"), depth: z.number().optional().describe("AX tree depth"), includeBounds: z.boolean().optional().describe("Include element bounds"),
  }, async (params) => {
    const state = await withSafety<WindowState>({ action: "get_window_state", params: {}, requiresAccessibility: true, execute: () => getPlatform().getWindowState(params.windowId, params.depth, params.includeBounds) });
    return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
  });
  registry.register("get_window_state");

  server.tool("click", "Click at screen coordinates", {
    x: z.number().describe("X coordinate"), y: z.number().describe("Y coordinate"),
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button"),
    windowId: z.string().optional().describe("If set, x/y are relative to this window"),
    ...captureAfterFields,
  }, async (params) => {
    const pt = await resolvePoint(params.x, params.y, params.windowId);
    await withSafety<void>({ action: "click", params: { x: pt.x, y: pt.y }, requiresAccessibility: true, execute: () => getPlatform().click(pt.x, pt.y, params.button) });
    return { content: [{ type: "text", text: JSON.stringify(await appendCaptureAfter({ clicked: true, x: pt.x, y: pt.y }, params.captureAfter), null, 2) }] };
  });
  registry.register("click");

  server.tool("double_click", "Double-click at screen coordinates", {
    x: z.number().describe("X coordinate"), y: z.number().describe("Y coordinate"),
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button"),
    windowId: z.string().optional().describe("If set, x/y are relative to this window"),
    ...captureAfterFields,
  }, async (params) => {
    const pt = await resolvePoint(params.x, params.y, params.windowId);
    await withSafety<void>({ action: "click", params: { x: pt.x, y: pt.y, doubleClick: true }, requiresAccessibility: true, execute: () => getPlatform().click(pt.x, pt.y, params.button, true) });
    return { content: [{ type: "text", text: JSON.stringify(await appendCaptureAfter({ doubleClicked: true, x: pt.x, y: pt.y }, params.captureAfter), null, 2) }] };
  });
  registry.register("double_click");

  server.tool("type_text", "Type text at the current cursor position", {
    text: z.string().describe("Text to type"), delay: z.number().optional().describe("Delay between keystrokes in ms"),
    windowId: z.string().optional().describe("UNSUPPORTED: windowId-targeted keyboard typing is not implemented"),
    ...captureAfterFields,
  }, async (params) => {
    if (params.windowId) throw new UnsupportedParameterError("windowId-targeted keyboard typing is not implemented");
    await withSafety<void>({ action: "type_text", params: { text: params.text }, requiresAccessibility: true, execute: () => getPlatform().type(params.text, params.delay) });
    return { content: [{ type: "text", text: JSON.stringify(await appendCaptureAfter({ typed: true, charCount: params.text.length }, params.captureAfter), null, 2) }] };
  });
  registry.register("type_text");

  server.tool("press_key", "Press a keyboard shortcut", {
    keys: z.array(z.string()).optional().describe("Keys to press simultaneously"),
    key: z.string().optional().describe("Single key to press (alias for keys)"),
    windowId: z.string().optional().describe("UNSUPPORTED: windowId-targeted key events are not implemented"),
    ...captureAfterFields,
  }, async (params) => {
    if (params.windowId) throw new UnsupportedParameterError("windowId-targeted key events are not implemented");
    const keys = params.keys ?? (params.key ? [params.key] : []);
    if (keys.length === 0) throw new Error("press_key requires at least one key");
    await withSafety<void>({ action: "press_key", params: { keys }, requiresAccessibility: true, execute: () => getPlatform().key(keys) });
    return { content: [{ type: "text", text: JSON.stringify(await appendCaptureAfter({ pressed: true, keys: params.keys }, params.captureAfter), null, 2) }] };
  });
  registry.register("press_key");

  server.tool("scroll", "Scroll at coordinates", {
    x: z.number().describe("X coordinate"), y: z.number().describe("Y coordinate"),
    deltaX: z.number().describe("Horizontal scroll"), deltaY: z.number().describe("Vertical scroll (negative = up)"),
    windowId: z.string().optional().describe("If set, x/y are relative to this window"),
    ...captureAfterFields,
  }, async (params) => {
    const pt = await resolvePoint(params.x, params.y, params.windowId);
    await withSafety<void>({ action: "scroll", params: { x: pt.x, y: pt.y }, requiresAccessibility: true, execute: () => getPlatform().scroll(pt.x, pt.y, params.deltaX, params.deltaY) });
    return { content: [{ type: "text", text: JSON.stringify(await appendCaptureAfter({ scrolled: true, x: pt.x, y: pt.y }, params.captureAfter), null, 2) }] };
  });
  registry.register("scroll");

  server.tool("drag", "Drag from one point to another", {
    startX: z.number().describe("Start X"), startY: z.number().describe("Start Y"),
    endX: z.number().describe("End X"), endY: z.number().describe("End Y"),
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button"),
    duration: z.number().optional().describe("Drag duration in ms"),
    ...captureAfterFields,
  }, async (params) => {
    await withSafety<void>({ action: "drag", params: {}, requiresAccessibility: true, execute: () => getPlatform().drag(params.startX, params.startY, params.endX, params.endY, params.button, params.duration) });
    return { content: [{ type: "text", text: JSON.stringify(await appendCaptureAfter({ dragged: true }, params.captureAfter), null, 2) }] };
  });
  registry.register("drag");

  server.tool("doctor", "Check system permissions and diagnose common issues", {}, async () => {
    const { checkPermissions } = await import("../safety/permissions.js");
    const { MacOSPlatform: MacPlat } = await import("../platform/macos.js");
    const permissions = await checkPermissions();
    const screenLocked = process.platform === "darwin" ? new MacPlat().isScreenLocked?.() ?? false : false;
    const report = {
      ok: permissions.granted && !screenLocked,
      platform: process.platform,
      node: process.version,
      permissions,
      screenLocked,
      safety: {
        urlBlocklist: true,
        lockScreenGuard: process.platform === "darwin",
        typedTextInjectionScan: true,
      },
      stdioCommand: "ucu-mcp",
      clients: {
        claudeCodeCli: "Run ucu-mcp as an MCP stdio server.",
        claudeCodeDesktop: "Configure ucu-mcp as a local MCP stdio server.",
        openCode: "Configure ucu-mcp as a local MCP stdio server.",
      },
    };
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  });
  registry.register("doctor");

  server.tool("wait", "Wait for a specified duration", { ms: z.number().describe("Duration in milliseconds") }, async (params) => {
    await new Promise(r => setTimeout(r, params.ms));
    return { content: [{ type: "text", text: JSON.stringify({ waited: params.ms }) }] };
  });
  registry.register("wait");

  server.tool("wait_for_element", "Poll until an accessibility element matching the criteria appears", {
    text: z.string().optional().describe("Element text"), role: z.string().optional().describe("Element role"),
    app: z.string().optional().describe("Target app"), timeout: z.number().optional().describe("Timeout ms (default 5000)"), interval: z.number().optional().describe("Poll interval ms (default 500)"),
  }, async (params) => {
    const deadline = Date.now() + (params.timeout ?? 5000);
    const interval = params.interval ?? 500;
    while (Date.now() < deadline) {
      try {
        const results = await getPlatform().findElement({ text: params.text, role: params.role, app: params.app, maxResults: 1 });
        if (results.length > 0) return { content: [{ type: "text", text: JSON.stringify({ found: true, element: results[0] }, null, 2) }] };
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, interval));
    }
    return { content: [{ type: "text", text: JSON.stringify({ found: false, reason: "timeout" }) }] };
  });
  registry.register("wait_for_element");

  server.tool("get_cursor_position", "Get current cursor position", {}, async () => {
    const pos = await withSafety<CursorPosition>({ action: "get_cursor_position", params: {}, execute: () => Promise.resolve(getPlatform().getCursorPosition()) });
    return { content: [{ type: "text", text: JSON.stringify(pos, null, 2) }] };
  });
  registry.register("get_cursor_position");

  server.tool("get_screen_size", "Get screen dimensions and scale factor", {
    display: z.number().optional().describe("Display index"),
  }, async (params) => {
    return { content: [{ type: "text", text: JSON.stringify(getPlatform().getScreenSize(params.display), null, 2) }] };
  });
  registry.register("get_screen_size");

  server.tool("ocr", "Perform OCR on screen region", {
    display: z.number().optional().describe("Display index"),
    region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional().describe("Region to OCR"),
  }, async (params) => {
    const result = await withSafety<OcrResult>({ action: "ocr", params: {}, requiresScreenRecording: true, execute: () => getPlatform().ocr(params.display, params.region) });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });
  registry.register("ocr");

  server.tool("move", "Move cursor to coordinates", {
    x: z.number().describe("X coordinate"), y: z.number().describe("Y coordinate"),
    windowId: z.string().optional().describe("If set, x/y are relative to this window"),
  }, async (params) => {
    const pt = await resolvePoint(params.x, params.y, params.windowId);
    await withSafety<void>({ action: "move", params: { x: pt.x, y: pt.y }, requiresAccessibility: true, execute: () => getPlatform().move(pt.x, pt.y) });
    return { content: [{ type: "text", text: JSON.stringify({ moved: true, x: pt.x, y: pt.y }, null, 2) }] };
  });
  registry.register("move");

  server.tool("find_element", "Find accessibility elements by text, role, or app", {
    text: z.string().optional().describe("Text to search"), role: z.string().optional().describe("AX role"), app: z.string().optional().describe("Target app"),
    depth: z.number().optional().describe("AX tree depth"), includeBounds: z.boolean().default(true).describe("Include bounds"), maxResults: z.number().min(1).max(200).default(50).describe("Max results"),
  }, async (params) => {
    const results = await withSafety<FindElementResult[]>({ action: "find_element", params: {}, requiresAccessibility: true,
      execute: () => getPlatform().findElement({ text: params.text, role: params.role, app: params.app, depth: params.depth, includeBounds: params.includeBounds, maxResults: params.maxResults }) });
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });
  registry.register("find_element");

  server.tool("click_element", "Click an accessibility element by its ID", {
    elementId: z.string().describe("AX element identifier"), app: z.string().optional().describe("Target app"), ...captureAfterFields,
  }, async (params) => {
    await withSafety<void>({ action: "click_element", params: {}, requiresAccessibility: true, execute: () => getPlatform().clickElement(params.elementId, params.app) });
    return { content: [{ type: "text", text: JSON.stringify(await appendCaptureAfter({ clicked: true, elementId: params.elementId }, params.captureAfter), null, 2) }] };
  });
  registry.register("click_element");

  server.tool("set_value", "Set the value of an accessibility element", {
    elementId: z.string().describe("AX element identifier"), value: z.string().describe("Value to set"), app: z.string().optional().describe("Target app"), ...captureAfterFields,
  }, async (params) => {
    await withSafety<void>({ action: "set_value", params: { value: params.value }, requiresAccessibility: true, execute: () => getPlatform().setElementValue!(params.elementId, params.value, params.app) });
    return { content: [{ type: "text", text: JSON.stringify(await appendCaptureAfter({ setValue: true, elementId: params.elementId }, params.captureAfter), null, 2) }] };
  });
  registry.register("set_value");

  server.tool("type_in_element", "Type text into an accessibility element, optionally clearing first", {
    elementId: z.string().describe("AX element identifier"), text: z.string().describe("Text to type"),
    app: z.string().optional().describe("Target app"), clearFirst: z.boolean().optional().describe("Clear existing text before typing"), ...captureAfterFields,
  }, async (params) => {
    await withSafety<void>({ action: "type_in_element", params: { text: params.text }, requiresAccessibility: true, execute: () => getPlatform().typeInElement(params.elementId, params.text, params.app, params.clearFirst) });
    return { content: [{ type: "text", text: JSON.stringify(await appendCaptureAfter({ typed: true, elementId: params.elementId, charCount: params.text.length }, params.captureAfter), null, 2) }] };
  });
  registry.register("type_in_element");

  log.info("Registered tools", { count: registry.tools.length, tools: registry.tools.join(", ") });

  // Start user activity monitoring
  startUserActivityMonitor();
}
export class ToolRegistry {
  private static _instance: ToolRegistry | undefined;
  readonly tools: string[] = [];
  private readonly _handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  static get instance(): ToolRegistry { if (!ToolRegistry._instance) ToolRegistry._instance = new ToolRegistry(); return ToolRegistry._instance; }
  register(name: string, handler?: (args: Record<string, unknown>) => Promise<unknown>): void {
    this.tools.push(name);
    if (handler) this._handlers.set(name, handler);
  }
  async dispatch(name: string, args: Record<string, unknown>): Promise<any> {
    const handler = this._handlers.get(name);
    if (!handler) return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    return handler(args);
  }
}
