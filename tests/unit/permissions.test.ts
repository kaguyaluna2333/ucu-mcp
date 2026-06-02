import { describe, it, expect, vi } from "vitest";
import {
  checkPermissions,
  checkPermission,
} from "../../src/safety/permissions.js";

// Mock platform for testing
vi.mock("node:os", () => ({
  platform: () => "darwin",
}));

// Mock child_process for macOS - return successful results
vi.mock("node:child_process", () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
    const cmd = args[0] as string;

    if (cmd === "/usr/bin/osascript") {
      callback(null, "true", "");
    } else if (cmd === "/usr/sbin/screencapture") {
      callback(null, "", "");
    } else {
      callback(null, "", "");
    }
    return {};
  }),
}));

describe("permissions", () => {
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
});
