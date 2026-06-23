import { z } from "zod";
import type { Platform, AppTarget } from "../../platform/base.js";
import { MacOSPlatform } from "../../platform/macos/index.js";
import { SafetyGuard, classifyAction } from "../../safety/guard.js";
import { checkPermission } from "../../safety/permissions.js";
import { retry } from "../../util/retry.js";
import { metrics } from "../../util/metrics.js";
import { SafetyError, PermissionError, UcuError, WindowNotFoundError } from "../../util/errors.js";

let _platform: Platform | undefined;
export function getPlatform(): Platform {
  if (!_platform) {
    _platform = process.platform === "darwin" ? new MacOSPlatform() : undefined as never;
  }
  return _platform;
}

/** @internal Test-only injection point. */
export function __setPlatformForTesting(platform: Platform | undefined): void {
  _platform = platform;
}
export const safety = new SafetyGuard();

let activeTargetContext: AppTarget | undefined;

export function getActiveTarget(): AppTarget | undefined {
  return activeTargetContext;
}

export function setActiveTarget(target: AppTarget): void {
  activeTargetContext = target;
}

let lastCursorPos = { x: 0, y: 0 };
let userActivityInterval: ReturnType<typeof setInterval> | undefined;

export const captureAfterFields = {
  captureAfter: z.boolean().default(false).describe("Take a screenshot after the action completes and include it in the response"),
  captureMaxWidth: z.number().default(1280).describe("Maximum width for the post-action screenshot"),
  captureFormat: z.enum(["png", "jpeg"]).default("jpeg").describe("Format for the post-action screenshot"),
};

export async function resolvePoint(x: number, y: number, windowId?: string): Promise<{ x: number; y: number }> {
  if (!windowId) return { x, y };
  const win = (await getPlatform().listWindows()).find(w => w.id === windowId);
  if (!win) throw new WindowNotFoundError(windowId);
  return { x: win.bounds.x + x, y: win.bounds.y + y };
}

export async function getSafetyContext(windowId?: string): Promise<{ windowTitle?: string; url?: string }> {
  const target = activeTargetContext;
  const effectiveWindowId = windowId ?? target?.windowId;

  // Resolve window title and browser URL concurrently; they have no dependency.
  const [windowTitleResult, urlResult] = await Promise.all([
    (async (): Promise<string | undefined> => {
      if (!effectiveWindowId) return undefined;
      try {
        const windows = await getPlatform().listWindows();
        const win = windows.find((w) => w.id === effectiveWindowId);
        return win?.title;
      } catch {
        /* best effort */
        return undefined;
      }
    })(),
    (async (): Promise<string | undefined> => {
      const platform = getPlatform();
      if (!platform.getActiveBrowserContext) return undefined;
      try {
        const appName = target?.appName;
        const ctx = await platform.getActiveBrowserContext(appName);
        return ctx?.url;
      } catch {
        /* best effort */
        return undefined;
      }
    })(),
  ]);

  const windowTitle = windowTitleResult || target?.title;
  const url = urlResult;

  return { windowTitle, url };
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolResult = { content: ToolContent[]; isError?: boolean };

export function jsonText(value: unknown): ToolContent {
  return { type: "text", text: JSON.stringify(value, null, 2) };
}

export function recoveryHint(code: string): string {
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

export function errorDetails(error: unknown): Record<string, unknown> {
  const err = error instanceof Error ? error : new Error(String(error));
  const code = error instanceof UcuError ? error.code : "UNKNOWN_ERROR";
  const retryable = error instanceof UcuError ? error.retryable : false;
  const inlineHint = err instanceof UcuError ? err.hint : undefined;
  const details: Record<string, unknown> = {
    name: err.name,
    code,
    retryable,
    message: err.message,
    recovery: recoveryHint(code),
  };
  if (inlineHint) {
    details.hint = inlineHint;
  }
  return details;
}

export interface ActionReceipt {
  actionId: string;
  action: string;
  status: "ok" | "partial" | "blocked";
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
  result: Record<string, unknown>;
  capture: {
    requested: boolean;
    status: "ok" | "skipped" | "error";
    format?: string;
    maxWidth?: number;
    error?: Record<string, unknown>;
  };
  warnings: string[];
  next: string;
}

let _actionCounter = 0;
function nextActionId(): string {
  _actionCounter = (_actionCounter + 1) % 1_000_000;
  return `a${Date.now().toString(36)}-${_actionCounter.toString(36)}`;
}

export function buildActionReceipt(
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

export function mcpErrorResponse(error: unknown): ToolResult {
  return {
    isError: true,
    content: [
      jsonText({
        error: errorDetails(error),
      }),
    ],
  };
}

export async function actionResponse(
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

export interface SafetyAction {
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

export type RegisterToolFn = (
  name: string,
  description: string,
  schema: Record<string, z.ZodTypeAny>,
  handler: (params: any) => Promise<ToolResult>,
) => void;

export async function withSafety<T>(sa: SafetyAction): Promise<T> {
  const platform = getPlatform();
  if (platform.isScreenLocked?.()) throw new SafetyError("Screen is locked");
  const check = safety.checkAction(sa.action, sa.params, {
    skipUserActivityPause: sa.skipUserActivityPause ?? classifyAction(sa.action) === "observe",
  });
  if (!check.allowed) throw new SafetyError(check.reason ?? "Action blocked by safety guard");
  if (sa.requiresAccessibility) { const { granted } = await checkPermission("accessibility"); if (!granted) throw new PermissionError("accessibility", process.platform); }
  if (sa.requiresScreenRecording) { const { granted } = await checkPermission("screenRecording"); if (!granted) throw new PermissionError("screenRecording", process.platform); }
  if (sa.dryRun) return `[DRY-RUN] ${await sa.dryRun()}` as T;
  const start = Date.now();
  try {
    return retryableActions.has(sa.action)
      ? await retry(() => sa.execute() as Promise<T>)
      : await sa.execute() as T;
  } finally {
    metrics.record(sa.action, Date.now() - start);
  }
}

// ponytail: polls getCursorPosition (sync osascript spawn) every 500ms for the
// whole server lifetime, blocking the event loop ~100ms/tick. Faster fix =
// cgevent-helper cursor command, but CGEvent.location's coordinate origin vs
// NSEvent.mouseLocation (flipped) needs verification first — left as ceiling.
// Widen the interval or move to cgevent when event-loop latency shows up.
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
  }, 500);
  (userActivityInterval as NodeJS.Timeout).unref?.();
}

export function stopUserActivityMonitor(): void {
  if (userActivityInterval) {
    clearInterval(userActivityInterval);
    userActivityInterval = undefined;
  }
}
