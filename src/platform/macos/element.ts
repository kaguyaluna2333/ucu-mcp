import { execFileSync } from "node:child_process";
import type { MacOSPlatform } from "./base.js";
import { ElementNotFoundError } from "../../util/errors.js";
import { rethrowElementActionError } from "./helpers.js";

export async function clickElement(this: MacOSPlatform, elementId: string, app?: string): Promise<void> {
  this.evictExpiredCacheEntries();
  const elementIdLiteral = JSON.stringify(elementId);
  const effectiveApp = app || (this as any).activeTarget?.appName;
  const appLiteral = JSON.stringify(effectiveApp || "");
  const cached = (this as any).elementCache.get(elementId);
  if (cached && this.isCacheEntryExpired(cached)) {
    (this as any).elementCache.delete(elementId);
  }
  const cachedJson = JSON.stringify((this as any).elementCache.get(elementId) ?? null);

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

export async function typeInElement(this: MacOSPlatform, elementId: string, text: string, app?: string, clearFirst?: boolean): Promise<void> {
  this.evictExpiredCacheEntries();
  const textLiteral = JSON.stringify(text);
  const effectiveApp = app || (this as any).activeTarget?.appName;
  const appLiteral = JSON.stringify(effectiveApp || "");
  const elementIdLiteral = JSON.stringify(elementId);
  const cached = (this as any).elementCache.get(elementId);
  if (cached && this.isCacheEntryExpired(cached)) {
    (this as any).elementCache.delete(elementId);
  }
  const cachedJson = JSON.stringify((this as any).elementCache.get(elementId) ?? null);

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

export async function setElementValue(this: MacOSPlatform, elementId: string, value: string, app?: string): Promise<void> {
  this.evictExpiredCacheEntries();
  const effectiveApp = app || (this as any).activeTarget?.appName;
  const valueLiteral = JSON.stringify(value);
  const appLiteral = JSON.stringify(effectiveApp || "");
  const elementIdLiteral = JSON.stringify(elementId);
  const cached = (this as any).elementCache.get(elementId);
  if (cached && this.isCacheEntryExpired(cached)) {
    (this as any).elementCache.delete(elementId);
  }
  const cachedJson = JSON.stringify((this as any).elementCache.get(elementId) ?? null);

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
    const currentCached = (this as any).elementCache.get(elementId);
    if (currentCached) {
      (this as any).elementCache.set(elementId, { ...currentCached, value, cachedAt: Date.now() });
    }
  } catch (error) {
    rethrowElementActionError(error, "set_value", elementId);
  }
}
