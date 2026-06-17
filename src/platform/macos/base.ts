import type { Platform, WindowInfo, AppTarget } from "../base.js";
import { TargetStaleError } from "../../util/errors.js";
import type { CachedElementDescriptor, MacOSPlatformOptions } from "./helpers.js";
import { saveFocus, restoreFocus } from "./focus.js";
import { screenshot, screenshotWindow, getScreenSize, isScreenLocked, ocr } from "./screen.js";
import { listApps, focusApp, getActiveBrowserContext, listWindows, keepTargetAxAlive } from "./window.js";
import { getWindowState, findElement } from "./ax-tree.js";
import { click, move, drag, scroll, getCursorPosition, type as typeMethod, key } from "./input.js";
import { clickElement, typeInElement, setElementValue, findMenuBarExtra, clickMenuBarExtra } from "./element.js";
import { readClipboard, writeClipboard } from "./clipboard.js";

export type { MacOSPlatformOptions } from "./helpers.js";

export class MacOSPlatform implements Platform {
  readonly _nativeHelperPaths: Record<string, string | null> | undefined;

  readonly elementCache = new Map<string, CachedElementDescriptor>();
  readonly elementCacheTtlMs = 30_000;
  readonly elementCacheMaxSize = 100;
  readonly windowCacheTtlMs = 300;
  windowCache: { cachedAt: number; windows: WindowInfo[] } | undefined;
  windowCacheInFlight = false;
  activeTarget: AppTarget | undefined;
  savedFocus: { appName: string; windowTitle: string } | undefined;

  constructor(options?: MacOSPlatformOptions) {
    this._nativeHelperPaths = options?.nativeHelperPaths;
  }

  // ── Element Cache Management ────────────────────────────────────────────

  evictExpiredCacheEntries(): void {
    const now = Date.now();
    for (const [key, descriptor] of this.elementCache) {
      if (now - descriptor.cachedAt > this.elementCacheTtlMs) {
        this.elementCache.delete(key);
      }
    }
  }

  evictOverflowCacheEntries(): void {
    while (this.elementCache.size > this.elementCacheMaxSize) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, descriptor] of this.elementCache) {
        if (descriptor.cachedAt < oldestTime) {
          oldestTime = descriptor.cachedAt;
          oldestKey = key;
        }
      }
      if (oldestKey !== null) {
        this.elementCache.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  isCacheEntryExpired(descriptor: CachedElementDescriptor): boolean {
    return Date.now() - descriptor.cachedAt > this.elementCacheTtlMs;
  }

  // ── Target Validation ────────────────────────────────────────────────────

  async validateActiveTarget(): Promise<void> {
    if (!this.activeTarget?.windowId) return;
    // 托盘 target（focus_app 找不到窗口时回退到 status item）没有真实窗口，
    // 恒有效直到模型显式 focus_app 其他应用——不查 listWindows（查了必然失配）。
    if (this.activeTarget.windowId === "tray") return;
    this.windowCache = undefined;
    const windows = await this.listWindows(true);
    const match = windows.find(w => w.id === this.activeTarget!.windowId);
    if (!match) {
      throw new TargetStaleError(this.activeTarget.windowId);
    }
    if (match.pid !== this.activeTarget.pid) {
      throw new TargetStaleError(this.activeTarget.windowId);
    }
  }

  // ── Bound methods from domain modules ────────────────────────────────────

  saveFocus = saveFocus;
  restoreFocus = restoreFocus;

  screenshot = screenshot;
  screenshotWindow = screenshotWindow;
  getScreenSize = getScreenSize;
  isScreenLocked = isScreenLocked;
  ocr = ocr;

  listApps = listApps;
  focusApp = focusApp;
  getActiveBrowserContext = getActiveBrowserContext;
  keepTargetAxAlive = keepTargetAxAlive;
  listWindows = listWindows;

  getWindowState = getWindowState;
  findElement = findElement;

  click = click;
  move = move;
  drag = drag;
  scroll = scroll;
  getCursorPosition = getCursorPosition;
  type = typeMethod;
  key = key;

  clickElement = clickElement;
  typeInElement = typeInElement;
  setElementValue = setElementValue;
  findMenuBarExtra = findMenuBarExtra;
  clickMenuBarExtra = clickMenuBarExtra;

  readClipboard = readClipboard;
  writeClipboard = writeClipboard;
}
