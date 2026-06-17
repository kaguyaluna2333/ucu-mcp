import { execFileSync } from "node:child_process";
import type { MacOSPlatform } from "./base.js";
import type { ClickResult } from "../base.js";
import { ElementNotFoundError } from "../../util/errors.js";
import { rethrowElementActionError } from "./helpers.js";
import { jxaElementActionHelpers } from "../jxa-helpers.js";

/**
 * App-name hints for which AXPress is known to be silently swallowed
 * (Tauri custom window decorations, some Electron controls). When the target
 * app matches, clickElement/clickMenuBarExtra skip AXPress and go straight to
 * a coordinate click. Conservative starting set — extend as more silent-swallow
 * apps are confirmed.
 */
const AX_SILENT_APP_HINTS = ["tauri"];

function preferCoordinateClick(appName?: string): boolean {
  if (!appName) return false;
  const n = appName.toLowerCase();
  return AX_SILENT_APP_HINTS.some((h) => n.includes(h));
}

function prepareCache(this: MacOSPlatform, elementId: string) {
  this.evictExpiredCacheEntries();
  const cached = this.elementCache.get(elementId);
  if (cached && this.isCacheEntryExpired(cached)) {
    this.elementCache.delete(elementId);
  }
  return this.elementCache.get(elementId) ?? null;
}

/**
 * Shared JXA snippet: read an observable state signature from an AX element.
 * Used by clickElement/clickMenuBarExtra to verify whether AXPress actually
 * changed anything (Tauri/Electron silently swallow AXPress without throwing).
 * Returns a string concatenation of value/focused/selected (each defensively
 * read; missing attributes contribute ''). An empty signature means the element
 * exposes no observable state — verification is inconclusive.
 */
const JXA_STATE_SIGNATURE = `
  function stateSignature(elem) {
    var parts = [];
    try { var v = elem.value(); parts.push('v=' + (v === undefined || v === null ? '' : String(v))); } catch(e) { parts.push('v='); }
    try { parts.push('f=' + (elem.focused ? (elem.focused() ? 1 : 0) : '')); } catch(e) { parts.push('f='); }
    try { parts.push('s=' + (elem.selected ? (elem.selected() ? 1 : 0) : '')); } catch(e) { parts.push('s='); }
    return parts.join('|');
  }
  // Brief synchronous spin to let an async AXPress propagate state.
  function spinMs(ms) { var t = Date.now(); while (Date.now() - t < ms) {} }
`;

/**
 * Shared JXA snippet: compute the element's bounds center (for coordinate fallback).
 * Does NOT post any event — the actual click is performed by the TS input layer
 * (this.click) so it routes through per-process posting (skylight-helper) when a
 * pid is available, instead of the JXA HID-tap that would move the global cursor.
 */
const JXA_BOUNDS_CENTER = `
  function boundsCenter(elem) {
    var pos = elem.position();
    var sz = elem.size();
    return {x: pos[0] + sz[0] / 2, y: pos[1] + sz[1] / 2};
  }
`;

export async function clickElement(this: MacOSPlatform, elementId: string, app?: string): Promise<ClickResult> {
  const elementIdLiteral = JSON.stringify(elementId);
  const effectiveApp = app || this.activeTarget?.appName;
  const appLiteral = JSON.stringify(effectiveApp || "");
  const cachedDescriptor = prepareCache.call(this, elementId);
  const cachedJson = JSON.stringify(cachedDescriptor);
  const preferCoord = preferCoordinateClick(effectiveApp);

  const jxaScript = `
    var se = Application('System Events');
    var _result = null;
    ${jxaElementActionHelpers()}
    ${JXA_STATE_SIGNATURE}
    ${JXA_BOUNDS_CENTER}
    var elemPath = ${elementIdLiteral};
    var appName = ${appLiteral};
    // 容忍大小写/空格/连字符/下划线变体（cc-switch vs CC Switch vs cc_switch）
    var _norm = function(s) { return String(s||'').toLowerCase().split(' ').join('').split('-').join('').split('_').join(''); };
    var appNorm = _norm(appName);
    var cached = ${cachedJson};
    var preferCoord = ${preferCoord ? "true" : "false"};

    var elem = resolveElementInApp(elemPath, appName) || resolveElementByFullPath(elemPath);
    if (elem && !descriptorMatches(elem)) {
      elem = refetchEquivalent() || elem;
    }
    if (!elem) {
      elem = refetchEquivalent();
    }

    if (!elem) {
      _result = {success: false, error: "Element not found: " + elemPath};
    } else if (preferCoord) {
      // 启发式命中（Tauri 等已知静默吞 AXPress 的应用）：请求坐标点击（TS 层执行 per-process）
      var c = boundsCenter(elem);
      _result = {success: true, needCoordinateClick: true, cx: c.x, cy: c.y};
    } else {
      // AXPress + verify：采样前后状态签名，无变化则请求坐标点击
      var sigBefore = stateSignature(elem);
      var axpressThrew = false;
      try {
        elem.actions.AXPress.perform();
      } catch(e) {
        axpressThrew = true;
      }
      if (axpressThrew) {
        var c1 = boundsCenter(elem);
        _result = {success: true, needCoordinateClick: true, cx: c1.x, cy: c1.y};
      } else {
        spinMs(80);
        var sigAfter = stateSignature(elem);
        if (sigBefore !== '' && sigAfter !== sigBefore) {
          _result = {success: true, method: "axpress", verified: true};
        } else if (sigBefore === '' && sigAfter === '') {
          _result = {success: true, method: "axpress", verified: false};
        } else {
          var c2 = boundsCenter(elem);
          _result = {success: true, needCoordinateClick: true, cx: c2.x, cy: c2.y};
        }
      }
    }
    JSON.stringify(_result);
  `;

  let result: { success: boolean; error?: string; method?: string; verified?: boolean; needCoordinateClick?: boolean; cx?: number; cy?: number };
  try {
    const out = execFileSync("osascript", [
      "-l", "JavaScript",
      "-e", jxaScript,
    ], { encoding: "utf-8", timeout: 15000 }).trim();
    result = JSON.parse(out);
  } catch (error) {
    rethrowElementActionError(error, "click_element", elementId);
    return { method: "axpress", verified: false }; // unreachable — rethrow throws
  }
  if (!result.success) {
    // Route through rethrowElementActionError so "element not found" / accessibility
    // errors are converted to the proper UcuError subclasses (ElementNotFoundError etc.).
    rethrowElementActionError(new Error(result.error || "click_element failed"), "click_element", elementId);
  }
  // JXA requested a coordinate click → perform it via the input layer (per-process
  // when a pid is available, so the global cursor does not move).
  if (result.needCoordinateClick && typeof result.cx === "number" && typeof result.cy === "number") {
    await this.click(Math.round(result.cx), Math.round(result.cy), "left", false);
    return { method: "coordinate", verified: false };
  }
  return {
    method: (result.method as "axpress" | "coordinate") ?? "axpress",
    verified: Boolean(result.verified),
  };
}

export async function typeInElement(this: MacOSPlatform, elementId: string, text: string, app?: string, clearFirst?: boolean): Promise<void> {
  const textLiteral = JSON.stringify(text);
  const effectiveApp = app || this.activeTarget?.appName;
  const appLiteral = JSON.stringify(effectiveApp || "");
  const elementIdLiteral = JSON.stringify(elementId);
  const cachedDescriptor = prepareCache.call(this, elementId);
  const cachedJson = JSON.stringify(cachedDescriptor);

  const jxaScript = `
    var se = Application('System Events');
    var _result = null;
    ${jxaElementActionHelpers()}
    var elemPath = ${elementIdLiteral};
    var appName = ${appLiteral};
    // 容忍大小写/空格/连字符/下划线变体（cc-switch vs CC Switch vs cc_switch）
    var _norm = function(s) { return String(s||'').toLowerCase().split(' ').join('').split('-').join('').split('_').join(''); };
    var appNorm = _norm(appName);
    var textToType = ${textLiteral};
    var shouldClear = ${clearFirst ? "true" : "false"};
    var cached = ${cachedJson};

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
  const effectiveApp = app || this.activeTarget?.appName;
  const valueLiteral = JSON.stringify(value);
  const appLiteral = JSON.stringify(effectiveApp || "");
  const elementIdLiteral = JSON.stringify(elementId);
  const cachedDescriptor = prepareCache.call(this, elementId);
  const cachedJson = JSON.stringify(cachedDescriptor);

  const jxaScript = `
    var se = Application('System Events');
    var _result = null;
    ${jxaElementActionHelpers()}
    var elemPath = ${elementIdLiteral};
    var appName = ${appLiteral};
    // 容忍大小写/空格/连字符/下划线变体（cc-switch vs CC Switch vs cc_switch）
    var _norm = function(s) { return String(s||'').toLowerCase().split(' ').join('').split('-').join('').split('_').join(''); };
    var appNorm = _norm(appName);
    var valueToSet = ${valueLiteral};
    var cached = ${cachedJson};

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

// ── Menu bar extras (status item / tray) — 方向4a ──────────────────────
// 托盘应用（LSUIElement，如 cc-switch）的 status item 不在任何应用窗口 AX 树里，
// focus_app 找不到窗口。这两个函数直接遍历 processes[app].menuBars() 的
// menuBarItems，定位并点击托盘图标（AXPress，静默失败则坐标点击中心）。

export interface MenuBarExtraItem {
  menuBar: number;
  index: number;
  name: string;
  description: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Which process hosts this status item. "self" = app's own menu bar; "systemuiserver" = third-party tray hosted by SystemUIServer. */
  host: "self" | "systemuiserver";
  /** The hosting process pid — app's own pid for host:"self", SystemUIServer's pid for host:"systemuiserver". Enables per-process event posting. */
  pid: number;
}

export interface MenuBarExtraSelector {
  description?: string;
  name?: string;
  index?: number;
}

export async function findMenuBarExtra(this: MacOSPlatform, app: string): Promise<MenuBarExtraItem[]> {
  const appLiteral = JSON.stringify(app);
  // 两阶段 JXA：先遍历 app 自身 menuBarItems（host:"self"），若为空或只有 Apple 菜单，
  // 再遍历 SystemUIServer.menuBarItems 找第三方托盘 status item（host:"systemuiserver"）。
  // 纯 LSUIElement 托盘应用的 status item 由 SystemUIServer 进程托管，不在 app 自身进程里。
  const jxaScript = `
    var se = Application('System Events');
    var _result = null;
    var appName = ${appLiteral};
    // 容忍大小写/空格/连字符/下划线变体（cc-switch vs CC Switch vs cc_switch）
    var _norm = function(s) { return String(s||'').toLowerCase().split(' ').join('').split('-').join('').split('_').join(''); };
    var appNorm = _norm(appName);

    // 双向 includes 容忍 "CC Switch" vs "cc-switch" 之类长度差异
    var _matchApp = function(itemNorm) {
      if (!itemNorm) return false;
      return itemNorm === appNorm || itemNorm.indexOf(appNorm) !== -1 || appNorm.indexOf(itemNorm) !== -1;
    };

    var _readItem = function(item, mb, i, host, hostPid) {
      var desc = '', nm = '';
      try { desc = item.description(); } catch(e) {}
      try { nm = item.name(); } catch(e) {}
      var pos = [0,0], sz = [0,0];
      try { pos = item.position(); } catch(e) {}
      try { sz = item.size(); } catch(e) {}
      if (sz[0] === 0 && sz[1] === 0) return null;
      return {menuBar: mb, index: i, name: nm, description: desc, x: pos[0], y: pos[1], width: sz[0], height: sz[1], host: host, pid: hostPid || 0};
    };

    try {
      var procs = se.processes;
      var p = null;
      for (var k = 0; k < procs.length; k++) {
        var pn = '';
        try { pn = procs[k].name(); } catch(e) {}
        if (_norm(pn) === appNorm) { p = procs[k]; break; }
      }

      var items = [];

      // 阶段 1：app 自身 menuBarItems（host:"self"，用 app 自身 pid）
      var appPid = 0;
      if (p) { try { appPid = p.unixId(); } catch(e) {} }
      if (p) {
        try {
          var menuBars = p.menuBars();
          for (var mb = 0; mb < menuBars.length; mb++) {
            var mbItems;
            try { mbItems = menuBars[mb].menuBarItems(); } catch(e) { continue; }
            for (var i = 0; i < mbItems.length; i++) {
              var rec = _readItem(mbItems[i], mb, i, "self", appPid);
              if (rec) items.push(rec);
            }
          }
        } catch(e) {}
      }

      // 是否需要阶段 2：app 自身无 item，或仅含 Apple 菜单（index 0 的 app-name 项）
      var hasNonApple = false;
      for (var j = 0; j < items.length; j++) {
        if (_norm(items[j].name) !== "apple") { hasNonApple = true; break; }
      }

      // 阶段 2：SystemUIServer 托管的第三方托盘 status item（host:"systemuiserver"）
      // 仅当 app 自身没有可点击的非 Apple 项时才查 SystemUIServer，避免对有窗口的应用产生噪音。
      if (!hasNonApple) {
        try {
          var suiProcs = se.processes.byName("SystemUIServer");
          var suiPid = 0;
          if (suiProcs) { try { suiPid = suiProcs.unixId(); } catch(e) {} }
          if (suiProcs) {
            var suiBars = suiProcs.menuBars();
            for (var smb = 0; smb < suiBars.length; smb++) {
              var suiItems;
              try { suiItems = suiBars[smb].menuBarItems(); } catch(e) { continue; }
              for (var si = 0; si < suiItems.length; si++) {
                var sItem = suiItems[si];
                var sDesc = '', sNm = '';
                try { sDesc = sItem.description(); } catch(e) {}
                try { sNm = sItem.name(); } catch(e) {}
                // 按 description/name 匹配目标 app（status item 的 description 通常是 app 名）
                if (_matchApp(_norm(sDesc)) || _matchApp(_norm(sNm))) {
                  var sRec = _readItem(sItem, smb, si, "systemuiserver", suiPid);
                  if (sRec) {
                    // 保留匹配信号，供 click 二次定位
                    sRec.name = sNm; sRec.description = sDesc;
                    items.push(sRec);
                  }
                }
              }
            }
          }
        } catch(e) {
          // SystemUIServer 不可达（罕见），忽略，继续返回阶段 1 结果
        }
      }

      if (!p && items.length === 0) {
        _result = {error: "process not found: " + appName, items: []};
      } else {
        _result = {items: items};
      }
    } catch(e) {
      _result = {error: "menu bar AX read failed: " + String(e.message || e), items: []};
    }
    JSON.stringify(_result);
  `;
  let out: string;
  try {
    out = execFileSync("osascript", ["-l", "JavaScript", "-e", jxaScript], { encoding: "utf-8", timeout: 15000 }).trim();
  } catch (error) {
    rethrowElementActionError(error, "find_menu_bar_extra", app);
    return []; // unreachable — rethrow throws
  }
  const parsed = JSON.parse(out);
  if (parsed.error) {
    throw new Error(parsed.error);
  }
  return parsed.items as MenuBarExtraItem[];
}

export function matchMenuBarExtra(items: MenuBarExtraItem[], selector: MenuBarExtraSelector): MenuBarExtraItem | undefined {
  if (items.length === 0) return undefined;
  let filtered = items;
  if (selector.description) {
    const d = selector.description.toLowerCase();
    filtered = filtered.filter((it) => (it.description || "").toLowerCase().includes(d) || (it.name || "").toLowerCase().includes(d));
  } else if (selector.name) {
    const n = selector.name.toLowerCase();
    filtered = filtered.filter((it) => (it.name || "").toLowerCase().includes(n) || (it.description || "").toLowerCase().includes(n));
  } else if (selector.index === undefined) {
    // 无 selector 时排除 Apple 菜单（macOS 每个 app 的 index 0 app-name 项），
    // 否则 click_menu_bar_extra(app) 不带 selector 会误点 Apple 菜单。
    // 注意：SystemUIServer 托管的第三方托盘 item 不应被此过滤误删——它们的 name 通常非 "apple"。
    filtered = filtered.filter((it) => (it.name || "").toLowerCase() !== "apple");
  }
  if (selector.index !== undefined) {
    return filtered[selector.index];
  }
  return filtered[0];
}

export async function clickMenuBarExtra(this: MacOSPlatform, app: string, selector: MenuBarExtraSelector = {}): Promise<ClickResult> {
  const items = await this.findMenuBarExtra(app);
  const target = matchMenuBarExtra(items, selector);
  if (!target) {
    throw new ElementNotFoundError(`menu bar extra not found in ${app} (selector: ${JSON.stringify(selector)}; ${items.length} items scanned)`);
  }
  const appLiteral = JSON.stringify(app);
  const mb = target.menuBar;
  const idx = target.index;
  const host = target.host;
  const tgtNameLiteral = JSON.stringify(target.name || "");
  const tgtDescLiteral = JSON.stringify(target.description || "");
  const preferCoord = preferCoordinateClick(app);
  // AXPress + verify-then-fallback（与 clickElement 同模式，应对 Tauri 等静默吞）。
  // host==="systemuiserver" 时在 SystemUIServer 进程上重定位（托盘 status item 由它托管），
  // SystemUIServer.menuBarItems 顺序不稳定，用保存的 name/description 二次匹配定位具体 item。
  // host==="self" 时按 app 进程的 menuBars()[mb].menuBarItems()[idx] 重定位（稳定）。
  const resolveItemBlock = host === "systemuiserver"
    ? `// SystemUIServer 托管的第三方托盘：按 name/description 二次匹配（顺序不稳定）
      var suiProc = null;
      try { suiProc = se.processes.byName("SystemUIServer"); } catch(e) {}
      var item = null;
      if (suiProc) {
        var suiBars = suiProc.menuBars();
        outer: for (var b = 0; b < suiBars.length; b++) {
          var suiItems;
          try { suiItems = suiBars[b].menuBarItems(); } catch(e) { continue; }
          for (var ii = 0; ii < suiItems.length; ii++) {
            var it = suiItems[ii];
            var iDesc = '', iNm = '';
            try { iDesc = it.description(); } catch(e) {}
            try { iNm = it.name(); } catch(e) {}
            if (_matchApp(_norm(iDesc)) || _matchApp(_norm(iNm))
                || _norm(iDesc) === tgtDescNorm || _norm(iNm) === tgtNameNorm) {
              item = it; break outer;
            }
          }
        }
      }
      if (!item) { _result = {success: false, error: "SystemUIServer status item not found for " + appName}; }`
    : `// app 自身 menu bar：按 menuBar/index 重定位（稳定）
      if (!p) {
        _result = {success: false, error: "process not found: " + appName};
      } else {
        var item = p.menuBars()[${mb}].menuBarItems()[${idx}];
      }`;
  const jxaScript = `
    var se = Application('System Events');
    var _result = null;
    var appName = ${appLiteral};
    var tgtName = ${tgtNameLiteral};
    var tgtDesc = ${tgtDescLiteral};
    ${JXA_STATE_SIGNATURE}
    ${JXA_BOUNDS_CENTER}
    // 容忍大小写/空格/连字符/下划线变体（cc-switch vs CC Switch vs cc_switch）
    var _norm = function(s) { return String(s||'').toLowerCase().split(' ').join('').split('-').join('').split('_').join(''); };
    var appNorm = _norm(appName);
    var tgtNameNorm = _norm(tgtName);
    var tgtDescNorm = _norm(tgtDesc);
    var preferCoord = ${preferCoord ? "true" : "false"};
    var _matchApp = function(itemNorm) {
      if (!itemNorm) return false;
      return itemNorm === appNorm || itemNorm.indexOf(appNorm) !== -1 || appNorm.indexOf(itemNorm) !== -1;
    };
    try {
      var procs = se.processes;
      var p = null;
      for (var k = 0; k < procs.length; k++) {
        var pn = '';
        try { pn = procs[k].name(); } catch(e) {}
        if (_norm(pn) === appNorm) { p = procs[k]; break; }
      }
      ${resolveItemBlock}
      if (!_result && item) {
        if (preferCoord) {
          // 启发式命中：请求坐标点击（TS 层执行 per-process）
          var c0 = boundsCenter(item);
          _result = {success: true, needCoordinateClick: true, cx: c0.x, cy: c0.y};
        } else {
          // AXPress + verify
          var sigBefore = stateSignature(item);
          var axpressThrew = false;
          try {
            item.actions.AXPress.perform();
          } catch(e) {
            axpressThrew = true;
          }
          if (axpressThrew) {
            var c1 = boundsCenter(item);
            _result = {success: true, needCoordinateClick: true, cx: c1.x, cy: c1.y};
          } else {
            spinMs(80);
            var sigAfter = stateSignature(item);
            if (sigBefore !== '' && sigAfter !== sigBefore) {
              _result = {success: true, method: "axpress", verified: true};
            } else if (sigBefore === '' && sigAfter === '') {
              _result = {success: true, method: "axpress", verified: false};
            } else {
              var c2 = boundsCenter(item);
              _result = {success: true, needCoordinateClick: true, cx: c2.x, cy: c2.y};
            }
          }
        }
      }
    } catch(e) {
      _result = {success: false, error: String(e.message || e)};
    }
    JSON.stringify(_result);
  `;
  let out: string;
  try {
    out = execFileSync("osascript", ["-l", "JavaScript", "-e", jxaScript], { encoding: "utf-8", timeout: 15000 }).trim();
  } catch (error) {
    rethrowElementActionError(error, "click_menu_bar_extra", app);
    return { method: "axpress", verified: false }; // unreachable — rethrow throws
  }
  const result = JSON.parse(out);
  if (!result.success) {
    throw new Error(`click_menu_bar_extra failed in ${app}: ${result.error}`);
  }
  if (result.needCoordinateClick && typeof result.cx === "number" && typeof result.cy === "number") {
    await this.click(Math.round(result.cx), Math.round(result.cy), "left", false);
    return { method: "coordinate", verified: false };
  }
  return {
    method: (result.method as "axpress" | "coordinate") ?? "axpress",
    verified: Boolean(result.verified),
  };
}
