import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { Platform, ScreenRegion, ScreenSize, CursorPosition, WindowInfo, WindowState, ElementInfo, OcrResult, FindElementOptions, FindElementResult, FindElementResponse, AppInfo, AppTarget, BrowserContext, ScreenshotOptions } from "./base.js";
import { captureFullScreen, captureRegion } from "../utils/screenshot.js";
import { click as inputClick, doubleClick as inputDoubleClick, move as inputMove, drag as inputDrag, scroll as inputScroll, typeText, pressShortcut } from "../utils/input.js";
import { CaptureError, ElementNotFoundError, InputSynthesisError, PermissionError, PlatformError, TargetStaleError, UcuError, WindowNotFoundError } from "../util/errors.js";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __macosDirname = dirname(fileURLToPath(import.meta.url));

const execFileAsync = promisify(execFile);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAccessibilityPermissionError(error: unknown): boolean {
  return /not allowed|permission|assistive|accessibility/i.test(errorMessage(error));
}

function rethrowCaptureError(error: unknown, operation: string): never {
  if (error instanceof UcuError) throw error;
  throw new CaptureError(`${operation} failed: ${errorMessage(error)}`);
}

function rethrowAccessibilityError(error: unknown, operation: string): never {
  if (error instanceof UcuError) throw error;
  if (isAccessibilityPermissionError(error)) {
    throw new PermissionError("accessibility", "darwin");
  }
  throw new PlatformError(`${operation} failed: ${errorMessage(error)}`);
}

function rethrowElementActionError(error: unknown, operation: string, elementId: string): never {
  if (error instanceof UcuError) throw error;
  if (isAccessibilityPermissionError(error)) {
    throw new PermissionError("accessibility", "darwin");
  }
  if (/element not found/i.test(errorMessage(error))) {
    throw new ElementNotFoundError(elementId);
  }
  throw new PlatformError(`${operation} failed: ${errorMessage(error)}`);
}

function rethrowInputError(error: unknown, operation: string): never {
  if (error instanceof UcuError) throw error;
  throw new InputSynthesisError(`${operation} failed: ${errorMessage(error)}`);
}

function normalizeAppName(name: string): string {
  return name.trim().toLowerCase();
}

function appNameMatches(processName: string, requestedApp: string): boolean {
  const process = normalizeAppName(processName);
  const requested = normalizeAppName(requestedApp);
  if (!process || !requested) return false;
  return process === requested ||
    process.startsWith(`${requested} `) ||
    process.startsWith(`${requested}-`) ||
    process.includes(` ${requested} `);
}

function selectWindowForApp(windows: WindowInfo[], requestedApp: string): WindowInfo | undefined {
  const requested = normalizeAppName(requestedApp);
  return windows.find((window) => normalizeAppName(window.processName) === requested) ??
    windows.find((window) => appNameMatches(window.processName, requestedApp));
}

interface CachedElementDescriptor {
  elementId: string;
  appName: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  subrole?: string;
  identifier?: string;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  cachedAt: number;
}

export interface MacOSPlatformOptions {
  /**
   * Override native helper resolution.
   * - Map of folder name to absolute binary path to inject a specific helper.
   * - Set a value to null to skip that helper (force JXA fallback).
   * Used by tests to control native helper behavior without filesystem tricks.
   */
  nativeHelperPaths?: Record<string, string | null>;
}

export class MacOSPlatform implements Platform {
  private readonly _nativeHelperPaths: Record<string, string | null> | undefined;

  private readonly elementCache = new Map<string, CachedElementDescriptor>();
  private readonly elementCacheTtlMs = 30_000;
  private readonly elementCacheMaxSize = 100;
  private readonly windowCacheTtlMs = 300;
  private windowCache: { cachedAt: number; windows: WindowInfo[] } | undefined;
  private windowCacheInFlight = false;
  private activeTarget: AppTarget | undefined;
  private savedFocus: { appName: string; windowTitle: string } | undefined;

  constructor(options?: MacOSPlatformOptions) {
    this._nativeHelperPaths = options?.nativeHelperPaths;
  }


  // ── Element Cache Management ────────────────────────────────────────────

  /** Remove expired entries from the element cache. */
  private evictExpiredCacheEntries(): void {
    const now = Date.now();
    for (const [key, descriptor] of this.elementCache) {
      if (now - descriptor.cachedAt > this.elementCacheTtlMs) {
        this.elementCache.delete(key);
      }
    }
  }

  /** Evict oldest entries when cache exceeds the maximum size (LRU-style). */
  private evictOverflowCacheEntries(): void {
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

  /** Check whether a cached element descriptor has expired. */
  private isCacheEntryExpired(descriptor: CachedElementDescriptor): boolean {
    return Date.now() - descriptor.cachedAt > this.elementCacheTtlMs;
  }


  // ── Target Validation ────────────────────────────────────────────────────

  /** Validate that the active target window still exists. */
  async validateActiveTarget(): Promise<void> {
    if (!this.activeTarget?.windowId) return;
    this.windowCache = undefined; // Bypass cache — stale detection must use fresh data
    const windows = await this.listWindows(true);
    const match = windows.find(w => w.id === this.activeTarget!.windowId);
    if (!match) {
      throw new TargetStaleError(this.activeTarget.windowId);
    }
    // Also invalidate if pid changed (app restarted)
    if (match.pid !== this.activeTarget.pid) {
      throw new TargetStaleError(this.activeTarget.windowId);
    }
  }

  // ── Focus Management ────────────────────────────────────────────────────

  /** Save the current frontmost app/window so we can restore after an action. */
  async saveFocus(): Promise<void> {
    try {
      const apps = await this.listApps();
      const front = apps.find((a) => a.isFrontmost);
      if (front) {
        const windows = await this.listWindows();
        const win = windows.find((w) => w.processName === front.name && w.isOnScreen);
        this.savedFocus = {
          appName: front.name,
          windowTitle: win?.title ?? "",
        };
      }
    } catch {
      this.savedFocus = undefined;
    }
  }

  /** Restore the previously saved frontmost app/window. */
  async restoreFocus(): Promise<void> {
    if (!this.savedFocus) return;
    try {
      const { appName } = this.savedFocus;
      const appNameLiteral = JSON.stringify(appName);
      execFileSync("osascript", [
        "-e", `tell application ${appNameLiteral} to activate`,
      ], { timeout: 5000 });
    } catch {
      // Best effort — don't fail the action if restore fails
    }
    this.savedFocus = undefined;
  }

  // ── Screenshot ──────────────────────────────────────────────────────────

  async screenshot(_display?: number, region?: ScreenRegion, options?: ScreenshotOptions): Promise<Buffer> {
    try {
      const base64 = region
        ? await captureRegion(region.x, region.y, region.width, region.height, options)
        : await captureFullScreen(options);
      return Buffer.from(base64, "base64");
    } catch (error) {
      rethrowCaptureError(error, region ? "capture region" : "capture full screen");
    }
  }

  async screenshotWindow(windowId: string, options?: ScreenshotOptions): Promise<Buffer> {
    const win = (await this.listWindows(true)).find((w) => w.id === windowId);
    if (!win) {
      throw new WindowNotFoundError(windowId);
    }
    return this.screenshot(undefined, win.bounds, options);
  }

  // ── Screen Info ─────────────────────────────────────────────────────────

  getScreenSize(display?: number): ScreenSize {
    try {
      const idx = display ?? 0;
      const out = execFileSync("osascript", [
        "-l", "JavaScript",
        "-e",
        `ObjC.import('AppKit');
        var screens = $.NSScreen.screens;
        var idx = ${idx};
        if (idx < 0 || idx >= screens.count) idx = 0;
        var screen = $(screens).objectAtIndex(idx);
        var frame = screen.frame;
        var scaleFactor = screen.backingScaleFactor;
        JSON.stringify({width:Math.round(frame.size.width),height:Math.round(frame.size.height),scaleFactor:scaleFactor})`,
      ], { encoding: "utf-8", timeout: 5000 }).trim();
      return JSON.parse(out) as ScreenSize;
    } catch {
      return { width: 1920, height: 1080, scaleFactor: 2 };
    }
  }

  isScreenLocked(): boolean {
    try {
      const out = execFileSync("/usr/sbin/ioreg", ["-n", "Root", "-d1"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      return /"IOConsoleLocked"\s*=\s*Yes/.test(out);
    } catch {
      // Fail-closed: if we can't determine lock state, assume locked
      return true;
    }
  }

  // ── Window Management ───────────────────────────────────────────────────

  async listApps(): Promise<AppInfo[]> {
    const jxaScript = `
      var se = Application('System Events');
      var result = [];
      var procs = se.processes();
      for (var i = 0; i < procs.length; i++) {
        try {
          var p = procs[i];
          var background = false;
          try { background = p.backgroundOnly(); } catch(e) {}
          if (background) continue;
          var wins = [];
          try { wins = p.windows(); } catch(e) {}
          result.push({
            name: p.name() || '',
            pid: p.unixId ? p.unixId() : 0,
            isFrontmost: p.frontmost ? !!p.frontmost() : false,
            windowCount: wins.length || 0
          });
        } catch(e) {}
      }
      JSON.stringify(result);
    `;
    const out = execFileSync("osascript", [
      "-l", "JavaScript",
      "-e", jxaScript,
    ], { encoding: "utf-8", timeout: 10000 }).trim();
    return JSON.parse(out) as AppInfo[];
  }

  async focusApp(app: string): Promise<AppTarget> {
    const appLiteral = JSON.stringify(app);
    this.windowCache = undefined;
    // NOTE: We intentionally do NOT call AppleScript "activate" here.
    // focus_app sets the internal target context so subsequent operations
    // know which app/window to target. It does NOT bring the app to the
    // foreground — the user should remain in their current app (terminal,
    // Codex, etc.) while the agent works in the background.
    // CGEvent input injection works at the HID level and doesn't require
    // the target app to be frontmost. AX operations target processes by
    // name/PID via System Events, also without needing frontmost status.

    let target: WindowInfo | undefined;
    const deadline = Date.now() + 3000;
    do {
      const windows = await this.listWindows(true);
      target = selectWindowForApp(windows, app);
      if (target) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    } while (Date.now() < deadline);

    if (!target) {
      // Wrap with a more diagnostic message: many real-world failures are
      // Electron apps that do not expose their AX tree to System Events
      // (CC Switch, VS Code, Discord, Slack). WindowNotFoundError carries the
      // app name so the tool handler can surface a remediation hint. The
      // bare WindowNotFoundError("CC Switch") was indistinguishable from
      // "the app is not running", which led models to retry forever.
      this.activeTarget = undefined; // Clear stale target on focus failure
      const err = new WindowNotFoundError(app, { hint:
        "list_windows returned no match for this app. If the app is running, " +
        "the most likely cause is that it is an Electron app whose AX tree is " +
        "not exposed to System Events (System Settings > Privacy & Security > " +
        "Accessibility must be granted to the Electron process itself, not just " +
        "to the host terminal). Pixel-level workaround: call screenshot to " +
        "capture the screen, then ocr to locate UI text and get its bounding " +
        "box coordinates, then click(x, y) at those screen coordinates. " +
        "Alternatively, modify the app's config file or database directly." });
      throw err;
    }
    this.activeTarget = {
      targetId: randomUUID(),
      appName: target.processName,
      pid: target.pid,
      windowId: target.id,
      title: target.title,
      capturedAt: new Date().toISOString(),
    };
    return this.activeTarget;
  }

  async getActiveBrowserContext(app?: string): Promise<BrowserContext | undefined> {
    const appName = app || this.activeTarget?.appName;
    if (!appName) return undefined;

    const normalized = appName.toLowerCase();
    const knownBrowser = [
      "safari",
      "google chrome",
      "chrome",
      "arc",
      "microsoft edge",
      "edge",
      "brave browser",
      "brave",
    ].some((name) => normalized.includes(name));
    if (!knownBrowser) return undefined;

    const appLiteral = JSON.stringify(appName);
    const jxaScript = `
      function run() {
        var appName = ${appLiteral};
        try {
          var app = Application(appName);
          var url = "";
          var title = "";
          if (appName.toLowerCase().indexOf("safari") !== -1) {
            try { url = app.documents[0].url(); } catch(e) {}
            try { title = app.documents[0].name(); } catch(e) {}
          } else {
            try { url = app.windows[0].activeTab.url(); } catch(e) {}
            try { title = app.windows[0].activeTab.title(); } catch(e) {}
          }
          return JSON.stringify({appName: appName, url: url || undefined, title: title || undefined});
        } catch(e) {
          return JSON.stringify({appName: appName});
        }
      }
      run();
    `;

    try {
      const out = execFileSync("osascript", [
        "-l", "JavaScript",
        "-e", jxaScript,
      ], { encoding: "utf-8", timeout: 5000 }).trim();
      const parsed = JSON.parse(out) as BrowserContext;
      return parsed.url || parsed.title ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async listWindows(_includeMinimized?: boolean): Promise<WindowInfo[]> {
    const now = Date.now();
    if (this.windowCache && now - this.windowCache.cachedAt <= this.windowCacheTtlMs) {
      return this.windowCache.windows.map((window) => ({
        ...window,
        bounds: { ...window.bounds },
      }));
    }

    // P0 #3: Prevent concurrent cache refreshes
    if (this.windowCacheInFlight) {
      // Another call is already refreshing; return stale or empty
      return this.windowCache?.windows.map(w => ({ ...w, bounds: { ...w.bounds } })) ?? [];
    }
    this.windowCacheInFlight = true;

    try {
      // Try native Swift helper first (CGWindowListCopyWindowInfo, ~1ms).
      // Falls back to JXA System Events if the helper is not available.
      // The native helper reliably enumerates ALL windows including Electron
      // apps, whereas JXA relies on System Events AX which is inconsistent
      // for Chromium-rendered windows.
      let windows: WindowInfo[];
      const nativeResult = this.listWindowsNative();
      if (nativeResult !== null) {
        windows = nativeResult;
      } else {
        windows = await this.listWindowsJxa();
      }

      this.windowCache = {
        cachedAt: Date.now(),
        windows: windows.map((window) => ({
          ...window,
          bounds: { ...window.bounds },
        })),
      };
      return windows;
    } catch {
      // Fallback: return empty list if both methods fail
      return [];
    } finally {
      this.windowCacheInFlight = false;
    }
  }

  private listWindowsNative(): WindowInfo[] | null {
    try {
      const helperPath = this.resolveNativeHelper("windowlist", "windowlist-helper");
      if (!helperPath) return null;
      const out = execFileSync(helperPath, [], {
        encoding: "utf-8",
        timeout: 5000,
      });
      const parsed = JSON.parse(out.trim()) as {
        windows: Array<{
          id: string; title: string; processName: string; pid: number;
          bounds: { x: number; y: number; width: number; height: number };
          isOnScreen: boolean; windowNumber: number;
        }>;
        error?: string;
      };
      if (parsed.error) return null;
      return parsed.windows.map(w => ({
        id: w.id,
        title: w.title,
        processName: w.processName,
        pid: w.pid,
        bounds: w.bounds,
        isMinimized: !w.isOnScreen,
        isOnScreen: w.isOnScreen,
      }));
    } catch {
      return null;
    }
  }

  private resolveNativeHelper(folder: string, binary: string): string | null {
    // Test injection: if the caller provided explicit paths, use those
    // instead of hitting the filesystem.
    if (this._nativeHelperPaths && folder in this._nativeHelperPaths) {
      const override = this._nativeHelperPaths[folder];
      // null means "skip native, force JXA fallback"
      return override === null ? null : override;
    }
    // dev: src/platform/macos.ts → native/<folder>/<binary>
    // prod: dist/src/platform/macos.js → native/<folder>/<binary>
    const candidates = [
      join(__macosDirname, "..", "..", "native", folder, binary),
      join(__macosDirname, "..", "..", "..", "native", folder, binary),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return null;
  }

  private async listWindowsJxa(): Promise<WindowInfo[]> {
      const jxaScript = `
        var se = Application('System Events');
        var result = [];
        var procs = se.processes();
        for (var i = 0; i < procs.length; i++) {
          var p = procs[i];
          var pName = '';
          var pPid = 0;
          try { pName = p.name(); } catch(e) {}
          try { pPid = p.unixId(); } catch(e) {}
          try {
            var wins = p.windows();
            for (var j = 0; j < wins.length; j++) {
              var w = wins[j];
              var pos, sz;
              try { pos = w.position(); } catch(e) { pos = [0, 0]; }
              try { sz = w.size(); } catch(e) { sz = [0, 0]; }
              if (sz[0] === 0 && sz[1] === 0) continue;
              var title = '';
              try { title = w.name() || ''; } catch(e) {}
              result.push({
                id: pName + '/win' + j,
                title: title,
                processName: pName,
                pid: pPid,
                bounds: { x: pos[0], y: pos[1], width: sz[0], height: sz[1] },
                isMinimized: false,
                isOnScreen: true
              });
            }
          } catch(e) {}
        }
        JSON.stringify(result);
      `;

      const jxaOut = execFileSync("osascript", [
        "-l", "JavaScript",
        "-e", jxaScript
      ], { encoding: "utf-8", timeout: 15000 });
      return JSON.parse(jxaOut.trim()) as WindowInfo[];
  }

  async getWindowState(windowId?: string, depth?: number, includeBounds: boolean = true): Promise<WindowState> {
    if (!windowId || windowId === this.activeTarget?.windowId) {
      await this.validateActiveTarget();
    }
    const resolvedWindowId = windowId || this.activeTarget?.windowId;
    if (!resolvedWindowId) {
      throw new WindowNotFoundError("active target");
    }
    const maxDepth = Math.min(depth || 3, 10);
    const maxElements = 50;
    const windowIdLiteral = JSON.stringify(resolvedWindowId);
    const targetWindow = (await this.listWindows(true)).find((w) => w.id === resolvedWindowId);
    const targetJson = JSON.stringify(targetWindow ?? null);

    try {
      const jxaScript = `
        ObjC.import('AppKit');
        var se = Application('System Events');
      function childElements(elem) {
        try { return elem.uiElements(); } catch(e1) {
          try { return elem.elements(); } catch(e2) { return []; }
        }
      }
        var result = {window: null, focusedElement: null, tree: null, error: null};
        var target = ${targetJson};
        var includeBounds = ${includeBounds ? "true" : "false"};

        function closeEnough(a, b, tolerance) {
          return Math.abs(Number(a || 0) - Number(b || 0)) <= tolerance;
        }

        function windowMatches(win, proc) {
          if (!target) {
            try { return String(win.id()) === String(${windowIdLiteral}); } catch(e) { return false; }
          }
          try {
            if (target.pid && proc.unixId && proc.unixId() !== target.pid) return false;
          } catch(e) {}

          var name = "";
          try { name = win.name() || ""; } catch(e) {}
          if (target.title && name && name === target.title) return true;

          try {
            var pos = win.position();
            var size = win.size();
            var b = target.bounds || {};
            return closeEnough(pos[0], b.x, 12) &&
              closeEnough(pos[1], b.y, 12) &&
              closeEnough(size[0], b.width, 24) &&
              closeEnough(size[1], b.height, 24);
          } catch(e) {}

          try { return String(win.id()) === String(${windowIdLiteral}); } catch(e) {}
          return false;
        }

        var foundWin = null;
        var foundProc = null;

        // Fast path: resolve "ProcessName/winN" format directly
        var idParts = ${windowIdLiteral}.split('/');
        if (idParts.length >= 2 && idParts[0]) {
          var procName = idParts[0];
          var winIdx = 0;
          var winMatch = idParts[1].match(/^win(\d+)$/);
          if (winMatch) winIdx = parseInt(winMatch[1]);
          try {
            var proc = se.processes[procName]();
            var ws = proc.windows();
            if (winIdx < ws.length) {
              foundWin = ws[winIdx];
              foundProc = proc;
            }
          } catch(e) {}
        }

        try {
          if (!foundWin) {
            var procs = se.processes();
            for (var p = 0; p < procs.length; p++) {
              var proc = procs[p];
              try {
                var wins = proc.windows();
                for (var w = 0; w < wins.length; w++) {
                  if (windowMatches(wins[w], proc)) {
                    foundWin = wins[w];
                    foundProc = proc;
                    break;
                  }
                }
              } catch(e) {}
              if (foundWin) break;
            }
          }
          if (!foundWin) {
            result.error = 'Window not found';
          } else {

          var winPos = foundWin.position();
          var winSize = foundWin.size();
          result.window = {
            id: String(${windowIdLiteral}),
            title: foundWin.name() || '',
            processName: foundProc.name() || '',
            pid: foundProc.unixId ? foundProc.unixId() : 0,
            bounds: {x: winPos[0] || 0, y: winPos[1] || 0, width: winSize[0] || 0, height: winSize[1] || 0},
            isMinimized: false,
            isOnScreen: true
          };

          var elemCount = [0];
          function summarizeFocusedElement(info) {
            var summary = {
              role: info.role || '',
              name: info.name || '',
              value: info.value || '',
              states: info.states ? info.states.slice(0) : []
            };
            if (includeBounds && info.bounds) summary.bounds = info.bounds;
            return summary;
          }

          function getElementBounds(axElem) {
            try {
              var pos = axElem.position();
              var sz = axElem.size();
              return {x: pos[0]||0, y: pos[1]||0, width: sz[0]||0, height: sz[1]||0};
            } catch(e) {
              return null;
            }
          }

          function elementBelongsToWindow(axElem) {
            var b = getElementBounds(axElem);
            if (!b) return false;
            var wx = winPos[0] || 0;
            var wy = winPos[1] || 0;
            var ww = winSize[0] || 0;
            var wh = winSize[1] || 0;
            var cx = b.x + b.width / 2;
            var cy = b.y + b.height / 2;
            return cx >= wx && cx <= wx + ww && cy >= wy && cy <= wy + wh;
          }

          function readElementInfo(axElem) {
            var info = {role: '', name: '', value: '', states: [], children: []};
            try { info.role = axElem.role() || ''; } catch(e) {}
            try { info.name = axElem.description ? axElem.description() : (axElem.name ? axElem.name() : ''); } catch(e) {}
            try {
              var val = axElem.value();
              info.value = (val !== undefined && val !== null) ? String(val) : '';
            } catch(e) {}
            if (includeBounds) {
              info.bounds = getElementBounds(axElem) || {x: 0, y: 0, width: 0, height: 0};
            }
            return info;
          }

          try {
            var processFocused = foundProc.focusedUIElement ? foundProc.focusedUIElement() : null;
            if (processFocused && elementBelongsToWindow(processFocused)) {
              var focusedInfo = readElementInfo(processFocused);
              focusedInfo.states.push('focused');
              result.focusedElement = summarizeFocusedElement(focusedInfo);
            }
          } catch(e) {}

          function extractElement(axElem, currentDepth) {
            if (elemCount[0] >= ${maxElements}) return null;
            elemCount[0]++;
            var info = readElementInfo(axElem);
            try {
              try {
                if (axElem.focused && axElem.focused()) info.states.push('focused');
              } catch(e0) {}
            } catch(e) {}
            if (!result.focusedElement && info.states.indexOf('focused') !== -1) {
              result.focusedElement = summarizeFocusedElement(info);
            }

            if (currentDepth < ${maxDepth}) {
              try {
                var kids = childElements(axElem);
                for (var k = 0; k < kids.length && elemCount[0] < ${maxElements}; k++) {
                  var child = extractElement(kids[k], currentDepth + 1);
                  if (child) info.children.push(child);
                }
              } catch(e) {}
            }
            return info;
          }

            result.tree = extractElement(foundWin, 0);
          }
        } catch(e) {
          result.error = String(e.message || e);
        }
        JSON.stringify(result);
      `;

      const out = execFileSync("osascript", [
        "-l", "JavaScript",
        "-e", jxaScript,
      ], { encoding: "utf-8", timeout: 15000 }).trim();

      const parsed = JSON.parse(out);

      if (parsed.error && !parsed.window) {
        throw new WindowNotFoundError(resolvedWindowId);
      }

      const windowInfo: WindowInfo = parsed.window || {
        id: resolvedWindowId,
        title: "",
        processName: "",
        pid: 0,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        isMinimized: false,
        isOnScreen: true,
      };

      return {
        window: windowInfo,
        focusedElement: parsed.focusedElement || undefined,
        tree: parsed.tree || undefined,
      };
    } catch (error) {
      if (error instanceof WindowNotFoundError) throw error;
      rethrowAccessibilityError(error, "get_window_state");
    }
  }

  // ── Mouse ───────────────────────────────────────────────────────────────

  async click(x: number, y: number, button?: "left" | "right" | "middle", doubleClick?: boolean): Promise<void> {
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

  async move(x: number, y: number): Promise<void> {
    try {
      await inputMove(x, y);
    } catch (error) {
      rethrowInputError(error, "move");
    }
  }

  async drag(startX: number, startY: number, endX: number, endY: number, button?: "left" | "right" | "middle", duration?: number): Promise<void> {
    try {
      await inputDrag(startX, startY, endX, endY, button, duration);
    } catch (error) {
      rethrowInputError(error, "drag");
    }
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    try {
      await inputScroll(x, y, deltaX, deltaY);
    } catch (error) {
      rethrowInputError(error, "scroll");
    }
  }

  // ── Cursor ──────────────────────────────────────────────────────────────

  getCursorPosition(): CursorPosition {
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

  // ── OCR ──────────────────────────────────────────────────────────────────

  async ocr(display?: number, region?: ScreenRegion): Promise<OcrResult> {
    const buf = await this.screenshot(display, region);

    const { writeFile, unlink } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const tmpPath = join(tmpdir(), `ucu-ocr-${randomUUID()}.png`);
    await writeFile(tmpPath, buf);

    try {
      const screenSize = this.getScreenSize(display);
      const scaleFactor = screenSize.scaleFactor ?? 2;

      // Try native Swift OCR helper first (avoids JXA ObjC bridge bugs on macOS Sequoia+)
      const nativeResult = await this.ocrNative(tmpPath, scaleFactor, region);
      if (nativeResult) return nativeResult;

      // Fallback to JXA Vision framework
      return await this.ocrJxa(tmpPath, screenSize, scaleFactor, region, buf);
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  }

  private async ocrNative(tmpPath: string, scaleFactor: number, region?: ScreenRegion): Promise<OcrResult | null> {
    const { existsSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    // Resolve native binary path (same pattern as input.ts CGEvent helper)
    const candidates = [
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "native", "ocr", "ocr-helper"),
      join(dirname(fileURLToPath(import.meta.url)), "..", "native", "ocr", "ocr-helper"),
      join(process.cwd(), "native", "ocr", "ocr-helper"),
    ];

    let binaryPath: string | undefined;
    for (const p of candidates) {
      if (existsSync(p)) { binaryPath = p; break; }
    }
    if (!binaryPath) return null;

    try {
      const input = JSON.stringify({ imagePath: tmpPath });
      const out = execFileSync(binaryPath, [], {
        input,
        encoding: "utf-8",
        timeout: 30000,
      }).trim();
      const parsed = JSON.parse(out);
      if (parsed.error) return null;

      const elements = parsed.elements.map((el: any) => ({
        text: el.text,
        x: Math.round(el.x / scaleFactor) + (region ? region.x : 0),
        y: Math.round(el.y / scaleFactor) + (region ? region.y : 0),
        width: Math.round(el.width / scaleFactor),
        height: Math.round(el.height / scaleFactor),
        confidence: el.confidence,
      }));

      return { elements, fullText: parsed.fullText };
    } catch {
      return null;
    }
  }

  private async ocrJxa(tmpPath: string, screenSize: ScreenSize, scaleFactor: number, region: ScreenRegion | undefined, buf: Buffer): Promise<OcrResult> {
    const pathLiteral = JSON.stringify(tmpPath);
    const jxaScript = `
      function run() {
        ObjC.import('Vision');
        ObjC.import('AppKit');
        ObjC.import('Foundation');
        var app = Application.currentApplication();
        app.includeStandardAdditions = true;
        var path = ${pathLiteral};
        var url = $.NSURL.fileURLWithPath(path);
        var image = $.NSImage.alloc.initWithContentsOfURL(url);
        if (!image || !image.isValid) {
          return JSON.stringify({error: "Failed to load screenshot image", elements: [], fullText: ""});
        }
        var cgImage = image.CGImageForProposedRectContextHints(null, null, null);
        if (!cgImage) {
          return JSON.stringify({error: "Failed to get CGImage from screenshot", elements: [], fullText: ""});
        }
        var request = $.VNRecognizeTextRequest.alloc.init;
        request.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
        request.usesLanguageCorrection = true;
        var handler = $.VNImageRequestHandler.alloc.initWithCGImageOptions(cgImage, null);
        var performError = $();
        var success = handler.performRequestsError([request], performError);
        if (!success) {
          return JSON.stringify({error: "OCR request failed", elements: [], fullText: ""});
        }
        var results = request.results;
        var elements = [];
        var fullTextParts = [];
        var imgWidth = cgImage.width;
        var imgHeight = cgImage.height;
        for (var i = 0; i < results.count; i++) {
          var obs = $(results).objectAtIndex(i);
          var candidates = obs.topCandidates(1);
          if (candidates && candidates.count > 0) {
            var candidate = $(candidates).objectAtIndex(0);
            var text = candidate.string.toString();
            var confidence = candidate.confidence;
            var bbox = obs.boundingBox;
            var bx = bbox.origin.x * imgWidth;
            var by = (1 - bbox.origin.y - bbox.size.height) * imgHeight;
            var bw = bbox.size.width * imgWidth;
            var bh = bbox.size.height * imgHeight;
            elements.push({text:text,x:Math.round(bx),y:Math.round(by),width:Math.round(bw),height:Math.round(bh),confidence:confidence});
            fullTextParts.push(text);
          }
        }
        return JSON.stringify({elements:elements,fullText:fullTextParts.join("\\n"),error:null});
      }
      run();
    `;
    const out = execFileSync("osascript", ["-l", "JavaScript", "-e", jxaScript], { encoding: "utf-8", timeout: 30000 }).trim();
    const parsed = JSON.parse(out);
    if (parsed.error) {
      // Distinguish permission-class failures from real Vision errors.
      // screencapture writes a 0-byte file when Screen Recording is not granted,
      // and the JXA NSImage init then fails with "Failed to load screenshot image".
      // Surface that as a PermissionError hint so the model can suggest the right fix.
      const hint = parsed.error === "Failed to load screenshot image"
        ? " (the screenshot file is empty or unreadable — Screen Recording permission is most likely missing; run `doctor` and grant Screen Recording to the host terminal, then retry)"
        : parsed.error === "Failed to get CGImage from screenshot"
          ? " (the screenshot could not be decoded — likely an empty capture; check Screen Recording permission)"
          : "";
      throw new CaptureError(`ocr failed: ${parsed.error}${hint}`);
    }

    const imgWidth = buf.readUInt32BE(16);
    const scaleFactorX = screenSize.width / (region ? region.width : (imgWidth / scaleFactor));
    const elements = parsed.elements.map((el: any) => ({
      text: el.text,
      x: Math.round(el.x / scaleFactor) + (region ? region.x : 0),
      y: Math.round(el.y / scaleFactor) + (region ? region.y : 0),
      width: Math.round(el.width / scaleFactor),
      height: Math.round(el.height / scaleFactor),
      confidence: el.confidence,
    }));
    return { elements, fullText: parsed.fullText };
  }

  // ── Keyboard ────────────────────────────────────────────────────────────

  async type(text: string, delay?: number): Promise<void> {
    await typeText(text, delay);
  }

  async key(keys: string[]): Promise<void> {
    await pressShortcut(keys);
  }

  // ── Accessibility (AX) Element Actions ───────────────────────────────────

  async findElement(options: FindElementOptions): Promise<FindElementResponse> {
    this.evictExpiredCacheEntries();
    const { text, role, app, depth, includeBounds = true, textMode = "contains", visibleOnly = false, value } = options;
    const effectiveApp = app || this.activeTarget?.appName;
    const maxDepth = Math.min(depth || 5, 10);
    const maxResults = Math.min(Math.max(options.maxResults ?? 50, 1), 200);
    const appLiteral = JSON.stringify(effectiveApp || "");
    const textLiteral = text ? JSON.stringify(text) : "null";
    const roleLiteral = role ? JSON.stringify(role) : "null";
    const valueLiteral = value ? JSON.stringify(value) : "null";

    // Pre-compile regex on TS side to validate syntax before passing to JXA
    if (text && textMode === "regex") {
      try {
        new RegExp(text);
      } catch {
        throw new PlatformError(`Invalid regex pattern: ${text}`);
      }
    }
    // Same pre-validation for value field when regex textMode is requested;
    // otherwise JXA's valueMatches silently returns false on invalid regex,
    // which surfaces as "no results" instead of a clear error.
    if (value && textMode === "regex") {
      try {
        new RegExp(value);
      } catch {
        throw new PlatformError(`Invalid regex pattern: ${value}`);
      }
    }

    const startTime = Date.now();

      const jxaScript = `
        var se = Application('System Events');
      function childElements(elem) {
        try { return elem.uiElements(); } catch(e1) {
          try { return elem.elements(); } catch(e2) { return []; }
        }
      }
        var results = [];
      var scannedCount = 0;
      var matchedCount = 0;
      var resultCount = [0];
      var maxResults = ${maxResults};
      var includeBounds = ${includeBounds ? "true" : "false"};
      var visibleOnly = ${visibleOnly ? "true" : "false"};
      var textMode = ${JSON.stringify(textMode)};

      var textFilter = ${textLiteral};
      var roleFilter = ${roleLiteral};
      var valueFilter = ${valueLiteral};

      function isVisible(elem) {
        try {
          var pos = elem.position();
          var sz = elem.size();
          if (!pos || !sz) return false;
          return sz[0] > 0 && sz[1] > 0 && pos[0] > -10000 && pos[1] > -10000;
        } catch(e) {
          return false;
        }
      }

      // Shared filter helper. textMatches and valueMatches used to be near
      // copies of the same three-branch dispatch (contains / exact / regex);
      // this consolidates the logic so the two callers only differ in which
      // sources they iterate. Declared before textMatches/valueMatches for
      // readability — JXA's function declarations are hoisted, so order
      // doesn't affect callability. (Singer Nit + Herschel comment fix)
      function matchesValue(filter, value, mode) {
        if (filter === null) return true;
        if (mode === "exact") {
          return value.toLowerCase() === filter.toLowerCase();
        } else if (mode === "regex") {
          try {
            return new RegExp(filter, "i").test(value);
          } catch(e) { return false; }
        } else {
          // contains (default)
          return value.toLowerCase().indexOf(filter.toLowerCase()) !== -1;
        }
      }

      function textMatches(elemName, elemValue, elemDesc) {
        if (textFilter === null) return true;
        var sources = [elemName, elemValue, elemDesc];
        // Hoist regex compilation out of the loop. The TS-side pre-validation
        // in findElement guarantees the pattern is valid, so the RegExp
        // constructor cannot throw here. (Herschel perf Minor)
        if (textMode === "regex") {
          var reText = new RegExp(textFilter, "i");
          for (var i = 0; i < sources.length; i++) {
            if (reText.test(sources[i])) return true;
          }
          return false;
        }
        for (var j = 0; j < sources.length; j++) {
          if (matchesValue(textFilter, sources[j], textMode)) return true;
        }
        return false;
      }

      function valueMatches(elemValue) {
        return matchesValue(valueFilter, elemValue, textMode);
      }

      function matches(elem) {
        scannedCount++;
        var elemName = '';
        var elemRole = '';
        var elemDesc = '';
        var elemValue = '';
        try { elemName = elem.name() || ''; } catch(e) {}
        try { elemRole = elem.role() || ''; } catch(e) {}
        try { elemDesc = elem.description() || ''; } catch(e) {}
        try { var v = elem.value(); elemValue = (v !== undefined && v !== null) ? String(v) : ''; } catch(e) {}

        if (visibleOnly && !isVisible(elem)) return false;

        if (!textMatches(elemName, elemValue, elemDesc)) return false;
        if (roleFilter !== null) {
          if (elemRole !== roleFilter) return false;
        }
        if (!valueMatches(elemValue)) return false;
        matchedCount++;
        return true;
      }

      function getBounds(elem) {
        try {
          var pos = elem.position();
          var sz = elem.size();
          return {x: pos[0] || 0, y: pos[1] || 0, width: sz[0] || 0, height: sz[1] || 0};
        } catch(e) {
          return {x: 0, y: 0, width: 0, height: 0};
        }
      }

      function traverse(elem, path, currentDepth) {
        if (resultCount[0] >= maxResults) return;
        if (currentDepth > ${maxDepth}) return;

        if (matches(elem)) {
          var item = {
            id: path,
            role: '',
            name: '',
            value: undefined,
            description: undefined,
            subrole: undefined,
            identifier: undefined
          };
          var elemName = '';
          var elemRole = '';
          var elemDesc = '';
          var elemValue = '';
          var elemSubrole = '';
          var elemIdentifier = '';
          try { elemName = elem.name() || ''; } catch(e) {}
          try { elemRole = elem.role() || ''; } catch(e) {}
          try { elemDesc = elem.description() || ''; } catch(e) {}
          try { var v = elem.value(); elemValue = (v !== undefined && v !== null) ? String(v) : ''; } catch(e) {}
          try { elemSubrole = elem.subrole() || ''; } catch(e) {}
          try { elemIdentifier = elem.identifier() || ''; } catch(e) {}

          item.role = elemRole;
          item.name = elemName;
          if (elemValue) item.value = elemValue;
          if (elemDesc) item.description = elemDesc;
          if (elemSubrole) item.subrole = elemSubrole;
          if (elemIdentifier) item.identifier = elemIdentifier;
          if (includeBounds) item.bounds = getBounds(elem);
          results.push(item);
          resultCount[0]++;
        }

        if (currentDepth < ${maxDepth}) {
          try {
            var kids = childElements(elem);
            for (var k = 0; k < kids.length && resultCount[0] < maxResults; k++) {
              traverse(kids[k], path + '/' + k, currentDepth + 1);
            }
          } catch(e) {}
        }
      }

      try {
        if (${appLiteral}) {
          var proc = se.processes[${appLiteral}]();
          var wins = proc.windows();
          for (var w = 0; w < wins.length && resultCount[0] < maxResults; w++) {
            traverse(wins[w], ${appLiteral} + "/win" + w, 0);
          }
        } else {
          var procs = se.processes();
          for (var p = 0; p < procs.length && resultCount[0] < maxResults; p++) {
            try {
              var procName = procs[p].name();
              var wins = procs[p].windows();
              for (var w = 0; w < wins.length && resultCount[0] < maxResults; w++) {
                traverse(wins[w], procName + "/win" + w, 0);
              }
            } catch(e) {}
          }
        }
      } catch(e) {}

      JSON.stringify({results: results, scannedCount: scannedCount, matchedCount: matchedCount});
    `;

    try {
      const out = execFileSync("osascript", [
        "-l", "JavaScript",
        "-e", jxaScript,
      ], { encoding: "utf-8", timeout: 30000 }).trim();

      const parsed = JSON.parse(out) as { results: FindElementResult[]; scannedCount: number; matchedCount: number };
      const durationMs = Date.now() - startTime;
      for (const result of parsed.results) {
        const appName = effectiveApp || result.id.split("/")[0] || "";
        this.elementCache.set(result.id, {
          elementId: result.id,
          appName,
          role: result.role,
          name: result.name,
          value: result.value,
          description: result.description,
          subrole: (result as any).subrole,
          identifier: (result as any).identifier,
          bounds: result.bounds,
          cachedAt: Date.now(),
        });
      }
      this.evictOverflowCacheEntries();
      let finalResults = parsed.results;
      if (options.near) {
        const nx = options.near.x;
        const ny = options.near.y;
        finalResults = [...finalResults].sort((a, b) => {
          // Elements without bounds cannot be meaningfully compared against
          // a near point. Push them to the end of the sorted result so they
          // don't pollute the "closest first" ordering. (Singer Nit)
          const aHasBounds = !!a.bounds;
          const bHasBounds = !!b.bounds;
          if (!aHasBounds && !bHasBounds) return 0;
          if (!aHasBounds) return 1;
          if (!bHasBounds) return -1;
          const acx = (a.bounds?.x ?? 0) + (a.bounds?.width ?? 0) / 2;
          const acy = (a.bounds?.y ?? 0) + (a.bounds?.height ?? 0) / 2;
          const bcx = (b.bounds?.x ?? 0) + (b.bounds?.width ?? 0) / 2;
          const bcy = (b.bounds?.y ?? 0) + (b.bounds?.height ?? 0) / 2;
          return Math.hypot(acx - nx, acy - ny) - Math.hypot(bcx - nx, bcy - ny);
        });
      }
      if (typeof options.index === "number") {
        finalResults = options.index >= 0 && options.index < finalResults.length
          ? [finalResults[options.index]]
          : [];
      }
      return {
        results: finalResults,
        metrics: {
          scannedCount: parsed.scannedCount,
          matchedCount: parsed.matchedCount,
          durationMs,
          truncated: parsed.results.length >= maxResults,
        },
      };
    } catch (error) {
      rethrowAccessibilityError(error, "find_element");
    }
  }

  async clickElement(elementId: string, app?: string): Promise<void> {
    this.evictExpiredCacheEntries();
    const elementIdLiteral = JSON.stringify(elementId);
    const effectiveApp = app || this.activeTarget?.appName;
    const appLiteral = JSON.stringify(effectiveApp || "");
    const cached = this.elementCache.get(elementId);
    if (cached && this.isCacheEntryExpired(cached)) {
      this.elementCache.delete(elementId);
    }
    const cachedJson = JSON.stringify(this.elementCache.get(elementId) ?? null);

    const jxaScript = `
      var se = Application('System Events');
      var _result = null;
      function childElements(elem) {
        try { return elem.uiElements(); } catch(e1) {
          try { return elem.elements(); } catch(e2) { return []; }
        }
      }
      var elemPath = ${elementIdLiteral};
      var appName = ${appLiteral};
      var cached = ${cachedJson};

      function resolveElementByFullPath(path) {
        var parts = path.split('/');
        if (parts.length < 2) return null;

        var procName = parts[0];
        var winPart = parts[1];
        var winIdx = 0;
        var match = winPart.match(/^win(\\\\d+)$/);
        if (match) {
          winIdx = parseInt(match[1]);
        }

        try {
          var proc = se.processes[procName]();
          var wins = proc.windows();
          if (winIdx >= wins.length) return null;
          var current = wins[winIdx];

          for (var i = 2; i < parts.length; i++) {
            var idx = parseInt(parts[i]);
            if (isNaN(idx)) return null;
            try {
              var kids = childElements(current);
              if (idx >= kids.length) return null;
              current = kids[idx];
            } catch(e) { return null; }
          }
          return current;
        } catch(e) { return null; }
      }

      function elemString(elem, getter) {
        try {
          var value = getter(elem);
          return value === undefined || value === null ? '' : String(value);
        } catch(e) {
          return '';
        }
      }

      function getBounds(elem) {
        try {
          var pos = elem.position();
          var sz = elem.size();
          return {x: pos[0] || 0, y: pos[1] || 0, width: sz[0] || 0, height: sz[1] || 0};
        } catch(e) {
          return {x: 0, y: 0, width: 0, height: 0};
        }
      }

      function descriptorMatches(elem) {
        if (!cached) return true;
        var role = elemString(elem, function(e) { return e.role(); });
        var name = elemString(elem, function(e) { return e.name(); });
        var desc = elemString(elem, function(e) { return e.description(); });
        var value = elemString(elem, function(e) { return e.value(); });
        if (cached.role && role && role !== cached.role) return false;
        if (cached.name && name && name !== cached.name) return false;
        if (cached.value && value && value !== cached.value) return false;
        if (cached.description && desc && desc !== cached.description) return false;
        return true;
      }

      function scoreEquivalent(elem) {
        if (!cached) return -1;
        var score = 0;
        var role = elemString(elem, function(e) { return e.role(); });
        var name = elemString(elem, function(e) { return e.name(); });
        var desc = elemString(elem, function(e) { return e.description(); });
        var value = elemString(elem, function(e) { return e.value(); });
        var subrole = elemString(elem, function(e) { return e.subrole(); });
        var identifier = elemString(elem, function(e) { return e.identifier(); });
        if (cached.role && role === cached.role) score += 4;
        if (cached.name && name === cached.name) score += 4;
        if (cached.value && value === cached.value) score += 3;
        if (cached.description && desc === cached.description) score += 2;
        if (cached.subrole && subrole === cached.subrole) score += 2;
        if (cached.identifier && identifier === cached.identifier) score += 3;
        var b = getBounds(elem);
        if (cached.bounds) {
          var cx = b.x + b.width / 2;
          var cy = b.y + b.height / 2;
          var ocx = cached.bounds.x + cached.bounds.width / 2;
          var ocy = cached.bounds.y + cached.bounds.height / 2;
          var distance = Math.sqrt(Math.pow(cx - ocx, 2) + Math.pow(cy - ocy, 2));
          if (distance < 8) score += 4;
          else if (distance < 40) score += 2;
          else if (distance < 120) score += 1;
        }
        return score;
      }

      function refetchEquivalent() {
        if (!cached) return null;
        var targetApp = appName || cached.appName || '';
        var best = null;
        var bestScore = 0;
        var visited = [0];
        function visit(elem, depth) {
          if (visited[0] > 350 || depth > 10) return;
          visited[0]++;
          var score = scoreEquivalent(elem);
          if (score > bestScore) {
            best = elem;
            bestScore = score;
          }
          try {
            var kids = childElements(elem);
            for (var i = 0; i < kids.length; i++) visit(kids[i], depth + 1);
          } catch(e) {}
        }
        try {
          if (targetApp) {
            var proc = se.processes[targetApp]();
            var wins = proc.windows();
            for (var w = 0; w < wins.length; w++) visit(wins[w], 0);
          } else {
            var procs = se.processes();
            for (var p = 0; p < procs.length; p++) {
              try {
                var wins2 = procs[p].windows();
                for (var w2 = 0; w2 < wins2.length; w2++) visit(wins2[w2], 0);
              } catch(e2) {}
            }
          }
        } catch(e) {}
        return bestScore >= 6 ? best : null;
      }

      var elem = null;

      if (appName) {
        try {
          var proc = se.processes[appName]();
          var wins = proc.windows();
          var parts = elemPath.split('/');
          var winIdx = 0;
          var match = parts[0].match(/^win(\\\\d+)$/);
          if (match) winIdx = parseInt(match[1]);
          if (winIdx < wins.length) {
            var current = wins[winIdx];
            for (var i = 1; i < parts.length; i++) {
              var idx = parseInt(parts[i]);
              if (isNaN(idx)) break;
              try {
                var kids = childElements(current);
                if (idx >= kids.length) break;
                current = kids[idx];
              } catch(e) { break; }
            }
            elem = current;
          }
        } catch(e) {}
      }

      if (!elem) {
        elem = resolveElementByFullPath(elemPath);
      }

      if (elem && !descriptorMatches(elem)) {
        elem = refetchEquivalent() || elem;
      }

      if (!elem) {
        elem = refetchEquivalent();
      }

      if (!elem) {
        _result = {success: false, error: "Element not found: " + elemPath};
      } else {
        try {
          elem.actions.AXPress.perform();
          _result = {success: true};
        } catch(e) {
          try {
            var pos = elem.position();
            var sz = elem.size();
            var cx = pos[0] + sz[0] / 2;
            var cy = pos[1] + sz[1] / 2;
            ObjC.import('CoreGraphics');
            var src = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);
            var pt = $.CGPointMake(cx, cy);
            var down = $.CGEventCreateMouseEvent(src, $.kCGEventLeftMouseDown, pt, $.kCGMouseButtonLeft);
            $.CGEventPost($.kCGHIDEventTap, down);
            var up = $.CGEventCreateMouseEvent(src, $.kCGEventLeftMouseUp, pt, $.kCGMouseButtonLeft);
            $.CGEventPost($.kCGHIDEventTap, up);
            _result = {success: true};
          } catch(e2) {
            _result = {success: false, error: "Could not click element: " + String(e2.message || e2)};
          }
        }
      }
      JSON.stringify(_result);
    `;

    try {
      const out = execFileSync("osascript", [
        "-l", "JavaScript",
        "-e", jxaScript,
      ], { encoding: "utf-8", timeout: 15000 }).trim();

      const result = JSON.parse(out);
      if (!result.success) {
        throw result.error
          ? new Error(result.error)
          : new ElementNotFoundError(elementId);
      }
    } catch (error) {
      rethrowElementActionError(error, "click_element", elementId);
    }
  }

  async typeInElement(elementId: string, text: string, app?: string, clearFirst?: boolean): Promise<void> {
    this.evictExpiredCacheEntries();
    const textLiteral = JSON.stringify(text);
    const effectiveApp = app || this.activeTarget?.appName;
    const appLiteral = JSON.stringify(effectiveApp || "");
    const elementIdLiteral = JSON.stringify(elementId);
    const cached = this.elementCache.get(elementId);
    if (cached && this.isCacheEntryExpired(cached)) {
      this.elementCache.delete(elementId);
    }
    const cachedJson = JSON.stringify(this.elementCache.get(elementId) ?? null);

    const jxaScript = `
      var se = Application('System Events');
      var _result = null;
      function childElements(elem) {
        try { return elem.uiElements(); } catch(e1) {
          try { return elem.elements(); } catch(e2) { return []; }
        }
      }
      var elemPath = ${elementIdLiteral};
      var appName = ${appLiteral};
      var textToType = ${textLiteral};
      var shouldClear = ${clearFirst ? "true" : "false"};
      var cached = ${cachedJson};

      function resolveElementByFullPath(path) {
        var parts = path.split('/');
        if (parts.length < 2) return null;

        var procName = parts[0];
        var winPart = parts[1];
        var winIdx = 0;
        var match = winPart.match(/^win(\\\\d+)$/);
        if (match) {
          winIdx = parseInt(match[1]);
        }

        try {
          var proc = se.processes[procName]();
          var wins = proc.windows();
          if (winIdx >= wins.length) return null;
          var current = wins[winIdx];

          for (var i = 2; i < parts.length; i++) {
            var idx = parseInt(parts[i]);
            if (isNaN(idx)) return null;
            try {
              var kids = childElements(current);
              if (idx >= kids.length) return null;
              current = kids[idx];
            } catch(e) { return null; }
          }
          return current;
        } catch(e) { return null; }
      }

      function elemString(elem, getter) {
        try {
          var value = getter(elem);
          return value === undefined || value === null ? '' : String(value);
        } catch(e) {
          return '';
        }
      }

      function getBounds(elem) {
        try {
          var pos = elem.position();
          var sz = elem.size();
          return {x: pos[0] || 0, y: pos[1] || 0, width: sz[0] || 0, height: sz[1] || 0};
        } catch(e) {
          return {x: 0, y: 0, width: 0, height: 0};
        }
      }

      function descriptorMatches(elem) {
        if (!cached) return true;
        var role = elemString(elem, function(e) { return e.role(); });
        var name = elemString(elem, function(e) { return e.name(); });
        var desc = elemString(elem, function(e) { return e.description(); });
        var value = elemString(elem, function(e) { return e.value(); });
        if (cached.role && role && role !== cached.role) return false;
        if (cached.name && name && name !== cached.name) return false;
        if (cached.value && value && value !== cached.value) return false;
        if (cached.description && desc && desc !== cached.description) return false;
        return true;
      }

      function scoreEquivalent(elem) {
        if (!cached) return -1;
        var score = 0;
        var role = elemString(elem, function(e) { return e.role(); });
        var name = elemString(elem, function(e) { return e.name(); });
        var desc = elemString(elem, function(e) { return e.description(); });
        var value = elemString(elem, function(e) { return e.value(); });
        var subrole = elemString(elem, function(e) { return e.subrole(); });
        var identifier = elemString(elem, function(e) { return e.identifier(); });
        if (cached.role && role === cached.role) score += 4;
        if (cached.name && name === cached.name) score += 4;
        if (cached.value && value === cached.value) score += 3;
        if (cached.description && desc === cached.description) score += 2;
        if (cached.subrole && subrole === cached.subrole) score += 2;
        if (cached.identifier && identifier === cached.identifier) score += 3;
        var b = getBounds(elem);
        if (cached.bounds) {
          var cx = b.x + b.width / 2;
          var cy = b.y + b.height / 2;
          var ocx = cached.bounds.x + cached.bounds.width / 2;
          var ocy = cached.bounds.y + cached.bounds.height / 2;
          var distance = Math.sqrt(Math.pow(cx - ocx, 2) + Math.pow(cy - ocy, 2));
          if (distance < 8) score += 4;
          else if (distance < 40) score += 2;
          else if (distance < 120) score += 1;
        }
        return score;
      }

      function refetchEquivalent() {
        if (!cached) return null;
        var targetApp = appName || cached.appName || '';
        var best = null;
        var bestScore = 0;
        var visited = [0];
        function visit(elem, depth) {
          if (visited[0] > 350 || depth > 10) return;
          visited[0]++;
          var score = scoreEquivalent(elem);
          if (score > bestScore) {
            best = elem;
            bestScore = score;
          }
          try {
            var kids = childElements(elem);
            for (var i = 0; i < kids.length; i++) visit(kids[i], depth + 1);
          } catch(e) {}
        }
        try {
          if (targetApp) {
            var proc = se.processes[targetApp]();
            var wins = proc.windows();
            for (var w = 0; w < wins.length; w++) visit(wins[w], 0);
          } else {
            var procs = se.processes();
            for (var p = 0; p < procs.length; p++) {
              try {
                var wins2 = procs[p].windows();
                for (var w2 = 0; w2 < wins2.length; w2++) visit(wins2[w2], 0);
              } catch(e2) {}
            }
          }
        } catch(e) {}
        return bestScore >= 6 ? best : null;
      }

      var elem = null;

      if (appName) {
        try {
          var proc = se.processes[appName]();
          var wins = proc.windows();
          var parts = elemPath.split('/');
          var winIdx = 0;
          var match = parts[0].match(/^win(\\\\d+)$/);
          if (match) winIdx = parseInt(match[1]);
          if (winIdx < wins.length) {
            var current = wins[winIdx];
            for (var i = 1; i < parts.length; i++) {
              var idx = parseInt(parts[i]);
              if (isNaN(idx)) break;
              try {
                var kids = childElements(current);
                if (idx >= kids.length) break;
                current = kids[idx];
              } catch(e) { break; }
            }
            elem = current;
          }
        } catch(e) {}
      }

      if (!elem) {
        elem = resolveElementByFullPath(elemPath);
      }

      if (elem && !descriptorMatches(elem)) {
        elem = refetchEquivalent() || elem;
      }

      if (!elem) {
        elem = refetchEquivalent();
      }

      if (!elem) {
        _result = {success: false, error: "Element not found: " + elemPath};
      } else {
        try {
          elem.focused = true;
        } catch(e) {}

        if (shouldClear) {
          try {
            elem.value = "";
          } catch(e) {
            try {
              se.keystroke("a", {command: true});
              se.keyDown("delete");
              se.keyUp("delete");
            } catch(e2) {}
          }
        }

        var didSet = false;
        try {
          elem.value = textToType;
          didSet = true;
        } catch(e) {}

        if (!didSet) {
          try {
            se.keystroke(textToType);
            _result = {success: true};
          } catch(e) {
            _result = {success: false, error: "Could not type into element: " + String(e.message || e)};
          }
        } else {
          _result = {success: true};
        }
      }
      JSON.stringify(_result);
    `;

    try {
      const out = execFileSync("osascript", [
        "-l", "JavaScript",
        "-e", jxaScript,
      ], { encoding: "utf-8", timeout: 15000 }).trim();

      const result = JSON.parse(out);
      if (!result.success) {
        throw result.error
          ? new Error(result.error)
          : new ElementNotFoundError(elementId);
      }
    } catch (error) {
      rethrowElementActionError(error, "type_in_element", elementId);
    }
  }

  // ── Clipboard ───────────────────────────────────────────────────────────

  async readClipboard(): Promise<string> {
    try {
      const out = execFileSync("pbpaste", [], { encoding: "utf-8", timeout: 5000 });
      return out;
    } catch (error) {
      throw new PlatformError(`read_clipboard failed: ${errorMessage(error)}`);
    }
  }

  async writeClipboard(text: string): Promise<void> {
    try {
      execFileSync("pbcopy", [], { input: text, encoding: "utf-8", timeout: 5000 });
    } catch (error) {
      throw new PlatformError(`write_clipboard failed: ${errorMessage(error)}`);
    }
  }

  async setElementValue(elementId: string, value: string, app?: string): Promise<void> {
    this.evictExpiredCacheEntries();
    const effectiveApp = app || this.activeTarget?.appName;
    const valueLiteral = JSON.stringify(value);
    const appLiteral = JSON.stringify(effectiveApp || "");
    const elementIdLiteral = JSON.stringify(elementId);
    const cached = this.elementCache.get(elementId);
    if (cached && this.isCacheEntryExpired(cached)) {
      this.elementCache.delete(elementId);
    }
    const cachedJson = JSON.stringify(this.elementCache.get(elementId) ?? null);

    const jxaScript = `
      var se = Application('System Events');
      var _result = null;
      function childElements(elem) {
        try { return elem.uiElements(); } catch(e1) {
          try { return elem.elements(); } catch(e2) { return []; }
        }
      }
      var elemPath = ${elementIdLiteral};
      var appName = ${appLiteral};
      var valueToSet = ${valueLiteral};
      var cached = ${cachedJson};

      function resolveElementByFullPath(path) {
        var parts = path.split('/');
        if (parts.length < 2) return null;

        var procName = parts[0];
        var winPart = parts[1];
        var winIdx = 0;
        var match = winPart.match(/^win(\\\\d+)$/);
        if (match) winIdx = parseInt(match[1]);

        try {
          var proc = se.processes[procName]();
          var wins = proc.windows();
          if (winIdx >= wins.length) return null;
          var current = wins[winIdx];

          for (var i = 2; i < parts.length; i++) {
            var idx = parseInt(parts[i]);
            if (isNaN(idx)) return null;
            try {
              var kids = childElements(current);
              if (idx >= kids.length) return null;
              current = kids[idx];
            } catch(e) { return null; }
          }
          return current;
        } catch(e) { return null; }
      }

      function resolveElementInApp(path, targetApp) {
        if (!targetApp) return null;
        var parts = path.split('/');
        var start = parts[0] === targetApp ? 1 : 0;
        var winPart = parts[start] || 'win0';
        var winIdx = 0;
        var match = winPart.match(/^win(\\\\d+)$/);
        if (match) winIdx = parseInt(match[1]);

        try {
          var proc = se.processes[targetApp]();
          var wins = proc.windows();
          if (winIdx >= wins.length) return null;
          var current = wins[winIdx];
          for (var i = start + 1; i < parts.length; i++) {
            var idx = parseInt(parts[i]);
            if (isNaN(idx)) return null;
            try {
              var kids = childElements(current);
              if (idx >= kids.length) return null;
              current = kids[idx];
            } catch(e) { return null; }
          }
          return current;
        } catch(e) { return null; }
      }

      function elemString(elem, getter) {
        try {
          var value = getter(elem);
          return value === undefined || value === null ? '' : String(value);
        } catch(e) {
          return '';
        }
      }

      function getBounds(elem) {
        try {
          var pos = elem.position();
          var sz = elem.size();
          return {x: pos[0] || 0, y: pos[1] || 0, width: sz[0] || 0, height: sz[1] || 0};
        } catch(e) {
          return {x: 0, y: 0, width: 0, height: 0};
        }
      }

      function descriptorMatches(elem) {
        if (!cached) return true;
        var role = elemString(elem, function(e) { return e.role(); });
        var name = elemString(elem, function(e) { return e.name(); });
        var desc = elemString(elem, function(e) { return e.description(); });
        var value = elemString(elem, function(e) { return e.value(); });
        if (cached.role && role && role !== cached.role) return false;
        if (cached.name && name && name !== cached.name) return false;
        if (cached.value && value && value !== cached.value) return false;
        if (cached.description && desc && desc !== cached.description) return false;
        return true;
      }

      function scoreEquivalent(elem) {
        if (!cached) return -1;
        var score = 0;
        var role = elemString(elem, function(e) { return e.role(); });
        var name = elemString(elem, function(e) { return e.name(); });
        var desc = elemString(elem, function(e) { return e.description(); });
        var value = elemString(elem, function(e) { return e.value(); });
        var subrole = elemString(elem, function(e) { return e.subrole(); });
        var identifier = elemString(elem, function(e) { return e.identifier(); });
        if (cached.role && role === cached.role) score += 4;
        if (cached.name && name === cached.name) score += 4;
        if (cached.value && value === cached.value) score += 3;
        if (cached.description && desc === cached.description) score += 2;
        if (cached.subrole && subrole === cached.subrole) score += 2;
        if (cached.identifier && identifier === cached.identifier) score += 3;
        var b = getBounds(elem);
        if (cached.bounds) {
          var cx = b.x + b.width / 2;
          var cy = b.y + b.height / 2;
          var ocx = cached.bounds.x + cached.bounds.width / 2;
          var ocy = cached.bounds.y + cached.bounds.height / 2;
          var distance = Math.sqrt(Math.pow(cx - ocx, 2) + Math.pow(cy - ocy, 2));
          if (distance < 8) score += 4;
          else if (distance < 40) score += 2;
          else if (distance < 120) score += 1;
        }
        return score;
      }

      function refetchEquivalent() {
        if (!cached) return null;
        var targetApp = appName || cached.appName || '';
        var best = null;
        var bestScore = 0;
        var visited = [0];
        function visit(elem, depth) {
          if (visited[0] > 350 || depth > 10) return;
          visited[0]++;
          var score = scoreEquivalent(elem);
          if (score > bestScore) {
            best = elem;
            bestScore = score;
          }
          try {
            var kids = childElements(elem);
            for (var i = 0; i < kids.length; i++) visit(kids[i], depth + 1);
          } catch(e) {}
        }
        try {
          if (targetApp) {
            var proc = se.processes[targetApp]();
            var wins = proc.windows();
            for (var w = 0; w < wins.length; w++) visit(wins[w], 0);
          } else {
            var procs = se.processes();
            for (var p = 0; p < procs.length; p++) {
              try {
                var wins2 = procs[p].windows();
                for (var w2 = 0; w2 < wins2.length; w2++) visit(wins2[w2], 0);
              } catch(e2) {}
            }
          }
        } catch(e) {}
        return bestScore >= 6 ? best : null;
      }

      var elem = resolveElementInApp(elemPath, appName) || resolveElementByFullPath(elemPath);
      if (elem && !descriptorMatches(elem)) {
        elem = refetchEquivalent() || elem;
      }
      if (!elem) {
        elem = refetchEquivalent();
      }

      if (!elem) {
        _result = {success: false, error: "Element not found: " + elemPath};
      } else {
        try {
          elem.value = valueToSet;
          _result = {success: true};
        } catch(e) {
          _result = {success: false, error: "Could not set AX value: " + String(e.message || e)};
        }
      }
      JSON.stringify(_result);
    `;

    try {
      const out = execFileSync("osascript", [
        "-l", "JavaScript",
        "-e", jxaScript,
      ], { encoding: "utf-8", timeout: 15000 }).trim();

      const result = JSON.parse(out);
      if (!result.success) {
        throw result.error
          ? new Error(result.error)
          : new ElementNotFoundError(elementId);
      }
      const currentCached = this.elementCache.get(elementId);
      if (currentCached) {
        this.elementCache.set(elementId, { ...currentCached, value, cachedAt: Date.now() });
      }
    } catch (error) {
      rethrowElementActionError(error, "set_value", elementId);
    }
  }
}
