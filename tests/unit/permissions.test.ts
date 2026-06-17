import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkPermissions,
  checkPermission,
  __resetPermissionCache,
} from "../../src/safety/permissions.js";

// Mock platform for testing
vi.mock("node:os", () => ({
  platform: () => "darwin",
}));

let accessDenied = false;

const execFileMock = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    const callback = (
      typeof args[args.length - 1] === "function"
        ? args[args.length - 1]
        : args[args.length - 2]
    ) as (err: Error | null, stdout: string | { stdout: string; stderr: string }, stderr?: string) => void;
    const cmd = args[0] as string;

    if (cmd === "/usr/bin/osascript") {
      (callback as any)(null, { stdout: accessDenied ? "0" : "5", stderr: "" }, undefined);
    } else if (cmd === "/usr/sbin/screencapture") {
      (callback as any)(null, { stdout: "", stderr: "" }, undefined);
    } else {
      (callback as any)(null, { stdout: "", stderr: "" }, undefined);
    }
    return {};
  })
);

// Mock child_process for macOS - return successful results
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("permissions", () => {
  beforeEach(() => {
    accessDenied = false;
    __resetPermissionCache();
    execFileMock.mockClear();
  });

  it("should return an object with granted and missing from checkPermissions", async () => {
    const result = await checkPermissions();
    expect(result).toHaveProperty("granted");
    expect(result).toHaveProperty("missing");
    expect(typeof result.granted).toBe("boolean");
    expect(Array.isArray(result.missing)).toBe(true);
  });

  it("should check individual permission and return object with granted", async () => {
    const result = await checkPermission("accessibility");
    expect(result).toHaveProperty("granted");
    expect(typeof result.granted).toBe("boolean");
    if (!result.granted) {
      expect(result.message).toBeDefined();
      expect(typeof result.message).toBe("string");
    }
  });

  it("should check screenRecording permission and return object with granted", async () => {
    const result = await checkPermission("screenRecording");
    expect(result).toHaveProperty("granted");
    expect(typeof result.granted).toBe("boolean");
  });

  it("caches granted accessibility permission and skips the second subprocess call", async () => {
    const first = await checkPermission("accessibility");
    expect(first.granted).toBe(true);
    const second = await checkPermission("accessibility");
    expect(second.granted).toBe(true);

    const osascriptCalls = execFileMock.mock.calls.filter((c) => c[0] === "/usr/bin/osascript");
    // One checkAccessibility call; requestAccessibilityWithPrompt should not run when granted.
    expect(osascriptCalls.length).toBe(1);
  });

  it("__resetPermissionCache forces a fresh permission check", async () => {
    await checkPermission("accessibility");
    __resetPermissionCache();
    await checkPermission("accessibility");

    const osascriptCalls = execFileMock.mock.calls.filter((c) => c[0] === "/usr/bin/osascript");
    expect(osascriptCalls.length).toBe(2);
  });
});
