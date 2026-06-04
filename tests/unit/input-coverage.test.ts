import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

const execFileMockSetup = () => {
  const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");
  (execFileMock as any)[promisifyCustom] = (...args: unknown[]) => {
    execFileMock(...args);
    return Promise.resolve({ stdout: "", stderr: "" });
  };
};
execFileMockSetup();

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

function lastJxaScript(): string {
  const call = execFileMock.mock.calls.at(-1);
  expect(call?.[0]).toBe("/usr/bin/osascript");
  const args = call?.[1] as string[];
  return args.at(-1) ?? "";
}

function allXdotoolArgs(): Array<{ cmd: string; args: string[] }> {
  return execFileMock.mock.calls
    .filter((c) => c[0] === "xdotool")
    .map((c) => ({ cmd: c[0] as string, args: c[1] as string[] }));
}

describe("input synthesis (extended coverage)", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMockSetup();
    delete process.env.UCU_DRY_RUN;
    execFileMock.mockReset();
    // Re-register the promisify.custom after resetModules/reset
    execFileMockSetup();
  });

  describe("click", () => {
    it("emits left-button mouseDown + mouseUp via CGEvent on darwin", async () => {
      const { click } = await import("../../src/utils/input.js");
      await click(100, 200, "left", "darwin");
      const script = lastJxaScript();
      expect(script).toContain("$.CGPointMake(100, 200)");
      // left button: down=1, up=2
      expect(script).toContain("$.CGEventCreateMouseEvent(null, 1");
      expect(script).toContain("$.CGEventCreateMouseEvent(null, 2");
      expect(script).toContain("$.CGEventPost(0, down)");
      expect(script).toContain("$.CGEventPost(0, up)");
    });

    it("emits right-button click on darwin (down=3, up=4)", async () => {
      const { click } = await import("../../src/utils/input.js");
      await click(0, 0, "right", "darwin");
      const script = lastJxaScript();
      expect(script).toContain("$.CGEventCreateMouseEvent(null, 3");
      expect(script).toContain("$.CGEventCreateMouseEvent(null, 4");
    });

    it("emits middle-button click on darwin (down=5, up=6)", async () => {
      const { click } = await import("../../src/utils/input.js");
      await click(0, 0, "middle", "darwin");
      const script = lastJxaScript();
      expect(script).toContain("$.CGEventCreateMouseEvent(null, 5");
      expect(script).toContain("$.CGEventCreateMouseEvent(null, 6");
    });

    it("uses xdotool mousemove + click on linux (left=1)", async () => {
      const { click } = await import("../../src/utils/input.js");
      await click(50, 60, "left", "linux");
      const xd = allXdotoolArgs();
      expect(xd).toEqual([
        { cmd: "xdotool", args: ["mousemove", "50", "60"] },
        { cmd: "xdotool", args: ["click", "1"] },
      ]);
    });

    it("uses xdotool click=3 for right button on linux", async () => {
      const { click } = await import("../../src/utils/input.js");
      await click(0, 0, "right", "linux");
      expect(allXdotoolArgs().at(-1)?.args).toEqual(["click", "3"]);
    });

    it("throws on Windows platform", async () => {
      const { click } = await import("../../src/utils/input.js");
      await expect(click(0, 0, "left", "win32")).rejects.toThrow(/not implemented for Windows/);
    });
  });

  describe("move", () => {
    it("emits a mouseMoved event on darwin (type=5)", async () => {
      const { move } = await import("../../src/utils/input.js");
      await move(10, 20, "darwin");
      const script = lastJxaScript();
      expect(script).toContain("$.CGPointMake(10, 20)");
      expect(script).toContain("$.CGEventCreateMouseEvent(null, 5");
    });

    it("uses xdotool mousemove on linux", async () => {
      const { move } = await import("../../src/utils/input.js");
      await move(70, 80, "linux");
      expect(allXdotoolArgs()).toEqual([
        { cmd: "xdotool", args: ["mousemove", "70", "80"] },
      ]);
    });

    it("throws on Windows platform", async () => {
      const { move } = await import("../../src/utils/input.js");
      await expect(move(0, 0, "win32")).rejects.toThrow(/not implemented for Windows/);
    });
  });

  describe("doubleClick", () => {
    it("on non-darwin, falls back to two clicks + 50ms gap", async () => {
      vi.useFakeTimers();
      try {
        const { doubleClick } = await import("../../src/utils/input.js");
        const promise = doubleClick(10, 20, "left", "linux");
        // Advance the 50ms setTimeout between the two clicks
        await vi.advanceTimersByTimeAsync(100);
        await promise;
        // two xdotool click pairs
        expect(allXdotoolArgs()).toEqual([
          { cmd: "xdotool", args: ["mousemove", "10", "20"] },
          { cmd: "xdotool", args: ["click", "1"] },
          { cmd: "xdotool", args: ["mousemove", "10", "20"] },
          { cmd: "xdotool", args: ["click", "1"] },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("pressKey", () => {
    it("emits keyDown + keyUp with no modifier flags when modifiers is empty", async () => {
      const { pressKey } = await import("../../src/utils/input.js");
      await pressKey("enter", [], "darwin");
      const script = lastJxaScript();
      expect(script).toContain("var flags = 0");
      expect(script).toContain("$.CGEventCreateKeyboardEvent(null, 36, true)");
      expect(script).toContain("$.CGEventCreateKeyboardEvent(null, 36, false)");
    });

    it("applies modifier flags using bitwise OR", async () => {
      const { pressKey } = await import("../../src/utils/input.js");
      // "a" is not in MAC_KEY_CODES; use "enter" to verify the flag path
      await pressKey("enter", ["cmd", "shift"], "darwin");
      const script = lastJxaScript();
      expect(script).toContain("var flags = ");
      // flags = cmd (0x00100000) | shift (0x00020000) = 0x00120000 = 1179648
      expect(script).toContain("1179648");
      // The flag value is applied to the key event
      expect(script).toContain("$.CGEventSetFlags(keyDown, flags)");
      expect(script).toContain("$.CGEventSetFlags(keyUp, flags)");
    });

    it("throws on unknown key on darwin", async () => {
      const { pressKey } = await import("../../src/utils/input.js");
      await expect(pressKey("Hyper", [], "darwin")).rejects.toThrow(/Unknown key/);
    });

    it("throws on unknown modifier on darwin", async () => {
      const { pressKey } = await import("../../src/utils/input.js");
      // "a" is not in MAC_KEY_CODES; use "enter" so the modifier check is reached
      await expect(pressKey("enter", ["hyper"], "darwin")).rejects.toThrow(/Unknown modifier/);
    });

    it("uses xdotool key with + separator on linux", async () => {
      const { pressKey } = await import("../../src/utils/input.js");
      await pressKey("c", ["ctrl"], "linux");
      expect(allXdotoolArgs()).toEqual([
        { cmd: "xdotool", args: ["key", "ctrl+c"] },
      ]);
    });

    it("uses xdotool key without modifier prefix on linux", async () => {
      const { pressKey } = await import("../../src/utils/input.js");
      await pressKey("Return", [], "linux");
      expect(allXdotoolArgs()).toEqual([
        { cmd: "xdotool", args: ["key", "Return"] },
      ]);
    });
  });

  describe("pressShortcut", () => {
    it("throws when fewer than 2 keys are provided", async () => {
      const { pressShortcut } = await import("../../src/utils/input.js");
      await expect(pressShortcut(["a"], "darwin")).rejects.toThrow(/at least 2 keys/);
    });

    it("splits modifiers from the final key", async () => {
      const { pressShortcut } = await import("../../src/utils/input.js");
      // "a" is not in MAC_KEY_CODES; use "enter" (keycode 36) as the final key
      await pressShortcut(["cmd", "shift", "enter"], "darwin");
      const script = lastJxaScript();
      expect(script).toContain("var flags = ");
      // flags = 0x00100000 | 0x00020000 = 1179648
      expect(script).toContain("1179648");
      // 'enter' keycode is 36
      expect(script).toContain("$.CGEventCreateKeyboardEvent(null, 36, true)");
    });
  });

  describe("dry-run mode", () => {
    beforeEach(() => {
      process.env.UCU_DRY_RUN = "true";
    });

    it("click does not call osascript or xdotool", async () => {
      const { click } = await import("../../src/utils/input.js");
      await click(1, 2, "left", "darwin");
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("move does not call osascript or xdotool", async () => {
      const { move } = await import("../../src/utils/input.js");
      await move(3, 4, "linux");
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("pressKey does not call osascript or xdotool", async () => {
      const { pressKey } = await import("../../src/utils/input.js");
      await pressKey("a", ["cmd"], "darwin");
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });
});
