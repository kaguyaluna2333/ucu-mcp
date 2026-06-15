/**
 * Cross-platform input synthesis for UCU-MCP.
 *
 * macOS: Uses CGEvent API exclusively for BACKGROUND input injection.
 * This does NOT activate windows or steal focus — the AI agent can
 * control the desktop while the user continues working in another
 * terminal/window without interruption.
 *
 * Windows: Uses SendInput (stub).
 * Linux: Uses xdotool (stub).
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../util/logger.js";

const execFileAsync = promisify(execFile);

// ── Native CGEvent helper (macOS) ──────────────────────────────────────
// JXA (osascript -l JavaScript) cannot call CGEventPost without segfault.
// We ship a small Swift binary that does native CGEvent injection instead.

const __dirname = dirname(fileURLToPath(import.meta.url));
// In dev: src/utils/input.ts → native/cgevent/cgevent-helper
// In prod: dist/src/utils/input.js → dist/native/cgevent/cgevent-helper
const nativeHelperPath = join(__dirname, "..", "..", "..", "native", "cgevent", "cgevent-helper");
// Fallback: try from project root (dev mode)
const nativeHelperPathAlt = join(__dirname, "..", "..", "native", "cgevent", "cgevent-helper");
import { existsSync } from "node:fs";
const resolvedNativePath = existsSync(nativeHelperPath) ? nativeHelperPath : nativeHelperPathAlt;

let _nativeAvailable: boolean | undefined;
function isNativeAvailable(): boolean {
  if (_nativeAvailable !== undefined) return _nativeAvailable;
  try {
    const stdout = execFileSync(resolvedNativePath, [], {
      input: '{"command":"ping"}',
      encoding: "utf8",
      timeout: 3000,
    });
    _nativeAvailable = stdout.includes('"ok"');
  } catch {
    _nativeAvailable = false;
  }
  return _nativeAvailable;
}

function runNativeChecked(payload: Record<string, unknown>): void {
  const raw = execFileSync(resolvedNativePath, [], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10000,
  }).trim();
  const resp = JSON.parse(raw);
  if (resp.error) {
    throw new Error(`native helper error: ${resp.error}`);
  }
}

// ── Dry-run mode ──────────────────────────────────────────────────────────

const isDryRun = (): boolean => process.env.UCU_DRY_RUN === "true";

function logDryRun(action: string, details: Record<string, unknown>): void {
  logger.info(`[DRY RUN] Would ${action}`, details);
}

// ── macOS key code map ────────────────────────────────────────────────────

const MAC_KEY_CODES: Record<string, number> = {
  enter: 36, return: 36,
  tab: 48,
  escape: 53, esc: 53,
  backspace: 51, delete: 51,
  forwarddelete: 117, fn_delete: 117,
  space: 49,
  up: 126, down: 125, left: 123, right: 124,
  home: 115, end: 119,
  pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  capslock: 57,
};

const MAC_MODIFIER_FLAGS: Record<string, number> = {
  cmd: 0x00100000, command: 0x00100000,
  shift: 0x00020000,
  option: 0x00080000, alt: 0x00080000,
  control: 0x00040000, ctrl: 0x00040000,
};

// 字母/数字 keyCode —— typeText 与 pressKey 共享的唯一数据源。
// pressKey 在 MAC_KEY_CODES（特殊键）未命中时回退查这两个 map，让 Cmd+M / Cmd+W 等
// 含字母的快捷键可用。注意 'a' 的 keyCode 是 0，查找时必须用 `in` 判定存在性，
// 不能用 truthy（否则 0 会被当成未命中而穿透到 digit map）。
const MAC_LETTER_KEY_CODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9,
  b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  o: 31, u: 32, i: 33, p: 34, l: 37, j: 38, k: 40,
  n: 45, m: 46,
};
const MAC_DIGIT_KEY_CODES: Record<string, number> = {
  "1": 18, "2": 19, "3": 20, "4": 21, "5": 23,
  "6": 22, "7": 26, "8": 28, "9": 25, "0": 29,
};

// ── AppleScript string escaping ───────────────────────────────────────────

function escapeAppleScriptString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

// ── JXA runner helper ─────────────────────────────────────────────────────

async function runJXA(script: string, timeout = 5000): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/osascript", [
    "-l", "JavaScript", "-e", script,
  ], { timeout });
  return stdout.trim();
}

// ── Mouse operations (CGEvent — background, no focus steal) ───────────────

export async function click(
  x: number, y: number,
  button: "left" | "right" | "middle" = "left",
  _platform: string = process.platform
): Promise<void> {
  if (isDryRun()) {
    logDryRun("click", { x, y, button });
    return;
  }
  if (_platform === "darwin") {
    if (isNativeAvailable()) {
      runNativeChecked({ command: "click", x, y, button });
      return;
    }
    const btnType = { left: 0, right: 1, middle: 2 }[button];
    await runJXA(`
      ObjC.import('CoreGraphics');
      var loc = $.CGPointMake(${x}, ${y});
      var down = $.CGEventCreateMouseEvent(null, ${1 + btnType * 2}, loc, ${btnType});
      var up = $.CGEventCreateMouseEvent(null, ${2 + btnType * 2}, loc, ${btnType});
      $.CGEventPost(0, down);
      $.CGEventPost(0, up);
      $.CFRelease(down);
      $.CFRelease(up);
    `);
    return;
  }
  if (_platform === "linux") {
    const btnFlag = { left: "1", right: "3", middle: "2" }[button];
    await execFileAsync("xdotool", ["mousemove", String(x), String(y)]);
    await execFileAsync("xdotool", ["click", btnFlag]);
    return;
  }
  // Windows
  throw new Error("click not implemented for Windows");
}

export async function doubleClick(
  x: number, y: number,
  button: "left" | "right" | "middle" = "left",
  _platform: string = process.platform
): Promise<void> {
  if (isDryRun()) {
    logDryRun("doubleClick", { x, y, button });
    return;
  }
  if (_platform === "darwin") {
    if (isNativeAvailable()) {
      runNativeChecked({ command: "doubleClick", x, y, button });
      return;
    }

    const btnType = { left: 0, right: 1, middle: 2 }[button];
    await runJXA(`
      ObjC.import('CoreGraphics');
      var loc = $.CGPointMake(${x}, ${y});
      var down1 = $.CGEventCreateMouseEvent(null, ${1 + btnType * 2}, loc, ${btnType});
      $.CGEventSetIntegerValueField(down1, 1, 1);
      var up1 = $.CGEventCreateMouseEvent(null, ${2 + btnType * 2}, loc, ${btnType});
      $.CGEventSetIntegerValueField(up1, 1, 1);
      var down2 = $.CGEventCreateMouseEvent(null, ${1 + btnType * 2}, loc, ${btnType});
      $.CGEventSetIntegerValueField(down2, 1, 2);
      var up2 = $.CGEventCreateMouseEvent(null, ${2 + btnType * 2}, loc, ${btnType});
      $.CGEventSetIntegerValueField(up2, 1, 2);
      $.CGEventPost(0, down1);
      $.CGEventPost(0, up1);
      $.CGEventPost(0, down2);
      $.CGEventPost(0, up2);
      $.CFRelease(down1);
      $.CFRelease(up1);
      $.CFRelease(down2);
      $.CFRelease(up2);
    `);
    return;
  }
  // Fallback: two clicks
  await click(x, y, button, _platform);
  await new Promise(r => setTimeout(r, 50));
  await click(x, y, button, _platform);
}

export async function move(
  x: number, y: number,
  _platform: string = process.platform
): Promise<void> {
  if (isDryRun()) {
    logDryRun("move", { x, y });
    return;
  }
  if (_platform === "darwin") {
    if (isNativeAvailable()) {
      runNativeChecked({ command: "move", x, y });
      return;
    }
    await runJXA(`
      ObjC.import('CoreGraphics');
      var loc = $.CGPointMake(${x}, ${y});
      var ev = $.CGEventCreateMouseEvent(null, 5, loc, 0);
      $.CGEventPost(0, ev);
      $.CFRelease(ev);
    `);
    return;
  }
  if (_platform === "linux") {
    await execFileAsync("xdotool", ["mousemove", String(x), String(y)]);
    return;
  }
  throw new Error("move not implemented for Windows");
}

export async function drag(
  fromX: number, fromY: number,
  toX: number, toY: number,
  button: "left" | "right" | "middle" = "left",
  duration: number = 300,
  _platform: string = process.platform
): Promise<void> {
  if (isDryRun()) {
    logDryRun("drag", { fromX, fromY, toX, toY, button, duration });
    return;
  }
  if (_platform === "darwin") {
    if (isNativeAvailable()) {
      runNativeChecked({ command: "drag", fromX, fromY, toX, toY, button, durationMs: duration });
      return;
    }

    const btnType = { left: 0, right: 1, middle: 2 }[button];
    const steps = Math.max(2, Math.min(60, Math.ceil(duration / 16)));
    const delayMicros = Math.max(0, Math.floor((duration * 1000) / steps));
    await runJXA(`
      ObjC.import('CoreGraphics');
      ObjC.import('stdlib');
      var from = $.CGPointMake(${fromX}, ${fromY});
      var to = $.CGPointMake(${toX}, ${toY});
      var down = $.CGEventCreateMouseEvent(null, ${1 + btnType * 2}, from, ${btnType});
      $.CGEventPost(0, down);
      $.CFRelease(down);
      for (var i = 1; i <= ${steps}; i++) {
        var t = i / ${steps};
        var x = ${fromX} + (${toX} - ${fromX}) * t;
        var y = ${fromY} + (${toY} - ${fromY}) * t;
        var pt = $.CGPointMake(x, y);
        var moveEv = $.CGEventCreateMouseEvent(null, 6, pt, ${btnType});
        $.CGEventPost(0, moveEv);
        $.CFRelease(moveEv);
        if (${delayMicros} > 0 && i < ${steps}) $.usleep(${delayMicros});
      }
      var up = $.CGEventCreateMouseEvent(null, ${2 + btnType * 2}, to, ${btnType});
      $.CGEventPost(0, up);
      $.CFRelease(up);
    `);
    return;
  }
  if (_platform === "linux") {
    await execFileAsync("xdotool", [
      "mousemove", String(fromX), String(fromY),
      "mousedown", String({ left: 1, right: 3, middle: 2 }[button]),
    ]);
    await execFileAsync("xdotool", ["mousemove", String(toX), String(toY)]);
    await execFileAsync("xdotool", [
      "mouseup", String({ left: 1, right: 3, middle: 2 }[button]),
    ]);
    return;
  }
  throw new Error("drag not implemented for Windows");
}

export async function scroll(
  x: number, y: number,
  deltaX: number,
  deltaY: number,
  _platform: string = process.platform
): Promise<void> {
  if (isDryRun()) {
    logDryRun("scroll", { x, y, deltaX, deltaY });
    return;
  }
  if (_platform === "darwin") {
    if (isNativeAvailable()) {
      runNativeChecked({ command: "scroll", x, y, deltaX, deltaY });
      return;
    }
    const verticalDelta = -deltaY;
    const horizontalDelta = deltaX;
    await runJXA(`
      ObjC.import('CoreGraphics');
      var loc = $.CGPointMake(${x}, ${y});
      var ev = $.CGEventCreateScrollWheelEvent(null, 1, 2, ${verticalDelta}, ${horizontalDelta});
      $.CGEventPost(0, ev);
      $.CFRelease(ev);
    `);
    return;
  }
  if (_platform === "linux") {
    const verticalButton = deltaY < 0 ? "4" : "5";
    for (let i = 0; i < Math.abs(deltaY); i++) {
      await execFileAsync("xdotool", ["click", verticalButton]);
    }
    const horizontalButton = deltaX < 0 ? "6" : "7";
    for (let i = 0; i < Math.abs(deltaX); i++) {
      await execFileAsync("xdotool", ["click", horizontalButton]);
    }
    return;
  }
  throw new Error("scroll not implemented for Windows");
}

// ── Keyboard operations (CGEvent — background) ────────────────────────────

export async function typeText(
  text: string,
  delay: number = 20,
  _platform: string = process.platform
): Promise<void> {
  if (isDryRun()) {
    logDryRun("typeText", { text: text.slice(0, 50), delay });
    return;
  }
  if (!text) return;

  if (_platform === "darwin") {
    // Character -> { keyCode, shift? } map for CGEvent injection
    const CHAR_TO_KEY: Record<string, { code: number; shift?: boolean }> = {};
    for (const [ch, code] of Object.entries(MAC_LETTER_KEY_CODES)) {
      CHAR_TO_KEY[ch] = { code };
      CHAR_TO_KEY[ch.toUpperCase()] = { code, shift: true };
    }
    for (const [ch, code] of Object.entries(MAC_DIGIT_KEY_CODES)) {
      CHAR_TO_KEY[ch] = { code };
    }
    // Unshifted symbols
    CHAR_TO_KEY["="] = { code: 24 };
    CHAR_TO_KEY["-"] = { code: 27 };
    CHAR_TO_KEY["["] = { code: 33 };
    CHAR_TO_KEY["]"] = { code: 30 };
    CHAR_TO_KEY["\\"] = { code: 42 };
    CHAR_TO_KEY[";"] = { code: 41 };
    CHAR_TO_KEY["'"] = { code: 39 };
    CHAR_TO_KEY[","] = { code: 43 };
    CHAR_TO_KEY["/"] = { code: 44 };
    CHAR_TO_KEY["."] = { code: 47 };
    CHAR_TO_KEY["`"] = { code: 50 };
    CHAR_TO_KEY[" "] = { code: 49 };
    // Shifted symbols
    CHAR_TO_KEY["!"] = { code: 18, shift: true };
    CHAR_TO_KEY["@"] = { code: 19, shift: true };
    CHAR_TO_KEY["#"] = { code: 20, shift: true };
    CHAR_TO_KEY["$"] = { code: 21, shift: true };
    CHAR_TO_KEY["%"] = { code: 23, shift: true };
    CHAR_TO_KEY["^"] = { code: 22, shift: true };
    CHAR_TO_KEY["&"] = { code: 26, shift: true };
    CHAR_TO_KEY["*"] = { code: 28, shift: true };
    CHAR_TO_KEY["("] = { code: 25, shift: true };
    CHAR_TO_KEY[")"] = { code: 29, shift: true };
    CHAR_TO_KEY["_"] = { code: 27, shift: true };
    CHAR_TO_KEY["+"] = { code: 24, shift: true };
    CHAR_TO_KEY["{"] = { code: 33, shift: true };
    CHAR_TO_KEY["}"] = { code: 30, shift: true };
    CHAR_TO_KEY["|"] = { code: 42, shift: true };
    CHAR_TO_KEY[":"] = { code: 41, shift: true };
    CHAR_TO_KEY['"'] = { code: 39, shift: true };
    CHAR_TO_KEY["<"] = { code: 43, shift: true };
    CHAR_TO_KEY[">"] = { code: 47, shift: true };
    CHAR_TO_KEY["?"] = { code: 44, shift: true };
    CHAR_TO_KEY["~"] = { code: 50, shift: true };

    const SHIFT_FLAG = 0x00020000;

    // Partition text into CGEvent-typable runs and fallback runs
    const batches: Array<{ cgEvent: boolean; chars: Array<{ code: number; shift: boolean }> | string }> = [];
    let currentFallback = "";
    let currentCG: Array<{ code: number; shift: boolean }> = [];

    const flushCG = () => {
      if (currentCG.length > 0) {
        batches.push({ cgEvent: true, chars: currentCG });
        currentCG = [];
      }
    };
    const flushFallback = () => {
      if (currentFallback.length > 0) {
        batches.push({ cgEvent: false, chars: currentFallback });
        currentFallback = "";
      }
    };

    for (const ch of text) {
      const entry = CHAR_TO_KEY[ch];
      if (entry) {
        flushFallback();
        currentCG.push({ code: entry.code, shift: !!entry.shift });
      } else {
        flushCG();
        currentFallback += ch;
      }
    }
    flushCG();
    flushFallback();

    // Process each batch
    for (const batch of batches) {
      if (batch.cgEvent && Array.isArray(batch.chars)) {
        if (isNativeAvailable()) {
          runNativeChecked({ command: "typeBatch", keys: batch.chars });
        } else {
          // Build a single JXA script that types all chars in this CGEvent batch
          const keyStatements = (batch.chars as Array<{ code: number; shift: boolean }>).map(({ code, shift }) => {
            const flags = shift ? SHIFT_FLAG : 0;
            return `
              kd = $.CGEventCreateKeyboardEvent(null, ${code}, true);
              ku = $.CGEventCreateKeyboardEvent(null, ${code}, false);
              if (${flags}) { $.CGEventSetFlags(kd, ${flags}); $.CGEventSetFlags(ku, ${flags}); }
              $.CGEventPost(0, kd);
              $.CGEventPost(0, ku);
              $.CFRelease(kd);
              $.CFRelease(ku);`;
          }).join("\n");
          await runJXA(`
            ObjC.import('CoreGraphics');
            var kd, ku;
            ${keyStatements}
          `);
        }
      } else {
        // Fallback: use osascript keystroke for unsupported chars (emoji, CJK, etc.)
        const escaped = escapeAppleScriptString(batch.chars as string);
        await execFileAsync("/usr/bin/osascript", [
          "-e", `tell application "System Events" to keystroke "${escaped}"`,
        ], { timeout: 5000 });
      }
    }
    return;
  }

  if (_platform === "linux") {
    await execFileAsync("xdotool", [
      "type", "--delay", String(delay), "--", text,
    ]);
    return;
  }

  throw new Error("typeText not implemented for Windows");
}

export async function pressKey(
  key: string,
  modifiers: string[] = [],
  _platform: string = process.platform
): Promise<void> {
  if (isDryRun()) {
    logDryRun("pressKey", { key, modifiers });
    return;
  }
  if (_platform === "darwin") {
    const lookup = key.toLowerCase();
    // 先查特殊键，未命中再回退查字母/数字（让 Cmd+M / Cmd+W 等含字母的快捷键可用）。
    // 用 `in` 判定存在性——'a' 的 keyCode 是 0，truthy 判断会误穿透到 digit map。
    const keyCode =
      lookup in MAC_KEY_CODES ? MAC_KEY_CODES[lookup] :
      (key.length === 1 && lookup in MAC_LETTER_KEY_CODES) ? MAC_LETTER_KEY_CODES[lookup] :
      (key.length === 1 && key in MAC_DIGIT_KEY_CODES) ? MAC_DIGIT_KEY_CODES[key] :
      undefined;
    if (keyCode === undefined) {
      throw new Error(`Unknown key: ${key}. Supported keys: special keys (${Object.keys(MAC_KEY_CODES).join(", ")}), single letters a-z, single digits 0-9`);
    }

    // Build modifier flags
    let flags = 0;
    for (const mod of modifiers) {
      const flag = MAC_MODIFIER_FLAGS[mod.toLowerCase()];
      if (flag === undefined) {
        throw new Error(`Unknown modifier: ${mod}. Supported: ${Object.keys(MAC_MODIFIER_FLAGS).join(", ")}`);
      }
      flags |= flag;
    }

    if (isNativeAvailable()) {
      runNativeChecked({ command: "pressKey", keyCode, flags });
      return;
    }

    await runJXA(`
      ObjC.import('CoreGraphics');
      var flags = ${flags};
      var keyDown = $.CGEventCreateKeyboardEvent(null, ${keyCode}, true);
      $.CGEventSetFlags(keyDown, flags);
      $.CGEventPost(0, keyDown);
      var keyUp = $.CGEventCreateKeyboardEvent(null, ${keyCode}, false);
      $.CGEventSetFlags(keyUp, flags);
      $.CGEventPost(0, keyUp);
      $.CFRelease(keyDown);
      $.CFRelease(keyUp);
    `);
    return;
  }

  if (_platform === "linux") {
    const keyArg = modifiers.length > 0 ? modifiers.join("+") + "+" + key : key;
    await execFileAsync("xdotool", ["key", keyArg]);
    return;
  }

  throw new Error("pressKey not implemented for Windows");
}

export async function pressShortcut(
  keys: string[],
  _platform: string = process.platform
): Promise<void> {
  if (isDryRun()) {
    logDryRun("pressShortcut", { keys });
    return;
  }
  if (keys.length < 2) {
    throw new Error("pressShortcut requires at least 2 keys (modifier + key)");
  }
  const modifiers = keys.slice(0, -1);
  const key = keys[keys.length - 1];
  await pressKey(key, modifiers, _platform);
}

// ── Cursor position ───────────────────────────────────────────────────────

export async function getCursorPosition(
  _platform: string = process.platform
): Promise<{ x: number; y: number }> {
  if (_platform === "darwin") {
    const result = await runJXA(`
      ObjC.import('CoreGraphics');
      var ev = $.CGEventCreate(null);
      var loc = $.CGEventGetLocation(ev);
      $.CFRelease(ev);
      return JSON.stringify({x: loc.x, y: loc.y});
    `);
    return JSON.parse(result);
  }
  if (_platform === "linux") {
    const { stdout } = await execFileAsync("xdotool", ["getmouselocation"]);
    const match = stdout.match(/x:(\d+)\s+y:(\d+)/);
    if (!match) throw new Error("Failed to parse cursor position");
    return { x: parseInt(match[1]), y: parseInt(match[2]) };
  }
  throw new Error("getCursorPosition not implemented for Windows");
}
