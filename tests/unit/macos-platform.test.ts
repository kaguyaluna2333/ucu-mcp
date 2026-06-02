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

// ── AX Element Cache: Expiration, Size Limit, Signature Matching ────────

describe("MacOSPlatform elementCache", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
  });

  it("caches element descriptors with a timestamp from findElement", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify([
      { id: "Notes/win0/1", role: "AXButton", name: "Save" },
    ]));
    const platform = new MacOSPlatform();
    const before = Date.now();

    await platform.findElement({ text: "Save", role: "AXButton", app: "Notes" });

    const after = Date.now();
    // Verify the cached descriptor is passed to JXA on a subsequent clickElement
    // by checking the cachedJson in the script. If cachedAt is between before/after,
    // the timestamp is present.
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
    await platform.clickElement("Notes/win0/1", "Notes");

    const script = lastJxaScript();
    // The cached object should have a cachedAt field within our time window
    const cachedMatch = script.match(/var cached = (\{[^}]+\})/s);
    expect(cachedMatch).toBeTruthy();
    const cachedObj = JSON.parse(cachedMatch![1]);
    expect(cachedObj.cachedAt).toBeGreaterThanOrEqual(before);
    expect(cachedObj.cachedAt).toBeLessThanOrEqual(after);
  });

  it("expires cache entries after TTL and passes null cached descriptor to JXA", async () => {
    vi.useFakeTimers();
    try {
      execFileSyncMock.mockReturnValue(JSON.stringify([
        { id: "Notes/win0/1", role: "AXButton", name: "Save" },
      ]));
      const platform = new MacOSPlatform();

      await platform.findElement({ text: "Save", role: "AXButton", app: "Notes" });

      // Advance past TTL (30 seconds)
      vi.advanceTimersByTime(31_000);

      // Now clickElement should treat the cache entry as expired
      execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
      await platform.clickElement("Notes/win0/1", "Notes");

      const script = lastJxaScript();
      const cachedMatch = script.match(/var cached = (null|\{[^}]+\})/s);
      expect(cachedMatch).toBeTruthy();
      expect(cachedMatch![1]).toBe("null");
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires cache entries on typeInElement after TTL", async () => {
    vi.useFakeTimers();
    try {
      execFileSyncMock.mockReturnValue(JSON.stringify([
        { id: "Notes/win0/1", role: "AXTextField", name: "Search" },
      ]));
      const platform = new MacOSPlatform();

      await platform.findElement({ text: "Search", role: "AXTextField", app: "Notes" });

      vi.advanceTimersByTime(31_000);

      execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
      await platform.typeInElement("Notes/win0/1", "hello", "Notes");

      const script = lastJxaScript();
      const cachedMatch = script.match(/var cached = (null|\{[^}]+\})/s);
      expect(cachedMatch).toBeTruthy();
      expect(cachedMatch![1]).toBe("null");
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires cache entries on setElementValue after TTL", async () => {
    vi.useFakeTimers();
    try {
      execFileSyncMock.mockReturnValue(JSON.stringify([
        { id: "Notes/win0/1", role: "AXTextField", name: "Search" },
      ]));
      const platform = new MacOSPlatform();

      await platform.findElement({ text: "Search", role: "AXTextField", app: "Notes" });

      vi.advanceTimersByTime(31_000);

      execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
      await platform.setElementValue("Notes/win0/1", "hello", "Notes");

      const script = lastJxaScript();
      const cachedMatch = script.match(/var cached = (null|\{[^}]+\})/s);
      expect(cachedMatch).toBeTruthy();
      expect(cachedMatch![1]).toBe("null");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps cache entries within TTL and passes cached descriptor to JXA", async () => {
    vi.useFakeTimers();
    try {
      execFileSyncMock.mockReturnValue(JSON.stringify([
        { id: "Notes/win0/1", role: "AXButton", name: "Save" },
      ]));
      const platform = new MacOSPlatform();

      await platform.findElement({ text: "Save", role: "AXButton", app: "Notes" });

      // Stay within TTL
      vi.advanceTimersByTime(10_000);

      execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
      await platform.clickElement("Notes/win0/1", "Notes");

      const script = lastJxaScript();
      const cachedMatch = script.match(/var cached = (null|\{[^}]+\})/s);
      expect(cachedMatch).toBeTruthy();
      expect(cachedMatch![1]).not.toBe("null");
      const cachedObj = JSON.parse(cachedMatch![1]);
      expect(cachedObj.role).toBe("AXButton");
      expect(cachedObj.name).toBe("Save");
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts oldest cache entries when exceeding maxSize (LRU)", async () => {
    // Populate cache with 100+ entries, then verify the oldest is gone
    execFileSyncMock.mockImplementation((_cmd: string, _args: string[]) => {
      // Return a unique result each call by inspecting the script
      return JSON.stringify([
        { id: "App/win0/1", role: "AXButton", name: "Btn" },
      ]);
    });

    const platform = new MacOSPlatform();

    // findElement 101 times with different apps to create 101 distinct cache entries
    for (let i = 0; i < 101; i++) {
      execFileSyncMock.mockReturnValue(JSON.stringify([
        { id: `App${i}/win0/1`, role: "AXButton", name: `Btn${i}` },
      ]));
      await platform.findElement({ text: `Btn${i}`, app: `App${i}` });
    }

    // The first entry (App0) should have been evicted.
    // Verify by calling clickElement for App0 — the cached descriptor should be null
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
    await platform.clickElement("App0/win0/1", "App0");

    const script = lastJxaScript();
    const cachedMatch = script.match(/var cached = (null|\{[^}]+\})/s);
    expect(cachedMatch).toBeTruthy();
    expect(cachedMatch![1]).toBe("null");

    // A recent entry (App100) should still be cached
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
    await platform.clickElement("App100/win0/1", "App100");

    const script2 = lastJxaScript();
    const cachedMatch2 = script2.match(/var cached = (null|\{[^}]+\})/s);
    expect(cachedMatch2).toBeTruthy();
    expect(cachedMatch2![1]).not.toBe("null");
    const cachedObj = JSON.parse(cachedMatch2![1]);
    expect(cachedObj.role).toBe("AXButton");
    expect(cachedObj.name).toBe("Btn100");
  });

  it("includes subrole and identifier in cached descriptors from findElement", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify([
      {
        id: "Notes/win0/1",
        role: "AXButton",
        name: "Save",
        subrole: "AXButtonSubrole",
        identifier: "save-btn",
      },
    ]));
    const platform = new MacOSPlatform();

    await platform.findElement({ text: "Save", role: "AXButton", app: "Notes" });

    // Check that subsequent clickElement receives the subrole and identifier
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
    await platform.clickElement("Notes/win0/1", "Notes");

    const script = lastJxaScript();
    const cachedMatch = script.match(/var cached = (\{[^}]+\})/s);
    expect(cachedMatch).toBeTruthy();
    const cachedObj = JSON.parse(cachedMatch![1]);
    expect(cachedObj.subrole).toBe("AXButtonSubrole");
    expect(cachedObj.identifier).toBe("save-btn");
  });

  it("scoreEquivalent JXA includes subrole and identifier matching", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify([
      {
        id: "Notes/win0/1",
        role: "AXButton",
        name: "Save",
        subrole: "AXButtonSubrole",
        identifier: "save-btn",
      },
    ]));
    const platform = new MacOSPlatform();

    await platform.findElement({ text: "Save", role: "AXButton", app: "Notes" });

    // Verify clickElement's JXA script contains subrole/identifier scoring
    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
    await platform.clickElement("Notes/win0/1", "Notes");

    const script = lastJxaScript();
    expect(script).toContain("e.subrole()");
    expect(script).toContain("e.identifier()");
    expect(script).toContain("cached.subrole");
    expect(script).toContain("cached.identifier");
    // Verify the scoring weights: subrole += 2, identifier += 3
    expect(script).toMatch(/cached\.subrole.*score \+= 2/);
    expect(script).toMatch(/cached\.identifier.*score \+= 3/);
  });

  it("scoreEquivalent JXA includes subrole and identifier in typeInElement", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify([
      {
        id: "Notes/win0/1",
        role: "AXTextField",
        name: "Search",
        subrole: "AXSearchField",
        identifier: "search-field",
      },
    ]));
    const platform = new MacOSPlatform();

    await platform.findElement({ text: "Search", role: "AXTextField", app: "Notes" });

    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
    await platform.typeInElement("Notes/win0/1", "hello", "Notes");

    const script = lastJxaScript();
    expect(script).toContain("e.subrole()");
    expect(script).toContain("e.identifier()");
    expect(script).toMatch(/cached\.subrole.*score \+= 2/);
    expect(script).toMatch(/cached\.identifier.*score \+= 3/);
  });

  it("scoreEquivalent JXA includes subrole and identifier in setElementValue", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify([
      {
        id: "Notes/win0/1",
        role: "AXTextField",
        name: "Search",
        subrole: "AXSearchField",
        identifier: "search-field",
      },
    ]));
    const platform = new MacOSPlatform();

    await platform.findElement({ text: "Search", role: "AXTextField", app: "Notes" });

    execFileSyncMock.mockReturnValue(JSON.stringify({ success: true }));
    await platform.setElementValue("Notes/win0/1", "hello", "Notes");

    const script = lastJxaScript();
    expect(script).toContain("e.subrole()");
    expect(script).toContain("e.identifier()");
    expect(script).toMatch(/cached\.subrole.*score \+= 2/);
    expect(script).toMatch(/cached\.identifier.*score \+= 3/);
  });
});
