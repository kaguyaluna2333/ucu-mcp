import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

import { MacOSPlatform } from "../../src/platform/macos.js";

function lastJxaScript(): string {
  const call = execFileSyncMock.mock.calls.at(-1);
  expect(call?.[0]).toBe("osascript");
  const args = call?.[1] as string[];
  return args.at(-1) ?? "";
}

describe("MacOSPlatform", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
  });

  it("sets AX element values without focusing or typing into the element", async () => {
    const platform = new MacOSPlatform();

    await platform.setElementValue("Notes/win0/1/2", "hello", "Notes");

    const script = lastJxaScript();
    expect(script).toContain("elem.value = valueToSet");
    expect(script).not.toContain("focused = true");
    expect(script).not.toContain("keystroke");
  });

  it("uses JSON literals for multiline and special-character AX values", async () => {
    const platform = new MacOSPlatform();
    const value = "line 1\nline 2 with \"quotes\", \\ backslash, $dollar, and `ticks`";

    await platform.setElementValue("Notes/win0/1/2", value, "Notes");

    const script = lastJxaScript();
    expect(script).toContain(`var valueToSet = ${JSON.stringify(value)};`);
    expect(script).toContain(`var elemPath = ${JSON.stringify("Notes/win0/1/2")};`);
    expect(script).toContain(`var appName = ${JSON.stringify("Notes")};`);
  });

  it("reports failed AX value assignment as set_value failure", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({
      success: false,
      error: "Could not set AX value: read only",
    }));
    const platform = new MacOSPlatform();

    await expect(platform.setElementValue("Notes/win0/1/2", "hello", "Notes"))
      .rejects.toThrow("set_value failed");
  });

  it("honors getWindowState depth up to 10 and includeBounds=false", async () => {
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify([
        {
          id: "123",
          title: "Notes",
          processName: "Notes",
          pid: 42,
          bounds: { x: 10, y: 20, width: 300, height: 200 },
          isMinimized: false,
          isOnScreen: true,
        },
      ]))
      .mockReturnValueOnce(JSON.stringify({
        window: {
          id: "123",
          title: "Notes",
          processName: "Notes",
          pid: 42,
          bounds: { x: 10, y: 20, width: 300, height: 200 },
          isMinimized: false,
          isOnScreen: true,
        },
        tree: {
          role: "AXWindow",
          name: "Notes",
          states: [],
          children: [],
        },
      }));
    const platform = new MacOSPlatform();

    await platform.getWindowState("123", 9, false);

    const script = lastJxaScript();
    expect(script).toContain("var includeBounds = false;");
    expect(script).toContain("currentDepth < 9");
    expect(script).toContain("if (includeBounds) {");
  });

  it("returns the focused AX element from getWindowState", async () => {
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify([
        {
          id: "123",
          title: "Notes",
          processName: "Notes",
          pid: 42,
          bounds: { x: 10, y: 20, width: 300, height: 200 },
          isMinimized: false,
          isOnScreen: true,
        },
      ]))
      .mockReturnValueOnce(JSON.stringify({
        window: {
          id: "123",
          title: "Notes",
          processName: "Notes",
          pid: 42,
          bounds: { x: 10, y: 20, width: 300, height: 200 },
          isMinimized: false,
          isOnScreen: true,
        },
        focusedElement: {
          role: "AXTextArea",
          name: "Body",
          value: "draft",
          bounds: { x: 20, y: 40, width: 260, height: 120 },
          states: ["focused"],
        },
        tree: {
          role: "AXWindow",
          name: "Notes",
          states: [],
          children: [],
        },
      }));
    const platform = new MacOSPlatform();

    const state = await platform.getWindowState("123", 3, true);

    expect(state.focusedElement).toMatchObject({
      role: "AXTextArea",
      name: "Body",
      value: "draft",
      bounds: { x: 20, y: 40, width: 260, height: 120 },
      states: ["focused"],
    });
    const script = lastJxaScript();
    expect(script).toContain("foundProc.focusedUIElement");
    expect(script).toContain("elementBelongsToWindow(processFocused)");
    expect(script).toContain("result.focusedElement = summarizeFocusedElement(focusedInfo);");
  });

  it("honors findElement maxResults and includeBounds=false", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify([
      {
        id: "Notes/win0/1",
        role: "AXButton",
        name: "Save",
      },
    ]));
    const platform = new MacOSPlatform();

    const results = await platform.findElement({
      text: "Save",
      role: "AXButton",
      app: "Notes",
      depth: 4,
      includeBounds: false,
      maxResults: 3,
    });

    expect(results).toEqual([
      {
        id: "Notes/win0/1",
        role: "AXButton",
        name: "Save",
      },
    ]);
    const script = lastJxaScript();
    expect(script).toContain("var maxResults = 3;");
    expect(script).toContain("var includeBounds = false;");
    expect(script).toContain("if (includeBounds) item.bounds = getBounds(elem);");
  });
});
