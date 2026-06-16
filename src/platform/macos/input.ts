import { execFileSync } from "node:child_process";
import type { MacOSPlatform } from "./base.js";
import type { CursorPosition } from "../base.js";
import { click as inputClick, doubleClick as inputDoubleClick, move as inputMove, drag as inputDrag, scroll as inputScroll, typeText, pressShortcut, type InputTarget } from "../../utils/input.js";
import type { DispatchMethod } from "../base.js";
import { PlatformError } from "../../util/errors.js";
import { rethrowInputError, errorMessage } from "./helpers.js";

/** Resolve the per-process event target from the active focus_app target (pid + windowNumber). */
function targetOf(this: MacOSPlatform): InputTarget | undefined {
  const t = this.activeTarget;
  if (!t || !t.pid || t.pid <= 0) return undefined;
  return { pid: t.pid, windowNumber: t.windowNumber };
}

export async function click(this: MacOSPlatform, x: number, y: number, button?: "left" | "right" | "middle", doubleClick?: boolean): Promise<DispatchMethod | void> {
  try {
    const target = targetOf.call(this);
    if (doubleClick) {
      return await inputDoubleClick(x, y, button, process.platform, target);
    } else {
      return await inputClick(x, y, button, process.platform, target);
    }
  } catch (error) {
    rethrowInputError(error, doubleClick ? "double_click" : "click");
  }
}

export async function move(this: MacOSPlatform, x: number, y: number): Promise<DispatchMethod | void> {
  try {
    return await inputMove(x, y, process.platform, targetOf.call(this));
  } catch (error) {
    rethrowInputError(error, "move");
  }
}

export async function drag(this: MacOSPlatform, startX: number, startY: number, endX: number, endY: number, button?: "left" | "right" | "middle", duration?: number): Promise<DispatchMethod | void> {
  try {
    return await inputDrag(startX, startY, endX, endY, button, duration, process.platform, targetOf.call(this));
  } catch (error) {
    rethrowInputError(error, "drag");
  }
}

export async function scroll(this: MacOSPlatform, x: number, y: number, deltaX: number, deltaY: number): Promise<DispatchMethod | void> {
  try {
    return await inputScroll(x, y, deltaX, deltaY, process.platform, targetOf.call(this));
  } catch (error) {
    rethrowInputError(error, "scroll");
  }
}

export function getCursorPosition(this: MacOSPlatform): CursorPosition {
  try {
    const out = execFileSync("osascript", [
      "-l", "JavaScript",
      "-e",
      `ObjC.import('AppKit');
      var pt = $.NSEvent.mouseLocation;
      JSON.stringify({x:Math.round(pt.x),y:Math.round($.NSScreen.mainScreen.frame.size.height - pt.y)});`,
    ], { encoding: "utf-8", timeout: 5000 }).trim();
    return JSON.parse(out) as CursorPosition;
  } catch (error) {
    throw new PlatformError(`get_cursor_position failed: ${errorMessage(error)}`);
  }
}

export async function type(this: MacOSPlatform, text: string, delay?: number): Promise<DispatchMethod | void> {
  return await typeText(text, delay, process.platform, targetOf.call(this));
}

export async function key(this: MacOSPlatform, keys: string[]): Promise<DispatchMethod | void> {
  return await pressShortcut(keys, process.platform, targetOf.call(this));
}
