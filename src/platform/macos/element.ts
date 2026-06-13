import { execFileSync } from "node:child_process";
import type { MacOSPlatform } from "./base.js";
import { ElementNotFoundError } from "../../util/errors.js";
import { rethrowElementActionError } from "./helpers.js";
import { jxaElementActionHelpers } from "../jxa-helpers.js";

function prepareCache(this: MacOSPlatform, elementId: string) {
  this.evictExpiredCacheEntries();
  const cached = this.elementCache.get(elementId);
  if (cached && this.isCacheEntryExpired(cached)) {
    this.elementCache.delete(elementId);
  }
  return this.elementCache.get(elementId) ?? null;
}

export async function clickElement(this: MacOSPlatform, elementId: string, app?: string): Promise<void> {
  const elementIdLiteral = JSON.stringify(elementId);
  const effectiveApp = app || this.activeTarget?.appName;
  const appLiteral = JSON.stringify(effectiveApp || "");
  const cachedDescriptor = prepareCache.call(this, elementId);
  const cachedJson = JSON.stringify(cachedDescriptor);

  const jxaScript = `
    var se = Application('System Events');
    var _result = null;
    ${jxaElementActionHelpers()}
    var elemPath = ${elementIdLiteral};
    var appName = ${appLiteral};
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
