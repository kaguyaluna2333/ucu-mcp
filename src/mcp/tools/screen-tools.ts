import { z } from "zod";
import type { WindowInfo, OcrResult, WindowState, ScreenSize } from "../../platform/base.js";
import { checkPermission } from "../../safety/permissions.js";
import { UnsupportedParameterError } from "../../util/errors.js";
import {
  type RegisterToolFn,
  type ToolResult,
  getPlatform,
  getActiveTarget,
  withSafety,
  jsonText,
} from "./helpers.js";

export function registerScreenTools(registerTool: RegisterToolFn): void {
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

  registerTool("list_windows", "List all visible windows on screen", {
    includeMinimized: z.boolean().optional().describe("Include minimized windows"),
  }, async (params) => {
    const windows = await withSafety<WindowInfo[]>({ action: "list_windows", params: {}, requiresAccessibility: true, execute: () => getPlatform().listWindows(params.includeMinimized) });
    let diagnostics: { hint: string; accessibility: "granted" | "denied" | "unknown" } | undefined;
    if (windows.length === 0) {
      let accessibility: "granted" | "denied" | "unknown" = "unknown";
      try {
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

  registerTool("get_window_state", "Get detailed state of a window including accessibility tree", {
    windowId: z.string().optional().describe("Window ID"), depth: z.number().optional().describe("AX tree depth"), includeBounds: z.boolean().optional().describe("Include element bounds"),
  }, async (params) => {
    const effectiveWindowId = params.windowId || getActiveTarget()?.windowId;
    const state = await withSafety<WindowState>({ action: "get_window_state", params: {}, requiresAccessibility: true, execute: () => getPlatform().getWindowState(effectiveWindowId, params.depth, params.includeBounds) });
    return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
  });

  registerTool("get_screen_size", "Get screen dimensions and scale factor", {
    display: z.number().optional().describe("Display index"),
  }, async (params) => {
    const result = await withSafety<ScreenSize>({ action: "get_screen_size", params: {}, execute: () => Promise.resolve(getPlatform().getScreenSize(params.display)) });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  registerTool("ocr", "Perform OCR on screen region", {
    display: z.number().optional().describe("Display index"),
    region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional().describe("Region to OCR"),
  }, async (params) => {
    const result = await withSafety<OcrResult>({ action: "ocr", params: {}, requiresScreenRecording: true, execute: () => getPlatform().ocr(params.display, params.region) });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });
}
