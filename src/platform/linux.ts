import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Platform, ScreenRegion, ScreenSize, CursorPosition, WindowInfo, WindowState, OcrResult, FindElementOptions, FindElementResponse, ClickResult } from "./base.js";
import { PlatformError } from "../util/errors.js";

/** Pick the first available clipboard utility, preferring xclip. */
function pickClipboardTool(): "xclip" | "xsel" | undefined {
  for (const bin of ["/usr/bin/xclip", "/usr/local/bin/xclip", "xclip"] as const) {
    if (bin.startsWith("/") ? existsSync(bin) : which(bin)) return "xclip";
  }
  for (const bin of ["/usr/bin/xsel", "/usr/local/bin/xsel", "xsel"] as const) {
    if (bin.startsWith("/") ? existsSync(bin) : which(bin)) return "xsel";
  }
  return undefined;
}

function which(bin: string): boolean {
  try {
    execFileSync("which", [bin], { encoding: "utf-8", timeout: 2000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Linux platform adapter (AT-SPI2 + xdotool fallback)
 * TODO: Implement with D-Bus AT-SPI2 bindings
 */
export class LinuxPlatform implements Platform {
  async screenshot(display?: number, region?: ScreenRegion): Promise<Buffer> {
    // TODO: Use scrot or grim (Wayland)
    throw new Error("Linux adapter not yet implemented");
  }

  getScreenSize(display?: number): ScreenSize {
    // TODO: Use xrandr or xdpyinfo
    throw new Error("Linux adapter not yet implemented");
  }

  async listWindows(_includeMinimized?: boolean): Promise<WindowInfo[]> {
    throw new Error("Not implemented: Linux listWindows");
  }

  async getWindowState(_windowId?: string, _depth?: number, _includeBounds?: boolean): Promise<WindowState> {
    // TODO: Implement using AT-SPI2 D-Bus bindings
    throw new Error("Not implemented: Linux getWindowState");
  }

  async click(x: number, y: number, button: "left" | "right" | "middle" = "left", doubleClick = false): Promise<void> {
    // TODO: Use xdotool click
    throw new Error("Linux adapter not yet implemented");
  }

  async move(x: number, y: number): Promise<void> {
    // TODO: Use xdotool mousemove
    throw new Error("Linux adapter not yet implemented");
  }

  async drag(startX: number, startY: number, endX: number, endY: number, button: "left" | "right" | "middle" = "left", duration?: number): Promise<void> {
    // TODO: Use xdotool mousedown + mousemove + mouseup
    throw new Error("Linux adapter not yet implemented");
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    // TODO: Use xdotool mousewheel
    throw new Error("Linux adapter not yet implemented");
  }

  getCursorPosition(): CursorPosition {
    // TODO: Use xdotool getmouselocation
    throw new Error("Linux adapter not yet implemented");
  }

  async type(text: string, delay?: number): Promise<void> {
    // TODO: Use xdotool type
    throw new Error("Linux adapter not yet implemented");
  }

  async key(keys: string[]): Promise<void> {
    // TODO: Use xdotool key
    throw new Error("Linux adapter not yet implemented");
  }

  async ocr(_display?: number, _region?: ScreenRegion): Promise<OcrResult> {
    // TODO: Use tesseract or similar
    throw new Error("Linux OCR not yet implemented");
  }

  async findElement(_options: FindElementOptions): Promise<FindElementResponse> {
    throw new Error("Not implemented: Linux findElement");
  }

  async clickElement(_elementId: string, _app?: string): Promise<ClickResult> {
    throw new Error("Not implemented: Linux clickElement");
  }

  async typeInElement(_elementId: string, _text: string, _app?: string, _clearFirst?: boolean): Promise<void> {
    throw new Error("Not implemented: Linux typeInElement");
  }

  async readClipboard(): Promise<string> {
    const tool = pickClipboardTool();
    if (!tool) {
      throw new PlatformError("readClipboard requires xclip or xsel on PATH", false);
    }
    try {
      const args = tool === "xclip" ? ["-selection", "clipboard", "-o"] : ["--clipboard", "--output"];
      const out = execFileSync(tool, args, { encoding: "utf-8", timeout: 5000 });
      return out;
    } catch (error) {
      throw new PlatformError(`read_clipboard failed: ${(error as Error).message}`);
    }
  }

  async writeClipboard(text: string): Promise<void> {
    const tool = pickClipboardTool();
    if (!tool) {
      throw new PlatformError("writeClipboard requires xclip or xsel on PATH", false);
    }
    try {
      const args = tool === "xclip" ? ["-selection", "clipboard"] : ["--clipboard", "--input"];
      execFileSync(tool, args, { input: text, encoding: "utf-8", timeout: 5000 });
    } catch (error) {
      throw new PlatformError(`write_clipboard failed: ${(error as Error).message}`);
    }
  }
}
