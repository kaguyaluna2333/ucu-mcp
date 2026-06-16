import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { MacOSPlatform } from "./base.js";
import type { AppInfo, AppTarget, WindowInfo, BrowserContext } from "../base.js";
import { WindowNotFoundError } from "../../util/errors.js";
import { rethrowAccessibilityError, selectWindowForApp } from "./helpers.js";

const __windowDirname = dirname(fileURLToPath(import.meta.url));

export async function listApps(this: MacOSPlatform): Promise<AppInfo[]> {
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
  try {
    const out = execFileSync("osascript", [
      "-l", "JavaScript",
      "-e", jxaScript,
    ], { encoding: "utf-8", timeout: 10000 }).trim();
    return JSON.parse(out) as AppInfo[];
  } catch (error) {
    rethrowAccessibilityError(error, "list_apps");
  }
}

export async function focusApp(this: MacOSPlatform, app: string): Promise<AppTarget> {
  const appLiteral = JSON.stringify(app);
  this.windowCache = undefined;

  let target: import("../base.js").WindowInfo | undefined;
  const deadline = Date.now() + 3000;
  do {
    const windows = await this.listWindows(true);
    target = selectWindowForApp(windows, app);
    if (target) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < deadline);

  if (!target) {
    // 托盘应用（LSUIElement，如 cc-switch）没有常规窗口——回退找菜单栏 status item，
    // 建立 tray activeTarget（windowId='tray'，validateActiveTarget 对它特判不查窗口）。
    try {
      const extras = await this.findMenuBarExtra(app);
      if (extras.length > 0) {
        this.activeTarget = {
          targetId: randomUUID(),
          appName: app,
          pid: 0,
          windowId: "tray",
          title: "",
          capturedAt: new Date().toISOString(),
        };
        return this.activeTarget;
      }
    } catch {
      // findMenuBarExtra 失败（AX 权限/进程不可达等），落到下面的 WindowNotFoundError
    }
    this.activeTarget = undefined;
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
    windowNumber: target.windowNumber,
  };
  return this.activeTarget;
}

export async function getActiveBrowserContext(this: MacOSPlatform, app?: string): Promise<BrowserContext | undefined> {
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

export async function listWindows(this: MacOSPlatform, _includeMinimized?: boolean): Promise<WindowInfo[]> {
  const now = Date.now();
  if (this.windowCache && now - this.windowCache.cachedAt <= this.windowCacheTtlMs) {
    return this.windowCache.windows.map((window: WindowInfo) => ({
      ...window,
      bounds: { ...window.bounds },
    }));
  }

  if (this.windowCacheInFlight) {
    return this.windowCache?.windows.map((w: WindowInfo) => ({ ...w, bounds: { ...w.bounds } })) ?? [];
  }
  this.windowCacheInFlight = true;

  try {
    let windows: WindowInfo[];
    const nativeResult = listWindowsNative.call(this);
    if (nativeResult !== null) {
      windows = nativeResult;
    } else {
      windows = await listWindowsJxa.call(this);
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
    return [];
  } finally {
    this.windowCacheInFlight = false;
  }
}

function listWindowsNative(this: MacOSPlatform): WindowInfo[] | null {
  try {
    const helperPath = resolveNativeHelper.call(this, "windowlist", "windowlist-helper");
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
      windowNumber: w.windowNumber,
    }));
  } catch {
    return null;
  }
}

function resolveNativeHelper(this: MacOSPlatform, folder: string, binary: string): string | null {
  if (this._nativeHelperPaths && folder in this._nativeHelperPaths) {
    const override = this._nativeHelperPaths[folder];
    return override === null ? null : override;
  }
  const candidates = [
    // npm prod: window.js 在 dist/src/platform/macos/（4 级深），到包根需 4 级 ../
    join(__windowDirname, "..", "..", "..", "..", "native", folder, binary),
    // dev: window.ts 在 src/platform/macos/（3 级深），3 级到包根
    join(__windowDirname, "..", "..", "..", "native", folder, binary),
    join(__windowDirname, "..", "..", "native", folder, binary),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function listWindowsJxa(this: MacOSPlatform): Promise<WindowInfo[]> {
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

    try {
      const jxaOut = execFileSync("osascript", [
        "-l", "JavaScript",
        "-e", jxaScript
      ], { encoding: "utf-8", timeout: 15000 });
      return JSON.parse(jxaOut.trim()) as WindowInfo[];
    } catch (error) {
      rethrowAccessibilityError(error, "list_windows_jxa");
    }
}
