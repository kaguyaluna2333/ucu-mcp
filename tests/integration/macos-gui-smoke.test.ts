import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { MacOSPlatform } from "../../src/platform/macos.js";

const runSmoke = process.platform === "darwin" && process.env.UCU_MACOS_GUI_SMOKE === "1";
const describeGuiSmoke = runSmoke ? describe : describe.skip;

function osascript(script: string, timeout = 10000): string {
  return execFileSync("/usr/bin/osascript", ["-e", script], {
    encoding: "utf-8",
    timeout,
  }).trim();
}

describeGuiSmoke("macOS GUI smoke", () => {
  const platform = new MacOSPlatform();

  it("finds a TextEdit text area and sets its value through AX without coordinate typing", async (ctx) => {
    let openedDocument = false;
    try {
      execFileSync("/usr/bin/open", ["-a", "TextEdit"], { timeout: 10000 });
      osascript(`
        tell application "TextEdit"
          make new document with properties {text:""}
        end tell
      `, 30000);
      openedDocument = true;
    } catch (error) {
      console.warn(`Skipping macOS GUI smoke: TextEdit automation is unavailable (${String(error)})`);
      ctx.skip();
      return;
    }

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

    if (openedDocument) {
      try {
        osascript(`
          tell application "TextEdit"
            if (count of documents) > 0 then close document 1 saving no
          end tell
        `, 30000);
      } catch {
        // Best effort cleanup for a gated smoke test.
      }
    }
  }, 30000);
});
