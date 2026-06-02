import type { Platform, ScreenRegion, ScreenSize, CursorPosition, WindowInfo, WindowState, OcrResult, FindElementOptions, FindElementResult } from "./base.js";

export class WindowsPlatform implements Platform {
  async screenshot(_display?: number, _region?: ScreenRegion): Promise<Buffer> {
    throw new Error("Not implemented: Windows screenshot");
  }

  getScreenSize(_display?: number): ScreenSize {
    throw new Error("Not implemented: Windows getScreenSize");
  }

  async listWindows(_includeMinimized?: boolean): Promise<WindowInfo[]> {
    throw new Error("Not implemented: Windows listWindows");
  }

  async getWindowState(_windowId?: string, _depth?: number, _includeBounds?: boolean): Promise<WindowState> {
    // TODO: Implement using UI Automation API
    throw new Error("Not implemented: Windows getWindowState");
  }

  async click(_x: number, _y: number, _button?: "left" | "right" | "middle", _doubleClick?: boolean): Promise<void> {
    throw new Error("Not implemented: Windows click");
  }

  async move(_x: number, _y: number): Promise<void> {
    throw new Error("Not implemented: Windows move");
  }

  async drag(_startX: number, _startY: number, _endX: number, _endY: number, _button?: "left" | "right" | "middle", _duration?: number): Promise<void> {
    throw new Error("Not implemented: Windows drag");
  }

  async scroll(_x: number, _y: number, _deltaX: number, _deltaY: number): Promise<void> {
    throw new Error("Not implemented: Windows scroll");
  }

  getCursorPosition(): CursorPosition {
    throw new Error("Not implemented: Windows getCursorPosition");
  }

  async type(_text: string, _delay?: number): Promise<void> {
    throw new Error("Not implemented: Windows type");
  }

  async key(_keys: string[]): Promise<void> {
    throw new Error("Not implemented: Windows key");
  }

  async ocr(_display?: number, _region?: ScreenRegion): Promise<OcrResult> {
    throw new Error("Not implemented: Windows OCR");
  }

  async findElement(_options: FindElementOptions): Promise<FindElementResult[]> {
    throw new Error("Not implemented: Windows findElement");
  }

  async clickElement(_elementId: string, _app?: string): Promise<void> {
    throw new Error("Not implemented: Windows clickElement");
  }

  async typeInElement(_elementId: string, _text: string, _app?: string, _clearFirst?: boolean): Promise<void> {
    throw new Error("Not implemented: Windows typeInElement");
  }
}
