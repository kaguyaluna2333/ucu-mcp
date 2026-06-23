import { execFileSync } from "node:child_process";
import type { MacOSPlatform } from "./base.js";
import type { WindowInfo, WindowState, FindElementOptions, FindElementResult, FindElementResponse } from "../base.js";
import { WindowNotFoundError, PlatformError } from "../../util/errors.js";
import { rethrowAccessibilityError, errorMessage } from "./helpers.js";
import { jxaChildElements, jxaGetBounds, jxaIsVisible } from "../jxa-helpers.js";
import { resolveNativeHelper } from "./window.js";
import { logger } from "../../util/logger.js";

export async function getWindowState(this: MacOSPlatform, windowId?: string, depth?: number, includeBounds: boolean = true): Promise<WindowState> {
  if (!windowId || windowId === this.activeTarget?.windowId) {
    await this.validateActiveTarget();
  }
  const resolvedWindowId = windowId || this.activeTarget?.windowId;
  if (!resolvedWindowId) {
    throw new WindowNotFoundError("active target");
  }
  const maxDepth = Math.min(depth || 3, 10);

  // ponytail: native CoreFoundation AX helper first — ~36x faster than the JXA
  // bridge (0.05s vs 1.7s measured on ccSwitch). Falls back to the JXA path
  // below if the helper binary is absent or returns an error.
  const nativeState = getWindowStateNative.call(this, resolvedWindowId, maxDepth, includeBounds);
  if (nativeState) return nativeState;

  const maxElements = 50;
  const windowIdLiteral = JSON.stringify(resolvedWindowId);
  const targetWindow = (await this.listWindows(true)).find((w) => w.id === resolvedWindowId);
  const targetJson = JSON.stringify(targetWindow ?? null);

  try {
    const jxaScript = `
      ObjC.import('AppKit');
      var se = Application('System Events');
      ${jxaChildElements()}
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

      var idParts = ${windowIdLiteral}.split('/');
      if (idParts.length >= 2 && idParts[0]) {
        var procName = idParts[0];
        var winIdx = 0;
        var winMatch = idParts[1].match(/^win(\\d+)$/);
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

export async function findElement(this: MacOSPlatform, options: FindElementOptions): Promise<FindElementResponse> {
  this.evictExpiredCacheEntries();
  const { text, role, app, depth, includeBounds = true, textMode = "contains", visibleOnly = false, value } = options;
  const effectiveApp = app || this.activeTarget?.appName;
  const maxDepth = Math.min(depth || 5, 10);
  const maxResults = Math.min(Math.max(options.maxResults ?? 50, 1), 200);
  const appLiteral = JSON.stringify(effectiveApp || "");
  const textLiteral = text ? JSON.stringify(text) : "null";
  const roleLiteral = role ? JSON.stringify(role) : "null";
  const valueLiteral = value ? JSON.stringify(value) : "null";

  if (text && textMode === "regex") {
    try {
      new RegExp(text);
    } catch {
      throw new PlatformError(`Invalid regex pattern: ${text}`);
    }
  }
  if (value && textMode === "regex") {
    try {
      new RegExp(value);
    } catch {
      throw new PlatformError(`Invalid regex pattern: ${value}`);
    }
  }

  const startTime = Date.now();

  // ponytail: native AX helper first (~36x faster); JXA below is the fallback.
  const nativeFind = findElementNative.call(this, options);

    const jxaScript = `
      var se = Application('System Events');
      ${jxaChildElements()}
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

    ${jxaIsVisible()}

    function matchesValue(filter, value, mode) {
      if (filter === null) return true;
      if (mode === "exact") {
        return value.toLowerCase() === filter.toLowerCase();
      } else if (mode === "regex") {
        try {
          return new RegExp(filter, "i").test(value);
        } catch(e) { return false; }
      } else {
        return value.toLowerCase().indexOf(filter.toLowerCase()) !== -1;
      }
    }

    function textMatches(elemName, elemValue, elemDesc) {
      if (textFilter === null) return true;
      var sources = [elemName, elemValue, elemDesc];
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

    ${jxaGetBounds()}

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
    // nativeFind short-circuits the JXA spawn when set; native errors are
    // swallowed inside findElementNative (returns null) so they fall through to JXA.
    const parsed = (nativeFind ?? JSON.parse(execFileSync("osascript", [
      "-l", "JavaScript",
      "-e", jxaScript,
    ], { encoding: "utf-8", timeout: 30000 }).trim())) as { results: FindElementResult[]; scannedCount: number; matchedCount: number };
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
        subrole: result.subrole,
        identifier: result.identifier,
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

// ponytail: native CoreFoundation AX traversal via the ax-helper binary.
// ~36x faster than JXA (no per-attribute ObjC bridge hop, no osascript spawn).
// Both return null when the helper is absent or errors so callers fall back to JXA.
function getWindowStateNative(this: MacOSPlatform, windowId: string, maxDepth: number, includeBounds: boolean): WindowState | null {
  const pid = this.activeTarget?.pid;
  if (!pid) return null;
  // tray targets ("tray" or any non-"App/winN" id) can't be resolved by the
  // helper's winN index — fall back to JXA so behavior matches pre-native
  // (WindowNotFoundError) instead of silently returning host window 0.
  if (!windowId.includes("/win")) return null;
  const helperPath = resolveNativeHelper.call(this, "ax", "ax-helper");
  if (!helperPath) return null;
  try {
    const out = execFileSync(helperPath, [], {
      input: JSON.stringify({ command: "getWindowState", pid, windowId, depth: maxDepth, maxNodes: 50, includeBounds }),
      encoding: "utf-8",
      timeout: 15000,
    }).trim();
    const parsed = JSON.parse(out);
    // tree-less success means winIdx was out of range: windowId carries a
    // CGWindowNumber from windowlist (not an index), so it almost never maps to
    // a valid kAXWindowsAttribute slot → fall back to JXA (which matches by
    // title/bounds) instead of returning a degenerate tree-less WindowState.
    if (parsed.error || !parsed.window || !parsed.tree) return null;
    const w = parsed.window;
    // shape guard: a malformed payload (drift) must fall back to JXA, not yield
    // a degenerate WindowInfo with missing bounds fields.
    if (!w.bounds || typeof w.bounds.x !== "number" || typeof w.bounds.width !== "number") return null;
    return {
      window: {
        id: w.id ?? windowId,
        title: w.title ?? "",
        processName: w.processName ?? "",
        pid: w.pid ?? pid,
        bounds: w.bounds,
        isMinimized: w.isMinimized ?? false,
        isOnScreen: w.isOnScreen ?? true,
      },
      focusedElement: parsed.focusedElement || undefined,
      tree: parsed.tree || undefined,
    };
  } catch (error) {
    logger.warn("native ax-helper failed, falling back to JXA", { op: "getWindowState", error: errorMessage(error) });
    return null;
  }
}

function findElementNative(this: MacOSPlatform, options: FindElementOptions): { results: FindElementResult[]; scannedCount: number; matchedCount: number } | null {
  const helperPath = resolveNativeHelper.call(this, "ax", "ax-helper");
  if (!helperPath) return null;
  const { text, role, app, depth, includeBounds = true, textMode = "contains", visibleOnly = false, value } = options;
  const effectiveApp = app || this.activeTarget?.appName;
  const pid = this.activeTarget?.pid;
  const input: Record<string, unknown> = {
    command: "findElement",
    depth: Math.min(depth || 5, 10),
    // maxNodes 2000: JXA's findElement is effectively unbounded (capped only by
    // maxResults), so a low cap lost matches on ccSwitch's multi-window tree.
    // 2000 is a hard ceiling — apps with larger trees truncate here where JXA
    // would not; acceptable for the ~200x perf win, revisit if a target needs more.
    maxNodes: 2000,
    maxResults: Math.min(Math.max(options.maxResults ?? 50, 1), 200),
    includeBounds,
    textMode,
    visibleOnly,
  };
  if (text) input.text = text;
  if (role) input.role = role;
  if (value) input.value = value;
  // app is always passed when known: ax-helper uses it as the elementId prefix
  // (matching JXA's `${app}/win${w}` path) even when a pid is also present.
  if (effectiveApp) input.app = effectiveApp;
  if (pid) input.pid = pid;
  else if (!effectiveApp) input.scanAllProcesses = true;
  try {
    const out = execFileSync(helperPath, [], {
      input: JSON.stringify(input),
      encoding: "utf-8",
      timeout: 30000,
    }).trim();
    const r = JSON.parse(out);
    if (r.error) return null;
    // shape guard: drift (e.g. renamed fields) must fall back to JXA, not coerce
    // into a silent empty-result success that bypasses JXA.
    if (!Array.isArray(r.results) || typeof r.scannedCount !== "number" || typeof r.matchedCount !== "number") return null;
    return { results: r.results, scannedCount: r.scannedCount, matchedCount: r.matchedCount };
  } catch (error) {
    logger.warn("native ax-helper failed, falling back to JXA", { op: "findElement", error: errorMessage(error) });
    return null;
  }
}
