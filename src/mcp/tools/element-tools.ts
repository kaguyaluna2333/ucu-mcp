import { z } from "zod";
import type { FindElementResponse } from "../../platform/base.js";
import {
  type RegisterToolFn,
  getPlatform,
  getActiveTarget,
  getSafetyContext,
  withSafety,
  actionResponse,
  captureAfterFields,
} from "./helpers.js";

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

export function registerElementTools(registerTool: RegisterToolFn): void {
  registerTool("find_element", "Find accessibility elements by text, role, or value. Supports value/index/near selectors.", findElementInputSchema, async (params) => {
    const effectiveApp = params.app || getActiveTarget()?.appName;
    const safetyCtx = await getSafetyContext(undefined);
    const response = await withSafety<FindElementResponse>({ action: "find_element", params: { ...safetyCtx }, requiresAccessibility: true,
      execute: () => getPlatform().findElement({ text: params.text, role: params.role, app: effectiveApp, depth: params.depth, includeBounds: params.includeBounds, maxResults: params.maxResults, textMode: params.textMode, visibleOnly: params.visibleOnly, value: params.value, index: params.index, near: params.near }) });
    // Security: mask password/secret field values before returning to the model.
    const SENSITIVE_RE = /password|passwd|secret|pincode|pin\b|token|credential|api[_-]?key|access[_-]?key|private[_-]?key/i;
    const SENSITIVE_ROLES = new Set(["AXSecureTextField", "AXPasswordField"]);
    for (const r of response.results) {
      if (SENSITIVE_ROLES.has(r.role) || SENSITIVE_RE.test(r.name || "")) {
        r.value = "[REDACTED]";
      }
    }
    const payload: Record<string, unknown> = { results: response.results, metrics: response.metrics };
    if (response.results.length === 0 && effectiveApp && response.metrics.scannedCount === 0) {
      payload.hint =
        `${effectiveApp} returned 0 AX elements (scannedCount=0, meaning the AX tree is empty). ` +
        "This is typical for Electron/Chromium apps whose AX tree is not exposed to System Events. " +
        "Pixel-level workaround: call screenshot to capture the screen, then ocr to locate " +
        "the target UI text and get its bounding box coordinates, then click(x, y) at those " +
        "screen coordinates. Alternatively, use type_text or press_key for keyboard-based " +
        "interaction, or modify the app's config file or database directly.";
    }
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  });

  registerTool("click_element", "Click an accessibility element by its ID", {
    elementId: z.string().describe("AX element identifier"), app: z.string().optional().describe("Target app"), ...captureAfterFields,
  }, async (params) => {
    const effectiveApp = params.app || getActiveTarget()?.appName;
    const safetyCtx = await getSafetyContext();
    const clickResult = await withSafety<import("../../platform/base.js").ClickResult>({ action: "click_element", params: { ...safetyCtx }, requiresAccessibility: true, execute: () => getPlatform().clickElement(params.elementId, effectiveApp) });
    const warnings = clickResult.verified
      ? []
      : [clickResult.method === "coordinate"
        ? "AXPress produced no observable state change (or the app is known to silently swallow it); coordinate fallback was used. Re-observe with screenshot/get_window_state to confirm."
        : "AXPress completed but the element exposed no observable state to verify against. Re-observe with screenshot/get_window_state to confirm."];
    return actionResponse("click_element", { clicked: true, elementId: params.elementId, method: clickResult.method, verified: clickResult.verified }, { elementId: params.elementId, app: effectiveApp }, params.captureAfter, params.captureFormat, params.captureMaxWidth, warnings);
  });

  registerTool("set_value", "Set the value of an accessibility element", {
    elementId: z.string().describe("AX element identifier"), value: z.string().describe("Value to set"), app: z.string().optional().describe("Target app"), ...captureAfterFields,
  }, async (params) => {
    const effectiveApp = params.app || getActiveTarget()?.appName;
    const safetyCtx = await getSafetyContext();
    await withSafety<void>({ action: "set_value", params: { value: params.value, ...safetyCtx }, requiresAccessibility: true, execute: () => getPlatform().setElementValue!(params.elementId, params.value, effectiveApp) });
    return actionResponse("set_value", { setValue: true, elementId: params.elementId }, { elementId: params.elementId, app: effectiveApp }, params.captureAfter, params.captureFormat, params.captureMaxWidth);
  });

  registerTool("type_in_element", "Type text into an accessibility element, optionally clearing first", {
    elementId: z.string().describe("AX element identifier"), text: z.string().describe("Text to type"),
    app: z.string().optional().describe("Target app"), clearFirst: z.boolean().optional().describe("Clear existing text before typing"), ...captureAfterFields,
  }, async (params) => {
    const effectiveApp = params.app || getActiveTarget()?.appName;
    const safetyCtx = await getSafetyContext();
    await withSafety<void>({ action: "type_in_element", params: { text: params.text, ...safetyCtx }, requiresAccessibility: true, execute: () => getPlatform().typeInElement(params.elementId, params.text, effectiveApp, params.clearFirst) });
    return actionResponse("type_in_element", { typed: true, elementId: params.elementId, charCount: params.text.length }, { elementId: params.elementId, app: effectiveApp }, params.captureAfter, params.captureFormat, params.captureMaxWidth);
  });

  registerTool("click_menu_bar_extra", "Click a menu bar status item (tray icon) — for menu-bar-only apps (e.g. cc-switch) that focus_app cannot target. After clicking, the menu opens; use find_element to locate menu items, or screenshot + ocr if the menu's AX tree is opaque.", {
    app: z.string().describe("Target app name"),
    description: z.string().optional().describe("Match menu bar item by description/name substring"),
    name: z.string().optional().describe("Match menu bar item by name/description substring"),
    index: z.number().int().nonnegative().optional().describe("0-based index among matched items (default 0)"),
    ...captureAfterFields,
  }, async (params) => {
    const safetyCtx = await getSafetyContext();
    const clickResult = await withSafety<import("../../platform/base.js").ClickResult>({ action: "click_menu_bar_extra", params: { ...safetyCtx }, requiresAccessibility: true, execute: () => getPlatform().clickMenuBarExtra!(params.app, { description: params.description, name: params.name, index: params.index }) });
    const warnings = clickResult.verified
      ? []
      : [clickResult.method === "coordinate"
        ? "AXPress produced no observable state change; coordinate fallback was used. Use find_element or screenshot to confirm the menu opened."
        : "AXPress completed but the status item exposed no observable state to verify against. Use find_element or screenshot to confirm the menu opened."];
    return actionResponse("click_menu_bar_extra", { clicked: true, app: params.app, method: clickResult.method, verified: clickResult.verified }, { app: params.app }, params.captureAfter, params.captureFormat, params.captureMaxWidth, warnings);
  });
}
