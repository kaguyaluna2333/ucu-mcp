import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MacOSPlatform } from "../../src/platform/macos.js";

const runSmoke = process.platform === "darwin" && process.env.UCU_MACOS_GUI_SMOKE === "1";
const describeGuiSmoke = runSmoke ? describe : describe.skip;

function osascript(script: string, timeout = 10000): string {
  return execFileSync("/usr/bin/osascript", ["-e", script], {
    encoding: "utf-8",
    timeout,
  }).trim();
}

/** Try to launch TextEdit with an empty document; return true on success. */
function launchTextEdit(): boolean {
  try {
    execFileSync("/usr/bin/open", ["-a", "TextEdit"], { timeout: 10000 });
    osascript(
      `
      tell application "TextEdit"
        make new document with properties {text:""}
      end tell
    `,
      30000,
    );
    return true;
  } catch {
    return false;
  }
}

function closeTextEditDocs(): void {
  try {
    osascript(
      `
      tell application "TextEdit"
        if (count of documents) > 0 then close document 1 saving no
      end tell
    `,
      30000,
    );
  } catch {
    // Best effort cleanup for a gated smoke test.
  }
}

describeGuiSmoke("macOS GUI smoke", () => {
  const platform = new MacOSPlatform();
  let textEditAvailable = false;

  beforeAll(async () => {
    textEditAvailable = launchTextEdit();
    if (!textEditAvailable) {
      console.warn("TextEdit automation unavailable – some tests will be skipped");
    }
  }, 60000);

  afterAll(() => {
    if (textEditAvailable) closeTextEditDocs();
  }, 60000);

  // ── 1. list_windows ─────────────────────────────────────────────────────

  it("list_windows returns at least one window with required fields", async () => {
    const windows = await platform.listWindows();
    expect(windows.length).toBeGreaterThan(0);

    const w = windows[0];
    expect(w).toHaveProperty("id");
    expect(typeof w.id).toBe("string");
    expect(w.id.length).toBeGreaterThan(0);

    expect(w).toHaveProperty("title");
    expect(typeof w.title).toBe("string");

    expect(w).toHaveProperty("processName");
    expect(typeof w.processName).toBe("string");
    expect(w.processName.length).toBeGreaterThan(0);

    expect(w).toHaveProperty("pid");
    expect(typeof w.pid).toBe("number");
    expect(w.pid).toBeGreaterThan(0);

    expect(w).toHaveProperty("bounds");
    expect(w.bounds).toHaveProperty("x");
    expect(w.bounds).toHaveProperty("y");
    expect(w.bounds).toHaveProperty("width");
    expect(w.bounds).toHaveProperty("height");
  });

  // ── 2. get_screen_size ──────────────────────────────────────────────────

  it("getScreenSize returns valid dimensions and scaleFactor", () => {
    const size = platform.getScreenSize();
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
    if (size.scaleFactor !== undefined) {
      expect([1, 2]).toContain(size.scaleFactor);
    }
  });

  // ── 3. find_element ─────────────────────────────────────────────────────

  it("findElement locates an AXTextArea in TextEdit", async (ctx) => {
    if (!textEditAvailable) ctx.skip();

    const matches = await platform.findElement({
      app: "TextEdit",
      role: "AXTextArea",
      depth: 8,
    });
    expect(matches.length).toBeGreaterThan(0);

    const el = matches[0];
    expect(el).toHaveProperty("role");
    expect(el.role).toBeTruthy();
    // At least one of name or id must be present
    const hasName = Boolean(el.name);
    const hasId = Boolean(el.id);
    expect(hasName || hasId).toBe(true);
  });

  // ── 4. click ────────────────────────────────────────────────────────────

  it("click at screen center does not throw", async () => {
    const size = platform.getScreenSize();
    const cx = Math.floor(size.width / 2);
    const cy = Math.floor(size.height / 2);

    // click should resolve without error
    await expect(platform.click(cx, cy)).resolves.toBeUndefined();
  });

  // ── 5. screenshot ───────────────────────────────────────────────────────

  it("screenshot returns a non-empty Buffer", async () => {
    const buf = await platform.screenshot();
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(0);
  });

  // ── Original: set_value on TextEdit ─────────────────────────────────────

  it("finds a TextEdit text area and sets its value through AX", async (ctx) => {
    if (!textEditAvailable) ctx.skip();

    const target = await platform.focusApp("TextEdit");
    expect(target.appName).toContain("TextEdit");

    const matches = await platform.findElement({
      app: "TextEdit",
      role: "AXTextArea",
      depth: 8,
    });
    expect(matches.length).toBeGreaterThan(0);

    await platform.setElementValue(matches[0].id, "ucu-mcp macOS GUI smoke", "TextEdit");

    const text = osascript('tell application "TextEdit" to get text of document 1');
    expect(text).toContain("ucu-mcp macOS GUI smoke");
  }, 30000);
});
