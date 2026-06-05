import type { Platform, ScreenRegion, ScreenSize, CursorPosition, WindowInfo, WindowState, OcrResult, FindElementOptions, FindElementResponse } from "./base.js";

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

  async clickElement(_elementId: string, _app?: string): Promise<void> {
    throw new Error("Not implemented: Linux clickElement");
  }

  async typeInElement(_elementId: string, _text: string, _app?: string, _clearFirst?: boolean): Promise<void> {
    throw new Error("Not implemented: Linux typeInElement");
  }
}
