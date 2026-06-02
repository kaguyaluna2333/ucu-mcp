import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => {
  const mock = vi.fn();
  const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");
  (mock as any)[promisifyCustom] = (...args: unknown[]) => {
    mock(...args);
    return Promise.resolve({ stdout: "", stderr: "" });
  };
  return mock;
});

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

function lastJxaScript(): string {
  const call = execFileMock.mock.calls.at(-1);
  expect(call?.[0]).toBe("/usr/bin/osascript");
  const args = call?.[1] as string[];
  return args.at(-1) ?? "";
}

describe("macOS input synthesis", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args.find((arg) => typeof arg === "function");
      if (typeof callback === "function") {
        callback(null, "", "");
      }
      return {};
    });
  });

  it("posts two click pairs for double-click", async () => {
    const { doubleClick } = await import("../../src/utils/input.js");

    await doubleClick(10, 20, "left", "darwin");

    const script = lastJxaScript();
    expect(script).toContain("down1");
    expect(script).toContain("up1");
    expect(script).toContain("down2");
    expect(script).toContain("up2");
    expect(script).toContain("$.CGEventSetIntegerValueField(down1, 1, 1)");
    expect(script).toContain("$.CGEventSetIntegerValueField(up1, 1, 1)");
    expect(script).toContain("$.CGEventSetIntegerValueField(down2, 1, 2)");
    expect(script).toContain("$.CGEventSetIntegerValueField(up2, 1, 2)");
  });

  it("uses duration to interpolate drag movement", async () => {
    const { drag } = await import("../../src/utils/input.js");

    await drag(0, 0, 100, 50, "left", 320, "darwin");

    const script = lastJxaScript();
    expect(script).toContain("for (var i = 1; i <= 20; i++)");
    expect(script).toContain("var t = i / 20");
    expect(script).toContain("$.usleep(16000)");
    expect(script).toContain("var up = $.CGEventCreateMouseEvent");
  });

  it("passes vertical and horizontal deltas to macOS scroll events", async () => {
    const { scroll } = await import("../../src/utils/input.js");

    await scroll(10, 20, 7, -3, "darwin");

    const script = lastJxaScript();
    expect(script).toContain("$.CGEventCreateScrollWheelEvent(null, 1, 2, 3, 7)");
  });
});
