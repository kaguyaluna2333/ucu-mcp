import { z } from "zod";
import type { DispatchMethod } from "../../platform/base.js";
import { UnsupportedParameterError } from "../../util/errors.js";
import {
  type RegisterToolFn,
  getPlatform,
  getSafetyContext,
  withSafety,
  actionResponse,
  captureAfterFields,
} from "./helpers.js";

function keyDispatchWarnings(dispatch: DispatchMethod | undefined): string[] {
  return dispatch === "hid-tap" ? ["Key event dispatched via global HID tap (no target pid available; may affect foreground). Use focus_app first to enable per-process posting."] : [];
}

export function registerKeyboardTools(registerTool: RegisterToolFn): void {
  registerTool("type_text", "Type text at the current cursor position", {
    text: z.string().describe("Text to type"), delay: z.number().optional().describe("Delay between keystrokes in ms"),
    windowId: z.string().optional().describe("UNSUPPORTED: windowId-targeted keyboard typing is not implemented"),
    ...captureAfterFields,
  }, async (params) => {
    if (params.windowId) throw new UnsupportedParameterError("windowId-targeted keyboard typing is not implemented");
    const safetyCtx = await getSafetyContext();
    const dispatch = await withSafety<DispatchMethod | undefined>({ action: "type_text", params: { text: params.text, ...safetyCtx }, requiresAccessibility: true, execute: () => getPlatform().type(params.text, params.delay) });
    return actionResponse("type_text", { typed: true, charCount: params.text.length, dispatch: dispatch ?? "hid-tap" }, {}, params.captureAfter, params.captureFormat, params.captureMaxWidth, keyDispatchWarnings(dispatch));
  });

  registerTool("press_key", "Press a keyboard shortcut", {
    keys: z.array(z.string()).optional().describe("Keys to press simultaneously — special keys (enter/escape/tab/f1-f12/arrows...), single letters a-z, or single digits 0-9"),
    key: z.string().optional().describe("Single key (alias for keys) — special keys, single letter a-z, or single digit 0-9"),
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
    const safetyCtx = await getSafetyContext();
    const dispatch = await withSafety<DispatchMethod | undefined>({ action: "press_key", params: { keys, ...safetyCtx }, requiresAccessibility: true, execute: () => getPlatform().key(keys) });
    return actionResponse("press_key", { pressed: true, keys, dispatch: dispatch ?? "hid-tap" }, {}, params.captureAfter, params.captureFormat, params.captureMaxWidth, keyDispatchWarnings(dispatch));
  });
}
