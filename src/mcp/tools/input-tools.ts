import { z } from "zod";
import type { CursorPosition } from "../../platform/base.js";
import {
  type RegisterToolFn,
  getPlatform,
  resolvePoint,
  getSafetyContext,
  withSafety,
  actionResponse,
  captureAfterFields,
} from "./helpers.js";

export function registerInputTools(registerTool: RegisterToolFn): void {
  registerTool("click", "Click at screen coordinates", {
    x: z.number().describe("X coordinate"), y: z.number().describe("Y coordinate"),
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button"),
    windowId: z.string().optional().describe("If set, x/y are relative to this window"),
    ...captureAfterFields,
  }, async (params) => {
    const pt = await resolvePoint(params.x, params.y, params.windowId);
    const safetyCtx = await getSafetyContext(params.windowId);
    await withSafety<void>({ action: "click", params: { x: pt.x, y: pt.y, ...safetyCtx }, requiresAccessibility: true, execute: () => getPlatform().click(pt.x, pt.y, params.button) });
    return actionResponse("click", { clicked: true, x: pt.x, y: pt.y }, { x: pt.x, y: pt.y, windowId: params.windowId }, params.captureAfter, params.captureFormat, params.captureMaxWidth);
  });

  registerTool("double_click", "Double-click at screen coordinates", {
    x: z.number().describe("X coordinate"), y: z.number().describe("Y coordinate"),
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button"),
    windowId: z.string().optional().describe("If set, x/y are relative to this window"),
    ...captureAfterFields,
  }, async (params) => {
    const pt = await resolvePoint(params.x, params.y, params.windowId);
    const safetyCtx = await getSafetyContext(params.windowId);
    await withSafety<void>({ action: "double_click", params: { x: pt.x, y: pt.y, doubleClick: true, ...safetyCtx }, requiresAccessibility: true, execute: () => getPlatform().click(pt.x, pt.y, params.button, true) });
    return actionResponse("double_click", { doubleClicked: true, x: pt.x, y: pt.y }, { x: pt.x, y: pt.y, windowId: params.windowId }, params.captureAfter, params.captureFormat, params.captureMaxWidth);
  });

  registerTool("scroll", "Scroll at coordinates", {
    x: z.number().describe("X coordinate"), y: z.number().describe("Y coordinate"),
    deltaX: z.number().default(0).describe("Horizontal scroll"), deltaY: z.number().describe("Vertical scroll (negative = up)"),
    windowId: z.string().optional().describe("If set, x/y are relative to this window"),
    ...captureAfterFields,
  }, async (params) => {
    const pt = await resolvePoint(params.x, params.y, params.windowId);
    const deltaX = params.deltaX ?? 0;
    const safetyCtx = await getSafetyContext(params.windowId);
    await withSafety<void>({ action: "scroll", params: { x: pt.x, y: pt.y, ...safetyCtx }, requiresAccessibility: true, execute: () => getPlatform().scroll(pt.x, pt.y, deltaX, params.deltaY) });
    return actionResponse("scroll", { scrolled: true, x: pt.x, y: pt.y }, { x: pt.x, y: pt.y, windowId: params.windowId }, params.captureAfter, params.captureFormat, params.captureMaxWidth);
  });

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
    const safetyCtx = await getSafetyContext(params.windowId);
    await withSafety<void>({ action: "drag", params: { startX: start.x, startY: start.y, endX: end.x, endY: end.y, ...safetyCtx }, requiresAccessibility: true, execute: () => getPlatform().drag(start.x, start.y, end.x, end.y, params.button, params.duration) });
    return actionResponse("drag", { dragged: true, startX: start.x, startY: start.y, endX: end.x, endY: end.y }, { startX: start.x, startY: start.y, endX: end.x, endY: end.y, windowId: params.windowId }, params.captureAfter, params.captureFormat, params.captureMaxWidth);
  });

  registerTool("move", "Move cursor to coordinates", {
    x: z.number().describe("X coordinate"), y: z.number().describe("Y coordinate"),
    windowId: z.string().optional().describe("If set, x/y are relative to this window"),
    ...captureAfterFields,
  }, async (params) => {
    const pt = await resolvePoint(params.x, params.y, params.windowId);
    const safetyCtx = await getSafetyContext(params.windowId);
    await withSafety<void>({ action: "move", params: { x: pt.x, y: pt.y, ...safetyCtx }, requiresAccessibility: true, execute: () => getPlatform().move(pt.x, pt.y) });
    return actionResponse("move", { moved: true, x: pt.x, y: pt.y }, { x: pt.x, y: pt.y, windowId: params.windowId }, params.captureAfter, params.captureFormat, params.captureMaxWidth);
  });

  registerTool("get_cursor_position", "Get current cursor position", {}, async () => {
    const pos = await withSafety<CursorPosition>({ action: "get_cursor_position", params: {}, execute: () => Promise.resolve(getPlatform().getCursorPosition()) });
    return { content: [{ type: "text", text: JSON.stringify(pos, null, 2) }] };
  });
}
