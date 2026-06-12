import { execFileSync } from "node:child_process";
import type { MacOSPlatform } from "./base.js";
import type { CursorPosition } from "../base.js";
import { click as inputClick, doubleClick as inputDoubleClick, move as inputMove, drag as inputDrag, scroll as inputScroll, typeText, pressShortcut } from "../../utils/input.js";
import { PlatformError } from "../../util/errors.js";
import { rethrowInputError, errorMessage } from "./helpers.js";

export async function click(this: MacOSPlatform, x: number, y: number, button?: "left" | "right" | "middle", doubleClick?: boolean): Promise<void> {
  try {
    if (doubleClick) {
      await inputDoubleClick(x, y, button);
    } else {
      await inputClick(x, y, button);
    }
  } catch (error) {
    rethrowInputError(error, doubleClick ? "double_click" : "click");
  }
}

export async function move(this: MacOSPlatform, x: number, y: number): Promise<void> {
  try {
    await inputMove(x, y);
  } catch (error) {
    rethrowInputError(error, "move");
  }
}

export async function drag(this: MacOSPlatform, startX: number, startY: number, endX: number, endY: number, button?: "left" | "right" | "middle", duration?: number): Promise<void> {
  try {
    await inputDrag(startX, startY, endX, endY, button, duration);
  } catch (error) {
    rethrowInputError(error, "drag");
  }
}

export async function scroll(this: MacOSPlatform, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
  try {
    await inputScroll(x, y, deltaX, deltaY);
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

export async function type(this: MacOSPlatform, text: string, delay?: number): Promise<void> {
  await typeText(text, delay);
}

export async function key(this: MacOSPlatform, keys: string[]): Promise<void> {
  await pressShortcut(keys);
}
