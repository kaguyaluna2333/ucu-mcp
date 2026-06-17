import { z } from "zod";
import type { WindowInfo, OcrResult, WindowState, ScreenSize, ScreenDescription, ElementInfo } from "../../platform/base.js";
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

/** Sensitive-field detection regex for AX tree masking (password fields, secrets). */
const SENSITIVE_NAME_RE = /password|passwd|secret|pincode|pin\b|token|credential/i;
const SENSITIVE_ROLES = new Set(["AXSecureTextField", "AXPasswordField"]);

/**
 * Recursively mask values of password / secret fields in an AX subtree.
 * Mutates in place. Covers AXSecureTextField role and heuristic name matches.
 */
function maskSensitiveFields(el: ElementInfo | undefined): void {
  if (!el) return;
  const isSensitive = SENSITIVE_ROLES.has(el.role) || SENSITIVE_NAME_RE.test(el.name || "") || SENSITIVE_NAME_RE.test(el.description || "");
  if (isSensitive && el.value) el.value = "[REDACTED]";
  if (el.children) for (const child of el.children) maskSensitiveFields(child);
}

interface BuildScreenDescriptionOpts {
  display?: number;
  runOcr: boolean;
  includeAx: boolean;
  axDepth: number;
  ocrBlocks: number;
  windowId?: string;
}

/**
 * Build a structured ScreenDescription — each source (screen / foreground / OCR / AX)
 * is collected independently inside try/catch. Failures go to `errors` and set the
 * corresponding status; the function never throws. This is the text fallback for
 * environments where image content blocks are downgraded to URLs.
 *
 * Sources are collected concurrently because they have no data dependencies.
 */
async function buildScreenDescription(opts: BuildScreenDescriptionOpts): Promise<ScreenDescription> {
  const platform = getPlatform();
  const errors: ScreenDescription["errors"] = [];
  const capturedAt = new Date().toISOString();

  type SourceResult<T> =
    | { ok: true; value: T; error?: undefined }
    | { ok: false; value?: T; error: string };

  const collectScreen = async (): Promise<SourceResult<ScreenSize>> => {
    try {
      return { ok: true, value: platform.getScreenSize(opts.display) };
    } catch (e) {
      return { ok: false, error: `getScreenSize failed: ${(e as Error).message}` };
    }
  };

  const collectForeground = async (): Promise<SourceResult<WindowInfo | undefined>> => {
    try {
      if (!platform.listApps) return { ok: true, value: undefined };
      const apps = await platform.listApps();
      const front = apps.find((a) => a.isFrontmost);
      if (!front) return { ok: true, value: undefined };
      const wins = await platform.listWindows(true);
      return { ok: true, value: wins.find((w) => w.processName === front.name && w.isOnScreen) };
    } catch (e) {
      return { ok: false, error: `foreground window resolution failed: ${(e as Error).message}` };
    }
  };

  const collectOcr = async (): Promise<SourceResult<ScreenDescription["ocr"]>> => {
    if (!opts.runOcr) {
      return { ok: true, value: { blocks: [], fullText: "", status: "skipped" } };
    }
    try {
      const result: OcrResult = await platform.ocr(opts.display);
      return {
        ok: true,
        value: {
          blocks: result.elements.slice(0, opts.ocrBlocks),
          fullText: result.fullText,
          status: "ok",
        },
      };
    } catch (e) {
      return {
        ok: false,
        value: { blocks: [], fullText: "", status: "failed" },
        error: `ocr failed: ${(e as Error).message}`,
      };
    }
  };

  const collectAx = async (): Promise<SourceResult<ScreenDescription["ax"]>> => {
    if (!opts.includeAx) {
      return { ok: true, value: { status: "skipped" } };
    }
    const effectiveWindowId = opts.windowId ?? getActiveTarget()?.windowId;
    try {
      const cappedDepth = Math.min(opts.axDepth, 10);
      const state: WindowState = await platform.getWindowState(effectiveWindowId, cappedDepth, true);
      maskSensitiveFields(state.tree);
      maskSensitiveFields(state.focusedElement);
      return {
        ok: true,
        value: { elements: state.tree, status: "ok", windowId: effectiveWindowId },
      };
    } catch (e) {
      return {
        ok: false,
        value: { status: "failed", windowId: effectiveWindowId },
        error: `getWindowState failed: ${(e as Error).message}`,
      };
    }
  };

  const [screenResult, foregroundResult, ocrResult, axResult] = await Promise.all([
    collectScreen(),
    collectForeground(),
    collectOcr(),
    collectAx(),
  ]);

  const screen = screenResult.ok
    ? screenResult.value
    : { width: 0, height: 0, scaleFactor: 1, estimated: true };
  if (!screenResult.ok) errors.push({ source: "screen", message: screenResult.error });

  const foregroundWindow = foregroundResult.ok ? foregroundResult.value : undefined;
  if (!foregroundResult.ok) errors.push({ source: "foreground", message: foregroundResult.error });

  const ocr = ocrResult.ok ? ocrResult.value : ocrResult.value ?? { blocks: [], fullText: "", status: "failed" };
  if (!ocrResult.ok) errors.push({ source: "ocr", message: ocrResult.error! });

  const ax = axResult.ok ? axResult.value : axResult.value ?? { status: "failed" };
  if (!axResult.ok) errors.push({ source: "ax", message: axResult.error! });

  return { capturedAt, screen, foregroundWindow, ocr, ax, errors };
}

export function registerScreenTools(registerTool: RegisterToolFn): void {
  registerTool("screenshot", "Capture a screenshot of the entire screen or a region. Set describe=true to also append a structured text description (OCR + AX tree) — useful when image content blocks may not be visible to the model.", {
    display: z.number().optional().describe("Display index (default 0)"),
    windowId: z.string().optional().describe("Window ID from list_windows; when set, captures that window"),
    region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional().describe("Region to capture"),
    format: z.enum(["png", "jpeg"]).default("png").describe("Image format"),
    maxWidth: z.number().default(1280).describe("Maximum output width in pixels. Aspect ratio is preserved."),
    describe: z.boolean().default(false).describe("When true, append a text content block with a structured screen description (OCR + AX tree) after the image"),
    describeOptions: z.object({
      axDepth: z.number().int().positive().default(3).describe("AX tree depth (capped at 10)"),
      ocrBlocks: z.number().int().positive().default(50).describe("Max OCR blocks to include"),
      includeAx: z.boolean().default(true).describe("Include the AX tree in the description"),
    }).optional().describe("Options for the appended description (only used when describe=true)"),
  }, async (params) => {
    if (params.windowId && params.region) throw new UnsupportedParameterError("screenshot windowId cannot be combined with region");
    const options = { format: params.format, maxWidth: params.maxWidth };
    const screenshotPromise = withSafety<Buffer>({
      action: "screenshot",
      params,
      requiresScreenRecording: true,
      execute: () => params.windowId
        ? getPlatform().screenshotWindow
          ? getPlatform().screenshotWindow!(params.windowId, options)
          : Promise.reject(new UnsupportedParameterError("window screenshots are not implemented on this platform"))
        : getPlatform().screenshot(params.display, params.region, options),
    });

    const describeOpts = params.describeOptions ?? { axDepth: 3, ocrBlocks: 50, includeAx: true } as const;
    const descriptionPromise = params.describe
      ? buildScreenDescription({
          display: params.display,
          runOcr: true,
          includeAx: describeOpts.includeAx ?? true,
          axDepth: describeOpts.axDepth ?? 3,
          ocrBlocks: describeOpts.ocrBlocks ?? 50,
          windowId: params.windowId,
        })
      : Promise.resolve(undefined);

    const [buf, desc] = await Promise.all([screenshotPromise, descriptionPromise]);

    const content: ToolResult["content"] = [{ type: "image", data: buf.toString("base64"), mimeType: `image/${params.format}` }];
    if (desc) {
      content.push(jsonText(desc));
    }
    return { content };
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

  registerTool("describe_screen", "Get a structured text description of the screen (OCR blocks + AX tree + foreground window). Use this when image content blocks are not visible to the model (e.g. relayed/downgraded to URLs) or when you need a machine-readable screen layout. With ocr=false it does not require Screen Recording. Sensitive fields (passwords) are masked.", {
    display: z.number().optional().describe("Display index (default 0)"),
    ocr: z.boolean().default(true).describe("Run OCR and include text blocks (requires Screen Recording)"),
    includeAx: z.boolean().default(true).describe("Include the AX tree of the foreground/active window"),
    axDepth: z.number().int().positive().default(3).describe("AX tree depth (capped at 10)"),
    ocrBlocks: z.number().int().positive().default(50).describe("Max OCR blocks to include"),
    windowId: z.string().optional().describe("Window ID for AX traversal (defaults to active target's window)"),
  }, async (params) => {
    const desc = await withSafety<ScreenDescription>({
      action: "describe_screen",
      params,
      requiresScreenRecording: params.ocr,
      requiresAccessibility: params.includeAx,
      // describe_screen never throws from inner source failures (they go to errors[]),
      // but withSafety still needs to enforce rate-limit / lock / dry-run semantics around it.
      execute: () => buildScreenDescription({
        display: params.display,
        runOcr: params.ocr,
        includeAx: params.includeAx,
        axDepth: params.axDepth,
        ocrBlocks: params.ocrBlocks,
        windowId: params.windowId,
      }),
    });
    return { content: [jsonText(desc)] };
  });
}
