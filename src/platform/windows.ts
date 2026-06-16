import { execFileSync } from "node:child_process";
import type { Platform, ScreenRegion, ScreenSize, CursorPosition, WindowInfo, WindowState, OcrResult, FindElementOptions, FindElementResponse, ClickResult } from "./base.js";
import { PlatformError } from "../util/errors.js";

function runPowerShell(script: string, input?: string): string {
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf-8",
      timeout: 10000,
      ...(input !== undefined ? { input } : {}),
    });
  } catch (error) {
    throw new PlatformError(`PowerShell failed: ${(error as Error).message}`);
  }
}

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

  async findElement(_options: FindElementOptions): Promise<FindElementResponse> {
    throw new Error("Not implemented: Windows findElement");
  }

  async clickElement(_elementId: string, _app?: string): Promise<ClickResult> {
    throw new Error("Not implemented: Windows clickElement");
  }

  async typeInElement(_elementId: string, _text: string, _app?: string, _clearFirst?: boolean): Promise<void> {
    throw new Error("Not implemented: Windows typeInElement");
  }

  async readClipboard(): Promise<string> {
    try {
      // Get-Clipboard returns the clipboard text; trim trailing newline PowerShell adds
      const out = runPowerShell("Get-Clipboard -Raw");
      return out;
    } catch (error) {
      throw new PlatformError(`read_clipboard failed: ${(error as Error).message}`);
    }
  }

  async writeClipboard(text: string): Promise<void> {
    try {
      // Pipe the text to Set-Clipboard via stdin to avoid shell quoting issues
      runPowerShell("$stdin = [Console]::In.ReadToEnd(); Set-Clipboard -Value $stdin", text);
    } catch (error) {
      throw new PlatformError(`write_clipboard failed: ${(error as Error).message}`);
    }
  }
}
