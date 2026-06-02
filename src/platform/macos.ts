import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { Platform, ScreenRegion, ScreenSize, CursorPosition, WindowInfo, WindowState, ElementInfo, OcrResult, FindElementOptions, FindElementResult, AppInfo, AppTarget, BrowserContext, ScreenshotOptions } from "./base.js";
import { captureFullScreen, captureRegion, captureWindow } from "../utils/screenshot.js";
import { click as inputClick, doubleClick as inputDoubleClick, move as inputMove, drag as inputDrag, scroll as inputScroll, typeText, pressShortcut } from "../utils/input.js";

const execFileAsync = promisify(execFile);

interface CachedElementDescriptor {
  elementId: string;
  appName: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export class MacOSPlatform implements Platform {
  private readonly elementCache = new Map<string, CachedElementDescriptor>();
  private activeTarget: AppTarget | undefined;

  // ── Screenshot ──────────────────────────────────────────────────────────

  async screenshot(_display?: number, region?: ScreenRegion, options?: ScreenshotOptions): Promise<Buffer> {
    const base64 = region
      ? await captureRegion(region.x, region.y, region.width, region.height, options)
      : await captureFullScreen(options);
    return Buffer.from(base64, "base64");
  }

  async screenshotWindow(windowId: string, options?: ScreenshotOptions): Promise<Buffer> {
    const base64 = await captureWindow(windowId, options);
    return Buffer.from(base64, "base64");
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
      return false;
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
    const appLower = app.toLowerCase();
    const windows = await this.listWindows(true);
    const target = windows.find((w) => w.processName.toLowerCase().includes(appLower));
    if (!target) {
      throw new Error(`No on-screen window found for app "${app}". Use list_apps to inspect localized macOS app names.`);
    }
    this.activeTarget = {
      appName: target.processName,
      pid: target.pid,
      windowId: target.id,
      title: target.title,
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

    const escapedApp = appName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const jxaScript = `
      function run() {
        var appName = "${escapedApp}";
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
    try {
      const jxaScript = `
        ObjC.import('CoreGraphics');
        ObjC.import('Foundation');
        var winList = $.CGWindowListCopyWindowInfo(1, 0);
        var count = winList.count;
        var result = [];
        for (var i = 0; i < count; i++) {
          var w = $(winList).objectAtIndex(i);
          var bounds = w.objectForKey('kCGWindowBounds');
          var numberVal = w.objectForKey('kCGWindowNumber');
          var nameVal = w.objectForKey('kCGWindowName');
          var ownerVal = w.objectForKey('kCGWindowOwnerName');
          var pidVal = w.objectForKey('kCGWindowOwnerPID');
          var onScreenVal = w.objectForKey('kCGWindowIsOnscreen');
          var layerVal = w.objectForKey('kCGWindowLayer');

          // Skip windows at layer > 0 (menus, overlays, etc.)
          if (layerVal && layerVal.intValue > 0) continue;

          var bx = 0, by = 0, bw = 0, bh = 0;
          try { bx = $(bounds).objectForKey('X').intValue; } catch(e) {}
          try { by = $(bounds).objectForKey('Y').intValue; } catch(e) {}
          try { bw = $(bounds).objectForKey('Width').intValue; } catch(e) {}
          try { bh = $(bounds).objectForKey('Height').intValue; } catch(e) {}

          // Skip zero-size windows
          if (bw === 0 && bh === 0) continue;

          result.push({
            id: String(numberVal ? numberVal.intValue : 0),
            title: nameVal ? String(nameVal) : '',
            processName: ownerVal ? String(ownerVal) : '',
            pid: pidVal ? pidVal.intValue : 0,
            bounds: { x: bx, y: by, width: bw, height: bh },
            isMinimized: false,
            isOnScreen: onScreenVal ? onScreenVal.boolValue : true
          });
        }
        JSON.stringify(result);
      `;

      const jxaOut = execFileSync("osascript", [
        "-l", "JavaScript",
        "-e", jxaScript
      ], { encoding: "utf-8", timeout: 15000 });
      return JSON.parse(jxaOut.trim());
    } catch {
      // Fallback: return empty list if JXA fails
      return [];
    }
  }

  async getWindowState(windowId?: string, depth?: number, includeBounds: boolean = true): Promise<WindowState> {
    const resolvedWindowId = windowId || this.activeTarget?.windowId;
    if (!resolvedWindowId) {
      throw new Error("getWindowState requires windowId or a prior focus_app target");
    }
    const maxDepth = Math.min(depth || 3, 10);
    const maxElements = 50;
    const escapedWindowId = resolvedWindowId.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    const targetWindow = (await this.listWindows(true)).find((w) => w.id === resolvedWindowId);
    const targetJson = JSON.stringify(targetWindow ?? null);

    try {
      const jxaScript = `
        ObjC.import('AppKit');
        var se = Application('System Events');
        var result = {window: null, focusedElement: null, tree: null, error: null};
        var target = ${targetJson};
        var includeBounds = ${includeBounds ? "true" : "false"};

        function closeEnough(a, b, tolerance) {
          return Math.abs(Number(a || 0) - Number(b || 0)) <= tolerance;
        }

        function windowMatches(win, proc) {
          if (!target) {
            try { return String(win.id()) === String("${escapedWindowId}"); } catch(e) { return false; }
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

          try { return String(win.id()) === String("${escapedWindowId}"); } catch(e) {}
          return false;
        }

        try {
          var foundWin = null;
          var foundProc = null;
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
          if (!foundWin) { result.error = 'Window not found'; JSON.stringify(result); return; }

          var winPos = foundWin.position();
          var winSize = foundWin.size();
          result.window = {
            id: String("${escapedWindowId}"),
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
                var kids = axElem.elements();
                for (var k = 0; k < kids.length && elemCount[0] < ${maxElements}; k++) {
                  var child = extractElement(kids[k], currentDepth + 1);
                  if (child) info.children.push(child);
                }
              } catch(e) {}
            }
            return info;
          }

          result.tree = extractElement(foundWin, 0);
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
        throw new Error(parsed.error);
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
    } catch (error: any) {
      if (String(error.message || error).includes("not allowed") ||
          String(error.message || error).includes("permission") ||
          String(error.message || error).includes("assistive")) {
        throw new Error(`Accessibility permission required: grant System Events access in System Preferences > Privacy & Accessibility`);
      }
      throw new Error(`Window ${resolvedWindowId} not found or Accessibility permission missing`);
    }
  }

  // ── Mouse ───────────────────────────────────────────────────────────────

  async click(x: number, y: number, button?: "left" | "right" | "middle", doubleClick?: boolean): Promise<void> {
    if (doubleClick) {
      await inputDoubleClick(x, y, button);
    } else {
      await inputClick(x, y, button);
    }
  }

  async move(x: number, y: number): Promise<void> {
    await inputMove(x, y);
  }

  async drag(startX: number, startY: number, endX: number, endY: number, button?: "left" | "right" | "middle", duration?: number): Promise<void> {
    await inputDrag(startX, startY, endX, endY, button, duration);
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await inputScroll(x, y, deltaX, deltaY);
  }

  // ── Cursor ──────────────────────────────────────────────────────────────

  getCursorPosition(): CursorPosition {
    try {
      const out = execFileSync("osascript", [
        "-l", "JavaScript",
        "-e",
        `ObjC.import('CoreGraphics');
        var event = $.CGEventCreate(null);
        var loc = $.CGEventGetLocation(event);
        $.CFRelease(event);
        JSON.stringify({x:Math.round(loc.x),y:Math.round(loc.y)})`,
      ], { encoding: "utf-8", timeout: 5000 }).trim();
      return JSON.parse(out) as CursorPosition;
    } catch (error: any) {
      throw new Error(`get_cursor_position failed: ${error.message || error}`);
    }
  }

  // ── OCR ──────────────────────────────────────────────────────────────────

  async ocr(display?: number, region?: ScreenRegion): Promise<OcrResult> {
    // Take a screenshot first (reuse existing logic)
    const buf = await this.screenshot(display, region);

    // Write screenshot to a temp file so Vision framework can read it
    const { writeFile, unlink } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const tmpPath = join(tmpdir(), `ucu-ocr-${randomUUID()}.png`);
    await writeFile(tmpPath, buf);

    try {
      const screenSize = this.getScreenSize(display);
      const scaleFactor = screenSize.scaleFactor ?? 2;

      // Build JXA script that uses Vision framework for OCR
      // JXA does not allow return statements at global scope, so we wrap in a function
      const jxaScript = `
        function run() {
          ObjC.import('Vision');
          ObjC.import('AppKit');
          ObjC.import('Foundation');

          var app = Application.currentApplication();
          app.includeStandardAdditions = true;

          var path = "${tmpPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$')}";
          var url = $.NSURL.fileURLWithPath(path);
          var image = $.NSImage.alloc.initWithContentsOfURL(url);

          if (!image || image.isValid() === false) {
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

              // Vision boundingBox is normalized (0-1) with origin at bottom-left
              // Convert to screen coordinates (origin at top-left)
              var bx = bbox.origin.x * imgWidth;
              var by = (1 - bbox.origin.y - bbox.size.height) * imgHeight;
              var bw = bbox.size.width * imgWidth;
              var bh = bbox.size.height * imgHeight;

              elements.push({
                text: text,
                x: Math.round(bx),
                y: Math.round(by),
                width: Math.round(bw),
                height: Math.round(bh),
                confidence: confidence
              });
              fullTextParts.push(text);
            }
          }

          return JSON.stringify({elements: elements, fullText: fullTextParts.join("\\n"), error: null});
        }
        run();
      `;

      const out = execFileSync("osascript", [
        "-l", "JavaScript",
        "-e", jxaScript,
      ], { encoding: "utf-8", timeout: 30000 }).trim();

      const parsed = JSON.parse(out);

      if (parsed.error) {
        throw new Error(parsed.error);
      }

      // Scale coordinates from image space to screen space
      // The screenshot may be taken at a different resolution than screen coordinates
      const imgWidth = buf.readUInt32BE(16); // PNG width at offset 16
      const scaleFactorX = screenSize.width / (region ? region.width : (imgWidth / scaleFactor));

      const elements = parsed.elements.map((el: any) => ({
        text: el.text,
        x: Math.round(el.x / scaleFactor) + (region ? region.x : 0),
        y: Math.round(el.y / scaleFactor) + (region ? region.y : 0),
        width: Math.round(el.width / scaleFactor),
        height: Math.round(el.height / scaleFactor),
        confidence: el.confidence,
      }));

      return {
        elements,
        fullText: parsed.fullText,
      };
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  }

  // ── Keyboard ────────────────────────────────────────────────────────────

  async type(text: string, delay?: number): Promise<void> {
    await typeText(text, delay);
  }

  async key(keys: string[]): Promise<void> {
    await pressShortcut(keys);
  }

  // ── Accessibility (AX) Element Actions ───────────────────────────────────

  async findElement(options: FindElementOptions): Promise<FindElementResult[]> {
    const { text, role, app, depth, includeBounds = true } = options;
    const effectiveApp = app || this.activeTarget?.appName;
    const maxDepth = Math.min(depth || 5, 10);
    const maxResults = Math.min(Math.max(options.maxResults ?? 50, 1), 200);
    const escapedApp = (effectiveApp || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    const escapedText = text ? text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$') : "";
    const escapedRole = role ? role.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$') : "";

    const jxaScript = `
      var se = Application('System Events');
      var results = [];
      var resultCount = [0];
      var maxResults = ${maxResults};
      var includeBounds = ${includeBounds ? "true" : "false"};

      var textFilter = ${text ? `"${escapedText}"` : "null"};
      var roleFilter = ${role ? `"${escapedRole}"` : "null"};

      function matches(elem) {
        var elemName = '';
        var elemRole = '';
        var elemDesc = '';
        var elemValue = '';
        try { elemName = elem.name() || ''; } catch(e) {}
        try { elemRole = elem.role() || ''; } catch(e) {}
        try { elemDesc = elem.description() || ''; } catch(e) {}
        try { var v = elem.value(); elemValue = (v !== undefined && v !== null) ? String(v) : ''; } catch(e) {}

        if (textFilter !== null) {
          var t = textFilter.toLowerCase();
          if (elemName.toLowerCase().indexOf(t) === -1 &&
              elemValue.toLowerCase().indexOf(t) === -1 &&
              elemDesc.toLowerCase().indexOf(t) === -1) {
            return false;
          }
        }
        if (roleFilter !== null) {
          if (elemRole !== roleFilter) return false;
        }
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
            description: undefined
          };
          var elemName = '';
          var elemRole = '';
          var elemDesc = '';
          var elemValue = '';
          try { elemName = elem.name() || ''; } catch(e) {}
          try { elemRole = elem.role() || ''; } catch(e) {}
          try { elemDesc = elem.description() || ''; } catch(e) {}
          try { var v = elem.value(); elemValue = (v !== undefined && v !== null) ? String(v) : ''; } catch(e) {}

          item.role = elemRole;
          item.name = elemName;
          if (elemValue) item.value = elemValue;
          if (elemDesc) item.description = elemDesc;
          if (includeBounds) item.bounds = getBounds(elem);
          results.push(item);
          resultCount[0]++;
        }

        if (currentDepth < ${maxDepth}) {
          try {
            var kids = elem.elements();
            for (var k = 0; k < kids.length && resultCount[0] < maxResults; k++) {
              traverse(kids[k], path + '/' + k, currentDepth + 1);
            }
          } catch(e) {}
        }
      }

      try {
        if ("${escapedApp}") {
          var proc = se.processes["${escapedApp}"]();
          var wins = proc.windows();
          for (var w = 0; w < wins.length && resultCount[0] < maxResults; w++) {
            traverse(wins[w], "win" + w, 0);
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

      JSON.stringify(results);
    `;

    try {
      const out = execFileSync("osascript", [
        "-l", "JavaScript",
        "-e", jxaScript,
      ], { encoding: "utf-8", timeout: 30000 }).trim();

      const results = JSON.parse(out) as FindElementResult[];
      for (const result of results) {
        const appName = effectiveApp || result.id.split("/")[0] || "";
        this.elementCache.set(result.id, {
          elementId: result.id,
          appName,
          role: result.role,
          name: result.name,
          value: result.value,
          description: result.description,
          bounds: result.bounds,
        });
      }
      return results;
    } catch (error: any) {
      if (String(error.message || error).includes("not allowed") ||
          String(error.message || error).includes("permission") ||
          String(error.message || error).includes("assistive")) {
        throw new Error("Accessibility permission required: grant System Events access in System Preferences > Privacy & Accessibility");
      }
      throw new Error(`find_element failed: ${error.message || error}`);
    }
  }

  async clickElement(elementId: string, app?: string): Promise<void> {
    const escapedElementId = elementId.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    const effectiveApp = app || this.activeTarget?.appName;
    const escapedApp = (effectiveApp || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    const cached = this.elementCache.get(elementId);
    const cachedJson = JSON.stringify(cached ?? null);

    const jxaScript = `
      var se = Application('System Events');
      var elemPath = "${escapedElementId}";
      var appName = "${escapedApp}";
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
              var kids = current.elements();
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
        if (cached.role && role === cached.role) score += 4;
        if (cached.name && name === cached.name) score += 4;
        if (cached.value && value === cached.value) score += 3;
        if (cached.description && desc === cached.description) score += 2;
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
            var kids = elem.elements();
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
                var kids = current.elements();
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
        JSON.stringify({success: false, error: "Element not found: " + elemPath});
      } else {
        try {
          elem.actions.AXPress.perform();
          JSON.stringify({success: true});
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
            JSON.stringify({success: true});
          } catch(e2) {
            JSON.stringify({success: false, error: "Could not click element: " + String(e2.message || e2)});
          }
        }
      }
    `;

    try {
      const out = execFileSync("osascript", [
        "-l", "JavaScript",
        "-e", jxaScript,
      ], { encoding: "utf-8", timeout: 15000 }).trim();

      const result = JSON.parse(out);
      if (!result.success) {
        throw new Error(result.error || `click_element failed for element ${elementId}`);
      }
    } catch (error: any) {
      if (error.message && error.message.includes("click_element failed")) throw error;
      if (String(error.message || error).includes("not allowed") ||
          String(error.message || error).includes("permission")) {
        throw new Error("Accessibility permission required: grant System Events access in System Preferences > Privacy & Accessibility");
      }
      throw new Error(`click_element failed: ${error.message || error}`);
    }
  }

  async typeInElement(elementId: string, text: string, app?: string, clearFirst?: boolean): Promise<void> {
    const escapedText = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    const effectiveApp = app || this.activeTarget?.appName;
    const escapedApp = (effectiveApp || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    const escapedElementId = elementId.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    const cached = this.elementCache.get(elementId);
    const cachedJson = JSON.stringify(cached ?? null);

    const jxaScript = `
      var se = Application('System Events');
      var elemPath = "${escapedElementId}";
      var appName = "${escapedApp}";
      var textToType = "${escapedText}";
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
              var kids = current.elements();
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
        if (cached.role && role === cached.role) score += 4;
        if (cached.name && name === cached.name) score += 4;
        if (cached.value && value === cached.value) score += 3;
        if (cached.description && desc === cached.description) score += 2;
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
            var kids = elem.elements();
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
                var kids = current.elements();
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
        JSON.stringify({success: false, error: "Element not found: " + elemPath});
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
          } catch(e) {
            JSON.stringify({success: false, error: "Could not type into element: " + String(e.message || e)});
          }
        }

        JSON.stringify({success: true});
      }
    `;

    try {
      const out = execFileSync("osascript", [
        "-l", "JavaScript",
        "-e", jxaScript,
      ], { encoding: "utf-8", timeout: 15000 }).trim();

      const result = JSON.parse(out);
      if (!result.success) {
        throw new Error(result.error || `type_in_element failed for element ${elementId}`);
      }
    } catch (error: any) {
      if (error.message && error.message.includes("type_in_element failed")) throw error;
      if (String(error.message || error).includes("not allowed") ||
          String(error.message || error).includes("permission")) {
        throw new Error("Accessibility permission required: grant System Events access in System Preferences > Privacy & Accessibility");
      }
      throw new Error(`type_in_element failed: ${error.message || error}`);
    }
  }

  async setElementValue(elementId: string, value: string, app?: string): Promise<void> {
    const effectiveApp = app || this.activeTarget?.appName;
    const valueLiteral = JSON.stringify(value);
    const appLiteral = JSON.stringify(effectiveApp || "");
    const elementIdLiteral = JSON.stringify(elementId);
    const cached = this.elementCache.get(elementId);
    const cachedJson = JSON.stringify(cached ?? null);

    const jxaScript = `
      var se = Application('System Events');
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
              var kids = current.elements();
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
              var kids = current.elements();
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
        if (cached.role && role === cached.role) score += 4;
        if (cached.name && name === cached.name) score += 4;
        if (cached.value && value === cached.value) score += 3;
        if (cached.description && desc === cached.description) score += 2;
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
            var kids = elem.elements();
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
        JSON.stringify({success: false, error: "Element not found: " + elemPath});
      } else {
        try {
          elem.value = valueToSet;
          JSON.stringify({success: true});
        } catch(e) {
          JSON.stringify({success: false, error: "Could not set AX value: " + String(e.message || e)});
        }
      }
    `;

    try {
      const out = execFileSync("osascript", [
        "-l", "JavaScript",
        "-e", jxaScript,
      ], { encoding: "utf-8", timeout: 15000 }).trim();

      const result = JSON.parse(out);
      if (!result.success) {
        throw new Error(result.error || `set_value failed for element ${elementId}`);
      }
      if (cached) {
        this.elementCache.set(elementId, { ...cached, value });
      }
    } catch (error: any) {
      if (error.message && error.message.includes("set_value failed")) throw error;
      if (String(error.message || error).includes("not allowed") ||
          String(error.message || error).includes("permission")) {
        throw new Error("Accessibility permission required: grant System Events access in System Preferences > Privacy & Accessibility");
      }
      throw new Error(`set_value failed: ${error.message || error}`);
    }
  }
}
