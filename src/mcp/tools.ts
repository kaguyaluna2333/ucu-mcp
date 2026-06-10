/**
 * Tool registry for UCU-MCP.
 *
 * Registers 24 MCP tools on the server and dispatches each call through
 * a shared safety/permission/retry pipeline (`withSafety`).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Platform, WindowInfo, CursorPosition, OcrResult, FindElementResult, FindElementResponse, WindowState, AppTarget } from "../platform/base.js";
import { MacOSPlatform } from "../platform/macos.js";
import { SafetyGuard, classifyAction } from "../safety/guard.js";
import { checkPermission } from "../safety/permissions.js";
import { retry } from "../util/retry.js";
import { createLogger } from "../util/logger.js";
import { metrics } from "../util/metrics.js";
import { SafetyError, PermissionError, UnsupportedParameterError, UcuError, WindowNotFoundError } from "../util/errors.js";

const log = createLogger("tools");

let _platform: Platform | undefined;
function getPlatform(): Platform {
  if (!_platform) {
    _platform = process.platform === "darwin" ? new MacOSPlatform() : undefined as never;
  }
  return _platform;
}
const safety = new SafetyGuard();

// Active target context — set by focus_app, used by AX element tools
let activeTargetContext: AppTarget | undefined;

/**
 * Get the currently active target context (set by focus_app).
 */
export function getActiveTarget(): AppTarget | undefined {
  return activeTargetContext;
}

// User activity monitor — pauses automation when user moves the cursor
let lastCursorPos = { x: 0, y: 0 };
let userActivityInterval: ReturnType<typeof setInterval> | undefined;

const captureAfterFields = {
  captureAfter: z.boolean().default(false).describe("Take a screenshot after the action completes and include it in the response"),
  captureMaxWidth: z.number().default(1280).describe("Maximum width for the post-action screenshot"),
  captureFormat: z.enum(["png", "jpeg"]).default("jpeg").describe("Format for the post-action screenshot"),
};

// Exported so unit tests can pin the schema constraint directly instead
// of going through the McpServer wrapper (which `handler()` calls
// bypass). (Herschel review Major: 0.3.5's value='' test was a
// tautology because it re-created a local zod schema instead of
// asserting against this one.)
export const findElementInputSchema = {
  text: z.string().optional().describe("Text to search"),
  role: z.string().optional().describe("AX role"),
  app: z.string().optional().describe("Target app"),
  depth: z.number().optional().describe("AX tree depth"),
  includeBounds: z.boolean().default(true).describe("Include bounds"),
  maxResults: z.number().min(1).max(200).default(50).describe("Max results"),
  textMode: z.enum(["contains", "exact", "regex"]).default("contains").describe("Text matching mode: contains (default), exact, or regex"),
  visibleOnly: z.boolean().default(false).describe("Only return elements with valid on-screen bounds"),
  value: z.string().min(1).optional().describe("Filter by AX element value (text/regex/exact, see textMode). Empty string is treated as unset (omit the field instead)."),
  index: z.number().int().nonnegative().optional().describe("Return only the Nth match (0-based) after all other filtering and sorting"),
  near: z.object({ x: z.number(), y: z.number() }).optional().describe("Sort results by ascending distance to this point and return closest first"),
};

async function resolvePoint(x: number, y: number, windowId?: string): Promise<{ x: number; y: number }> {
  if (!windowId) return { x, y };
  const win = (await getPlatform().listWindows()).find(w => w.id === windowId);
  if (!win) throw new WindowNotFoundError(windowId);
  return { x: win.bounds.x + x, y: win.bounds.y + y };
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type ToolResult = { content: ToolContent[]; isError?: boolean };

function jsonText(value: unknown): ToolContent {
  return { type: "text", text: JSON.stringify(value, null, 2) };
}

function recoveryHint(code: string): string {
  switch (code) {
    case "WINDOW_NOT_FOUND":
      return "Run list_windows again, then retry with a fresh windowId or omit windowId for screen coordinates.";
    case "TARGET_STALE":
      return "Run focus_app again for the target app, or run list_windows and retry with a fresh windowId.";
    case "ELEMENT_NOT_FOUND":
      return "Run find_element again, then retry with a fresh elementId.";
    case "PERMISSION_DENIED":
      return "Run doctor and grant the missing macOS permission, then restart the launching client.";
    case "UNSUPPORTED_PARAMETER":
      return "Remove or replace the unsupported parameter; inspect tools/list for this tool schema.";
    case "SAFETY_BLOCKED":
      return "Choose a less risky action or ask the user to perform it manually.";
    case "INPUT_FAILED":
      return "Observe current state with screenshot or get_window_state before retrying manually.";
    case "CAPTURE_FAILED":
      return "Run doctor to check Screen Recording permission, then retry screenshot or ocr.";
    case "COORDINATE_OUT_OF_BOUNDS":
      return "Run get_screen_size or list_windows, then retry with coordinates inside the active display or window bounds.";
    default:
      return "Inspect the error message, observe the current UI state, and retry only if the operation is safe.";
  }
}

function errorDetails(error: unknown): Record<string, unknown> {
  const err = error instanceof Error ? error : new Error(String(error));
  const code = error instanceof UcuError ? error.code : "UNKNOWN_ERROR";
  const retryable = error instanceof UcuError ? error.retryable : false;
  // Some platform errors carry an inline `hint` field (added by macos.ts focusApp
  // for the Electron AX case, etc.). Surface it under `hint` so the model can
  // see remediation without parsing the message string.
  const inlineHint = (err as Error & { hint?: unknown }).hint;
  const details: Record<string, unknown> = {
    name: err.name,
    code,
    retryable,
    message: err.message,
    recovery: recoveryHint(code),
  };
  if (typeof inlineHint === "string" && inlineHint.length > 0) {
    details.hint = inlineHint;
  }
  return details;
}

/**
 * Unified Action Receipt returned by all action-class tools.
 */
interface ActionReceipt {
  /** Short unique ID for this tool call */
  actionId: string;
  /** Tool name / action type */
  action: string;
  /** Overall status: ok | partial | blocked */
  status: "ok" | "partial" | "blocked";
  /** What the action acted upon */
  target: {
    app?: string;
    windowId?: string;
    elementId?: string;
    x?: number;
    y?: number;
    startX?: number;
    startY?: number;
    endX?: number;
    endY?: number;
  };
  /** Original business result of the tool */
  result: Record<string, unknown>;
  /** Screenshot capture metadata */
  capture: {
    requested: boolean;
    status: "ok" | "skipped" | "error";
    format?: string;
    maxWidth?: number;
    error?: Record<string, unknown>;
  };
  /** Non-fatal warnings */
  warnings: string[];
  /** Suggested next observation or recovery action */
  next: string;
}

let _actionCounter = 0;
function nextActionId(): string {
  _actionCounter = (_actionCounter + 1) % 1_000_000;
  return `a${Date.now().toString(36)}-${_actionCounter.toString(36)}`;
}

function buildActionReceipt(
  action: string,
  status: ActionReceipt["status"],
  target: ActionReceipt["target"],
  result: Record<string, unknown>,
  captureRequested: boolean,
  captureFormat?: string,
  captureMaxWidth?: number,
  captureError?: Record<string, unknown>,
  warnings: string[] = [],
): ActionReceipt {
  const captureStatus = captureRequested
    ? captureError ? "error" : "ok"
    : "skipped";
  return {
    actionId: nextActionId(),
    action,
    status,
    target,
    result,
    capture: {
      requested: captureRequested,
      status: captureStatus,
      ...(captureFormat && { format: captureFormat }),
      ...(captureMaxWidth && { maxWidth: captureMaxWidth }),
      ...(captureError && { error: captureError }),
    },
    warnings,
    next: captureError
      ? "screenshot"
      : status === "partial"
        ? "get_window_state"
        : "find_element or get_window_state",
  };
}

function mcpErrorResponse(error: unknown): ToolResult {
  return {
    isError: true,
    content: [
      jsonText({
        error: errorDetails(error),
      }),
    ],
  };
}

async function actionResponse(
  action: string,
  result: Record<string, unknown>,
  target: ActionReceipt["target"],
  captureAfter?: boolean,
  captureFormat: "png" | "jpeg" = "jpeg",
  captureMaxWidth: number = 1280,
  warnings: string[] = [],
): Promise<{ content: ToolContent[] }> {
  const receipt = buildActionReceipt(
    action,
    "ok",
    target,
    result,
    captureAfter ?? false,
    captureFormat,
    captureMaxWidth,
    undefined,
    warnings,
  );

  if (!captureAfter) {
    return { content: [jsonText(receipt)] };
  }

  try {
    const buf = await getPlatform().screenshot(undefined, undefined, {
      format: captureFormat,
      maxWidth: captureMaxWidth,
    });
    return {
      content: [
        jsonText(receipt),
        {
          type: "image",
          data: buf.toString("base64"),
          mimeType: `image/${captureFormat}`,
        },
      ],
    };
  } catch (error) {
    const partialReceipt = buildActionReceipt(
      action,
      "partial",
      target,
      result,
      true,
      captureFormat,
      captureMaxWidth,
      errorDetails(error),
      [...warnings, "Post-action screenshot capture failed"],
    );
    return { content: [jsonText(partialReceipt)] };
  }
}

interface SafetyAction {
  action: string; params: Record<string, unknown>;
  requiresAccessibility?: boolean; requiresScreenRecording?: boolean;
  skipUserActivityPause?: boolean;
  dryRun?: () => Promise<string>; execute: () => Promise<unknown>;
}
const retryableActions = new Set([
  "screenshot",
  "list_windows",
  "list_apps",
  "get_window_state",
  "get_cursor_position",
  "get_screen_size",
  "ocr",
  "doctor",
  "find_element",
]);

async function withSafety<T>(sa: SafetyAction): Promise<T> {
  const platform = getPlatform();
  if (platform.isScreenLocked?.()) throw new SafetyError("Screen is locked");
  const check = safety.checkAction(sa.action, sa.params, {
    skipUserActivityPause: sa.skipUserActivityPause ?? classifyAction(sa.action) === "observe",
  });
  if (!check.allowed) throw new SafetyError(check.reason ?? "Action blocked by safety guard");
  if (sa.requiresAccessibility) { const { granted } = await checkPermission("accessibility"); if (!granted) throw new PermissionError("accessibility", process.platform); }
  if (sa.requiresScreenRecording) { const { granted } = await checkPermission("screenRecording"); if (!granted) throw new PermissionError("screenRecording", process.platform); }
  if (sa.dryRun) return `[DRY-RUN] ${await sa.dryRun()}` as T;
  const shouldManageFocus = sa.requiresAccessibility && !["screenshot", "list_windows", "list_apps", "get_window_state", "get_cursor_position", "get_screen_size", "ocr", "doctor", "wait", "wait_for_element", "find_element", "focus_app"].includes(sa.action);
  if (shouldManageFocus) await platform.saveFocus?.();
  const start = Date.now();
  try {
    return retryableActions.has(sa.action)
      ? await retry(() => sa.execute() as Promise<T>)
      : await sa.execute() as T;
  } finally {
    metrics.record(sa.action, Date.now() - start);
    if (shouldManageFocus) await platform.restoreFocus?.();
  }
}

export function startUserActivityMonitor(): void {
  if (userActivityInterval) return;
  try {
    lastCursorPos = getPlatform().getCursorPosition();
  } catch {
    // Keep the default when the cursor cannot be queried during startup.
  }
  userActivityInterval = setInterval(() => {
    try {
      const pos = getPlatform().getCursorPosition();
      if (pos.x !== lastCursorPos.x || pos.y !== lastCursorPos.y) {
        safety.recordUserActivity();
        lastCursorPos = pos;
      }
    } catch { /* can't check cursor */ }
  }, 250);
  (userActivityInterval as NodeJS.Timeout).unref?.();
}

export function stopUserActivityMonitor(): void {
  if (userActivityInterval) {
    clearInterval(userActivityInterval);
    userActivityInterval = undefined;
  }
}

export function registerTools(server: McpServer): void {
  const registry = ToolRegistry.instance;
  const registerTool = (
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    handler: (params: any) => Promise<ToolResult>,
  ) => {
    server.tool(name, description, schema, async (params: any) => {
      try {
        return await handler(params);
      } catch (error) {
        return mcpErrorResponse(error);
      }
    });
  };

  registerTool("screenshot", "Capture a screenshot of the entire screen or a region", {
    display: z.number().optional().describe("Display index (default 0)"),
    windowId: z.string().optional().describe("Window ID from list_windows; when set, captures that window"),
    region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional().describe("Region to capture"),
    format: z.enum(["png", "jpeg"]).default("png").describe("Image format"),
    maxWidth: z.number().default(1280).describe("Maximum output width in pixels. Aspect ratio is preserved."),
  }, async (params) => {
    if (params.windowId && params.region) throw new UnsupportedParameterError("screenshot windowId cannot be combined with region");
    const options = { format: params.format, maxWidth: params.maxWidth };
    const buf = await withSafety<Buffer>({
      action: "screenshot",
      params,
      requiresScreenRecording: true,
      execute: () => params.windowId
        ? getPlatform().screenshotWindow
          ? getPlatform().screenshotWindow!(params.windowId, options)
          : Promise.reject(new UnsupportedParameterError("window screenshots are not implemented on this platform"))
        : getPlatform().screenshot(params.display, params.region, options),
    });
    return { content: [{ type: "image", data: buf.toString("base64"), mimeType: `image/${params.format}` }] };
  });
  registry.register("screenshot");

  registerTool("list_windows", "List all visible windows on screen", {
    includeMinimized: z.boolean().optional().describe("Include minimized windows"),
  }, async (params) => {
    const windows = await withSafety<WindowInfo[]>({ action: "list_windows", params: {}, requiresAccessibility: true, execute: () => getPlatform().listWindows(params.includeMinimized) });
    // Attach a diagnostic hint when the result is empty so the model can
    // tell the difference between "no windows are open" and "AX enumeration
    // failed for the target app" (common with Electron apps like CC Switch,
    // VS Code, Discord). The windows list itself is the source of truth; the
    // hint is advisory only.
    let diagnostics: { hint: string; accessibility: "granted" | "denied" | "unknown" } | undefined;
    if (windows.length === 0) {
      let accessibility: "granted" | "denied" | "unknown" = "unknown";
      try {
        const { checkPermission } = await import("../safety/permissions.js");
        const { granted } = await checkPermission("accessibility");
        accessibility = granted ? "granted" : "denied";
      } catch { /* keep unknown */ }
      const axNote = accessibility === "denied"
        ? "Accessibility is currently denied to this terminal — grant it via System Settings > Privacy & Security > Accessibility, then retry."
        : accessibility === "granted"
          ? "Accessibility is granted. If you expected a specific app to appear here, it is likely an Electron app whose AX tree is not exposed to System Events. Pixel-level workaround: call screenshot, then ocr to locate the target UI text and get its bounding box, then click(x, y) at those screen coordinates. Alternatively, modify the app's config file or database directly."
          : "Accessibility status is unknown. Run `doctor` first to verify.";
      diagnostics = { hint: `list_windows returned 0 windows. ${axNote}`, accessibility };
    }
    return { content: [{ type: "text", text: JSON.stringify(diagnostics ? { windows, diagnostics } : windows, null, 2) }] };
  });
  registry.register("list_windows");

  registerTool("list_apps", "List all running applications", {}, async () => {
    const apps = await withSafety({ action: "list_apps", params: {}, requiresAccessibility: true, execute: async () => getPlatform().listApps!() });
    return { content: [{ type: "text", text: JSON.stringify(apps, null, 2) }] };
  });
  registry.register("list_apps");

  registerTool("focus_app", "Select an application/window as the active target context", {
    app: z.string().describe("Application name to focus"),
  }, async (params) => {
    const target = await withSafety<AppTarget>({ action: "focus_app", params: {}, requiresAccessibility: true, execute: () => getPlatform().focusApp!(params.app) });
    activeTargetContext = target;
    return { content: [{ type: "text", text: JSON.stringify(target, null, 2) }] };
  });
  registry.register("focus_app");

  registerTool("get_window_state", "Get detailed state of a window including accessibility tree", {
    windowId: z.string().optional().describe("Window ID"), depth: z.number().optional().describe("AX tree depth"), includeBounds: z.boolean().optional().describe("Include element bounds"),
  }, async (params) => {
    const effectiveWindowId = params.windowId || getActiveTarget()?.windowId;
    const state = await withSafety<WindowState>({ action: "get_window_state", params: {}, requiresAccessibility: true, execute: () => getPlatform().getWindowState(effectiveWindowId, params.depth, params.includeBounds) });
    return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
  });
  registry.register("get_window_state");

  registerTool("click", "Click at screen coordinates", {
    x: z.number().describe("X coordinate"), y: z.number().describe("Y coordinate"),
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button"),
    windowId: z.string().optional().describe("If set, x/y are relative to this window"),
    ...captureAfterFields,
  }, async (params) => {
    const pt = await resolvePoint(params.x, params.y, params.windowId);
    await withSafety<void>({ action: "click", params: { x: pt.x, y: pt.y }, requiresAccessibility: true, execute: () => getPlatform().click(pt.x, pt.y, params.button) });
    return actionResponse("click", { clicked: true, x: pt.x, y: pt.y }, { x: pt.x, y: pt.y, windowId: params.windowId }, params.captureAfter, params.captureFormat, params.captureMaxWidth);
  });
  registry.register("click");

  registerTool("double_click", "Double-click at screen coordinates", {
    x: z.number().describe("X coordinate"), y: z.number().describe("Y coordinate"),
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button"),
    windowId: z.string().optional().describe("If set, x/y are relative to this window"),
    ...captureAfterFields,
  }, async (params) => {
    const pt = await resolvePoint(params.x, params.y, params.windowId);
    await withSafety<void>({ action: "click", params: { x: pt.x, y: pt.y, doubleClick: true }, requiresAccessibility: true, execute: () => getPlatform().click(pt.x, pt.y, params.button, true) });
    return actionResponse("double_click", { doubleClicked: true, x: pt.x, y: pt.y }, { x: pt.x, y: pt.y, windowId: params.windowId }, params.captureAfter, params.captureFormat, params.captureMaxWidth);
  });
  registry.register("double_click");

  registerTool("type_text", "Type text at the current cursor position", {
    text: z.string().describe("Text to type"), delay: z.number().optional().describe("Delay between keystrokes in ms"),
    windowId: z.string().optional().describe("UNSUPPORTED: windowId-targeted keyboard typing is not implemented"),
    ...captureAfterFields,
  }, async (params) => {
    if (params.windowId) throw new UnsupportedParameterError("windowId-targeted keyboard typing is not implemented");
    await withSafety<void>({ action: "type_text", params: { text: params.text }, requiresAccessibility: true, execute: () => getPlatform().type(params.text, params.delay) });
    return actionResponse("type_text", { typed: true, charCount: params.text.length }, {}, params.captureAfter, params.captureFormat, params.captureMaxWidth);
  });
  registry.register("type_text");

  registerTool("press_key", "Press a keyboard shortcut", {
    keys: z.array(z.string()).optional().describe("Keys to press simultaneously"),
    key: z.string().optional().describe("Single key to press (alias for keys)"),
    modifiers: z.array(z.string()).optional().describe("Modifier keys used with key, such as cmd, shift, alt, or ctrl"),
    windowId: z.string().optional().describe("UNSUPPORTED: windowId-targeted key events are not implemented"),
    ...captureAfterFields,
  }, async (params) => {
    if (params.windowId) throw new UnsupportedParameterError("windowId-targeted key events are not implemented");
    const keys = params.keys ?? [
      ...(params.modifiers ?? []),
      ...(params.key ? [params.key] : []),
    ];
    if (keys.length === 0) throw new UnsupportedParameterError("press_key requires at least one key");
    await withSafety<void>({ action: "press_key", params: { keys }, requiresAccessibility: true, execute: () => getPlatform().key(keys) });
    return actionResponse("press_key", { pressed: true, keys }, {}, params.captureAfter, params.captureFormat, params.captureMaxWidth);
  });
  registry.register("press_key");

  registerTool("scroll", "Scroll at coordinates", {
    x: z.number().describe("X coordinate"), y: z.number().describe("Y coordinate"),
    deltaX: z.number().default(0).describe("Horizontal scroll"), deltaY: z.number().describe("Vertical scroll (negative = up)"),
    windowId: z.string().optional().describe("If set, x/y are relative to this window"),
    ...captureAfterFields,
  }, async (params) => {
    const pt = await resolvePoint(params.x, params.y, params.windowId);
    const deltaX = params.deltaX ?? 0;
    await withSafety<void>({ action: "scroll", params: { x: pt.x, y: pt.y }, requiresAccessibility: true, execute: () => getPlatform().scroll(pt.x, pt.y, deltaX, params.deltaY) });
    return actionResponse("scroll", { scrolled: true, x: pt.x, y: pt.y }, { x: pt.x, y: pt.y, windowId: params.windowId }, params.captureAfter, params.captureFormat, params.captureMaxWidth);
  });
  registry.register("scroll");

  registerTool("drag", "Drag from one point to another", {
    startX: z.number().describe("Start X"), startY: z.number().describe("Start Y"),
    endX: z.number().describe("End X"), endY: z.number().describe("End Y"),
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button"),
    windowId: z.string().optional().describe("If set, start/end coordinates are relative to this window"),
    duration: z.number().optional().describe("Drag duration in ms"),
    ...captureAfterFields,
  }, async (params) => {
    const start = await resolvePoint(params.startX, params.startY, params.windowId);
    const end = await resolvePoint(params.endX, params.endY, params.windowId);
    await withSafety<void>({ action: "drag", params: { startX: start.x, startY: start.y, endX: end.x, endY: end.y }, requiresAccessibility: true, execute: () => getPlatform().drag(start.x, start.y, end.x, end.y, params.button, params.duration) });
    return actionResponse("drag", { dragged: true, startX: start.x, startY: start.y, endX: end.x, endY: end.y }, { startX: start.x, startY: start.y, endX: end.x, endY: end.y, windowId: params.windowId }, params.captureAfter, params.captureFormat, params.captureMaxWidth);
  });
  registry.register("drag");

  registerTool("doctor", "Check system permissions, native helpers, and client readiness", {}, async () => {
    const { checkPermissions, getPermissionInstructions, getTerminalAppName } = await import("../safety/permissions.js");
    const { MacOSPlatform: MacPlat } = await import("../platform/macos.js");
    const { existsSync, statSync } = await import("node:fs");
    const { join, dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { execFileSync } = await import("node:child_process");
    const permissions = await checkPermissions();
    const screenLocked = process.platform === "darwin" ? new MacPlat().isScreenLocked?.() ?? false : false;
    const termApp = process.platform === "darwin" ? getTerminalAppName() : undefined;

    // Resolve native helper binaries across every install layout we have seen:
    //  - dev: process.cwd() === project root
    //  - npm install --prefix X: argv[1] is in X/node_modules/ucu-mcp/...
    //  - global install via npm: argv[1] is in $(npm root -g)/ucu-mcp/...
    //  - npx: argv[1] is in ~/.npm/_npx/.../node_modules/ucu-mcp/...
    //  - bin/ucu-mcp.js is the entry; dist/src/*/tools.js is the module path
    function resolveHelperPath(relParts: string[]): { path: string | null; tried: string[] } {
      const tried: string[] = [];
      const tryPaths: string[] = [];
      const moduleDir = dirname(fileURLToPath(import.meta.url));
      const argv1 = process.argv[1] ? resolve(process.argv[1]) : "";
      const argv1Dir = argv1 ? dirname(argv1) : "";
      // (1) process.cwd() — dev invocation
      tryPaths.push(join(process.cwd(), ...relParts));
      // (2) argv[1] dir — npm / npx / global
      if (argv1Dir) {
        tryPaths.push(join(argv1Dir, ...relParts));
        tryPaths.push(join(argv1Dir, "..", ...relParts));
        tryPaths.push(join(argv1Dir, "..", "..", ...relParts));
      }
      // (3) module dir — dist/bin or dist/src/mcp; walk up to 4 levels
      tryPaths.push(join(moduleDir, "..", ...relParts));
      tryPaths.push(join(moduleDir, "..", "..", ...relParts));
      tryPaths.push(join(moduleDir, "..", "..", "..", ...relParts));
      tryPaths.push(join(moduleDir, "..", "..", "..", "..", ...relParts));
      // (4) npm root -g for global install (best effort)
      if (process.platform === "darwin") {
        try {
          const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf-8", timeout: 2000 }).trim();
          if (npmRoot) {
            tryPaths.push(join(npmRoot, "ucu-mcp", ...relParts));
          }
        } catch { /* npm not on PATH is fine */ }
      }
      for (const p of tryPaths) {
        tried.push(p);
        try {
          if (existsSync(p) && statSync(p).isFile()) return { path: p, tried };
        } catch { /* skip */ }
      }
      return { path: null, tried };
    }

    let nativeHelpers:
      | { cgevent: { ok: boolean; path: string | null; tried: string[] };
          ocr: { ok: boolean; path: string | null; tried: string[] };
          windowlist: { ok: boolean; path: string | null; tried: string[] } }
      | undefined;
    if (process.platform === "darwin") {
      const cgevent = resolveHelperPath(["native", "cgevent", "cgevent-helper"]);
      const ocr = resolveHelperPath(["native", "ocr", "ocr-helper"]);
      const windowlist = resolveHelperPath(["native", "windowlist", "windowlist-helper"]);
      nativeHelpers = {
        cgevent: { ok: cgevent.path !== null, path: cgevent.path, tried: cgevent.tried.slice(0, 3) },
        ocr: { ok: ocr.path !== null, path: ocr.path, tried: ocr.tried.slice(0, 3) },
        windowlist: { ok: windowlist.path !== null, path: windowlist.path, tried: windowlist.tried.slice(0, 3) },
      };
    }

    let readiness: "ready" | "degraded" | "blocked" = "ready";
    const issues: string[] = [];
    if (!permissions.granted) {
      readiness = "blocked";
      for (const m of (permissions.missing ?? []) as Array<"accessibility" | "screenRecording">) {
        issues.push(`Missing macOS permission: ${m}`);
      }
    }
    if (screenLocked) {
      readiness = "blocked";
      issues.push("Screen is locked");
    }
    if (process.platform === "darwin" && nativeHelpers) {
      if (!nativeHelpers.cgevent.ok) {
        readiness = readiness === "ready" ? "degraded" : readiness;
        issues.push("Native CGEvent helper not found (input synthesis may crash on macOS Sequoia+). Run `npm run build` to compile it, or reinstall ucu-mcp so the helper ships from the tarball.");
      }
      if (!nativeHelpers.ocr.ok) {
        readiness = readiness === "ready" ? "degraded" : readiness;
        issues.push("Native OCR helper not found (OCR may fail on macOS Sequoia+). Run `npm run build` to compile it, or reinstall ucu-mcp so the helper ships from the tarball.");
      }
      if (!nativeHelpers.windowlist.ok) {
        readiness = readiness === "ready" ? "degraded" : readiness;
        issues.push("Native windowlist helper not found (window enumeration will fall back to slow JXA). Run `npm run build` to compile it.");
      }
    }

    // Heuristic AX hint: if Accessibility is granted but list_windows consistently
    // returns empty for the only app the model cared about, the model has likely
    // hit the Electron AX limitation (Electron windows do not expose AX to System
    // Events unless Accessibility is also granted to the Electron process itself,
    // and the app has accessibility features enabled). This block is read-only —
    // we never hit JXA here because the doctor must stay fast and side-effect free.
    const electronHint = "If the target app is Electron (e.g. CC Switch, VS Code, Discord), list_windows may return [] even with Accessibility granted to your terminal. Grant Accessibility to the Electron app itself in System Settings > Privacy & Security > Accessibility, and restart the app. Pixel-level workaround: use screenshot + ocr to locate UI elements by text, then click(x, y) at the detected bounding box coordinates. Alternatively, modify the app\'s config file or database directly.";

    const clients: Record<string, string> = {};
    for (const bin of ["claude", "codex", "opencode", "npx"]) {
      try {
        const path = execFileSync("which", [bin], { encoding: "utf-8", timeout: 2000 }).trim();
        clients[bin] = path || "not found";
      } catch {
        clients[bin] = "not found";
      }
    }

    const recommendations: string[] = [];
    if (readiness === "blocked") {
      for (const m of (permissions.missing ?? []) as Array<"accessibility" | "screenRecording">) {
        const app = termApp ?? "your terminal app";
        recommendations.push(`${m}: ${getPermissionInstructions(m)} (Grant to ${app}.)`);
      }
      if (screenLocked) recommendations.push("Unlock the screen, then retry.");
    }
    if (readiness !== "ready") {
      if (process.platform === "darwin" && nativeHelpers && (!nativeHelpers.cgevent.ok || !nativeHelpers.ocr.ok)) {
        recommendations.push("Run `npm run build` in the ucu-mcp project to compile native Swift helpers (cgevent-helper, ocr-helper, windowlist-helper).");
      }
      if (process.platform === "darwin" && nativeHelpers && !nativeHelpers.windowlist.ok) {
        recommendations.push("windowlist helper missing — list_windows will fall back to JXA (~3-6s, unreliable for Electron). Run `npm run build`.");
      }
    }
    if (readiness === "ready") {
      recommendations.push("All checks passed. MCP client can proceed with automation.");
    } else if (process.platform === "darwin") {
      recommendations.push(electronHint);
    }

    const report = {
      readiness,
      issues: issues.length > 0 ? issues : undefined,
      recommendations,
      platform: process.platform,
      node: process.version,
      permissions,
      screenLocked,
      terminalApp: termApp,
      nativeHelpers,
      clients,
      safety: {
        urlBlocklist: true,
        lockScreenGuard: process.platform === "darwin",
        typedTextInjectionScan: true,
      },
      stdioCommand: "ucu-mcp",
      metrics: {
        global: metrics.stats(),
        byTool: metrics.byTool(),
      },
    };
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  });
  registry.register("doctor");

  registerTool("wait", "Wait for a specified duration", { ms: z.number().describe("Duration in milliseconds") }, async (params) => {
    await new Promise(r => setTimeout(r, params.ms));
    return { content: [{ type: "text", text: JSON.stringify({ waited: params.ms }) }] };
  });
  registry.register("wait");

  registerTool("wait_for_element", "Poll until an accessibility element matching the criteria reaches the desired state", {
    text: z.string().optional().describe("Element text"), role: z.string().optional().describe("Element role"),
    app: z.string().optional().describe("Target app"),
    timeout: z.number().optional().describe("Timeout ms (default 5000)"),
    timeoutMs: z.number().optional().describe("Alias for timeout"),
    interval: z.number().optional().describe("Poll interval ms (default 500)"),
    intervalMs: z.number().optional().describe("Alias for interval"),
    until: z.enum(["appear", "disappear", "value_change"]).default("appear").describe("Wait condition: 'appear' (default) waits for a match, 'disappear' waits until no match, 'value_change' waits until first match's value changes"),
  }, async (params) => {
    const deadline = Date.now() + (params.timeout ?? params.timeoutMs ?? 5000);
    const interval = params.interval ?? params.intervalMs ?? 500;
    const until = params.until ?? "appear";
    const effectiveApp = params.app || getActiveTarget()?.appName;
    const query = { text: params.text, role: params.role, app: effectiveApp, maxResults: 1 };
    const { granted } = await checkPermission("accessibility");
    if (!granted) throw new PermissionError("accessibility", process.platform);
    let initialValue: string | undefined;
    let hasInitial = false;
    while (Date.now() < deadline) {
      const response = await getPlatform().findElement(query);
      const matched = response.results[0];
      if (until === "appear") {
        if (matched) return { content: [{ type: "text", text: JSON.stringify({ found: true, element: matched }, null, 2) }] };
      } else if (until === "disappear") {
        if (!matched) return { content: [{ type: "text", text: JSON.stringify({ found: true, reason: "disappeared" }, null, 2) }] };
      } else {
        // value_change: capture the initial value of the first match, then wait for it to differ.
        // A separate `hasInitial` flag is required because the first match's `value` may itself be
        // undefined; using `initialValue === undefined` to mean "not yet captured" would loop
        // forever in that case. On timeout, distinguish "element never appeared" from "value stayed
        // the same" so the model can branch on the result.
        if (matched) {
          if (!hasInitial) {
            initialValue = matched.value;
            hasInitial = true;
          } else if (matched.value !== initialValue) {
            return { content: [{ type: "text", text: JSON.stringify({ found: true, oldValue: initialValue, newValue: matched.value }, null, 2) }] };
          }
        }
      }
      await new Promise(r => setTimeout(r, interval));
    }
    const reason = until === "value_change" ? (hasInitial ? "value_unchanged" : "never_appeared") : "timeout";
    return { content: [{ type: "text", text: JSON.stringify({ found: false, reason }, null, 2) }] };
  });
  registry.register("wait_for_element");

  registerTool("get_cursor_position", "Get current cursor position", {}, async () => {
    const pos = await withSafety<CursorPosition>({ action: "get_cursor_position", params: {}, execute: () => Promise.resolve(getPlatform().getCursorPosition()) });
    return { content: [{ type: "text", text: JSON.stringify(pos, null, 2) }] };
  });
  registry.register("get_cursor_position");

  registerTool("get_screen_size", "Get screen dimensions and scale factor", {
    display: z.number().optional().describe("Display index"),
  }, async (params) => {
    return { content: [{ type: "text", text: JSON.stringify(getPlatform().getScreenSize(params.display), null, 2) }] };
  });
  registry.register("get_screen_size");

  registerTool("ocr", "Perform OCR on screen region", {
    display: z.number().optional().describe("Display index"),
    region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional().describe("Region to OCR"),
  }, async (params) => {
    const result = await withSafety<OcrResult>({ action: "ocr", params: {}, requiresScreenRecording: true, execute: () => getPlatform().ocr(params.display, params.region) });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });
  registry.register("ocr");

  registerTool("move", "Move cursor to coordinates", {
    x: z.number().describe("X coordinate"), y: z.number().describe("Y coordinate"),
    windowId: z.string().optional().describe("If set, x/y are relative to this window"),
    ...captureAfterFields,
  }, async (params) => {
    const pt = await resolvePoint(params.x, params.y, params.windowId);
    await withSafety<void>({ action: "move", params: { x: pt.x, y: pt.y }, requiresAccessibility: true, execute: () => getPlatform().move(pt.x, pt.y) });
    return actionResponse("move", { moved: true, x: pt.x, y: pt.y }, { x: pt.x, y: pt.y, windowId: params.windowId }, params.captureAfter, params.captureFormat, params.captureMaxWidth);
  });
  registry.register("move");

  registerTool("find_element", "Find accessibility elements by text, role, or value. Supports value/index/near selectors.", findElementInputSchema, async (params) => {
    const effectiveApp = params.app || getActiveTarget()?.appName;
    const response = await withSafety<FindElementResponse>({ action: "find_element", params: {}, requiresAccessibility: true,
      execute: () => getPlatform().findElement({ text: params.text, role: params.role, app: effectiveApp, depth: params.depth, includeBounds: params.includeBounds, maxResults: params.maxResults, textMode: params.textMode, visibleOnly: params.visibleOnly, value: params.value, index: params.index, near: params.near }) });
    return { content: [{ type: "text", text: JSON.stringify({ results: response.results, metrics: response.metrics }, null, 2) }] };
  });
  registry.register("find_element");

  registerTool("click_element", "Click an accessibility element by its ID", {
    elementId: z.string().describe("AX element identifier"), app: z.string().optional().describe("Target app"), ...captureAfterFields,
  }, async (params) => {
    const effectiveApp = params.app || getActiveTarget()?.appName;
    await withSafety<void>({ action: "click_element", params: {}, requiresAccessibility: true, execute: () => getPlatform().clickElement(params.elementId, effectiveApp) });
    return actionResponse("click_element", { clicked: true, elementId: params.elementId }, { elementId: params.elementId, app: effectiveApp }, params.captureAfter, params.captureFormat, params.captureMaxWidth);
  });
  registry.register("click_element");

  registerTool("set_value", "Set the value of an accessibility element", {
    elementId: z.string().describe("AX element identifier"), value: z.string().describe("Value to set"), app: z.string().optional().describe("Target app"), ...captureAfterFields,
  }, async (params) => {
    const effectiveApp = params.app || getActiveTarget()?.appName;
    await withSafety<void>({ action: "set_value", params: { value: params.value }, requiresAccessibility: true, execute: () => getPlatform().setElementValue!(params.elementId, params.value, effectiveApp) });
    return actionResponse("set_value", { setValue: true, elementId: params.elementId }, { elementId: params.elementId, app: effectiveApp }, params.captureAfter, params.captureFormat, params.captureMaxWidth);
  });
  registry.register("set_value");

  registerTool("type_in_element", "Type text into an accessibility element, optionally clearing first", {
    elementId: z.string().describe("AX element identifier"), text: z.string().describe("Text to type"),
    app: z.string().optional().describe("Target app"), clearFirst: z.boolean().optional().describe("Clear existing text before typing"), ...captureAfterFields,
  }, async (params) => {
    const effectiveApp = params.app || getActiveTarget()?.appName;
    await withSafety<void>({ action: "type_in_element", params: { text: params.text }, requiresAccessibility: true, execute: () => getPlatform().typeInElement(params.elementId, params.text, effectiveApp, params.clearFirst) });
    return actionResponse("type_in_element", { typed: true, elementId: params.elementId, charCount: params.text.length }, { elementId: params.elementId, app: effectiveApp }, params.captureAfter, params.captureFormat, params.captureMaxWidth);
  });
  registry.register("type_in_element");

  registerTool("clipboard_read", "Read the current contents of the system clipboard", {}, async () => {
    const text = await withSafety<string>({ action: "clipboard_read", params: {}, execute: () => getPlatform().readClipboard() });
    return { content: [{ type: "text", text: JSON.stringify({ text }, null, 2) }] };
  });
  registry.register("clipboard_read");

  registerTool("clipboard_write", "Write text to the system clipboard (text injection patterns are blocked)", {
    text: z.string().describe("Text to place on the clipboard"),
  }, async (params) => {
    await withSafety<void>({ action: "clipboard_write", params: { text: params.text }, execute: () => getPlatform().writeClipboard(params.text) });
    return { content: [{ type: "text", text: JSON.stringify({ written: true }, null, 2) }] };
  });
  registry.register("clipboard_write");

  log.info("Registered tools", { count: registry.tools.length, tools: registry.tools.join(", ") });

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
