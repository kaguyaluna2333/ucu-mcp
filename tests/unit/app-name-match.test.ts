import { describe, it, expect } from "vitest";
import {
  normalizeAppName,
  appNameMatches,
  selectWindowForApp,
} from "../../src/platform/macos/helpers.js";
import type { WindowInfo } from "../../src/platform/base.js";

function win(processName: string, id = `${processName}/win1`): WindowInfo {
  return {
    id,
    title: "",
    processName,
    pid: 1,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    isMinimized: false,
    isOnScreen: true,
  };
}

describe("normalizeAppName", () => {
  it("collapses case + trims", () => {
    expect(normalizeAppName("  CC Switch  ")).toBe("ccswitch");
    expect(normalizeAppName("CC SWITCH")).toBe("ccswitch");
  });

  it("treats space, hyphen, underscore, dot as equivalent separators", () => {
    expect(normalizeAppName("CC Switch")).toBe("ccswitch");
    expect(normalizeAppName("cc-switch")).toBe("ccswitch");
    expect(normalizeAppName("cc_switch")).toBe("ccswitch");
    expect(normalizeAppName("CC.Switch")).toBe("ccswitch");
    expect(normalizeAppName("CC  Switch")).toBe("ccswitch");
    expect(normalizeAppName("CC---Switch")).toBe("ccswitch");
  });

  it("preserves digits", () => {
    expect(normalizeAppName("Code 2")).toBe("code2");
    expect(normalizeAppName("VSCode-1.85")).toBe("vscode185");
  });
});

describe("appNameMatches", () => {
  it("matches equivalent forms", () => {
    expect(appNameMatches("CC Switch", "cc-switch")).toBe(true);
    expect(appNameMatches("CC Switch", "CC.Switch")).toBe(true);
    expect(appNameMatches("Visual Studio Code", "visual-studio-code")).toBe(true);
  });

  it("rejects truly different apps", () => {
    expect(appNameMatches("CC Switch", "Code")).toBe(false);
    expect(appNameMatches("Safari", "Chrome")).toBe(false);
  });

  it("handles empty strings safely", () => {
    expect(appNameMatches("", "cc-switch")).toBe(false);
    expect(appNameMatches("CC Switch", "")).toBe(false);
  });
});

describe("selectWindowForApp — regression for the cc-switch / CC Switch mismatch", () => {
  it("matches CC Switch process when user passes cc-switch", () => {
    const windows = [win("CC Switch", "CC Switch/win1")];
    const found = selectWindowForApp(windows, "cc-switch");
    expect(found?.id).toBe("CC Switch/win1");
  });

  it("matches CC Switch process when user passes CC.Switch or cc_switch", () => {
    const windows = [win("CC Switch", "CC Switch/win1")];
    expect(selectWindowForApp(windows, "CC.Switch")?.id).toBe("CC Switch/win1");
    expect(selectWindowForApp(windows, "cc_switch")?.id).toBe("CC Switch/win1");
  });

  it("returns undefined when no window matches", () => {
    const windows = [win("Code", "Code/win1"), win("Safari", "Safari/win1")];
    expect(selectWindowForApp(windows, "cc-switch")).toBeUndefined();
  });

  it("prefers exact match over fuzzy match when both could apply", () => {
    const windows = [win("Visual Studio Code - Insiders", "Code Insiders/win1"), win("Visual Studio Code", "Code/win1")];
    const found = selectWindowForApp(windows, "visual studio code");
    expect(found?.id).toBe("Code/win1");
  });
});
